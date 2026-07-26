# Backlog de tareas — Fase 1 (POC)

Orden sugerido. Marcá cada una al completarla. No saltes al bloque 3 sin
haber cerrado el bloque 2 con un test que lo pruebe.

## Bloque 0 — Setup del monorepo
- [x] Completar `package.json` raíz con npm/pnpm workspaces apuntando a
      `apps/*`, `mcp-servers/*`, `packages/*`.
- [x] Configurar `tsconfig.base.json` y que cada paquete lo extienda.
- [~] `docker-compose.yml`: Postgres local configurado (Redis comentado,
      se agrega en fase 2). Config lista pero no verificada corriendo en
      este entorno — no hay Docker instalado en esta máquina. Confirmar
      `docker compose up -d postgres` localmente.
- [x] Confirmar que `npm run build` corre sin errores en todo el monorepo
      aunque los paquetes estén vacíos (se agregaron placeholders `src/*.ts`
      mínimos en cada paquete para que `tsc` no falle con "no inputs were
      found"; se reemplazan en los bloques 1-3).

## Bloque 1 — Tipos compartidos
- [x] `packages/shared-types`: definir `Intent`, `IntentCatalog`,
      `ConversationState`, `Property`, `Lead`, `Appointment`,
      `AuditLogEntry` a partir de `docs/intent_catalog.yaml` y `docs/SOW.md`.
- [x] Un loader/parser de `docs/intent_catalog.yaml` con validación de
      schema (zod) — `loadIntentCatalogFromFile` / `parseIntentCatalog` en
      `packages/shared-types/src/loader.ts`. Testeado contra el YAML real
      del proyecto (`src/loader.test.ts`, 4 tests OK). El orchestrator lo
      va a consumir en el Bloque 3.

## Bloque 2 — MCP servers (en este orden: weather, gcal, tokko)
- [x] `mcp-servers/mcp-weather`: tool `get_forecast(lat, lng, date)` contra
      el endpoint gratuito de OpenWeatherMap (5 day/3 hour forecast).
      Patrón fijado: `config.ts` (env), `openWeatherMapClient.ts` (cliente
      HTTP + parseo, inyectable para tests), `tools/getForecast.ts`
      (handler MCP puro, nunca inventa datos si el provider falla),
      `server.ts` (registro del tool), `index.ts` (entrypoint stdio).
      7 tests aislados (sin red real) en `openWeatherMapClient.test.ts` y
      `tools/getForecast.test.ts`.
- [x] `mcp-servers/mcp-gcal`: tools `freebusy`, `create_event`,
      `patch_event`, `delete_event`, `list_events` — más `get_event`
      (no estaba en esta lista pero lo usan `reprogramar_cancelar_visita`
      y `consulta_clima_visita` en `docs/intent_catalog.yaml`, que manda
      sobre este resumen). Adaptado del patrón de nspady/google-calendar-mcp
      (referencia pública en TS) pero simplificado a un solo calendario/
      cuenta vía OAuth refresh token (`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
      /CALENDAR_ID`), sin multi-account. 11 tests aislados (transforms
      puros + handlers con un `CalendarClient` stub, sin red real).
- [x] `mcp-servers/mcp-tokko`: tools `search_properties`, `get_property`,
      `search_leads`, `get_lead`, `log_activity` contra `MockTokkoClient`
      (en memoria, con 2 propiedades/2 leads de ejemplo). Sin credenciales
      reales todavía — marcado `// TODO: reemplazar por credenciales reales
      de Tokko` en `server.ts` y `tokkoClient.ts`. Reutiliza `Property`/
      `Lead` de `shared-types`. 12 tests aislados.
- [x] Cada MCP server tiene al menos un test que lo ejercita de forma
      aislada (mcp-weather 7, mcp-gcal 11, mcp-tokko 12 — todos sin red
      real ni dependencia del orchestrator).

## Bloque 3 — Orchestrator: loop mínimo end-to-end
- [x] Webhook handler de WhatsApp Cloud API (`channels/whatsapp`):
      recibe, valida firma (`X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`,
      agregado a `.env.example`), responde el handshake GET de Meta, y
      parsea el mensaje de texto entrante (zod).
- [x] Loader del `intent_catalog.yaml` integrado (del bloque 1) —
      `agent/intentCatalog.ts` reusa `loadIntentCatalogFromFile` de
      `shared-types`.
- [x] Loop de tool-use con Claude API: `agent/classifier.ts`
      (`ClaudeIntentClassifier`, tool-use forzado devuelve intent + confianza
      + búsqueda extraída) y `agent/composer.ts` (`ClaudeResponseComposer`,
      redacción final grounded). **Nota**: no hay `ANTHROPIC_API_KEY` en este
      entorno todavía, así que estas dos clases están implementadas contra
      la API real pero los tests automatizados las stubean (interfaces
      `IntentClassifier`/`ResponseComposer`, mismo patrón que mcp-tokko con
      Tokko). Falta correr un test manual con la clave real puesta.
- [x] Implementado **un solo intent de punta a punta**:
      `consulta_disponibilidad` (`agent/consultaDisponibilidad.ts`) contra
      `mcp-tokko` real — el orchestrator lo levanta como proceso hijo real
      por stdio (`mcp/mcpToolClient.ts` + `mcp/tokkoMcpClient.ts`, protocolo
      MCP real, no una llamada simulada) y usa su `MockTokkoClient` interno
      hasta que haya credenciales reales de Tokko.
- [x] `audit_log`: cada respuesta queda registrada con intent, confianza y
      tools llamadas (`agent/auditLog.ts`). Implementado como pidió el
      usuario: `FileAuditLogStore` (JSONL en `apps/orchestrator/data/`,
      gitignoreado por posibles datos de clientes) detrás de una interfaz
      `AuditLogStore` — migrar a Postgres (bloque 4+) es swap de
      implementación, no reescritura. **Esto es lo que se vuelve
      bloqueante instalar Docker de verdad**: en cuanto se necesite
      auditoría consultable entre procesos/concurrencia real, o se empiece
      el scheduler de recordatorios (fase 2), hay que migrar de archivo a
      Postgres.
- [x] **Hito de validación**: `src/app.test.ts` levanta un servidor HTTP
      efímero real, manda un POST de webhook con el mensaje "¿el depto de
      Palermo sigue disponible?" (firma HMAC real incluida), y verifica que
      el loop completo (parseo → classifier stub → mcp-tokko real →
      composer stub grounded → audit_log) responde 200 y audita
      correctamente. 27 tests en `apps/orchestrator` (7 archivos), 2 de
      ellos contra el proceso real de `mcp-tokko`.

## Bloque 4 — Escalamiento
- [x] `agent/escalation.ts` — `decideEscalation(intent, confidence, threshold)`,
      función pura. Implementa las reglas 1 y 3 de `docs/escalation_policy.md`
      explícitamente; documenta por qué las reglas 4/5/6/8 ya están cubiertas
      por la regla 1 (el catálogo las codifica como `requires_broker: true`
      por intent) y por qué las reglas 2 ("conditional") y 7 (irreversibilidad)
      quedan afuera a propósito — necesitan estado de conversación que recién
      llega con la máquina de estados del Bloque 5.
- [x] Los 5 intents que siempre escalan (`negociacion_precio`, `reclamo_queja`,
      `consulta_legal_contractual`, `hablar_con_persona`,
      `fallback_low_confidence`) — ya funcionaban estructuralmente desde el
      Bloque 3 (branch `requires_broker: true` → responde con el template del
      catálogo, cero tools de negocio), pero ahora hay un test por cada uno
      contra el catálogo real (`handleIncomingMessage.test.ts`, `it.each`)
      que lo deja explícito y a prueba de que alguien cambie el YAML.
- [x] Notificación al broker: `agent/draftComposer.ts`
      (`ClaudeDraftReplyComposer`, redacta un borrador — nunca se manda tal
      cual, marca `[CONFIRMAR: ...]` lo que no puede saber) +
      `agent/brokerNotifier.ts` (`WhatsAppBrokerNotifier`, arma el mensaje
      con intent + confianza + transcripción + motivo + borrador y lo manda
      por WhatsApp al `BROKER_WHATSAPP_NUMBER`). Best-effort: si falla la
      notificación al broker, el cliente igual recibe su respuesta (no
      revienta el loop) — testeado explícitamente.
      **Nota de alcance**: el "contexto de la conversación (últimos N
      mensajes)" que pide `docs/escalation_policy.md` todavía es solo el
      mensaje entrante — el historial multi-turno llega con la máquina de
      estados del Bloque 5.
      `AuditLogEntry` ganó un campo `escalationRule` (`shared-types`) para
      auditar explícitamente qué regla disparó el escalamiento, tal como
      pide la sección "Auditoría" de `docs/escalation_policy.md`.
      Bug real encontrado y corregido de paso al probar Bloque 3 con la API
      real de Claude: `MockTokkoClient` exigía substring exacto para
      `direccion`/`barrio`, pero el classifier extrae frases libres (ej.
      "depto Palermo", no "Palermo") — se cambió a matching por palabra
      significativa, con test de regresión. También se corrigió el prompt
      del composer para usar el formato real de WhatsApp (`*negrita*` con
      un asterisco, no `**doble**`), y se agregó `dotenv` al orchestrator
      (nada cargaba `.env` antes) apuntando explícitamente a la raíz del
      repo, porque `npm run dev:orchestrator` corre con cwd en
      `apps/orchestrator`.
      79 tests en todo el monorepo (44 en orchestrator). Verificado además
      con 2 mensajes reales contra la API de Claude del usuario
      (clasificación + redacción grounded reales, sin stub) — no se probó
      el envío real del mensaje al broker por WhatsApp porque
      `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
      `BROKER_WHATSAPP_NUMBER` no están configurados todavía.

## Bloque 5 — Resto de intents reactivos de fase 1
- [ ] `consulta_precio_condiciones`, `pedido_ficha_multimedia`,
      `agendar_visita`, `reprogramar_cancelar_visita`,
      `consulta_clima_visita`.
- [ ] Máquina de estados de conversación (`agent/state_machine.ts`) para
      soportar flujos multi-turno (ej: "quiero agendar visita" → agente
      propone horarios → cliente confirma uno).

## No hacer todavía (fase 2+, ver SOW)
- Recordatorios automáticos, recontacto proactivo, seguimiento post-visita
  (intents `scheduled`).
- Canal broker (`broker_resumen_agenda`, `broker_accion_directa`, etc).
- Cualquier cosa de "Out of scope" en `docs/SOW.md` sección 2.
