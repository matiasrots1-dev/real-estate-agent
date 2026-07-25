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
- [ ] `mcp-servers/mcp-weather`: tool `get_forecast(lat, lng, date)`.
      Es el más simple, sirve para fijar el patrón de MCP server del
      proyecto (estructura de carpeta, cómo se testea, cómo se declara un
      tool) antes de meterse con integraciones más complejas.
- [ ] `mcp-servers/mcp-gcal`: tools `freebusy`, `create_event`,
      `patch_event`, `delete_event`, `list_events`. Partir de un server
      MCP de referencia de Google Calendar existente y adaptarlo, no
      escribirlo desde cero.
- [ ] `mcp-servers/mcp-tokko`: tools `search_properties`, `get_property`,
      `search_leads`, `get_lead`, `log_activity`. Si no hay credenciales
      reales todavía, implementar con mocks y dejar marcado
      `// TODO: validar contra API real de Tokko` en cada tool.
- [ ] Cada MCP server tiene al menos un test que lo ejercita de forma
      aislada.

## Bloque 3 — Orchestrator: loop mínimo end-to-end
- [ ] Webhook handler de WhatsApp Cloud API (`channels/whatsapp`):
      recibe, valida firma, parsea mensaje entrante.
- [ ] Loader del `intent_catalog.yaml` integrado (del bloque 1).
- [ ] Loop de tool-use con Claude API: dado un mensaje + catálogo,
      devuelve intent matcheado + confianza + tools a llamar.
- [ ] Implementar **un solo intent de punta a punta**:
      `consulta_disponibilidad` contra el mock/real de `mcp-tokko`.
- [ ] `audit_log`: cada respuesta del agente queda registrada con intent,
      confianza, tools llamadas.
- [ ] **Hito de validación**: mandar un mensaje de prueba tipo "¿el depto
      de Palermo sigue disponible?" contra el webhook y verificar que el
      loop completo responde correctamente y loguea en `audit_log`.

## Bloque 4 — Escalamiento
- [ ] Implementar `agent/escalation.ts` según `docs/escalation_policy.md`.
- [ ] Implementar los intents `negociacion_precio`, `reclamo_queja`,
      `consulta_legal_contractual`, `hablar_con_persona`,
      `fallback_low_confidence` — todos escalan, ninguno ejecuta tools de
      negocio.
- [ ] Notificación al broker (mensaje de WhatsApp al canal broker con el
      contexto + borrador sugerido).

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
