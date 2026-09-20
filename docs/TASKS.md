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
- [x] `consulta_precio_condiciones` (`agent/consultaPrecioCondiciones.ts`) —
      mismo patrón de búsqueda que consulta_disponibilidad (factorizado en
      `agent/tokkoLookup.ts`), grounding en precio/expensas/requisitos/
      garantías; un campo no cargado se pasa `null` explícito al composer
      (nunca se omite en silencio ni se inventa).
- [x] `pedido_ficha_multimedia` (`agent/pedidoFichaMultimedia.ts`) — manda
      el template del catálogo + las fotos de la propiedad como mensajes de
      imagen reales (`WhatsAppSender.sendImage`, nuevo). Planos/videos
      quedan pendientes (necesitarían tipos de mensaje document/video que
      el sender no implementa todavía).
- [x] `consulta_clima_visita` (`agent/consultaClimaVisita.ts`) — encuentra
      la visita activa del lead (`AppointmentStore`), confirma la fecha
      real contra `gcal.get_event`, y pide `weather.get_forecast` con las
      coordenadas de la propiedad (`Property.lat/lng`, nuevo en
      shared-types) o un default de `config.ts` si no están cargadas.
- [x] `agendar_visita` (`agent/agendarVisita.ts`) y
      `reprogramar_cancelar_visita` (`agent/reprogramarCancelarVisita.ts`) —
      los dos flujos multi-turno reales: proponen hasta 3 horarios libres
      en las próximas 72hs vía `gcal.freebusy` (horario habitual 9-20hs,
      sin domingos, hora de Argentina — `agent/slotProposal.ts`), esperan
      la confirmación del cliente (`agent/slotConfirmation.ts`, Claude
      matchea la respuesta libre contra los horarios propuestos), y recién
      ahí ejecutan `gcal.create_event`/`patch_event`/`delete_event` +
      `tokko.log_activity`. Implementan las dos reglas de escalamiento
      condicional que el Bloque 4 había dejado pendientes (regla 2 de
      `docs/escalation_policy.md`): sin disponibilidad en 72hs, o el
      cliente no elige ninguno de los horarios propuestos (incluye pedir
      algo fuera de rango — nunca llegó a proponerse, así que cae acá
      naturalmente). `reprogramar_cancelar_visita` además escala si es la
      2da reprogramación de la misma visita (`Appointment.vecesReprogramada`).
- [x] Máquina de estados de conversación (`agent/stateMachine.ts` +
      `agent/conversationStateStore.ts`) — `ConversationState.step`
      (shared-types) trackea si hay un flujo multi-turno activo; si lo hay,
      `handleIncomingMessage` rutea directo a la continuación (sin volver a
      clasificar el mensaje) en vez de tratarlo como un mensaje nuevo. Si
      el estado quedó inconsistente (ej. el catálogo cambió), se resetea a
      `idle` en vez de trabar la conversación para siempre.
- [x] Nueva persistencia local (mismo patrón que `audit_log` del Bloque 3 —
      archivo JSON, interfaz swappable a Postgres): `AppointmentStore`
      (`apps/orchestrator/data/appointments.json`) y
      `ConversationStateStore` (`apps/orchestrator/data/conversations.json`).
      Simplificación deliberada: un lead tiene a lo sumo una visita activa
      a la vez (documentado en `appointmentStore.ts`).
- [x] `mcp-gcal` y `mcp-weather` no tenían mock de fallback (a diferencia de
      `mcp-tokko` desde el Bloque 2) — sin `GOOGLE_CLIENT_ID/SECRET/
      REFRESH_TOKEN/CALENDAR_ID` ni `WEATHER_API_KEY` (CLAUDE.md secc. 5,
      todavía sin confirmar), estos servers no arrancaban. Se agregó
      `MockGoogleCalendarClient` y `MockWeatherClient` (determinístico) con
      el mismo `// TODO: reemplazar por credenciales reales` que Tokko, y
      `GcalMcpClient`/`WeatherMcpClient` en el orchestrator (wrappers MCP
      tipados, mismo patrón que `TokkoMcpClient`).
      143 tests en todo el monorepo (99 en orchestrator — incluye
      integración real contra los 3 MCP servers por stdio, no solo Tokko).

---

# Backlog de tareas — Fase 2 (MVP en producción)

Mismo criterio que la Fase 1: no bloquear el trabajo por falta de una
credencial o prerequisito externo (plantillas de WhatsApp aprobadas por
Meta, `TOKKO_API_KEY`, etc.) — avanzar con mocks/stubs y dejar `// TODO`
explícito. Orden sugerido; no saltar un bloque sin haber cerrado el
anterior con un test que lo pruebe (mismo criterio que la Fase 1).

## Bloque 6 — Scheduler + `recordatorio_visita`
- [x] `apps/orchestrator/src/jobs/scheduler.ts` — polling a intervalo fijo
      (`SCHEDULER_INTERVAL_MS`, default 5 min), no cron expressions de
      verdad: los jobs de este proyecto son "chequeá si ya se cumplió tal
      condición", no "corré a tal hora exacta" (documentado en el propio
      archivo). Un job que falla no frena a los demás (`tick()` los
      atrapa individualmente).
- [x] `WhatsAppSender.sendTemplate(to, templateName, languageCode,
      bodyParams)` — nuevo método, mismo patrón que `sendText`/`sendImage`
      (Fase 1). Implementado contra la API real de Meta (`type: template`
      con components de body). **Pendiente de confirmar con el usuario**:
      que `recordatorio_visita_v1` exista y esté aprobada en Meta Business
      Manager — sin eso, el envío va a fallar en producción aunque el
      código esté bien (mismo tipo de bloqueo externo que Tokko/Calendar
      en la Fase 1, no bloquea el desarrollo).
- [x] `jobs/reminders.ts` — recorre `AppointmentStore.listActive()` (método
      nuevo, agregado a la interfaz) y dispara `recordatorio_visita` en
      T-24h/T-2h leyendo `schedule_rules` del catálogo en runtime
      (`jobs/scheduleOffset.ts` parsea "-24h"/"-2h"/"+3h" — nunca
      hardcodeado, CLAUDE.md secc. 7), usando `Appointment.remindersSent`
      (existía desde la Fase 1, sin usar todavía) para no duplicar. El
      mensaje incluye clima real (`weather.get_forecast`, mismo patrón que
      `consulta_clima_visita`) + datos de la propiedad.
- [x] Integrado en `server.ts`: el scheduler arranca solo si hay
      `WhatsAppSender` configurado (si no, warning y no arranca — no tiene
      sentido correr un job que no puede mandar nada).
- [x] Tests: 21 nuevos (`scheduler` 4, `scheduleOffset` 4, `sender` 5,
      `reminders` 6, `appointmentStore.listActive` 1, + fix de
      `brokerNotifier` para la nueva interfaz). Cubren: no manda si falta
      más de 24hs; manda -24h y lo marca en `remindersSent`; no duplica en
      una segunda corrida; manda -2h aunque -24h ya se haya mandado; nada
      para una visita ya pasada; un envío que falla no frena los demás ni
      marca `remindersSent` (para poder reintentar la próxima corrida).
      164 tests en todo el monorepo.

## Bloque 7 — `recontacto_lead_frio` + `seguimiento_post_visita`
- [x] `jobs/scheduleCondition.ts` — parser de las `condition` del catálogo
      ("dias_sin_respuesta >= 5"), paralelo a `scheduleOffset.ts` del
      Bloque 6 pero para condiciones sobre un campo en vez de offsets de
      tiempo. Nunca hardcodeados los umbrales 5/15/30 (CLAUDE.md secc. 7).
- [x] `agent/recontactStateStore.ts` (nuevo store, mismo patrón que
      `AppointmentStore`/`ConversationStateStore`) — trackea qué
      `condition` ya se disparó por lead. Deliberadamente separado de
      `Lead` (que espeja lo que devuelve Tokko): esto es contabilidad
      interna nuestra, no un dato de Tokko.
- [x] `TokkoQueries` ganó `searchLeads`/`getLead` (ya existían como tools en
      `mcp-tokko` desde el Bloque 2, nunca se habían expuesto en el
      orchestrator porque ningún intent los necesitaba hasta ahora).
- [x] `jobs/recontact.ts`: recorre leads fríos (`tokko.search_leads`) y
      evalúa `dias_sin_respuesta >= 5/15/30` leyendo las `condition` del
      catálogo en runtime. Arma el mensaje con `composer` (grounding: la
      propiedad original si sigue disponible, o una alternativa del mismo
      tipo si no — `tokko.search_properties`, nunca inventada). El umbral
      más alto del catálogo (30 días) es "el 3er intento":
      `requires_broker: "conditional"` — en vez de mandarse solo, se
      manda al broker como notificación con el mensaje como borrador
      (`brokerNotifier`). **Nota de alcance**: si el broker aprueba o edita
      ese borrador, hoy no hay forma de que su respuesta dispare el envío
      real — eso necesita manejo del canal broker (Bloque 8-10, todavía no
      existe). Por ahora el 3er intento queda en "notificado", no
      "enviado automáticamente", que es justamente el comportamiento que
      pide el catálogo (no mandarse solo).
- [x] `jobs/seguimientoPostVisita.ts`: dispara +3h después de la visita
      (offset del catálogo, no hardcodeado) y de paso marca
      `Appointment.estado = "realizada"` en el mismo paso — no hizo falta
      un pase separado para "cerrar" la visita, +3h ya es tiempo de sobra
      después de que terminó (una vez `realizada`,
      `AppointmentStore.listActive()` dejar de traerla evita duplicados).
- [x] Retrofit del Bloque 6: `jobs/reminders.ts` no auditaba nada — CLAUDE.md
      secc. 3 dice "toda respuesta del agente" sin excepción para las
      proactivas. Se agregó `AuditLogStore` a sus deps; los 3 jobs
      proactivos ahora auditan con `confidence: null` (no hubo
      clasificación, fue el scheduler el que disparó).
- [x] Tests: 24 nuevos (`scheduleCondition` 5, `recontactStateStore` 8,
      `recontact` 7, `seguimientoPostVisita` 4) + 2 nuevos en
      `tokkoMcpClient` real (`searchLeads`/`getLead` contra el proceso
      real de mcp-tokko). 191 tests en todo el monorepo.

## Bloque 8 — Canal broker: identificación + resúmenes (solo lectura)
- [x] Detectar el canal por número: si `message.from ===
      BROKER_WHATSAPP_NUMBER` es `channel: "broker"`, no `"cliente"`.
      Filtrar los intents candidatos que se le pasan al classifier según
      el canal del mensaje entrante — nunca dejar que un mensaje de
      cliente matchee un intent `channel: broker` o viceversa.
      Implementado como `filterCatalogByChannel(catalog, channel)` en
      `agent/intentCatalog.ts`: filtra el catálogo ANTES de llamar al
      classifier (el classifier no cambió — sigue recibiendo un
      `IntentCatalog`, solo que ya recortado). `handleIncomingMessage`
      calcula `channel` comparando `message.from` con el nuevo
      `HandleMessageDeps.brokerWhatsappNumber` (pasado desde `server.ts` ←
      `config.whatsapp.brokerWhatsappNumber`). Los intents `channel: any`
      (ej. `consulta_clima_visita`) quedan visibles en los dos canales.
      Nota de riesgo conocida (no resuelta, a revisar con uso real): la
      comparación es una igualdad de string exacta; Meta normaliza
      números argentinos de forma inconsistente (ya lo vimos en
      Bloques 4/6), así que un desfasaje de formato haría que el broker
      caiga silenciosamente en el canal `cliente` en vez de fallar
      ruidosamente.
      **Actualización (live testing del Bloque 10, 2026-07-27), corregida
      después de una primera lectura apresurada de la evidencia — ver
      abajo el detalle de qué se descartó y por qué.** Un número de
      celular argentino tiene dos representaciones válidas: el formato
      viejo/doméstico con prefijo `15` (ej. `54111155559999`) y el
      formato internacional con `9` (ej. `5491155559999`). Se probó en
      vivo mandando mensajes reales a las dos formas del mismo número:
      **Meta resuelve las dos como la misma cuenta de WhatsApp sin
      problema** (`contacts[].wa_id` en la respuesta de `POST /messages`
      devuelve el mismo `wa_id` para las dos) y, una vez que el número
      está autorizado como destinatario de prueba, los dos formatos
      entregan igual — la primera conclusión de esta sesión ("el formato
      `9` no entrega, hay que usar `15`") **era incorrecta** y quedó
      descartada con una prueba de re-envío específica. El único fallo
      real y reproducible contra la lista de destinatarios de prueba fue
      un `(#131030) Recipient phone number not in allowed list` al
      mandar a un número que directamente no estaba cargado como tester
      — un problema de autorización, no de formato.
      Aun así, el riesgo de fondo sigue en pie, con otra forma: el código
      no normaliza números de teléfono en ningún lado —
      `Lead.telefonoWhatsapp`, `BROKER_WHATSAPP_NUMBER`, `message.from`
      viajan como strings crudos, comparados/usados tal cual
      (`intentCatalog.ts` para detectar canal, `ConversationStateStore`
      que indexa por número para `broker_pausar_agente`,
      `brokerAccionDirectaExecutor.ts`, `jobs/recontact.ts`, etc.). El
      sistema no tiene forma de saber que `54111155559999` y
      `5491155559999` son la misma persona si aparecen escritos distinto
      en dos lugares (ej. `BROKER_WHATSAPP_NUMBER` en un formato y el
      `telefonoWhatsapp` de un `Lead` de Tokko en el otro) — eso puede
      hacer que el gate bulk de `broker_accion_directa` cuente 2
      contactos donde en realidad hay 1 (si Tokko tuviera el mismo
      contacto duplicado con dos formatos), o que un
      `broker_pausar_agente` puntual no encuentre la conversación correcta
      para pausar. **Sigue sin resolverse — no hay ninguna lógica de
      normalización de números en el código, esto queda documentado como
      pendiente, no como arreglado.**
- [x] `broker_resumen_agenda`: `gcal.list_events` + `tokko.get_lead`
      cruzado, arma un resumen de la agenda. Implementado en
      `agent/brokerResumenAgenda.ts`: trae los eventos de Calendar de una
      ventana de 7 días (`AGENDA_WINDOW_DAYS`, simplificación pragmática,
      no una regla de negocio del catálogo), y para cada evento busca la
      `Appointment` interna vía el nuevo `AppointmentStore.findByGcalEventId`
      para resolver el lead dueño con `tokko.get_lead`. Si un evento no
      tiene `Appointment` asociada (ej. algo cargado a mano en el
      Calendar), el resumen muestra `lead: null` en vez de inventar un
      nombre — `tokko.get_lead` ni se llama en ese caso, así el
      `toolsCalled` que se audita refleja exactamente lo que se usó.
- [x] `broker_resumen_leads`: `tokko.search_leads`, resumen de leads
      nuevos/fríos/en negociación. Implementado en
      `agent/brokerResumenLeads.ts`: un único `searchLeads({})` sin
      filtro, agrupado por `temperatura` en el propio código (no le pide
      al LLM que cuente) — los conteos son exactamente los que devolvió
      Tokko, nunca una estimación del composer.
- [x] Los dos son de un solo turno y sin escritura — el punto de entrada
      más simple al canal broker (mismo criterio de "empezar por lo más
      simple" que ya usamos en la Fase 1 con mcp-weather/consulta_disponibilidad).
- [x] Tests contra el catálogo real + mocks de Tokko/Calendar: 5 nuevos en
      `intentCatalog.test.ts` (filtrado por canal), 2 nuevos en
      `appointmentStore.test.ts` (`findByGcalEventId`), 3 nuevos en
      `brokerResumenAgenda.test.ts`, 2 nuevos en `brokerResumenLeads.test.ts`,
      y 5 nuevos en `handleIncomingMessage.test.ts` (el classifier recibe
      un catálogo sin intents `broker` cuando el mensaje es de un cliente
      y viceversa; sin `brokerWhatsappNumber` configurado todo se trata
      como canal cliente; dispatch end-to-end de los dos intents nuevos).
      El test viejo que esperaba `NotImplementedIntentError` para
      `broker_resumen_agenda` se eliminó porque ese intent ya tiene
      handler real. 209 tests en todo el monorepo.

## Bloque 9 — Canal broker: pausar el agente
- [x] `broker_pausar_agente`: pausar/reactivar respuestas automáticas —
      por conversación puntual (`ConversationState.pausedByBroker`, el
      campo ya existe desde la Fase 1 sin usar todavía) o global (flag
      nueva: `GlobalPauseStore`, mismo patrón In-Memory/File que
      `RecontactStateStore`). El catálogo lista `state.set_conversation_flag`
      / `state.set_global_flag` como "tools" del intent — no son tools MCP
      reales, son operaciones sobre nuestros propios stores, así que
      `agent/brokerPausarAgente.ts` las resuelve directo sin pasar por
      Tokko/Calendar.
      Distinguir "pausar" vs "reactivar" y "puntual" vs "global" (y el
      teléfono del cliente si el broker lo dio) necesita extraer estructura
      de lenguaje libre — nuevo `agent/pausarAgenteClassifier.ts`
      (`ClaudePausarAgenteActionClassifier`, mismo patrón de tool-use
      forzado que `ReprogramActionClassifier`). Si el broker solo da un
      nombre ("no le respondas más a Juan") sin número de teléfono, el
      agente no inventa a quién pausar — no hay una tool de búsqueda de
      leads por nombre en el catálogo de este intent, así que el handler le
      responde al broker pidiendo el número en vez de arriesgar pausar (o
      reactivar) la conversación equivocada. Documentado inline como
      limitación conocida, no como bug.
- [x] Si `pausedByBroker` es true (puntual o global),
      `handleIncomingMessage` no responde solo a ese cliente — se loguea
      en `audit_log` que se recibió el mensaje pero no se actuó, y se
      corta el flujo antes de clasificar (ahorra la llamada a Claude).
      El corte pasó a ser lo primero que hace `handleIncomingMessage`
      (antes incluso de intentar continuar un flujo multi-turno ya en
      curso, como `agendar_visita` a mitad de camino) — pausar tiene que
      silenciar al agente de una, no solo bloquear intents nuevos. Nunca
      aplica al canal `broker`: el broker tiene que poder hablar con el
      agente siempre, aunque sea para reactivarlo. Como no hay un intent
      real matcheado en este camino, el audit log usa un sentinel no
      perteneciente al catálogo (`"agente_pausado"`) en `matchedIntentId`,
      documentado inline. `HandleMessageResult.responseText` pasó a ser
      `string | null` (`null` = no hay nada que mandar); `app.ts` ahora
      chequea eso antes de llamar a `sender.sendText`.
- [x] Test: un mensaje de un cliente pausado no dispara ninguna tool ni
      respuesta, pero sí queda auditado. 16 tests nuevos (`globalPauseStore`
      5, `brokerPausarAgente` 5, `handleIncomingMessage` 6 nuevos para el
      gate de pausa + `broker_pausar_agente` end-to-end).
      `ClaudePausarAgenteActionClassifier` no tiene test directo — mismo
      criterio que `ReprogramActionClassifier`/`SlotConfirmationClassifier`,
      es un wrapper fino de Claude, se prueba indirecto vía
      `brokerPausarAgente.test.ts` con un stub de la interfaz. 225 tests en
      todo el monorepo.

## Bloque 10 — Canal broker: acción directa (el más grande, al final a propósito)
- [x] `broker_accion_directa`: orden compuesta en lenguaje libre ("mandale
      la ficha de X a Juan y ofrecele el sábado a las 11"). A diferencia
      de todo lo anterior, acá el LLM decide dinámicamente qué tools
      llamar (tool-use real de Claude sobre `tokko.get_property`,
      `tokko.search_leads`, `gcal.create_event`, `gcal.patch_event`,
      `whatsapp.send_message`, `whatsapp.send_template`), no un handler
      fijo por intent como el resto del catálogo.
      Se agregó `tokko.search_properties` a la lista de `tools` del intent
      en `docs/intent_catalog.yaml` (siguiendo CLAUDE.md secc. 7: "primero
      editá el YAML, después el código") — el broker referencia una
      propiedad por texto libre ("el depto de Palermo"), no por id, así
      que hace falta buscarla antes de poder usar `tokko.get_property`.
      **Diseño: planificar vs. ejecutar, separados a propósito.** En vez
      de darle a Claude las 4 tools de escritura/envío directo dentro de
      un mismo loop de tool-use, se separó en dos archivos:
      `agent/brokerAccionDirectaPlan.ts` (`ClaudeBrokerAccionDirectaPlanner`:
      Claude investiga con tools de solo lectura reales —
      `tokko_find_property`/`tokko_search_leads` — y termina siempre
      llamando a una tool terminal `submit_action_plan` con la lista
      estructurada de acciones + un preview para el broker) y
      `agent/brokerAccionDirectaExecutor.ts` (`executeActionPlan`: nuestro
      propio código TS ejecuta cada acción del plan contra Calendar/
      WhatsApp de verdad, best-effort por acción — mismo criterio que
      `jobs/reminders.ts`/`jobs/recontact.ts`). Esto es lo que hace posible
      el gate de confirmación bulk de abajo: interceptamos el plan ANTES
      de tocar nada, en vez de confiar en que el modelo respete una
      instrucción de "esperá mi confirmación" en medio de un loop con las
      tools de escritura ya en la mano. `gcal_create_event` también guarda
      una `Appointment` (igual que `agendarVisita.ts`) — si no, la visita
      creada por esta vía no aparecería en `broker_resumen_agenda` ni en
      los jobs de recordatorio/seguimiento.
- [x] `requires_preview_if_bulk: true` (docs/intent_catalog.yaml): si la
      orden afecta a más de un contacto, el agente responde primero con
      un preview ("esto le va a llegar a 14 contactos, ¿confirmás?") y
      espera el OK del broker antes de ejecutar — nunca una acción masiva
      directo, sin excepción.
      El conteo es de **contactos distintos** (`leadId` únicos en el
      plan), no de acciones — "mandale la ficha a Juan y ofrecele el
      sábado" son 2 acciones sobre 1 solo contacto y se ejecuta directo,
      sin pedir confirmación (`requires_client_confirmation: false` del
      catálogo es justo eso: el que confirma es el broker, no el
      cliente). El texto del preview y del resumen de ejecución se arman
      con código propio, no con el composer (aunque el catálogo declara
      `response.style: generative_grounded`) — desviación deliberada: la
      pregunta de confirmación bulk es seguridad, no redacción, y no
      queremos que una reformulación del LLM pierda el conteo exacto o la
      pregunta misma. El turno 2 (confirmación) usa un nuevo
      `agent/confirmationClassifier.ts` (sí/no simple, mismo patrón de
      tool-use forzado que el resto) enganchado en `stateMachine.ts` bajo
      el step `esperando_ok_broker` (el campo ya existía en
      `ConversationStep` desde la Fase 1, sin usar hasta ahora) — el plan
      completo viaja serializado en `ConversationState.context` del
      broker entre los dos turnos.
- [x] Es lo más parecido a una acción irreversible de alto impacto que
      construimos hasta ahora — priorizar los tests de "no ejecuta sin
      confirmación" antes que los de "ejecuta bien cuando confirma".
      `brokerAccionDirecta.test.ts` arranca justamente con el describe
      "el gate bulk nunca ejecuta sin confirmación" (verifica que ningún
      tool de escritura se llama, y que el conteo de contactos usa leads
      distintos, no acciones) antes de los tests de ejecución exitosa.
      37 tests nuevos (`brokerAccionDirectaExecutor` 9,
      `brokerAccionDirectaPlan` 6 — con un fake del cliente Anthropic para
      poder probar el loop de planificación multi-turno sin red real,
      incluyendo el caso de plan incompleto y el de turnos agotados sin
      converger —, `brokerAccionDirecta` 10, `stateMachine` +1,
      `handleIncomingMessage` +4). 255 tests en todo el monorepo
      (`ClaudeConfirmationClassifier` sumó test directo propio después,
      ver la nota de live testing más abajo — dejó de ser un wrapper
      "solo probado indirecto").
- [x] **Live testing en vivo contra credenciales reales, antes de aprobar
      el PR (2026-07-27/28)**: se armaron 2 leads de prueba en el mock de
      Tokko (números reales del usuario, verificados como testers en Meta)
      y se corrieron los 5 casos que importaban del gate bulk, simulando
      el POST del webhook localmente (mismo patrón que `app.test.ts`) pero
      con Claude, mcp-tokko y el envío por WhatsApp Cloud API reales de
      punta a punta — sin depender del camino entrante de Meta (ver nota
      aparte más abajo sobre por qué):
      1. Orden bulk (2 contactos) → preview pidiendo confirmar, **cero
         envíos a los leads**. ✅
      2. Confirmación negativa ("mejor no, dejalo por ahora") → **cero
         envíos**, plan descartado, conversación vuelve a `idle`. ✅
      3. Orden bulk otra vez, con texto distinto (para descartar que fuera
         un eco del plan anterior) → preview nuevo, **cero envíos**. ✅
      4. Confirmación positiva ("sí, dale, confirmado") → recién ahí
         **2 envíos reales**, uno a cada lead. ✅ (en el primer intento
         esto falló — ver el bug de abajo — funcionó después del fix)
      5. Orden a un solo contacto (filtro que matchea 1 solo lead) →
         **ejecuta directo, sin pedir confirmación** — confirma que el
         gate discrimina por cantidad real de contactos, no que pregunta
         siempre. ✅
      Los 5 casos se confirmaron mirando el teléfono real del usuario, no
      solo el audit_log — incluye descartar activamente que los mensajes
      le llegaran a los leads en los pasos 1-3 (nunca llegó nada) y que sí
      llegaran en 4-5 (llegó lo esperado, nada más).
      **Bug real encontrado en el camino: `ClaudeConfirmationClassifier`
      tenía `max_tokens: 32`, insuficiente — Claude se quedaba sin tokens
      a mitad del `tool_use` (`stop_reason: "max_tokens"`) antes de
      escribir `"confirmed"` en el JSON, y el `input` volvía `{}`. Como el
      código hacía `if (!confirmed)`, un `input` vacío (`confirmed:
      undefined`) caía en la rama segura de "no confirmado" — por
      casualidad, no por diseño. Con esa rama activa, ninguna
      confirmación real (probado con 4 frases distintas, todas volvieron
      `{}`) podía destrabar jamás un plan bulk.** Ningún test automatizado
      lo agarró — pega la API real de Claude, ver la nota de agujero de
      cobertura más abajo. Fix: subir `max_tokens` a 64; el classifier
      ahora detecta un `input` sin `confirmed: boolean` válido y **tira un
      error explícito** en vez de devolver un resultado ambiguo;
      `continueBrokerAccionDirecta` atrapa ese error, no toca el estado
      (el plan sigue pendiente, no se descarta), y responde "No pude
      interpretar tu respuesta, confirmame de nuevo" en vez de asumir un
      no silencioso; y el chequeo pasó de `if (!confirmed)` a
      `if (confirmed !== true)` como defensa adicional. 5 tests nuevos en
      `confirmationClassifier.test.ts` (incluye simular la respuesta
      truncada real que causó el bug) + 1 test nuevo en
      `brokerAccionDirecta.test.ts` (el classifier tira error → no
      ejecuta, no descarta el plan, pide confirmar de nuevo). 261 tests
      en todo el monorepo.
      De paso, mientras se investigaba por qué un preview no llegaba, se
      encontraron y descartaron dos hipótesis falsas antes de dar con la
      causa real (ver nota de ventana de 24hs más abajo) y una conclusión
      intermedia incorrecta sobre normalización de números de teléfono
      que se corrigió en el camino (ver nota de identidad de números más
      abajo) — quedan documentadas explícitamente como descartadas para
      que no se reintroduzcan como supuestos en el futuro.
- [x] **Resuelto en el Bloque 11 (2026-07-28) — ver esa sección para el
      detalle completo.** En su momento (2026-07-27) esto se dejó
      documentado como pendiente: el camino ENTRANTE (webhook de Meta) nunca
      se había validado contra la infraestructura real de Meta. Descubierto
      durante el review en vivo de este PR (2026-07-27): en Meta for
      Developers, la Callback URL y el Verify Token del webhook están los
      dos vacíos — nunca se configuraron. Revisando el historial del
      proyecto (`docs/TASKS.md`, commits, `.env`/`.env.example`,
      `infra/scripts/`) no aparece ningún túnel (ngrok u otro) ni
      evidencia de que Meta haya entregado alguna vez un webhook real a
      este servidor. Todo lo marcado como "validado con WhatsApp real" en
      bloques anteriores (4, 6-9) fue en realidad: (a) envíos SALIENTES
      directos contra la Graph API (`sendText`/`sendTemplate`, no
      necesitan URL pública), y/o (b) requests HTTP locales simulando el
      payload de Meta contra el webhook (como `app.test.ts`), sin que
      Meta lo haya entregado de verdad.
      Además, mientras la app siga sin publicar, Meta solo entrega
      webhooks de **prueba** disparados manualmente desde el panel de la
      app — no entrega datos de producción a nadie, ni siquiera a
      administradores o testers de la app. O sea que ni siquiera
      levantando un túnel ahora se podría validar el camino entrante tal
      como funcionaría en producción; hace falta publicar la app primero.
      La prueba en vivo del gate bulk de este mismo bloque (ver más
      arriba) se hizo a propósito **sin** depender del camino entrante:
      se simuló el POST del webhook con un request HTTP local firmado
      (mismo patrón que `app.test.ts`), dejando los envíos salientes
      reales. Eso prueba que el código del gate funciona: no prueba que
      un mensaje entrante real de un cliente por WhatsApp llegue hoy a
      este servidor.
      **Actualización Bloque 11**: se armó el túnel (port forwarding de
      VS Code, sin instalar nada) y se confirmó empíricamente — la
      afirmación de arriba sobre "mientras la app siga sin publicar, Meta
      solo entrega webhooks de prueba" era correcta: el botón "Probar" del
      panel llegó, un mensaje real desde el teléfono del usuario no
      llegó. El camino entrante está técnicamente completo y verificado;
      falta únicamente publicar la app (bloque aparte).
- [ ] **Pendiente, no resuelto: el proyecto no procesa los webhooks de
      status de Meta (`sent`/`delivered`/`read`/`failed`), así que hoy no
      hay forma de saber si un mensaje realmente le llegó a alguien —
      solo si Meta lo aceptó para encolar.** Ya estaba anotado como
      comentario en `channels/whatsapp/sender.ts` ("un 200 acá significa
      que Meta lo aceptó, no que el destinatario lo recibió").
      Se topó con un caso real durante el live testing de este bloque: el
      primer envío del preview del gate bulk devolvió `200 OK` con un
      `message_id` válido, sin ningún error — y no le llegó al
      destinatario en el momento. **Causa confirmada, no es un bug del
      gate ni del código de envío**: la ventana de servicio de 24hs
      todavía no estaba abierta con ese número (nunca le había escrito
      antes al número de prueba de Meta). Se probó reenviando el mismo
      texto exacto, por el mismo código (`GraphApiWhatsAppSender.sendText`,
      sin curl de por medio), una vez que el destinatario ya le había
      escrito al número de prueba y la ventana estaba abierta — entregó
      sin problema. El gate del Bloque 10 y el envío en sí funcionan
      correctamente; lo que falló fue la precondición de la ventana de
      servicio, no el código de este proyecto.
      **Para reproducir pruebas de envío saliente con números de Meta
      for Developers sin publicar: cada número de prueba tiene que
      escribirle primero (un simple "hola" alcanza) al número de WhatsApp
      de prueba antes de que el sistema pueda mandarle texto libre — si
      no, la Graph API responde `200 OK` con `message_id` igual, pero no
      entrega nada, sin ningún error que lo delate.**
      La limitación de fondo sigue sin resolver: aunque en este caso se
      pudo diagnosticar a mano, en producción no hay forma sistemática de
      distinguir "Meta lo aceptó y lo entregó" de "Meta lo aceptó pero no
      lo entregó" — `audit_log.responseSent` registra qué se *intentó*
      mandar, no qué se *entregó*. Implica agregar manejo del
      `field: statuses` del webhook de Meta (que hoy tampoco se recibe —
      ver el punto anterior sobre el camino entrante) y probablemente un
      estado explícito de entrega por mensaje en `AuditLogEntry` o en su
      propio store. Fuera de alcance de este bloque; queda para cuando se
      resuelva el camino entrante.
- [ ] **Agujero de cobertura estructural, no específico de este bloque: los
      255 tests del monorepo no cubren el comportamiento real de la API de
      Claude.** Todos los wrappers de Claude (`classifier.ts`,
      `composer.ts`, `draftComposer.ts`, `slotConfirmation.ts`,
      `reprogramActionClassifier.ts`, `pausarAgenteActionClassifier.ts`,
      `confirmationClassifier.ts`, `brokerAccionDirectaPlan.ts`) se testean
      siempre stubeados detrás de su interfaz — nunca contra la API real.
      Eso significa que ningún test automatizado puede agarrar cosas como:
      `max_tokens` insuficiente y la respuesta se corta a mitad de un
      tool_use, un `input` mal formado, un `stop_reason` inesperado, o
      cualquier otro comportamiento real del modelo que no sea "responde
      bien formado siempre". El bug real de `ClaudeConfirmationClassifier`
      (`max_tokens: 32` insuficiente — ver más arriba) es la prueba: pasó
      los 255 tests sin problema y lo agarró recién el live testing con
      credenciales reales, no el test suite. Mitigación parcial agregada en
      este mismo live testing: `confirmationClassifier.test.ts` y
      `brokerAccionDirectaPlan.test.ts` usan un cliente Anthropic fake que
      simula respuestas truncadas/mal formadas (mismo patrón que un mock,
      no pega la red real) — eso cubre "el código reacciona bien a una
      respuesta truncada", pero no cubre "el prompt/schema actual de cada
      classifier nunca se trunca en la práctica", que solo se puede
      verificar contra la API real. No hay todavía una rutina periódica de
      smoke test contra Claude real para todos los classifiers — quedó
      hecho ad-hoc, una vez, para este bug puntual.
- [ ] **Pendiente, no resuelto: `brokerAccionDirectaPlan.ts` manda a la
      API de Claude el `Lead[]` completo que devuelve Tokko, no solo los
      leads que terminan en el plan final.** Encontrado al armar la
      política de privacidad de la app (2026-07-29). `runReadTool`
      (tool `tokko_search_leads`, línea ~231) hace
      `return this.tokko.searchLeads({...})` directo — el resultado sin
      filtrar (nombre, teléfono, email de **todos** los leads que
      matchean el filtro de temperatura/días sin respuesta) viaja como
      `tool_result` a Anthropic. Si el broker pide "avisale a los leads
      fríos" y hay 40 que matchean pero el plan final que arma Claude
      solo termina tocando a 5 (porque el broker especificó más
      condiciones en el texto, o Claude decidió acotar), los otros 35
      leads igual mandaron su nombre/teléfono/email completos a un
      tercero (Anthropic) sin necesidad. Es sobre-exposición de datos
      personales de gente que no dio consentimiento para esa búsqueda
      puntual — no rompe nada funcionalmente, pero es exactamente el
      tipo de dato que una política de privacidad tiene que declarar con
      precisión, y un candidato claro a arreglar filtrando el resultado
      de `searchLeads` a los campos que el planner realmente necesita
      (ej. `id`, `temperatura`, `diasSinRespuesta`) antes de devolvérselo
      a Claude, agregando `nombre`/`telefonoWhatsapp` recién para los
      leads que terminan en el plan. No implementado todavía — queda
      documentado como pendiente, no como arreglado.

## Bloque 11 — Camino entrante: que Meta le pueda hablar al orchestrator
Alcance acotado a propósito (decisión del usuario, 2026-07-28): **este
bloque NO incluye publicar la app.** Publicar puede requerir verificación
del negocio en Meta y depender de tiempos de un tercero — no se abre un
bloque a esperar eso. Publicar queda como bloque aparte (ver más abajo por
qué hace falta).
- [x] Orchestrator levantado en `PORT=3000` (`.env`), corrido manualmente
      por el usuario en una terminal de VS Code (no como proceso de fondo)
      para ver los logs en vivo al llegar el webhook.
- [x] Puerto 3000 expuesto públicamente con el port forwarding nativo de
      VS Code (pestaña **Ports** → Forward a Port → 3000 → Port Visibility
      → **Public**, usando Dev Tunnels de Microsoft) — no hizo falta
      instalar ngrok ni nada externo, tal como pidió el usuario.
- [x] Callback URL pública (`<url-del-túnel>/webhook`) + el
      `WHATSAPP_WEBHOOK_VERIFY_TOKEN` ya existente en `.env` cargados en
      Meta for Developers (WhatsApp → Configuration → Webhook), campo
      `messages` suscripto. El handshake de verificación (`hub.mode` +
      `hub.verify_token`, `channels/whatsapp/signature.ts`) pasó.
- [x] **Prueba empírica concluyente (2026-07-28), reemplaza la duda que
      había quedado abierta en el Bloque 10 — esto ya NO es hipótesis,
      es un hecho confirmado con dos resultados contrastados a
      propósito:**
      - El botón **"Probar"** del panel de Meta (webhook de prueba,
        disparado manualmente desde el dashboard) **sí llegó**: log
        completo en la terminal, pasó por escalamiento, y notificó al
        broker por WhatsApp real.
      - Un **mensaje real** ("hola", mandado desde el teléfono real del
        usuario, número ya cargado como tester) **no llegó**: cero líneas
        nuevas en la terminal, el agente nunca se enteró.
      **Conclusión confirmada**: con la app en modo Desarrollo (sin
      publicar), Meta entrega webhooks de prueba disparados desde el
      panel, pero NO entrega webhooks de mensajes reales de producción —
      ni siquiera de un número ya cargado como tester de la propia app.
      Esto corrige la nota de duda que quedó en el Bloque 10 ("no se
      verificó ni contra la documentación ni empíricamente" — ya está
      verificado, la afirmación original del dashboard de Meta era
      correcta para el campo `messages` específicamente, no solo para
      Graph API en general).
- [x] **El camino entrante está técnicamente completo y verificado**:
      código, verify token, firma HMAC, túnel, suscripción del webhook —
      todo funciona correctamente contra un webhook real de Meta.
- [x] **Corrección (2026-07-29, Bloque 12): la hipótesis de que "lo único
      que falta es publicar la app" era incorrecta — quedó descartada con
      una prueba directa, no era solo una suposición sin probar.** Se
      publicó la app (modo Live, sin acciones pendientes en el panel) y el
      mensaje real ("hola" desde un número ya autorizado como tester)
      **igual no llegó** — cero líneas en la terminal, con el túnel
      confirmado sano (`/health` respondiendo desde internet) y esperando
      20+ minutos por si había demora de propagación. Publicar la app NO
      alcanzó. La causa real y el resto de la investigación quedan en el
      Bloque 12.

## Bloque 12 — Publicar la app: investigación (no alcanzó por sí sola)
- [x] App pasada a modo Live en Meta for Developers ("Publicada", sin
      acciones pendientes en el panel).
- [x] **Prueba empírica: publicar NO destrabó la entrega de webhooks de
      producción.** Estado verificado en el momento de la prueba:
      - App en Live, sin acciones requeridas.
      - Túnel sano: `/health` responde `{"ok":true}` desde internet.
      - Callback URL correcta y verificada, campo `messages` suscripto.
      - El botón "Probar" del panel sigue llegando (procesa, clasifica,
        escala, notifica al broker) — igual que en el Bloque 11.
      - Un "hola" real desde un número ya autorizado como tester
        (`972555559999`) **no llegó** — cero líneas en la terminal,
        esperando 20+ minutos por posible demora de propagación. El
        mensaje salió de WhatsApp con doble tilde (entregado a Meta), pero
        nunca se vio en el orchestrator.
- [x] **Investigación: ¿qué más puede bloquear la entrega, aparte del modo
      Dev/Live de la app?** Foco en si el número de prueba gratuito de
      Meta (el `+1 555...`) tiene una limitación propia para RECIBIR,
      independiente de si la app está publicada.
      **Encontrado, con una fuente directa (no es la documentación oficial
      de Meta, que sigue sin ser explícita en este punto puntual — ver
      nota de fuente más abajo): el número de prueba gratuito de Meta es
      de solo salida.** Un cliente real no puede mandarle un mensaje al
      número de prueba y que dispare el webhook — la lista de "números de
      prueba/destinatarios autorizados" habilita que VOS le mandes a esos
      números (saliente), no que ellos te escriban a vos y llegue
      (entrante). Esto explica el patrón completo que se observó: el botón
      "Probar" del panel es un evento sintético inyectado del lado de
      Meta (nunca pasa por la restricción de mensajería real), mientras
      que un mensaje real de un cliente sí queda sujeto a esa limitación,
      publicada la app o no.
      **Nota de fuente**: la documentación oficial de Meta for Developers
      sigue sin decir esto de forma explícita (mismo problema que ya se
      documentó en el Bloque 10/11 — la doc oficial es vaga en varios
      puntos de comportamiento de números de prueba). El hallazgo sale de
      un artículo de soporte de un tercero (WANotifier), no de Meta
      directamente — coincide exactamente con el patrón observado en las
      dos pruebas empíricas (Bloque 11 y este bloque), así que la
      evidencia empírica propia es lo que más pesa acá, no la fuente en sí.
- [ ] **Pendiente, decisión del usuario: registrar un número propio.**
      Resumen de qué implica (investigado, no ejecutado todavía):
      - **Requisitos**: un número de teléfono real que NO esté activo hoy
        en la app de WhatsApp/WhatsApp Business normal (hay que borrar esa
        cuenta primero, salvo que se use la función "Coexistence" de Meta,
        que permite mantener el número en la app normal y conectarlo
        también al Cloud API). Se agrega en WhatsApp Manager, se verifica
        por SMS/llamada, y se registra con una llamada a la API.
      - **Verificación del negocio**: NO es obligatoria para poder recibir
        mensajes — sin verificar, igual se pueden responder conversaciones
        iniciadas por el cliente sin límite; lo que la verificación
        destraba es superar el límite de 250 conversaciones iniciadas por
        el negocio cada 24hs (mismo límite que ya se vio con el número de
        prueba en el Bloque 10) y beneficios como la cuenta oficial
        verificada.
      - **Costos**: Meta no cobra por alojar/usar el número en la Cloud
        API en sí. Se cobra por conversación una vez que se supera el
        nivel gratuito, según categoría (marketing, utilidad,
        autenticación, servicio) — las de servicio/iniciadas por el
        cliente suelen ser gratis o muy baratas; las iniciadas por el
        negocio (marketing/utilidad) tienen costo por conversación,
        variable según país.
      - **Tiempos**: registrar el número en sí, de minutos a un día. La
        guía oficial dice 1-5 días hábiles para verificación del negocio
        si los documentos están correctos — pero ya se documentó en el
        Bloque 10/11 que hay casos reales reportados de semanas o meses
        de demora en la cola de revisión de Meta. Como no hace falta
        verificación para recibir mensajes (ver arriba), esto no debería
        ser bloqueante para probar el camino entrante — sí lo sería para
        escalar en volumen real más adelante.
      No se arrancó todavía — queda para cuando el usuario decida seguir.

## Bloque 13 — Escaneo de datos sensibles antes de cada commit
Motivado por un incidente real, no preventivo en abstracto: números de
teléfono reales del usuario llegaron a `main` dos veces (docs/TASKS.md,
Bloques 10 y 12) durante sesiones de live testing, porque el escaneo de
privacidad se hizo a mano, después del hecho, y una vez se hizo sobre la
rama equivocada (no agarró contenido ya mergeado por un PR distinto). Se
decidió explícitamente **no** reescribir el historial de `main` para sacar
los números viejos — el riesgo/complejidad de reescribir una rama
protegida y compartida (force-push, ramas huérfanas, caché de GitHub en
PRs ya mergeados) supera lo que resuelve, dado que un teléfono no es una
credencial explotable. El número israelí que había quedado expuesto se redactó del
`main` actual con el mismo tratamiento que el argentino en el Bloque 10
(placeholder con corrida de dígitos repetidos, mismo punto técnico).
- [x] `scripts/check-sensitive-data.mjs` — escanea el contenido real
      (staged, vía `git show :archivo`) buscando tokens con forma de
      credencial (Meta/Graph API, Anthropic, headers `Bearer`), URLs de
      túnel (Dev Tunnels, ngrok, Cloudflare Tunnel), y números de
      teléfono (Argentina/Israel) fuera de archivos de test/mock (esos
      quedan exentos a propósito — usan números ficticios en todos
      lados). Un número con una corrida de 4+ dígitos repetidos se trata
      como placeholder a propósito, no se bloquea — es la convención que
      ya usa el proyecto (`...5559999`).
- [x] `.githooks/pre-commit` (versionado en el repo) corre ese script
      antes de cada commit y lo bloquea si encuentra algo.
      `scripts/setup-git-hooks.mjs` corre solo en cada `npm install`
      (script `prepare` del `package.json` raíz) y apunta git a
      `.githooks/` vía `core.hooksPath` — mismo mecanismo nativo que usan
      herramientas como husky por debajo, sin agregar una dependencia
      nueva para algo así de chico. Un colaborador nuevo lo tiene activo
      desde su primer `npm install`, sin configurar nada a mano.
- [x] `npm run check:sensitive-data` (lo que está staged) y
      `npm run check:sensitive-data -- --all` (todo el árbol de trabajo
      actual — se usó para auditar el repo entero antes de este commit:
      163 archivos trackeados, sin coincidencias) para correrlo a mano.
- [x] Documentado en `CONTRIBUTING.md`, sección dedicada: qué bloquea, por
      qué existe, cómo se instala solo, y que `git commit --no-verify`
      sigue siendo el escape para un falso positivo real — no se inventó
      un mecanismo de bypass propio.
- [x] Probado en vivo antes de commitear este bloque: un commit con un
      token falso con forma de credencial y un teléfono con forma real
      fue bloqueado correctamente (y no se creó el commit); un commit con
      un número con corrida de dígitos repetidos pasó limpio.

## Bloque 14 — Fechas que se pudren solas en la suite de tests
Motivado por un fallo real, encontrado de casualidad al cerrar el Bloque 13:
2 tests de `appointmentStore.test.ts` estaban en rojo **sin que nadie tocara
nada** — el fixture `appt-cerca: 2026-08-01` había quedado en el pasado y ya
no era "la visita más próxima en el futuro". Confirmado con `git stash` que
fallaba igual en `main` limpio.

**Primer bloque que usa el pre-mortem de `CLAUDE.md` secc. 7**, y valió la
pena: de los 3 modos de fallo planteados, el #2 cambió el enfoque antes de
escribir una línea. La instrucción original era "que las fechas se calculen
relativas a hoy en vez de estar escritas fijas"; aplicada al pie de la letra
habría **roto tests que hoy andan**. `slotProposal.test.ts` pasa la fecha
como *input* (`proposeAvailableSlots(gcal, "2026-08-05T00:00:00Z")`) y por
eso es determinístico: hacerla relativa rompía el assert de formato en
español y volvía no determinístico el de "propone hasta 3 horarios". La
regla correcta quedó: **relativas solo donde se comparan contra el reloj
real; fijas donde son input determinístico.**

- [x] **Reloj inyectable en `AppointmentStore`** (mitigación del modo de
      fallo #3, decidida con el usuario en vez de asumida): `pickActive`
      leía `new Date()` directo y no había forma de testear su
      comportamiento en el tiempo. Ahora ambas implementaciones aceptan un
      `Clock` opcional (`() => Date`, default el reloj del sistema) — mismo
      patrón que ya usaban `jobs/reminders.ts`, `jobs/recontact.ts` y
      `jobs/seguimientoPostVisita.ts`. Con el reloj fijado en el test, las
      fechas fijas vuelven a ser correctas **y** determinísticas, que es
      mejor que relativas: no dependen de cuándo corra la suite.
- [x] **Bug real de producción encontrado de paso** (el modo de fallo #1
      era justamente "cambio el fixture y tapo un bug"): `pickActive`
      comparaba y ordenaba los `fechaHora` como **strings**. `Appointment.
      fechaHora` es ISO pero no siempre UTC — el proyecto mezcla slots en
      `Z` con datos en offset local — y comparar lexicográficamente ISO con
      offsets distintos da resultados incorrectos. Una cita
      `2026-08-21T01:00+03:00` (instante 22:00Z) ordena *después* de una
      `2026-08-20T23:00Z` por string, pero es *anterior* en el tiempo. Se
      pasó a comparar instantes (`new Date(...).getTime()`).
      Tiene test de regresión, y **se verificó que el test distingue de
      verdad**: el primer intento usaba una sola cita y pasaba con las dos
      implementaciones (el fallback `?? active[last]` devolvía lo mismo) —
      un test verde que no probaba nada, exactamente el modo de fallo del
      catálogo. Se rehizo con dos citas y se comprobó ejecutando ambas
      implementaciones sobre el mismo fixture: la vieja devuelve
      `appt-utc`, la nueva `appt-offset`.
- [x] **Auditoría empírica del resto de la suite, en vez de inferirla
      leyendo**: se levantó un harness descartable que adelanta `Date`
      (sin tocar `setTimeout`/`setInterval`, para no romper los tests que
      levantan subprocesos MCP reales) y se corrió la suite a distintos
      horizontes. Resultado: con el reloj a 30, 200, 400 y 1200 días
      adelante todo seguía en verde; **a ~1600 días (≈2030-12) aparecía 1
      fallo**: `agendarVisita.test.ts > "escala si no hay ningún horario
      libre"` usaba un rango de ocupación fijo `2020-01-01 → 2030-01-01`
      para simular "agenda llena", que deja de cubrir la ventana de
      propuesta una vez que el reloj pasa 2030 — el test se habría vuelto
      verde por la razón equivocada (aparecen horarios libres, ya no
      escala). Se pasó a un rango relativo a "ahora" (este sí corresponde
      que sea relativo: su semántica es "ocupado durante toda la ventana").
      Reverificado después del fix: 203/203 a 0, 1600, 5000 y 20000 días
      (año 2081).
- [x] Suite completa: **263 tests en verde** en todo el monorepo (antes:
      261 con 2 en rojo). Los 2 nuevos son el test de regresión del offset,
      que corre para las dos implementaciones del store.
- [x] **Qué pregunta lo habría agarrado antes** (cláusula de obituario de
      `CLAUDE.md` secc. 7): *"¿qué se rompe solo, sin que nadie toque
      nada?"* — no se hizo nunca hasta que un test ya estaba en rojo. Es
      el modo de fallo que ya está en el catálogo semilla de `CLAUDE.md`;
      este bloque es el que lo puso ahí con evidencia. Complemento
      aprendido acá: cuando un test empieza a fallar solo, la pregunta
      siguiente no es "¿cómo lo hago pasar?" sino **"¿el fixture envejeció
      o el código está mal?"** — en este bloque la respuesta fue "el
      fixture" para el test que fallaba, pero mirar el código igual
      destapó un bug real de producción que nadie estaba buscando.

## Bloque 15 — Retención de datos según la política publicada
Motivado por una brecha real y ya documentada (ver `docs/ONBOARDING.md`): la
política de privacidad **ya publicada** promete 12 meses para mensajes y
logs, y datos de gestión comercial "mientras dure la relación comercial" —
y ningún store borraba nada, nunca. Era una promesa pública incumplida, no
una deuda técnica futura.

**El pre-mortem encontró cuatro bloqueantes antes de escribir código**, tres
de los cuales hacían la política literalmente no implementable:
- `RecontactState` no tenía **ningún** campo de fecha (solo `leadId` y
  `attemptsSent`): imposible saber si un registro tenía 3 días o 3 años.
- `Appointment` no tiene fecha de creación, solo `fechaHora` (la de la visita).
- **"Mientras dure la relación comercial" no tiene señal técnica**: no existe
  `Lead.estado = cerrado` ni equivalente. Resuelto con el dueño del repo →
  operacionalizado como **24 meses desde la última interacción del lead**
  (elegido para no perder al lead que consulta, desaparece un año y vuelve,
  que en inmobiliaria es común).
- Tensión con la regla "auditoría desde el día 1, no es opcional" de
  `CLAUDE.md` secc. 3 — aclarada ahí mismo, explicando que la regla se
  escribió antes de que existiera la política y que el purge la cumple, no
  la contradice.

**Circularidad detectada por el dueño del repo, no por el pre-mortem**: si el
`audit_log` se purga a los 12 meses, después no se puede calcular la última
interacción de alguien que interactuó hace 18. Se evaluaron las dos salidas
posibles y **una no funcionaba**: "calcular los cortes antes de purgar"
alcanza dentro de una corrida pero se rompe entre corridas — a partir del mes
13 el audit ya no distingue "nunca interactuó" de "interactuó antes de lo que
recuerdo", y las visitas no se purgarían jamás.
- [x] **`LastInteractionStore`** (`agent/lastInteractionStore.ts`): guarda la
      última interacción como dato propio, desacoplando los dos plazos. Se
      actualiza en `handleIncomingMessage` con cada mensaje entrante de
      cliente (no del broker — no es un lead), **antes** del gate de pausa:
      que el broker haya pausado el agente no significa que el cliente dejó
      de estar activo.
- [x] **Respaldo para el backfill**: al desplegar, ese store arranca vacío y
      ningún lead preexistente tendría fecha. `ultimaInteraccionEfectiva`
      toma el **máximo** de tres señales — interacción registrada, última
      visita (`AppointmentStore.ultimaVisitaPorLead`) y última actividad de
      recontacto — así que funciona desde la primera corrida.
- [x] `purgeOlderThan` / `purgeLeads` en los 5 stores (In-Memory + File), con
      `jobs/retention.ts` como **coordinador único**: purgar un store y dejar
      el mismo teléfono vivo en otro daría apariencia de cumplimiento sin
      cumplir (modo de fallo #2 del pre-mortem). Hay un test que verifica que
      tras el purge el teléfono no queda en **ninguno** de los cinco.
- [x] **Arranca sin borrar** (modo de fallo #1: irreversible y sin backup).
      `RETENTION_BORRADO_HABILITADO=false` por default: reporta qué borraría
      y no borra. El reporte se **persiste** (`retention_reports.jsonl`, las
      últimas 12 corridas) para poder comparar semana contra semana, e
      incluye una **muestra de qué registros caerían** con la fecha que
      motivó cada decisión — no solo el conteo.
- [x] **El reporte no lleva contenido de mensajes ni teléfonos sin
      enmascarar**, con test que lo verifica. Se persiste para comparar
      corridas, así que si llevara contenido sería un archivo con exactamente
      los datos personales que este bloque existe para borrar — empeorando
      el problema en vez de resolverlo.
- [x] El purge del `audit_log` reescribe un JSONL append-only: se escribe a
      temporal y se renombra (rename atómico), para que un corte a mitad no
      deje el log truncado.
- [x] **Bug encontrado por un test propio**: el primer diseño purgaba
      recontactos por la antigüedad *del registro*, lo que pisaba la regla
      por lead — un lead que volvía hacía 1 mes perdía su recontacto viejo,
      exactamente el caso que el dueño del repo quería evitar. Corregido
      moviendo esa fecha al cálculo del coordinador como una señal más (se
      toma el máximo), así una señal vieja nunca acorta la retención de un
      lead activo.
- [x] 275 tests en verde en el monorepo (antes 263).
- [ ] **Pendiente: habilitar el borrado real.** Hoy corre en simulacro. Hay
      que revisar varias corridas de `retention_reports.jsonl` y recién
      entonces poner `RETENTION_BORRADO_HABILITADO=true`. **Hasta que eso
      pase, la política sigue incumplida** — el código está listo pero no
      borra.
- [x] **Qué pregunta lo habría agarrado antes**: *"¿lo que promete la
      política publicada existe en el código?"* Nadie la hizo hasta que el
      dueño del repo la trajo. El agujero no era técnico: el proyecto
      documentó la brecha en `ONBOARDING.md` (con riesgo "alto") y la dejó
      escrita durante bloques sin actuar. Aprendizaje para el catálogo:
      **documentar un riesgo no lo mitiga** — una brecha con impacto legal o
      público merece un bloque, no una línea en un documento.

## Bloque 16 — Sobre-exposición de datos personales al planificador
Segunda vez seguida del mismo patrón que motivó el Bloque 15: estaba
documentado como riesgo medio-alto en `docs/ONBOARDING.md` desde varios
bloques atrás y no se había actuado. **Documentar un riesgo no lo mitiga.**

**El problema**: `brokerAccionDirectaPlan.ts` mandaba a la API de Claude el
`Lead` completo de **cada** coincidencia — nombre, teléfono y email de todos
los que matchearan el filtro, no solo de los que terminaban en el plan. Si
el broker pedía "avisale a los leads fríos" y matcheaban 40 pero el plan
final tocaba 5, los otros 35 mandaban igual sus datos personales a un
tercero sin ninguna necesidad.

**Análisis campo por campo, contra lo que las acciones realmente consumen**
(hecho antes de tocar código, a pedido del dueño del repo):
- `id`, `temperatura`, `diasSinRespuesta`, `propiedadesDeInteres` →
  **necesarios** para filtrar y para identificar a quién apunta cada acción.
- `telefonoWhatsapp` → **no**: lo resuelve el executor a partir del `id`.
- `email`, `tokkoId`, `ultimaInteraccion` → **no los usa ninguna acción**.
- `nombre` → el único con tensión real (ver abajo).
- [x] **Proyección única**: todo lo que sale hacia Claude pasa por
      `proyectar()`, que devuelve solo `{id, temperatura, diasSinRespuesta,
      propiedadesDeInteres}`. El filtrado vive en un solo punto en vez de
      repartido por los callers.
- [x] **Split del tool de leads en dos**, para que el camino masivo —donde
      vive el volumen del daño— tenga exposición de identidad cero:
      `tokko_search_leads` (criterios, sin nombres) y
      `tokko_buscar_lead_por_nombre` (cuando el broker nombra a alguien).
- [x] **El tool de nombres nunca devuelve el nombre.** Cambio de diseño que
      salió de una pregunta del dueño del repo: *"¿puede Claude evadir el
      split llamando al tool de nombres en loop para reconstruir la base?"*.
      Con la versión original (`{id, nombre}`) sí podía — y peor, el loop de
      planificación soporta **tool-use en paralelo**, así que un solo turno
      admite decenas de llamadas; limitar la tasa habría sido tapar el
      agujero con cinta. La versión final cierra el agujero
      **estructuralmente**: el nombre viaja *hacia* la búsqueda (lo escribió
      el broker, ya estaba en el contexto) y **nunca vuelve**. Llamar en
      loop con todas las letras devuelve lo mismo que `tokko_search_leads`
      ya da de forma legítima: no hay nada extra que extraer. **La base de
      leads no le manda un solo nombre a Anthropic.**
- [x] **`phone` fuera del schema de la acción** (modo de fallo #1 del
      pre-mortem): filtrar solo la lectura no alcanzaba. Si el schema seguía
      pidiendo un teléfono que Claude ya no tiene, lo habría alucinado o
      tomado del texto del broker. El executor lo resuelve del `leadId` con
      `tokko.getLead`, y si el lead no existe la acción **falla ruidosamente**
      en vez de mandarle a un destinatario equivocado.
- [x] **Personalización por placeholder**: Claude escribe `{nombre}` y el
      executor lo sustituye al enviar, con el dato real de Tokko. Consistente
      con cómo el proyecto ya maneja plantillas (`{direccion_corta}`).
- [x] Tests: ninguno de los datos personales del fixture aparece en lo que
      viajó a la API (se serializa `create.mock.calls` completo y se verifica
      contra una lista de valores prohibidos), **incluido el caso del loop de
      evasión con llamadas en paralelo**, y que un nombre vacío no funcione
      como comodín. Más los del executor: resolución del teléfono,
      sustitución del placeholder, y fallo limpio si el lead no existe.
      282 tests en verde en el monorepo (antes 275).
- [x] **Alcance honesto**: esto **no** lleva la exposición a cero. Los
      nombres que el broker escribe en su orden siguen estando en el contexto
      de Claude, y el texto del mensaje que redacta puede contener datos. Lo
      que elimina es la exposición *innecesaria* — la de las 35 personas que
      no tenían nada que ver con el plan final.
- [x] **Qué pregunta lo habría agarrado antes**: *"¿qué de esto que le mando
      al modelo necesita realmente para la tarea?"* — nadie la hizo al
      construir el Bloque 10; se mandó el objeto entero porque era lo que
      devolvía la función. Para el catálogo: **cuando se le pasa un objeto de
      dominio a un tercero, el default correcto es proyectar los campos
      necesarios, no pasar el objeto y confiar en que no importa.**

## Bloque 17 — `leadId` inconsistente entre el flujo del cliente y el del broker
Encontrado investigando el Bloque 16, **no relacionado con la
sobre-exposición de datos** — se deja aparte a pedido del dueño del repo,
porque toca reprogramación del cliente y el barrido de retención (dos áreas
ya mergeadas) y mezclarlo haría imposible saber cuál cambio causó qué si
algo falla.
- [ ] **El bug**: en el flujo del cliente, `Appointment.leadId` es el
      **teléfono** (`leadId: message.from` en `agendarVisita.ts` y
      `reprogramarCancelarVisita.ts`). Pero `broker_accion_directa` guarda
      `leadId: action.leadId`, que sale de Tokko y es un id opaco
      (`"lead-1"`). Conviven dos formatos distintos en el mismo campo del
      mismo store.
- [ ] **Consecuencia concreta**: el broker agenda una visita para un cliente
      con una orden directa; el cliente después escribe "quiero
      reprogramar"; `findActiveByLead(message.from)` busca por teléfono, no
      encuentra la cita guardada con el id de Tokko, y el agente le responde
      **"no te veo ninguna visita agendada"**. La visita existe en Calendar
      pero el cliente no puede tocarla.
- [ ] **Segunda consecuencia, agregada por el Bloque 15**: el purgado por
      retención cruza los stores por `leadId` para verificar que un lead
      vencido no deje rastro en ninguno. Con dos formatos conviviendo, ese
      barrido no es parejo — un mismo cliente puede quedar purgado en un
      store y vivo en otro, que es justo el modo de fallo que ese bloque
      quiso evitar.
- [ ] Al arrancarlo: **hacer su propio pre-mortem**. Toca código ya mergeado
      y en uso, así que el riesgo no es solo implementarlo mal sino migrar
      mal los datos que ya están en disco con el formato viejo.

## Riesgo abierto — flag que apaga la validación de firma del webhook
**Estado: abierto. No es un bloque terminado, es deuda con fecha de
vencimiento.** Agregado el 2026-08-11 para poder probar contra un proveedor
que reenvía los webhooks de Meta desde su propia infraestructura, y por lo
tanto no puede firmarlos con el App Secret de la app.

- [x] `WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK` (default apagado). En `"true"`,
      `/webhook` acepta cualquier POST sin verificar la firma HMAC.
      Comparación exacta contra el string `"true"`: `"1"`, `"yes"` o `"TRUE"`
      dejan la validación **prendida**, para que un typo en `.env` no abra el
      endpoint (`config.test.ts`).
- [x] Aviso ruidoso al arrancar cuando está prendido, y **además un warning
      por cada request aceptado sin verificar**. Lo segundo no estaba pedido
      pero sale del pre-mortem: el aviso del arranque queda enterrado a las
      horas de proceso corriendo, y es justo cuando la ventana insegura se
      vuelve invisible.
- [x] De paso, se cerró un agujero de diagnóstico que ya existía: el rechazo
      por firma inválida era un **401 mudo**, sin una sola línea de log. Un
      reenvío fallido del proveedor no habría dejado ningún rastro del lado
      nuestro. Ahora cada POST rechazado loguea el motivo, distinguiendo
      `firma_ausente` de `firma_invalida`. Nunca se loguea el body (trae
      teléfonos y el texto del mensaje) — hay un test que lo verifica.

### Lo que hay que hacer para cerrarlo
- [ ] **Reemplazarlo por un secreto compartido con el proveedor** antes de
      operar en serio: que el reenvío llegue con una cabecera propia que el
      orchestrator valide, en vez de no validar nada. El flag es una
      escotilla para una prueba puntual, no un modo de operación.
- [ ] **Apagar el flag apenas termine la prueba.** Mientras esté prendido y
      el túnel expuesto, cualquiera que conozca la URL puede inyectar un
      webhook falso: el agente lo procesa, responde por WhatsApp a un número
      que elige el atacante, agenda visitas y contacta leads. El endpoint no
      tiene forma de distinguir eso de un mensaje real.

### Hallazgo lateral: apagar el flag no alcanza por sí solo
`app.ts` sólo validaba la firma `if (deps.whatsappAppSecret)` — con
`WHATSAPP_APP_SECRET` vacío, el webhook **ya aceptaba cualquier cosa, en
silencio y sin ningún flag**. El comportamiento no se cambió (hacerlo
rechazar era ampliar el alcance del pedido y podía romper entornos que hoy
levantan sin secreto), pero ahora avisa: al arrancar y en cada request, con
motivo `sin_secreto_configurado`. Además `WHATSAPP_APP_SECRET` faltaba en
`.env.example` pese a estar en uso — o sea que alguien copiando el ejemplo
levantaba el proyecto con la firma desactivada sin enterarse nunca.

### Pregunta que lo habría agarrado antes
*"¿Cuántas formas distintas hay de terminar sin validación de firma, y cuál
de ellas es silenciosa?"* — había dos, y la que no requería ningún flag era
la muda. Un pre-mortem enfocado sólo en el flag nuevo se la habría perdido:
la pregunta útil no era "¿qué puede salir mal con esto que estoy agregando?"
sino "¿qué otros caminos llegan al mismo estado inseguro?".

## Bloque 18 — `/webhook` responde 200 primero y procesa en background
El proveedor que reenvía los webhooks de Meta corta a los 3 segundos.
`/webhook` procesaba todo antes de responder, y **sólo la clasificación con
Claude tarda 1686-2241 ms** (medido contra la API real, tres mensajes), más
la llamada MCP, la redacción con una segunda llamada a Claude, y el envío por
Graph API. No entraba. Peor: al vencer el timeout el proveedor podía
reintentar mientras seguíamos procesando el original, así que el cliente
podía recibir la misma respuesta dos o tres veces.

- [x] El `200 { received: true }` sale antes de procesar. El 401 por firma y
      el 400 por JSON inválido siguen adelante del ACK: sólo se difiere el
      procesamiento del mensaje.
- [x] **Cola serializada por conversación desde el arranque**
      (`backgroundQueue.ts`), no como mejora posterior. Es el único modo de
      fallo *nuevo* que introduce el cambio: mientras el procesamiento era
      sincrónico, el reenviador esperaba la respuesta y eso serializaba las
      conversaciones **de casualidad**. Al contestar al toque esa protección
      se pierde, y los stores JSON (leer-entero → mutar → escribir-entero, sin
      lock) se pisan entre dos mensajes seguidos del mismo cliente. Ahora dos
      mensajes del mismo teléfono corren uno después del otro; teléfonos
      distintos siguen en paralelo.
- [x] **Contención de errores en tres anillos**: la tarea encolada tiene su
      `.catch` dentro de la cadena (así una tarea que falla no arrastra a la
      siguiente de la misma conversación), el reporte de error está a su vez
      envuelto por si el propio `onError` explota, y `server.ts` registra un
      `process.on("unhandledRejection")` que loguea en vez de dejar morir el
      proceso. Con el ACK adelantado ya no hay nadie esperando esas promesas,
      y Node 24 termina el proceso ante un rechazo sin manejar.
- [x] **Watchdog por tarea** (60 s por default). Sin él, una llamada HTTP
      colgada dejaba la cadena de ese teléfono bloqueada **para siempre**: ese
      cliente no recibiría respuesta nunca más y, como ya devolvimos 200,
      nadie reintenta. Falla en silencio y sólo para una persona. El watchdog
      no cancela el trabajo colgado (no se puede desde acá), libera la cadena
      — o sea que en ese caso patológico puede haber dos tareas de la misma
      conversación solapadas. Intercambio deliberado y anotado en el código.
- [x] **Tests que esperan de verdad el trabajo en vuelo**: `queue.idle()`, en
      loop hasta que no quede nada pendiente (un `idle()` que espera sólo las
      cadenas existentes al entrar resuelve antes de tiempo si una tarea
      encola más trabajo, y los tests que lo usen pasan en verde sin haber
      esperado nada). En `app.test.ts` el fetch está encapsulado en un helper
      `postWebhook()` que ya incluye el `idle()`, para que un test nuevo no
      pueda olvidárselo.
- [x] **Los tests se verificaron por mutación**, no sólo por estar en verde:
      quitando el encadenado de la cola, el test de serialización falla con
      `expected [ 'a', 'b' ] to deeply equal [ 'a' ]`; volviendo a esperar el
      procesamiento antes de responder, los tres tests de ACK y orden se
      cuelgan. Sin este paso no había forma de saber si probaban algo.

### Riesgos abiertos que este bloque NO resuelve
- [ ] **Cola durable.** Con el ACK adelantado, si el proceso muere mientras
      procesa, el mensaje se pierde **en silencio**: ya dijimos "recibido" y
      nadie reintenta. Antes, la caída dejaba al reenviador sin respuesta y
      había reintento. La solución de verdad es una cola persistida —
      **Redis ya está previsto para fase 2 en `CLAUDE.md` secc. 3 y en
      `docker-compose.yml`**, así que no hay que introducir infraestructura
      nueva, sólo usar la que ya está decidida.
- [ ] **Drain del shutdown.** `server.ts` hace `httpServer.close()` y
      `process.exit(0)` directo: un Ctrl-C descarta lo que esté en vuelo.
      `BackgroundQueue.idle()` ya existe y es lo único que hace falta (con un
      techo de tiempo, para no colgar el apagado). Se deja afuera a pedido
      del dueño del repo, para no mezclar dos cambios del mismo camino.
- [x] **Deduplicación por `id` de mensaje de Meta.** Resuelto en el Bloque 19,
      pero **no por el motivo que se había supuesto** — ver ahí.

### Pregunta que lo habría agarrado antes
*"¿Cuánto tarda realmente este camino, medido, y cuánto tiempo me da quien
me llama?"* — el presupuesto del proveedor (3 s) y el costo real del camino
(dos llamadas a Claude en serie) nunca se habían puesto uno al lado del otro.
La clasificación sola se comía hasta el 75% del presupuesto y eso no se supo
hasta medirlo; el diseño sincrónico venía de cuando el único cliente era el
panel de pruebas de Meta, que no tiene ese límite.

## Bloque 19 — Deduplicación de mensajes por `id` de Meta
Depende del Bloque 18 (engancha justo antes del encolado); mergear después.

### La causa real, que no era la que se había supuesto
Al cerrar el Bloque 18 se dio por hecho que el ACK rápido eliminaba los
duplicados de raíz, porque la fuente supuesta era el timeout de 3 s del
proveedor. **Era falso.** El proveedor confirmó:

- Ellos **no reintentan**: un solo POST por evento, a propósito.
- Su forward está enganchado **al principio de su webhook, antes de que su
  propio CRM procese**. Si el CRM devuelve un no-200, **Meta** reintenta el
  POST aguas arriba y el forward se dispara de nuevo con el mismo message id.
- Midieron **1,83 POST de Meta por evento** durante un bug.

O sea que la fuente de duplicados está aguas arriba del proveedor y **nuestra
latencia no interviene en esa cadena**. El ACK rápido eliminó los duplicados
que causaba *nuestro* timeout, que resultaron no existir; estos son de otra
fuente y hay que filtrarlos nosotros.

- [x] `LruMessageDeduplicator` (`messageDedup.ts`), consultado en `/webhook`
      **después** de responder 200 y **antes** de encolar. A un duplicado
      también se le contesta 200: un no-200 haría que Meta reintente todavía
      más, que es lo contrario de lo que se busca.
- [x] **Se marca al recibir, no al terminar.** El reintento de Meta puede
      llegar mientras todavía se está procesando el original, así que marcar
      al final no filtraría nada.
- [x] **`registrarSiEsNuevo()` es sincrónico**, no `async`. Chequear y marcar
      tienen que ser una sola operación: partido en dos `await`, dos reintentos
      simultáneos pasan los dos el chequeo antes de que ninguno marque, y el
      filtro no filtra justo en el caso para el que existe. Cubierto con 8
      POSTs idénticos en paralelo contra el webhook real.
- [x] **Ante la duda, se procesa.** Los dos errores posibles no son
      simétricos: un duplicado de más le manda al cliente una respuesta
      repetida (molesto y visible), un falso positivo lo deja sin respuesta
      para siempre y del lado nuestro no se nota nada. Por eso un `id` vacío o
      en blanco nunca se descarta, y un fallo del callback de logueo no puede
      hacer perder el mensaje.
- [x] Techo LRU de 10.000 ids con desalojo del más viejo; un duplicado
      **refresca** la posición, así que una tanda de reintentos mantiene vivo
      su id en vez de dejarlo envejecer hacia el desalojo. Aviso (una sola vez)
      cuando el registro llega al techo: si pasa seguido, la capacidad quedó
      corta y se están dejando pasar duplicados.
- [x] Contador acumulado + log por descarte, con el `wamid` (no es dato
      personal: no es el teléfono ni el texto) para poder cruzar con los logs
      del proveedor cuando el número empiece a subir.
- [x] Los fixtures de test tenían el `wamid` **hardcodeado** (`wamid.test123`
      en `app.test.ts`): con dedup, el segundo mensaje de la suite se
      descartaba como duplicado y los tests fallaban por una razón ajena a lo
      que probaban. Ahora el id se deriva del contenido.
- [x] Verificado por mutación: sacando el filtro de `app.ts`, los tests fallan
      con `expected [ 'hola', 'hola', 'hola' ] to deeply equal [ 'hola' ]`.

### Riesgo abierto
- [ ] **El registro es en memoria y se vacía al reiniciar.** Un reintento de
      Meta posterior a un reinicio se procesa como nuevo. Se eligió memoria a
      propósito: persistir los ids los metería bajo la política de retención
      (Bloque 15) sin que tengan valor más allá de la ventana de reintento. Si
      con uso real aparecen duplicados asociados a reinicios, la solución va
      junto con la cola durable del Bloque 18 — mismo Redis, misma decisión.

### Pregunta que lo habría agarrado antes
*"¿De dónde salen los duplicados, exactamente?"* — no *"¿quién reintenta?"*.
Se asumió que el reintento venía de quien nos llama, y por lo tanto que
contestarle más rápido lo evitaba. El reintento venía de **dos saltos más
arriba**, disparado por un tercero que falla, y ninguna mejora de nuestra
latencia lo toca. Es la misma forma de error que el obituario del Bloque 12
(dar por buena la causa de un fallo externo sin verificarla): la hipótesis
encajaba con los hechos conocidos y por eso no se buscó confirmarla — y la
confirmación, cuando llegó, la contradijo.

## Bloque 21 — Modo silencioso (después del incidente del 2026-08-12)

### El incidente
Al activarse el reenvío del proveedor entraron mensajes de **personas
reales** y el agente les respondió solo. Ventana: 13:08:17 → 13:10:46 UTC,
dos minutos y medio, tres números (uno de ellos el del propio proveedor
probando). Uno de los contactos recibió **cuatro** respuestas automáticas a
una conversación personal.

Qué salvó que no fuera peor: los seis mensajes cayeron en
`fallback_low_confidence` (0.05–0.15), así que la política de escalamiento
actuó — plantilla de espera y escalar, **sin llamar a ningún tool**. Los seis
tienen `toolsCalled: []`, o sea que **no salió ni un dato de propiedad del
mock**. No se agendó nada. Si esos mensajes hubieran clasificado con
confianza alta, habrían salido precios y direcciones inventados.

Los registros de los dos contactos reales se borraron del `audit_log` y de
`last_interaction` a pedido del dueño del repo: no son leads, y no
correspondía que les arrancara el reloj de retención de 24 meses.

### La causa
No había ningún estado intermedio entre "el agente no está conectado" y "el
agente le contesta solo a cualquiera que escriba". El proyecto se construyó
entero asumiendo que la conexión de una línea real iba a ser un acto
deliberado y controlado, y el modo por default era responder.

- [x] `AGENTE_MODO_SILENCIOSO`, **prendido por default**. Único flag del
      proyecto cuyo valor seguro es `true`: se apaga sólo con el string exacto
      `"false"`, cualquier otra cosa lo deja prendido. La asimetría es el
      argumento — silencioso cuando lo querías activo significa que al broker
      le llegan los borradores y responde a mano (molesto, y se nota en el
      acto); activo cuando lo querías silencioso es esto, y no se deshace.
- [x] **El filtro vive en el sender** (`SilentModeSender`), no en el llamador.
      Los mensajes a clientes salen del webhook, de los tres jobs del
      scheduler y de `broker_accion_directa`; un `if` por llamador deja afuera
      al que se escriba mañana. El decorador bloquea `sendText`, `sendImage` y
      `sendTemplate` hacia cualquier destino que no sea el broker, y **sin
      número de broker configurado no deja pasar nada** (falla cerrado).
- [x] **El broker recibe el borrador SIEMPRE**, escale o no el intent. Sin
      esto el modo silencioso sería peor que el problema: el cliente sin
      respuesta y nadie enterado de que escribió.
- [x] **Los jobs de mensajería no se registran** en modo silencioso, en vez de
      dejar que el sender les bloquee los envíos: si corrieran, marcarían el
      estado ("a este lead ya lo recontacté") sin haber mandado nada, y al
      apagar el modo ese lead no se contactaría nunca.
- [x] **El audit log dice la verdad**: en modo silencioso `responseSent` queda
      `undefined`, porque no se envió nada. Es el registro que se usa para
      reconstruir un incidente — si dijera que se mandó algo que no se mandó,
      el próximo informe saldría mal. Este incidente se reconstruyó con él.
- [x] Aviso ruidoso al arrancar en **las dos direcciones**. El que importa no
      es el del modo activo: es el de que está apagado.
- [x] Verificado por mutación: neutralizando la rama del modo silencioso,
      fallan 4 tests (`expected 'respuesta para el cliente' to be null`,
      `expected [] to have a length of 1`).

### Riesgo abierto
- [ ] El modo silencioso **no impide recibir ni clasificar**, o sea que cada
      mensaje de un desconocido sigue gastando llamadas a Claude y quedando
      en el audit log. Es deliberado (el broker necesita el borrador), pero si
      se conecta una línea con volumen real conviene revisar el costo.

### Pregunta que lo habría agarrado antes
*"¿Qué pasa si esto se conecta y funciona **antes** de que yo esté listo?"* —
todos los pre-mortems anteriores preguntaron qué pasa si algo falla. Acá no
falló nada: el webhook entrante, que llevaba bloqueado desde el Bloque 11,
**funcionó por primera vez**, y funcionar era el modo peligroso. Un
componente que se destraba solo hay que tratarlo como un despliegue: la
pregunta no es sólo "¿qué se rompe?" sino "¿qué se enciende, y hacia quién
apunta cuando lo haga?".

## Bloque 22 — Rechazo duro cuando falta `WHATSAPP_APP_SECRET`
Cerrado el hallazgo lateral del bloque del flag de firma. Antes,
`authorizeWebhookRequest` devolvía `aceptado: true` con motivo
`sin_secreto_configurado`: era la **segunda** forma de quedar sin verificación
de firma, no requería prender ningún flag, y bastaba con que la variable
estuviera vacía. Ahora rechaza con 401.

- [x] Desactivar la validación pasa a ser un acto deliberado (el flag
      `WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK`), nunca la consecuencia de un
      `.env` incompleto.
- [x] El flag se evalúa **antes** que el chequeo del secreto, así que la
      escotilla del proveedor sigue funcionando sin App Secret. Con test.
- [x] El motivo distingue `sin_secreto_configurado` de `firma_ausente`: se
      arreglan de formas distintas (un `.env` incompleto vs. quien llama
      mandando mal la firma). El log del rechazo dice cuál es el arreglo, no
      sólo que rechazó — este fallo tiene **el mismo síntoma que el blocker
      del Bloque 11** ("no llega nada"), que costó días.

### Lo que el pre-mortem subestimó
Se anticipó que habría "un test que afirma que sin secreto se acepta". Eran
**13 tests en dos archivos**: los harnesses de `webhookAckPrimero.test.ts` y
`webhookDedup.test.ts` no configuraban App Secret y dependían *implícitamente*
de que sin secreto todo pasara. No lo declaraban en ningún lado — se apoyaban
en el agujero sin saberlo. Se arreglaron **firmando los POSTs de verdad**, que
además los acerca a producción, en vez de prenderles el flag de escape.

Lección para el próximo cambio de este tipo: buscar quién *depende* del
comportamiento viejo no es lo mismo que buscar quién lo *afirma*. Lo primero
es un `grep` que no existe; hay que dejar que la suite lo diga.

### Anotación operativa: el espejo de coexistencia
Los mensajes **salientes** que el proveedor ve en sus métricas los manda el
broker desde su celular, **no el agente**. Es el espejo de coexistencia.
Anotado acá porque en un diagnóstico futuro es fácil confundirlos con envíos
del sistema y perseguir un fantasma.

### Pendiente relacionado, sin resolver
- [x] **Resuelto en el Bloque 23.** Se deja el texto original abajo porque
      explica de dónde salió el número 39.
- [ ] ~~**Los POSTs que no son mensajes no dejan ningún rastro.**~~ Del incidente
      del Bloque 21: el proveedor midió **39 POST** en la ventana y el
      `audit_log` sólo tiene **6**. Los otros 33 salieron por alguna de las
      cuatro salidas tempranas de `app.ts` (401 por firma, 400 por JSON
      inválido, `!message` — statuses/tipos no-texto/echos —, y descarte por
      dedup) y **ninguna de las cuatro audita**; dos ni siquiera loguean.
      La hipótesis que mejor encaja: 12 salientes (6 del broker + 6 del
      agente) × ~3 webhooks de status cada uno ≈ 33. **Sin confirmar** — hay
      que pedirle al proveedor el desglose por tipo de payload, o instrumentar
      un contador por motivo de salida. Mientras tanto, la pregunta "¿cuántos
      webhooks recibí y qué pasó con cada uno?" no tiene respuesta desde
      adentro del sistema.
- [ ] **Verificar si el espejo de coexistencia manda los salientes como
      `messages`** y no sólo como `statuses`. Si lo hiciera, el parser los
      tomaría como entrantes y, al venir del número del broker, caerían en el
      canal `broker`: el agente interpretaría lo que el broker le escribe a un
      cliente como una orden dirigida a él. En el incidente no pasó (no hay
      ninguna entrada del número del broker en el `audit_log`), pero hay que
      confirmarlo **antes** de apagar el modo silencioso.

## Bloque 23 — Observabilidad del webhook: cerrar los cuatro puntos ciegos
Para que no vuelva a haber un "39 POST y 6 respuestas" sin explicación.

- [x] Contador por resultado (`webhookMetrics.ts`), con **una categoría por
      salida** del camino POST: `procesado`, `duplicado`, `sin_mensaje`,
      `json_invalido`, `rechazado_firma_invalida`, `rechazado_firma_ausente`,
      `rechazado_sin_secreto`. Hay un test que verifica que **la suma de las
      partes es el total**: ningún POST queda sin clasificar.
- [x] Las dos salidas que eran completamente mudas (400 por JSON inválido y
      `!message`) ahora logean.
- [x] `describirPayloadSinMensaje()` desglosa el punto ciego más grande:
      distingue `status` de `mensaje_tipo:image` de `payload_no_reconocido`.
      "Me llegaron 30 statuses" y "me llegaron 30 mensajes de un tipo que no
      soporto" son problemas opuestos y antes eran el mismo silencio. Es
      **aditiva**: se llama sólo cuando `parseIncomingMessage` ya devolvió
      null, así que no puede romper el parseo de un mensaje bueno.
- [x] `GET /health` devuelve el resumen. Es lo que faltó el 2026-08-12: la
      respuesta estaba en el scrollback de una terminal que se cerró.
- [x] El resumen incluye **desde cuándo cuenta**. Sin eso, un reinicio hace
      leer la ventana equivocada y se saca la conclusión de otro rato.
- [x] Nunca se loguea el contenido ni el teléfono: el log de descartes no
      puede convertirse en un almacén de datos personales fuera de la política
      de retención. Con test.
- [x] El contador vive **fuera del `audit_log`**, a propósito: el audit_log
      audita mensajes clasificados, que es su trabajo. Un webhook de status no
      es un mensaje y no tiene por qué ensuciar la auditoría de conversaciones
      ni quedar sujeto a su retención.

### Lo que apareció al escribir los tests
Un body mal formado **con firma inválida** nunca llega al parse de JSON: se
rechaza antes, porque la firma se valida sobre los bytes crudos. O sea que
`json_invalido` sólo puede provenir de alguien que **firma bien y manda
basura** — es una señal mucho más específica de lo que parecía (un problema
del reenviador, no ruido de internet). El primer test estaba mal escrito por
no tener esto en cuenta.

## Bloque 24 — Descarte explícito del eco + auth por header del proveedor

### El eco: confirmado sobre payloads reales
El proveedor confirmó la forma: el espejo de coexistencia llega con
`field: "smb_message_echoes"` y el array en `value.message_echoes`, **sin**
`value.messages`. O sea que el canal broker nunca estuvo en riesgo — el
parser ya lo descartaba. Pero lo descartaba **por la ausencia de una clave**,
que es depender de que Meta nunca cambie la forma del payload.

- [x] `esEcoDeCoexistencia()`: descarte **explícito**, antes de parsear, con
      categoría propia (`eco_descartado`) en el contador. Si algún día el eco
      viniera además con `messages`, hoy el agente leería lo que el broker le
      escribe a un cliente como una orden dirigida a él (sale de su número, o
      sea del canal `broker`).
- [x] **Nunca descarta un payload que contenga un mensaje real.** Meta agrupa
      varios `changes` en un mismo POST, así que un eco puede viajar junto a
      un mensaje legítimo; en ese caso gana el mensaje. Descartar el POST
      entero por ver una marca de eco sería perder mensajes de clientes, que
      es peor que procesar un eco de más. Con test de payload mixto.
- [x] Verificado por mutación: sin el descarte explícito el eco cae en
      `sin_mensaje` (`expected { sin_mensaje: 1 } to deeply equal
      { eco_descartado: 1 }`) — se descartaba igual, pero sin distinguirse de
      un status y por el motivo equivocado.

### Auth por header del proveedor
- [x] `DOUBLETICK_WEBHOOK_SECRET` valida el header `X-DoubleTick-Secret`,
      **conviviendo** con la HMAC de Meta: el header sólo se evalúa si vino,
      así que la entrega directa de Meta (que no lo trae) sigue entrando por
      la firma. Test de los dos caminos con la misma configuración.
- [x] Comparación de **tiempo constante**: un `===` sobre un secreto
      compartido filtra por timing cuántos caracteres acertó quien lo adivina.
- [x] **Vacío o en blanco = no configurado**, y el header se ignora por
      completo. Sin esto, un `DOUBLETICK_WEBHOOK_SECRET=` vacío haría que un
      header vacío matcheara y el endpoint quedaba abierto — la misma trampa
      que el App Secret vacío del Bloque 22.
- [x] Rechazo con motivo propio (`rechazado_secreto_proveedor`) y su categoría
      en el contador, para distinguir "el proveedor tiene el secreto mal" de
      "alguien está probando" de "falló la firma de Meta".

### Causa CONFIRMADA: el numero esta desconectado de la plataforma
**Confirmado el 2026-09-15 a las 19:53** con una captura del iPhone:
*Ajustes > Cuenta > Plataforma para empresas* muestra la pantalla de alta,
con el boton **Conectate a la plataforma para empresas**. Si estuviera
conectado, ofreceria *Desconectar cuenta*. Eso explica de una sola vez el
corte de eventos del 8/09, el usuario de sistema sin activos y el envio
imposible.

Como se llego (la hipotesis original, que quedo debilitada en el camino):
Dato del dueno del repo (15/09): **el numero se opera replicando la sesion de
WhatsApp Business de un iPhone en un Android** (la sesion original vive en el
iPhone), y alrededor del 8/09 **la sesion se cerro y se volvio a abrir**.

En coexistencia, el numero queda vinculado a la Cloud API a traves de ese
registro. Verificado en la documentacion de Meta:
- El vinculo se puede cortar desde la propia app: *Settings > Account >
  Business Platform > Disconnect Account*.
- Al conectar un numero existente a la Cloud API **se desvinculan todos los
  dispositivos companion**, y despues hay que volver a vincularlos.

**No verificado**: que al re-registrar el numero aparezca una opcion, marcada
por defecto, para reconectar solos los productos de Cloud API. Aparecio en un
resumen de busqueda, no en la pagina de Meta. Hay que preguntarselo al
proveedor, que es Tech Provider.

**Corregido el mismo dia, con un dato del dueno del repo**: el Android esta
vinculado por **codigo QR desde Dispositivos vinculados**, o sea es un
dispositivo acompanante y no un registro aparte. Eso es compatible con
coexistencia — Meta manda `smb_message_echoes` justamente por los mensajes
escritos desde acompanantes, y el bot ya los usa. Asi que **replicar la
sesion, por si solo, no explica el corte**. Lo que falta saber es cual sesion
se cerro: la del iPhone (registro principal, se reabre con codigo de
verificacion, y eso si puede romper el vinculo) o la del Android (se reabre
escaneando el QR, y eso no lo rompe).

La hipotesis explica de una sola vez las tres cosas medidas: el corte de
eventos, el usuario de sistema sin activos y el envio imposible. Falta
confirmar la fecha exacta del re-registro contra el 8/09 17:30 ART.

- [ ] Mirar en el iPhone si el numero sigue conectado: *Configuracion > Cuenta
      > Plataforma de WhatsApp Business*.
- [ ] Confirmar fecha y hora del cierre y reapertura de sesion.
- [ ] **Regla operativa**: con coexistencia, el numero se registra en UN solo
      telefono. Para usarlo en otro, dispositivos vinculados; volver a
      registrarlo rompe el vinculo y deja al bot sin recibir ni enviar.

### Hipotesis 2: el proveedor perdio la asignacion de su lado (ya no hace falta)
Quedo descartada como **explicacion necesaria**: la captura del telefono ya
explica todo. Puede seguir siendo cierta en paralelo, y conviene preguntarla
igual, porque al reconectar el proveedor tiene que volver a tener el numero
asignado a su app.

Las listas vacias que medimos son del usuario de sistema **de ellos**
(`tick-app System User`). Son igual de compatibles con que el proveedor haya
rotado ese usuario de sistema, cambiado de app, o le haya quitado la WABA
asignada, sin que en el telefono del broker haya cambiado nada. Desde aca no
se puede distinguir de la Hipotesis 1: las dos producen exactamente los mismos
errores. Solo el proveedor puede mirar su propio Business Manager.

- [ ] Preguntarle al proveedor si ese usuario de sistema sigue teniendo la
      WABA asignada, y si rotaron credenciales o cambiaron de app alrededor
      del 8/09.

### Dato que cierra una duda de agosto
La linea del bot (`phone_number_id` 3207688612809306) es el numero que termina
en **...4543**: lo devolvio Meta el 18/09 en `display_phone_number`. Por eso
aparecia como contacto propio en el simulacro de recontacto de agosto, y por
eso `BROKER_WHATSAPP_NUMBER` **nunca** puede ser ese numero: el bot se estaria
mandando los borradores a si mismo, con riesgo de lazo si volvieran a entrar
como evento.

Decision del dueno del repo (18/09): los borradores siguen yendo al celular
personal, el que termina en ...6699, que ademas queda excluido del recontacto
por figurar como numero del broker. Un tercer numero dedicado al canal broker
queda anotado como mejora futura en `PENDIENTES.md`.

### Consecuencia: se puede retirar la escotilla
Cuando el proveedor active el header, `WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK`
deja de tener razón de existir: ya no hace falta aceptar sin autenticar. Eso
**cierra el riesgo abierto** que quedó del bloque del flag de firma.
- [ ] Retirar el flag una vez confirmado que el header funciona en producción.
      No se hace ahora para no quedarse sin ninguna vía si el header falla en
      el primer intento.

## Bloque 25 — Normalizacion de telefonos con libphonenumber
Decision del dueno del repo: no armar reglas por pais a mano. Argentina es de
los peores casos y ya rompio entregas dos veces en este proyecto.

- [x] `normalizarTelefono()` en `shared-types`, con `libphonenumber-js/max` y
      region `AR` por defecto. Devuelve `paraEnviar` (E.164 **sin `+`**, lo que
      espera la Graph API) y `paraMostrar` (formato nacional) en **campos
      separados**: mezclarlos es lo que hace que alguien mande a la API un
      numero con espacios.
- [x] **No alcanza con `isValid()`.** Medido: `1155551234` (un celular cargado
      sin el 9 y sin el 15) parsea como `FIXED_LINE` y `isValid()` devuelve
      `true`. Pasaria el filtro y el mensaje no llegaria a ningun lado, sin
      error visible. Se exige `getType() === "MOBILE"`.
- [x] Se usa la build `/max`: la default no trae metadata de tipo y
      `getType()` devuelve `undefined` siempre.
- [x] Lo que no se puede parsear con confianza **queda fuera de los envios
      automaticos**, mismo criterio que el estado indeterminado de una
      propiedad.

### Los que quedan afuera son visibles, no silenciosos
`npm run tokko:telefonos` — resumen, `--lista` para ver quienes son, `--csv`
para exportarlos. Corrida real sobre los 4682 contactos:

    Contactables por WhatsApp: 3649 (77.9%)
    NO contactables:           1033 (22.1%)
      793  Es linea fija (o falta el 9 del celular)  <- RECUPERABLES
      145  Sin telefono cargado
       84  Numero incompleto o invalido
       11  No se entiende como numero

Los 793 se arreglan editandolos en Tokko. El reporte imprime nombre y telefono
a proposito (el objetivo es ir a corregirlos) y **no escribe ningun archivo en
el repo**: sale por consola y se va con la terminal.

### El wa_id de Meta corrige la normalizacion
- [x] `TelefonoCanonicoStore` guarda el `contacts[].wa_id` que devuelve
      `POST /messages` — **el id canonico segun Meta**. `CanonicalizingSender`
      lo aplica antes de enviar y lo aprende despues. La normalizacion deja de
      depender de que acertemos las reglas de cada pais.
- [x] **La clave es el numero al que se envio**, en E.164 sin `+`, nunca el
      nombre ni el id de lead: una colision de clave mandaria el mensaje de un
      cliente a otro.
- [x] Un fallo del store **nunca impide un envio**: es exactitud, no requisito.
- [x] Nace implementando `purgeOlderThan`: es un archivo con telefonos, o sea
      datos personales, y no puede quedar fuera de la politica de retencion
      (Bloque 15).

### Bug encontrado al correr el reporte
La primera version paginaba con `offset += 200`, pero **Tokko topea la pagina
en 50 aunque se pida 200**. Leia 50 y salteaba 150: una muestra dispersa del
25% que se presentaba como un barrido completo. Los porcentajes salian
parecidos de casualidad; el `--lista` habria ocultado 3 de cada 4 contactos con
problema. Ahora el offset avanza por lo que la API **devolvio**, y si no se
pudo leer todo el reporte lo dice.

**Pregunta que lo habria agarrado antes**: *"el paginado, lo verifique contra
el total o solo confie en que el loop termina?"* — un loop que termina no es un
loop que leyo todo.

### Riesgo abierto
- [ ] Los 793 recuperables siguen sin corregir en Tokko. Hasta que se corrijan,
      **el agente no puede contactar al 22% de la base**. No lo resuelve el
      codigo: hay que editarlos en el CRM.

## Bloque 26 — RealTokkoClient
Reemplaza al mock. Se elige por presencia de `TOKKO_API_KEY` y **se anuncia
siempre al arrancar**: correr contra el mock creyendo que son datos reales es
peor que no tener datos, porque el agente cita precios inventados con total
confianza.

- [x] La key va como **query param**. Con `Authorization: Token` la API
      devuelve 200 pero con **7605** propiedades en vez de 76 — un listado que
      no es el de esta cuenta. Usar el header habria hecho que el agente le
      cite a los clientes propiedades de otras inmobiliarias, sin ningun error.
- [x] **El filtro de sucursal se aplica de nuestro lado.** El del servidor no
      funciona: `/property/?branch_id=X` devuelve 200 y todas las propiedades
      igual, y en `/contact/` cualquier parametro inventado se ignora sin
      error. Todas las lecturas pasan por un unico metodo privado, asi que
      ningun metodo puede olvidarselo. `TOKKO_BRANCH_ID=94185` (moderna matias).
- [x] **El offset avanza por lo que la API devolvio**, no por lo pedido: Tokko
      topea la pagina en 50 aunque se pida 200. Es el mismo bug que aparecio en
      el reporte de telefonos del Bloque 25.
- [x] **El precio no se prioriza.** Si una propiedad esta publicada en venta y
      en alquiler, `precio` queda sin definir y las dos operaciones viajan en
      `operaciones`, para que el agente pregunte en vez de cotizar la que no
      es. Validado en vivo: *Olleros al 3700* tiene alquiler USD 4000 y venta
      USD 550000.
- [x] Lo que no se puede mapear se descarta **avisando**, nunca en silencio: una
      propiedad que desaparece del catalogo hace que el agente conteste "no la
      encontre" sobre algo que si existe.
- [x] Los leads sin telefono usable quedan fuera de `searchLeads`, para que
      ningun job los de por contactados. `npm run tokko:telefonos` dice cuales.
- [x] `logActivity` **falla ruidosamente** en vez de simular que escribio:
      es la unica operacion de escritura y sigue sin confirmarse con Tokko el
      permiso ni si hay sandbox.

### Verificado en vivo contra la cuenta real
Las 4 propiedades de la sucursal, con estado resuelto, tipo traducido,
coordenadas presentes (el intent del clima funciona) y fotos separadas de
planos.

## Bloque 27 — Recontacto seguro (BLOQUEANTE para apagar el modo silencioso)
Pedido explicito del dueno del repo. Con **3649 contactos contactables**, el
job de recontacto es lo que mas riesgo tiene de todo el sistema: es el unico
que escribe a gente que **no escribio primero**.

- [ ] **Tope duro** de mensajes por corrida. Sin esto, el primer barrido puede
      salir a contactar cientos de personas de una.
- [ ] **Modo simulacro** por default, igual que el purgado por retencion del
      Bloque 15: reporta a quien le escribiria y no manda nada, hasta que
      alguien lo habilite explicitamente.
- [ ] **Resolver a que contactos les escribe.** Los 4682 son de toda la
      empresa; hoy `searchLeads` no distingue de quien es cada uno. Hay que
      definir el criterio (agente asignado, etiqueta, antiguedad) antes de que
      pueda mandar algo.
- [ ] Recien con las tres cosas se puede evaluar apagar el modo silencioso.

### Lo que se encontro al retomarlo (20/09)
**Las tres cosas estan construidas y probadas — y el job no usa ninguna.**

- `jobs/recontactoPolicy.ts` (341 lineas, con tests) tiene el tope por corrida,
  el tope por dia, la ventana horaria, el intervalo entre corridas, el maximo
  de intentos por persona, los 60 dias entre mensajes y el deduplicado por
  telefono de las fichas repetidas de Tokko.
- `jobs/topeDiarioStore.ts` persiste el tope diario en disco, justamente para
  que reiniciar el proceso no lo reinicie.
- `mcp-tokko/src/candidatosRecontacto.ts` tiene **el criterio que el dueno del
  repo ya definio** mirando la distribucion real: agente asignado, `lead_status`
  distinto de "Cerrado" (4145 de 4683 lo son), telefono usable y barrio de sus
  propiedades. De 4683 contactos, pasan **29**.
- `jobs/numerosInternos.ts` junta los numeros a los que nunca hay que escribir.

Todo eso lo usa **`scripts/simulacro-recontacto.mts`**, que es lo que el dueno
del repo mira para decidir. El job que **envia de verdad** no importa ninguno
de esos modulos: `createRecontactJob` le pide a Tokko
`searchLeads({ diasSinRespuestaMin })` —todos los contactables de la cuenta por
encima del umbral, unos 3600— y les escribe **a todos, en el orden que venga,
a cualquier hora, sin tope y sin deduplicar**.

O sea: el simulacro que se aprueba muestra 29 personas y el job haria otra
cosa. Y el job **ya esta registrado en el scheduler** (detras de
`sender && !modoSilencioso`), asi que lo unico que lo separa de correr es
apagar el modo silencioso — que es exactamente lo que este bloque bloquea.
La linea de PENDIENTES que decia "falta cablearlo al scheduler" estaba al
reves: lo que falta es cablearle las salvaguardas.

**Lo que se midio (servidor, 20/09)**
- El proceso corre en **hora local -03**, no en UTC: la retencion del Bloque
  40, que usa `setHours(4)`, disparo a las **04:01:47 -03**. Asi que la ventana
  de 9 a 20 de la politica son horas de Argentina, como se penso. El riesgo
  anotado en PENDIENTES ("en un servidor en UTC la ventana queda corrida 3
  horas") **no aplica hoy**; sigue vivo si alguien cambia el huso del servidor.

**Pre-mortem**

**1. El job le escribe a gente que el simulacro nunca mostro.** Es el modo de
fallo del bloque entero. Si el cableado queda a medias —el criterio aplicado
en el script pero no en el cliente de Tokko, por ejemplo— el simulacro sigue
mostrando 29 y el job sigue viendo 3600, y nadie se entera hasta que salgan
los mensajes. Con 3649 contactables, el primer barrido es masivo e
irreversible: no hay "deshacer" para un WhatsApp.
   *Mitigacion*: el filtro de candidatos vive **en el cliente de Tokko**, no en
   el llamador, asi que el job y el simulacro no pueden divergir sin que un
   test lo muestre. Tests de que el job pide los candidatos de recontacto y no
   todos los leads, y de que dos fichas con el mismo telefono producen un solo
   envio.

**2. El tope diario no cuenta lo que realmente salio.** El tope vive en disco
porque un contador en memoria deja de ser un tope al primer reinicio. Pero si
se suma antes de enviar, un envio que falla consume cupo; y si se suma fuera
del camino de exito, un envio que salio no lo consume y el tope se pasa. Con
el scheduler cada 5 minutos, un tope que no cuenta bien son decenas de
mensajes en una tarde.
   *Mitigacion*: se suma exactamente lo que salio, despues de cada envio
   exitoso. Test de que un envio que falla no consume cupo y de que uno
   exitoso si.

**3. El simulacro del propio job miente.** Si el modo simulacro calcula el
plan pero igual toca los stores (`recontactStateStore`, el tope diario), el
job "no manda nada" pero deja a esas personas marcadas como contactadas, y al
habilitar el envio real **no se las contacta nunca**. Es el mismo error que
server.ts ya describe para el modo silencioso, en el mismo job.
   *Mitigacion*: en simulacro no se escribe ningun store. Test de que despues
   de una corrida en simulacro los tres stores quedan exactamente igual.

## Bloque 28 — El catalogo de intents no resiste el trafico real (BLOQUEANTE)
Salio de mirar las 41 conversaciones reales que entraron entre el 2026-08-25 y
el 26, con el modo silencioso puesto. **Hay que revisarlo contra estas
conversaciones antes de siquiera pensar en apagar el modo silencioso**: son la
primera muestra de trafico de verdad que tiene el proyecto.

Los numeros, de `npm run pendientes`:

    38 conversaciones sin respuesta del agente
      10  agendar_visita / negociacion_precio
       5  reclamo_queja / reprogramar
       6  consulta de precio, ficha o disponibilidad
       2  consulta_clima_visita
      15  fallback_low_confidence   <- 39% de las conversaciones

A nivel mensaje individual es peor: **186 de 250 entradas del audit_log
cayeron en `fallback_low_confidence`** (74%).

- [ ] **Revisar el catalogo contra las 38 conversaciones reales.** El catalogo
      se escribio para el trafico que imaginabamos, no para el que llega. Casi
      4 de cada 10 conversaciones no matchean nada.
- [ ] **Un caso concreto de mala clasificacion**: "Fiedotin Propiedades" quedo
      como `reclamo_queja`. Es **otra inmobiliaria**, no un cliente enojado.
      El catalogo no contempla que escriban colegas, portales o proveedores —
      y con el modo silencioso apagado, a un colega le contestaria el bot.
- [ ] **Revisar tambien los umbrales de confianza**, no solo los intents: un
      fallback tan alto puede ser falta de intents o un umbral demasiado exigente.

**Por que es bloqueante**: con el modo silencioso apagado, cada uno de esos 15
recibe la plantilla de espera y un escalamiento. Eso es aceptable como red,
pero no como comportamiento del 39% de las conversaciones.

## Bloque 29 — Leads que llegan por WhatsApp y no quedan en el CRM
No es un problema de codigo: es un agujero de la operacion, detectado por el
sistema. Anotado a pedido del dueno del repo.

De las 41 conversaciones que entraron, **18 no tienen ninguna ficha en Tokko**
(23 si). O sea que **el 44% de la gente que escribe por WhatsApp no queda
registrada en el CRM**.

Entre ellos, al menos uno entro por un portal:

    "Hola! Quiero que me contacten por esta propiedad en venta
     que vi en Zonaprop..."

- [ ] **Decision del dueno del repo**: que se hace con un lead que escribe y no
      esta en Tokko. Hay al menos tres caminos y ninguno es obvio:
      cargarlo automaticamente (requiere escritura en Tokko, que sigue sin
      confirmarse), avisarle al broker para que lo cargue el, o dejarlo asi y
      asumir que WhatsApp es el registro.
- [ ] **Consecuencia que ya se nota**: todo lo que cruza contra Tokko (nombre
      del contacto, temperatura, candidatos a recontacto) ignora al 44%. El
      job de recontacto, por definicion, nunca los va a alcanzar.
- [ ] Cuando el eco de coexistencia este enganchado, esto ademas se puede
      medir en el tiempo en vez de estimarlo una vez.

## Bloque 30 — Baja: palabra clave y lista de no contactar (BLOQUEA LA POLITICA)
La politica de privacidad **no se puede publicar prometiendo esto hasta que
exista**. Se saco la clausula del texto por eso, no porque no haga falta.

Lo que hoy NO existe:

- [ ] **Responder a la palabra BAJA.** El catalogo de intents no la contempla.
      Si alguien la escribe hoy, cae en `fallback_low_confidence`: se escala al
      broker y el sistema no registra nada. Funciona por la via humana, pero no
      es lo que una clausula de baja promete.
- [ ] **Una lista persistente de "no contactar".** El job de recontacto tiene
      topes y un maximo de 2 intentos, pero **no tiene forma de marcar a alguien
      como excluido para siempre**. Si un cliente pide la baja hoy, la unica
      garantia es que el broker se acuerde.
- [ ] Cuando exista, la lista tiene que consultarse en `recontactoPolicy`
      (mismo lugar que los numeros internos) y sobrevivir a los reinicios.

**Estado actual de la politica**: dice que se puede pedir la baja **por mail**,
que es cierto y el broker lo puede cumplir a mano. La clausula de responder
BAJA por WhatsApp vuelve al texto cuando el sistema la maneje.

**Ojo con el orden**: esto se vuelve urgente el dia que se apague el modo
silencioso, porque recien ahi el agente empieza a mandar mensajes que alguien
podria querer frenar.

## Bloque 31 — La plantilla fija se manda UNA vez por conversacion
Sale del hallazgo del Bloque 32: con el modo silencioso apagado, los 16 leads
etiquetados recibirian 57 envios de la misma frase; una sola persona, 16
seguidas. Decision del dueno del repo: **responder la plantilla una vez y
despues callarse**. Los mensajes siguientes se siguen procesando y escalando
al broker; lo unico que no sale es otra plantilla.

### Alcance: 7 plantillas, no una
Del catalogo, 12 intents usan `style: template`. Cinco llevan variables
(`{direccion_corta}`, `{fecha_hora}`) y cambian de texto en cada envio: esas
NO entran, porque llevan informacion real. Las otras siete son texto fijo y
**las siete dicen lo mismo**: negociacion_precio, reclamo_queja,
consulta_legal_contractual, hablar_con_persona, rechazo_desinteres,
derivacion_colega y fallback_low_confidence.

Por eso la supresion es **una plantilla fija por conversacion en total, no una
por intent**. ***9738 toca tres de esas siete: suprimir por intent le mandaria
igual tres frases distintas que dicen "te paso con el asesor". El criterio
sale del catalogo en runtime (style template + sin `{variables}`), no de una
lista hardcodeada en TypeScript.

### Pre-mortem
**1. El silencio se vuelve permanente.** La condicion para volver a hablar es
que el broker responda, y eso se detecta por el eco de coexistencia, que es
best-effort: Meta no lo reintenta, y solo se registra si el destinatario
matchea un lead conocido. Si el eco se pierde, esa persona **nunca mas**
recibe nada. Es el patron de "se rompe solo sin que nadie toque nada" de los
obituarios previos, al reves: se queda roto solo.
   *Mitigado*: techo temporal. Pasados N dias la plantilla puede volver a
   salir aunque no haya llegado ningun eco. Con test.

**2. El propio sistema destraba el silencio.** `UltimoContactoStore` guarda
contactos con `origen: "sistema" | "manual"` en el mismo campo de fecha. Hoy
solo se escribe `"manual"` (app.ts, desde el eco), pero el job de recontacto
del Bloque 27 va a escribir `"sistema"` cuando se cablee. Si la condicion
mira solo la fecha, el recontacto automatico se cuenta como "el broker
respondio" y la repeticion vuelve, sin que nadie toque este codigo.
   *Mitigado*: se filtra por `origen === "manual"`, con un test que registra
   un contacto `"sistema"` y verifica que el silencio NO se rompe. Es un test
   de un camino que todavia no existe, escrito ahora para que el Bloque 27 no
   lo reintroduzca.

**3. El audit log dice que se envio algo que no se envio.** Si el camino de
supresion audita `responseSent` con el texto de la plantilla, el registro
afirma que el cliente recibio una respuesta que nunca salio. Rompe
`npm run pendientes` y cualquier forense futura — es la misma clase de agujero
que los 39 POST con 6 respuestas.
   *Mitigado*: se audita `responseSent: undefined` y un motivo propio,
   igual que hace el modo silencioso. Con test.

**4. El conjunto de plantillas fijas se desincroniza del catalogo.** Si
manana alguien le agrega una variable a una de las siete, o saca las variables
de otra, el conjunto cambia en silencio y la supresion aplica donde no debe.
   *Mitigado*: el conjunto se deriva del catalogo en runtime, y un test fija
   la clasificacion actual de las 12 plantillas, asi editar el YAML falla
   ruidoso en vez de cambiar comportamiento sin que nadie se entere.

### Decisiones
- [x] **Si no se puede leer el historial, se suprime** (falla cerrado). El
      dueno del repo dijo que 16 repeticiones es peor que el silencio, asi que
      ante la duda no se manda. El costo es perder una plantilla legitima.
- [x] Aplica **por conversacion**, nunca global.
- [x] Techo de 7 dias (`DIAS_TECHO_SILENCIO`) para el modo de fallo 1.

### Como quedo
- [x] `agent/plantillaRepetida.ts`: `plantillasFijas()` deriva el conjunto del
      catalogo en runtime, y `decidirPlantilla()` es una funcion pura — recibe
      historial, ultimo contacto y `ahora`, sin leer nada. Testeable sin API.
- [x] `leerHistorial()` reemplaza a la lectura que hacia `armarContexto`: una
      sola pasada por el audit log alimenta el contexto del clasificador **y**
      la supresion. `armarContexto` quedo pura.
- [x] Cableado en `finalizeEscalation`, que es por donde pasan las 7 (todas
      `requires_broker: true`, fijado en un test).
- [x] 20 tests nuevos; suite completa 581/581 en verde.
- [x] **Mutation testing de las 6 mitigaciones** — sacar el filtro por
      `origen`, sacar el techo, contar las suprimidas como enviadas, ignorar
      la respuesta del broker, fallar abierto, y auditar el texto como si se
      hubiera enviado. Las 6 ponen tests en rojo.

### Riesgo abierto
- [ ] **Nada de esto se nota hasta apagar el modo silencioso**, que es cuando
      el agente empieza a responderle al cliente. Hasta entonces el camino
      corre pero no cambia lo que recibe nadie.

## Bloque 34 — El audit log se escribe SIEMPRE, antes de clasificar
**Paso de verdad el 2026-08-28.** Se acabo el credito de la API de Anthropic y
los mensajes entrantes se evaporaron: `/webhook` respondio 200, el proveedor
los dio por entregados, el `.catch` de la cola lo escribio solo en consola, y
no quedo entrada en `audit_log` ni notificacion al broker. `npm run pendientes`
tampoco los muestra, porque lee el audit log.

Decision del dueno del repo: **el registro de que alguien escribio no puede
depender de que la API de Anthropic funcione.** El audit log se escribe con lo
que llego —telefono, texto, timestamp— ANTES de intentar clasificar. Si la
clasificacion falla, la entrada queda marcada como fallida y se escala con el
texto crudo.

### Lo que hizo falta medir antes de disenar
- `AuditLogEntry` **no tiene `messageId`**. Sin eso no se puede vincular la
  entrada de "llego" con la de "se resolvio", y todo consumidor que cuenta
  entradas pasaria a contar doble.
- **El camino de notificacion tambien usa el LLM.**
  `notifyBrokerBestEffort` llama a `composeDraft` (Claude) dentro del mismo
  `try`. El arreglo ingenuo — atrapar el error del clasificador y avisarle al
  broker — habria fallado por la misma causa que el error original.
- Nada en disco guarda lo que llego: `LruMessageDeduplicator` y
  `ContactosConocidos` son en memoria, y del `rawBody` solo se loguea el
  **largo**, nunca el contenido.

### Pre-mortem
**1. El aviso de que fallo tambien falla.** Si el clasificador murio porque la
API esta caida, `composeDraft` esta igual de muerto y la notificacion se
pierde en su propio `catch`. El broker sigue sin enterarse y el bloque no
sirvio para nada.
   *Mitigado*: el camino de fallo **no llama al LLM**. `AvisoDeFallos` arma el
   texto crudo y lo manda directo por WhatsApp. Test con el clasificador y el
   borrador caidos a la vez.

**2. Doble contabilidad silenciosa.** Con dos entradas por mensaje, todo lo
que lee el audit log cambia de numero sin que nadie lo toque: `medir:*`,
`pendientes`, la purga por retencion, y sobre todo `leerHistorial`, que le
pasaria al clasificador el mismo mensaje repetido como contexto previo.
   *Mitigado*: `messageId` en cada entrada y `colapsarPorMensaje` en todos los
   lectores: el contexto del clasificador, el corpus de estilo, `pendientes`,
   `medir:*` y `etiquetar`. Test de que el contexto no duplica.

**3. La escritura del audit log tumba el mensaje.** Si la entrada de "llego"
se escribe antes que todo y esa escritura falla, se pierde el mensaje entero
— peor que hoy, porque hoy al menos el camino feliz funciona.
   *Mitigado*: `registrarRecibido` y `registrarFallido` nunca tiran. Test con
   un audit log que falla en la primera escritura: el mensaje se procesa igual.

**4. Inundacion de notificaciones.** Si la API se cae dos horas y entran 40
mensajes, son 40 escalamientos al WhatsApp del broker. La proteccion contra
perder mensajes se convierte en la razon por la que deja de mirar el telefono.
   *Mitigado*, con la opcion B que eligio el dueno del repo (2026-09-19): los
   primeros 5 fallos de una caida salen sueltos; desde el sexto, un resumen
   cada 15 minutos; y un aviso cuando se recupera.

### Un caso que no estaba en el pre-mortem
Al escribir el `recibido` **antes** de encolar, el mensaje actual ya esta en
el audit log cuando `leerHistorial` arma el contexto. El clasificador habria
visto el mensaje que esta clasificando como si fuera un mensaje anterior de
la misma persona. Se excluye por `messageId`, con su propio test. Salio al
disenar, no en produccion.

### Como quedo
- [x] `registrarRecibido` en `app.ts`, despues del dedup: la escritura
      arranca antes de encolar (queda aunque el proceso muera antes de
      procesarlo) y la tarea la espera antes de clasificar. No se espera
      antes de encolar: ver "Revision del PR" mas abajo.
- [x] La captura del fallo envuelve **todo** `handleIncomingMessage`, no solo
      el clasificador: una caida de Tokko o de Calendar tambien es un mensaje
      que se perderia. El error se relanza para que la cola lo siga
      logueando.
- [x] `AuditLogEntry` suma `messageId` y `etapa` (`recibido` | `fallido`),
      opcionales: las entradas viejas y las de los jobs no cambian.
- [x] El colapso se hace **al leer** y no en `readAll()`: si lo hiciera
      `readAll()`, la purga de retencion reescribiria el archivo ya colapsado
      y borraria registros sin contarlos como borrados.
- [x] `pendientes` pone primero los mensajes `fallido` y los `recibido` que
      nunca se resolvieron: nadie les contesto.
- [x] En modo silencioso el aviso llega igual: `SilentModeSender` solo deja
      pasar envios al broker, y el aviso va al broker.
- [x] El mutation testing destapo un **error de logica** en el corpus de
      estilo: si el ultimo mensaje del cliente fallaba y el broker contestaba
      a mano, el ejemplo se guardaba con el intent de un mensaje anterior,
      posiblemente de otro tema. Ahora no se guarda: si no se sabe que
      pregunto, no se sabe que estaba respondiendo. Con dos tests.
- [x] 25 tests nuevos; suite completa 606/606.
- [x] **Mutation testing** de las mitigaciones, una por vez:
      - 1. no se escribe el recibido: 4 tests en rojo
      - 2. no se escribe el fallido: 1 tests en rojo
      - 3. el fallo no se le avisa al broker: 3 tests en rojo
      - 4. escribir el recibido puede tirar (FM3): 1 tests en rojo
      - 5. leerHistorial no colapsa (FM2): 1 tests en rojo
      - 6. el contexto incluye el mensaje actual: 1 tests en rojo
      - 7. appendAudit sin messageId: 5 tests en rojo
      - 8. sin agrupar: todos sueltos (FM4): 4 tests en rojo
      - 9. sin aviso de recuperacion: 2 tests en rojo
      - 10. corpus de estilo con el intent centinela: 2 tests en rojo
      - 11. corpus de estilo salteando el mensaje sin resolver (la logica vieja): 2 tests en rojo

### Revision del PR (#30): lo que se arreglo antes de mergear
El code review encontro 15 cosas. Siete eran del propio bloque (regresiones
o promesas que el bloque hace y no cumplia) y se arreglaron aca:
- [x] **El clasificador leia el futuro.** En una rafaga, los `recibido` de
      los mensajes que esperan en la cola ya estan en el audit log, y
      `leerHistorial` los pasaba como contexto del mensaje anterior: "hola"
      se clasificaba leyendo "quiero agendar" que llego despues. Ahora el
      contexto excluye los `recibido` sin resolver; como la cola es serial
      por conversacion, los anteriores ya estan resueltos. Los `fallido` si
      entran: el cliente los escribio.
- [x] **El orden de llegada dependia del disco.** Con `await` de la escritura
      antes de encolar, dos mensajes seguidos se encolaban en el orden en que
      termino cada escritura, no en el que llegaron.
- [x] **Las ordenes del broker disparaban el aviso** ("contestale vos" sobre
      su propio mensaje) y contaban para agrupar los fallos de clientes.
- [x] **Un reproceso fallido tapaba una respuesta real.** Tras un reinicio el
      dedup se pierde y Meta puede reentregar un mensaje ya contestado; si el
      reproceso fallaba, `colapsarPorMensaje` mostraba `fallido`. Ahora gana
      la etapa mas avanzada: resuelta > `fallido` > `recibido`.
- [x] **`pendientes` escondia los `fallido`** de conversaciones que el agente
      habia contestado alguna vez: "respondida" era de toda la conversacion.
      Ahora es del ultimo mensaje. (Script sin tests: se verifico leyendo.)
- [x] La entrada `fallido` decia "se le aviso al broker", pero se escribe
      antes del aviso y el aviso puede no salir. Ya no lo afirma.
- [x] Las mediciones descartaban el TEXTO de los mensajes fallidos, y con eso
      el contexto dejaba de ser el de produccion. Ahora se conserva el texto
      y solo el intent centinela queda fuera (`medir:*`, `etiquetar`).
- [x] Mutation testing de los arreglos, uno por vez:
      - M1. el contexto incluye los recibido sin resolver: 1 test en rojo
      - M2. `await` de la escritura antes de encolar: 1 test en rojo
      - M3. las ordenes del broker disparan el aviso: 2 tests en rojo
      - M4. colapsar deja ganar a la ultima escrita: 1 test en rojo
      - M5. la tarea no espera el recibido: **sobrevivio** — ningun test
        tenia un disco lento. Se agrego uno; ahora 1 test en rojo.

### Riesgos abiertos
- [ ] **Todo lo que le llega al broker es texto libre** (`sendText`), y la
      ventana de servicio de 24 hs de Meta aplica tambien a el: si el numero
      del broker no le escribio a la linea del bot en las ultimas 24 hs, Meta
      responde 200 y no entrega (Bloque 10 ya lo vio con el numero de
      prueba). Vale para el aviso de fallos **y para los borradores del modo
      silencioso**. No es de este bloque — viene del Bloque 5 — pero este
      bloque existe para que el broker se entere, y con la ventana cerrada no
      se entera. Pasa al Bloque 38.
- [ ] **Un exito cualquiera cierra la caida.** En una caida parcial (Tokko
      caido, Claude andando; o Claude caido y un cliente pausado que no lo
      necesita) cada fallo sale suelto y el exito siguiente manda "volvio a
      procesar". Es ruido, no perdida: el aviso de cada fallo sale igual.
- [x] *(Resuelto en el Bloque 38b.)* **Una llamada que se cuelga no es un fallo.** Si la API de Anthropic no
      responde (en vez de tirar error), la cola descarta la tarea a los 60 s
      y sigue, pero no se escribe `fallido` ni sale aviso hasta que la
      llamada termine: el SDK espera 10 minutos por intento, con reintentos.
      Arreglo: timeout explicito en el cliente de Anthropic. Pasa al Bloque 38.
- [x] *(Resuelto en 38d.)* **Un envio al cliente que falla no es un fallo.** La captura termina
      antes de `sendText`. En modo silencioso no se le manda nada al cliente,
      asi que hoy no aplica; bloquea apagarlo. Pasa al Bloque 38.
- [ ] El `fallido` no guarda que tools ya se habian llamado: si Calendar creo
      el evento y despues fallo el redactor, el audit log no lo muestra.
- [ ] Un `recibido` que queda huerfano por un reinicio (deploy con mensajes en
      la cola) no se le avisa a nadie: solo aparece en `pendientes`. Se cruza
      con el drenado al apagar del Bloque 35.
- [ ] El corpus de estilo puede guardar un ejemplo con el centinela
      `agente_pausado` (no es de este bloque, ya pasaba). Inofensivo: ese
      intent nunca se usa para redactar.
- [ ] El aviso de fallos vive en memoria: si el proceso se reinicia en medio
      de una caida, el resumen pendiente se pierde. El registro de verdad
      sigue en el audit log, donde cada mensaje queda como `fallido`.
- [ ] **Los mensajes que no son texto** (audios, fotos) se cuentan en
      `/health` pero no quedan en el audit log ni avisan. El 18/09 entro un
      audio y no dejo rastro. Decision pendiente: si se registran, y si avisan
      uno por uno.
- [ ] Un mensaje que llega con el servidor caido se pierde antes de llegar
      aca: el proveedor no reintenta. Este bloque no lo cubre.

## Bloque 32 — Contexto de conversacion en el clasificador
Cierra la parte grande del Bloque 28. Salio de etiquetar A MANO 43
conversaciones reales (`npm run etiquetar`), porque medir el clasificador
contra sus propias etiquetas es circular.

### El diagnostico, con la verdad de base manual
Los 5 leads que el clasificador perdia enteros **eran todos continuaciones**:
"si dale", "Recordame el link porfa", "Mayormente eso". Ninguno es
clasificable aislado y **ningun intent nuevo los arregla**. Dos de esos cinco
eran ademas el UNICO mensaje de la conversacion: respondian a algo que el
broker habia mandado, no iniciaban nada.

Confirmado en el codigo: `classify(message: string, catalog)` recibia **solo
el texto del mensaje actual**. Ni historial, ni mensaje previo, ni si hubo un
contacto saliente.

- [x] `ContextoConversacion`: mensajes entrantes previos + **hace cuantas
      horas el broker le escribio a esa persona**. El segundo dato es el que
      mas aporta y el unico que sirve para los casos de mensaje unico.
- [x] **No incluye que dijo el broker.** Los dos registros de salientes estan
      partidos a proposito por la decision de privacidad del corpus de estilo
      (uno tiene telefono sin texto, el otro texto sin telefono) y no se pueden
      unir. Para que el agente pudiera responder CON el link correcto habria
      que reabrir esa decision.
- [x] Techo de 4 mensajes y 220 caracteres: el clasificador esta en el camino
      critico de cada webhook (1686-2241 ms medidos).
- [x] Busqueda del hilo por igualdad **exacta** del `conversationId`, nunca
      canonica: un match flojo mezclaria dos conversaciones y el clasificador
      leeria la de otro (Bloque 17).
- [x] Si el audit log falla, se clasifica sin contexto en vez de perder el
      mensaje.

### Dos intents nuevos (el resto del Bloque 28)
- [x] `rechazo_desinteres` — no existia ningun intent para que el cliente diga
      que NO. Dos de los cinco leads perdidos eran rechazos. **Depende del
      contexto**: "no, gracias" aislado no se distingue de un no a cualquier
      cosa.
- [x] `derivacion_colega` — colegas de otras inmobiliarias derivando un
      cliente. Antes caian en fallback o, peor, en `reclamo_queja` (paso con
      "Fiedotin Propiedades").
- Los dos con `requires_broker: true`, con el motivo escrito en el YAML.

### Criterio de aceptacion (definido por el dueno del repo ANTES de empezar)
"Si la precision cae, el contexto no se mergea, aunque el recall suba."

    A) hoy                 precision 29%  recall 13%
    B) catalogo nuevo      precision 36%  recall 25%
    C) bloque completo     precision 50%  recall 38%

Reejecutable: `npm run medir:clasificador`.

**Error corregido en la propia medicion antes de darla por buena**: contaba A
como "cualquier mensaje de la conversacion matcheo" y B/C como "el ultimo
mensaje matcheo". A tenia muchas mas oportunidades de acertar, y el recall
parecia desplomarse de 69% a 38% por la metrica, no por el cambio.

**Pregunta que lo habria agarrado antes**: *"las variantes que comparo,
¿responden exactamente la misma pregunta?"*.

### Medicion en produccion (la comparable, 230 mensajes)
El criterio de aceptacion se midio sobre el ULTIMO mensaje de cada
conversacion. Esta corrida clasifica **cada mensaje** con el contexto que
habria tenido en ese momento (`ms.slice(0, k)`, nunca mensajes del futuro),
que es lo que el sistema hace de verdad. `npm run medir:produccion`.

    referencia (hoy)   precision 42%  recall 69%
    bloque completo    precision 52%  recall 81%   TP=13 FP=12 FN=3 TN=16

- [ ] **La senal de contacto del broker quedo sin validar.** Cubre 5 de 230
      mensajes: el registro de contactos arranca el 26/8 (cuando se engancho
      el eco) y el audit log va del 26/7 al 28/8. De 44 conversaciones, 11
      tienen registro y solo 2 lo tienen ANTERIOR a algun mensaje; usar las
      otras 9 seria filtrar informacion del futuro. Se valida sola con
      trafico en vivo. En el unico caso donde aplico (***9262) movio la
      clasificacion en la direccion correcta.
- [ ] **El clasificador no es determinista.** Dos corridas con entradas
      identicas dieron intents distintos (***3640: fallback vs
      rechazo_desinteres). Sobre 44 casos eso es ruido de corrida encima del
      ruido de muestra. Los numeros son una direccion, no una medicion fina.

### RIESGO ABIERTO: la plantilla de espera se repite literal
Encontrado mirando el recorrido caso por caso, no en ninguna metrica: las
agregadas cuentan una conversacion como bien atendida si **algun** mensaje
escalo, y eso tapa lo que recibe la persona en los otros.

`fallback_low_confidence` responde `template` con texto fijo y sin variables.
Con el modo silencioso apagado, los 16 leads etiquetados recibirian **57
envios de la misma frase literal**. El peor caso (***3661) son 16 repeticiones
de "Dejame confirmarlo con el asesor y te respondo enseguida" en una
conversacion de 18 mensajes; ***9738 otras 16.

**Es bloqueante para apagar el modo silencioso**, mas que la precision: un
cliente que recibe la misma frase 16 veces ve un bot roto. Ninguna metrica de
clasificacion lo iba a mostrar, porque el intent es CORRECTO — el problema es
que hacemos con el.

Opciones sin decidir (es decision del dueno del repo): no repetir la
plantilla si ya se mando en la misma conversacion; variar el texto; o quedarse
callado despues de la primera y solo escalar.

**Pregunta que lo habria agarrado antes**: *"si esta conversacion tiene 18
mensajes, ¿que recibe la persona en los 16 que no escalaron?"*.

### Lo que queda del catalogo
- [ ] **El umbral de confianza, quieto por decision del dueno del repo.** Subir
      a 0.6 mejoraria la precision unos 8 puntos y costaria 6 de recall, y no
      toca ninguno de los casos perdidos, que estaban en fallback por falta de
      contexto y no por umbral.
- [ ] La muestra es chica: 16 leads y 28 no-leads. Un caso mueve el numero 6
      puntos. La direccion es clara, la magnitud no.
- [ ] El contexto tambien introduce falsos positivos nuevos: "nos vemos"
      (etiquetado no-lead) paso a `agendar_visita` 0.72. Neto positivo, pero
      no es gratis.

## Bloque 35 — El bot corre en un servidor (AWS Lightsail)

El bot corría en la laptop y estuvo apagado del 30/8 al 15/9 sin que nadie lo
notara: dos semanas sin audit log ni borradores para el broker.

Decisión del dueño del repo (2026-09-15), después de investigar Railway, Render
y AWS con experiencias de usuarios de 2025–2026: **AWS Lightsail, instancia de
2 GB en Ohio (`us-east-2`)**. Operación y comandos en `infra/aws/README.md`.

### Por qué Lightsail
- **Railway:** 5 incidentes que afectaron servicios en marcha en unos 7 meses,
  uno de ~8 h en todas sus regiones (19/5/2026). Recomienda el plan Pro
  (USD 20 mínimo) para uso comercial, y los backups de volumen figuran como
  exclusivos de Pro.
- **Render:** el plan de 512 MB no alcanza para lo medido abajo, y el
  siguiente ya es de 2 GB por USD 25.
- **AWS:** ninguna opción administrada cumple "siempre prendido + disco + una
  sola instancia" dentro de USD 5–15. App Runner no acepta clientes nuevos
  desde abril de 2026. Lightsail es un VPS: precio fijo, snapshots diarios y el
  mantenimiento a nuestro cargo, casi todo automatizado.

### Lo que se midió antes de diseñar
- **RAM en reposo:** con `tsx`, 12 procesos y ~606 MB; compilado, 4 procesos y
  ~280 MB (medido en Windows, sin tráfico). En 2 GB entra holgado con `tsx`, así
  que compilar queda como mejora y no como requisito.
- **`tsx` es devDependency, pero se usa en producción** para lanzar los MCP
  servers.
- **Dos cálculos dependen de la hora local del proceso:** `recontactoPolicy.ts`
  (`getHours`) y `topeDiarioStore.ts` (`getDate`).
- **El apagado existe pero no drena la cola.** `shutdown` cierra el HTTP, frena
  el scheduler, cierra los MCP y hace `process.exit(0)` sin esperar los mensajes
  en curso.
- **Los MCP servers no heredan el entorno completo:** reciben
  `getInheritableEnv()` más las variables de config.
- **Lightsail solo importa claves RSA.** La clave ed25519 se instala con el
  script de primer arranque.
- **`core.autocrlf=true` y no había `.gitattributes`.**

### Pre-mortem
Obituarios previos que aplican directo:
- *"¿qué pasa si esto se conecta y funciona antes de que yo esté listo?"*
  (incidente del 2026-08-12)
- *"¿qué se rompe solo, sin que nadie toque nada?"*
- los tests en verde que no prueban el comportamiento real (el `max_tokens: 32`
  del Bloque 10)

**1. `/health` en verde con el bot roto.**
Si la instalación omite las devDependencies (`NODE_ENV=production`), `tsx` no
está y los MCP servers no arrancan. Toda consulta a Tokko o a Calendar falla,
pero el HTTP responde y `/health` dice `ok`.
- *Mitigado:* `npm ci` corre sin `NODE_ENV`, y el deploy verifica con `pgrep` que
  los tres MCP servers estén vivos. Si no lo están, falla y muestra los logs.

**2. Dos bots vivos con las mismas credenciales.**
Si después de migrar alguien levanta el orchestrator en la laptop con el `.env`
de producción, su scheduler corre en paralelo al del servidor: recordatorios
dobles hoy, recontactos dobles cuando se cablee el Bloque 27, y dos audit logs
que divergen.
- *Mitigado en parte:* `migrar.sh` se niega a correr si el bot de la laptop
  responde.
- *Riesgo abierto:* ninguna guarda en el código impide que el scheduler corra
  fuera del servidor.

**3. La hora del servidor corrida 3 horas.**
El servidor arranca en UTC. La ventana de 9 a 20 del recontacto pasaría a ser
de 6 a 17 hora argentina, y el tope diario se reiniciaría a las 21.
- *Mitigado:* zona horaria del sistema en `America/Argentina/Buenos_Aires`, que
  alcanza a todos los procesos, incluidos los MCP servers que no heredan el
  entorno. Además, `TZ` en la unidad de systemd. El deploy imprime la hora del
  servidor.

**4. El modo silencioso se apaga al migrar.**
Hoy depende de que `AGENTE_MODO_SILENCIOSO` no figure en el `.env`. Una edición
del `.env` en el servidor lo apagaría sin revisión.
- *Mitigado:* la unidad de systemd lo fuerza en `true`, y dotenv no pisa
  variables que ya existen. Apagarlo exige cambiar un archivo versionado, con
  PR. El deploy compara el valor **efectivo** del proceso (`/proc/<pid>/environ`)
  con el de la unidad, y falla si no coinciden.

**5. Se pierden mensajes en cada reinicio.**
El apagado no drena la cola y DoubleTick no reintenta. Reinician el bot cada
deploy y los reinicios automáticos por parches de seguridad.
- *Riesgo asumido:* los reinicios automáticos quedan a las 06:00 y los deploys
  se hacen en horario tranquilo. Drenar la cola al apagar queda como bloque
  chico aparte.

**6. Todo en un solo disco, en una sola cuenta.**
Si la instancia se rompe o la cuenta se cierra, se pierden el audit log y el
corpus de estilo. Con el Free plan, AWS cierra la cuenta a los 6 meses y borra
todo 90 días después.
- *Mitigado en parte:* snapshots automáticos diarios de Lightsail (06:00 hora
  argentina, 7 días) y cuenta en plan pago.
- *Riesgo abierto:* no hay copia fuera de AWS.

**7. Un secreto termina en un log.**
La verificación del webhook de Meta manda el `hub.verify_token` en la query
string, y un log de accesos del proxy lo guardaría en texto plano.
- *Mitigado:* Caddy corre sin log de accesos, y solo se publica `/webhook`.
  `/health`, que muestra la fuente de Tokko y los contadores, queda accesible
  únicamente desde el propio servidor.

**8. Los scripts locales leen datos viejos.**
`npm run pendientes`, `etiquetar` y `medir:*` leen `apps/orchestrator/data/` de
la laptop. Después de migrar, esa copia queda congelada y `pendientes`
mostraría una lista vieja de clientes sin responder.
- *Mitigado:* `infra/aws/npm-en-servidor.sh pendientes` corre el script en el
  servidor, contra los datos reales, sin traer datos personales a la laptop.

**9. Los finales de línea de Windows rompen los scripts en Linux.**
Con `core.autocrlf=true`, un script de bash que llega con `\r` falla en el
servidor con errores crípticos.
- *Mitigado:* `.gitattributes` fuerza LF en `*.sh` y `*.service`, y los scripts
  se niegan a mandar al servidor un archivo con CRLF.

**10. El nombre del servidor depende de un tercero.**
Con sslip.io, si ese DNS gratuito se cae, DoubleTick no resuelve la URL y los
mensajes no llegan.
- *Recomendado:* subdominio propio del negocio. Si se usa sslip.io, queda como
  riesgo asumido.

### Hallazgos durante la implementación del Bloque 35
- **Norton 360 intercepta el HTTPS de la laptop.** Su Web/Mail Shield firma los
  certificados con "Norton Web/Mail Shield Root". Windows y Node confían en esa
  raíz (el propio Norton define `NODE_EXTRA_CA_CERTS`); la AWS CLI no, y fallaba
  en toda llamada a AWS con `CERTIFICATE_VERIFY_FAILED`, incluido el último paso
  de `aws login`. Resuelto con `infra/aws/confiar-antivirus.sh`, que configura un
  paquete de certificados solo en los perfiles del bot.
- **Una verificación de HTTPS hecha desde la laptop engaña.** El `curl` de Git
  Bash da un error de certificado falso, y el de Windows podría aceptar un
  certificado roto porque ve el de Norton. El certificado del servidor se
  verifica desde el propio servidor.
- **`MSYS_NO_PATHCONV=1` aplicado a todo un script rompe los ejecutables
  nativos.** Hace falta para `aws.exe`, pero `openssl` (de `/mingw64`) deja de
  recibir rutas traducidas y no encuentra los archivos. Se aplica solo a las
  llamadas a `aws`.
- **La cuenta de AWS estaba en Free plan, sin MFA en el usuario raíz y sin
  alarma de gasto.** Lo detectó `infra/aws/configurar-acceso.sh` leyendo el
  estado real con la CLI, en lugar de depender de una confirmación de palabra.
  Verificado por CLI el mismo 15/9, con otra sesión de administrador: plan
  **pago y activo** (USD 120 de crédito restante) y alarma de gasto creada
  (USD 20 por mes, aviso al 80% del gasto real). El **MFA del usuario raíz no
  aparece** (`AccountMFAEnabled = 0`), aunque se había dado por activado. Es
  el caso por el que se verifica en vez de confiar en la confirmación. Ese
  `aws login` tampoco lo probaba: reutilizó una sesión de consola ya abierta y
  no pidió código.
- **`aws login` evita manejar la clave a mano.** Con una sesión temporal de
  administrador, `configurar-acceso.sh` creó el usuario `claude-lightsail`
  (solo Lightsail), guardó su clave sin mostrarla y cerró la sesión.

- **El primer deploy real falló por algo que existía solo en la laptop.**
  `shared-types` se consume por su `main` (`dist/index.js`), y `dist/` está en
  `.gitignore`: `git archive` no lo trae. En la laptop funcionaba porque `dist/`
  había quedado de una compilación anterior. La verificación del deploy lo
  agarró (`/health` no respondía y mostró `ERR_MODULE_NOT_FOUND`), y ahora el
  deploy compila `shared-types` después de `npm ci`.
**Pregunta que lo habría agarrado antes**: *"¿por dónde pasa el tráfico de esta
máquina antes de llegar a internet?"*. El antivirus estaba en el medio de toda
conexión HTTPS de la laptop, y el diseño asumía una conexión directa.

Y para el deploy: *"¿qué tiene mi máquina que no está en el repo?"*. Un
artefacto compilado que nadie recordaba haber generado alcanzó para que todo
andara local y nada arrancara en el servidor.

### Estado
- [x] Scripts de creación, preparación, migración y deploy (`infra/aws/`).
- [x] Crear el servidor y hacer el primer deploy (2026-09-15, `ae811db497d9`).
      Medido en el servidor: 501 MB de memoria real del servicio (límite 1500),
      905 MB de 1907 en toda la máquina.
- [x] Pasarle a DoubleTick la URL nueva y verificar que llegan mensajes. La
      cambiaron el 15/09 a las 20:09 y su evento de prueba llego: 200 en
      762 ms, cruzado con los logs. El canal siguio cortado por otra causa
      (Bloque 36) hasta el 18/09; ese dia entro trafico real y la prueba de
      punta a punta dio `consulta_disponibilidad` con 0.98 **sin responderle
      al cliente**.
- [ ] Guarda en el código contra dos schedulers (modo de fallo 2).
- [ ] Drenar la cola al apagar (modo de fallo 5).
- [ ] Copia de los datos fuera de AWS (modo de fallo 6).

## Bloque 36 — El numero dejo de recibir eventos de Meta (BLOQUEANTE)
Medido el 2026-09-15, justo despues de terminar el deploy en AWS.

### Lo que esta medido
- **DoubleTick no recibe ningun evento de Meta para el numero 3207688612809306
  desde el 8/09 a las 17:30 ART.** Venia con 100-200 por dia y se corto de
  golpe. El resto de sus lineas sigue recibiendo con normalidad.
- El cambio de URL al servidor nuevo **quedo aplicado y probado**: 15/09 20:09,
  y su evento de prueba de 20:17:56 llego y recibio 200 en 762 ms. Cruzado con
  los logs del servidor: aceptado con el secreto valido, 305 bytes.
- **Nuestro `WHATSAPP_ACCESS_TOKEN` es un usuario de sistema de la app del
  proveedor**, no de una app nuestra: `GET /me` devuelve `tick-app System User`
  (122101787181419977). El token es **valido**.
- **Ese token ya no tiene acceso al numero.** Leer `/{phone_number_id}` y hasta
  un POST de envio sin destinatario fallan con `code 100, error_subcode 33`.
  O sea: hoy el bot **tampoco podria enviar** un mensaje.
- `/me/businesses` y `/{usuario-de-sistema}/assigned_whatsapp_business_accounts`
  devuelven **listas vacias**: no es falta de permiso de lectura, no hay activos
  asignados.
- **El `waba_id` de nuestro `.env` (846618321715441) no coincide con el que
  nombra el proveedor (103523025667743).** Ninguno de los dos se puede leer.

### Lo que NO esta demostrado
- **Cuando** se perdio el acceso. Desde nuestro lado no hay forma de fecharlo:
  el audit log se corta el 30/08 porque el bot estaba apagado, y no hubo envios
  posteriores. La unica fecha es la medicion del proveedor.
- Que alguien haya quitado la app del WABA. El proveedor lo afirmo y despues se
  corrigio solo: su error de permisos tampoco probaba eso.
- Si el numero se movio de WABA o de Business Manager.

### Consecuencia
El canal entrante estaba cortado **desde antes** del deploy, y el saliente
tambien. El servidor esta sano y probado, pero no hay eventos para reenviar.
Esto bloquea todo lo demas: sin canal no hay trafico real que medir ni modo
silencioso que apagar.

- [x] Que cambio alrededor del 8/09: el numero quedo **desconectado de la
      plataforma**. La sesion de WhatsApp Business se cerro y se volvio a
      abrir por esos dias. No se pudo fechar el corte con precision desde
      aca; la unica fecha es la medicion del proveedor.
- [ ] A que WABA pertenece hoy el numero y quien la administra.
- [x] Volver a dar de alta el acceso de la app del proveedor al numero. Hecho
      el 18/09 desde el panel de DoubleTick, escaneando el QR desde el
      iPhone: `status: CONNECTED`, y el `phone_number_id` **no cambio**, asi
      que el `.env` siguio siendo valido.
- [ ] Evaluar tener una app propia de Meta: hoy el token con el que el bot
      envia es de la app del proveedor, asi que su configuracion nos deja sin
      enviar tambien.

**Pregunta que lo habria agarrado antes**: *"¿que me avisa si el canal se corta
cuando nadie esta mirando?"*. El canal murio el 8/09, el bot estaba apagado
desde el 30/08, y se descubrio el 15/09 por un comentario del proveedor. Nada
en el sistema avisa que dejaron de llegar mensajes.

## Bloque 37 — Una linea rota del audit log no puede tumbar el bot
Salio de la revision del PR #29 (2026-09-19), verificado en el codigo:
`FileAuditLogStore.readAll()` hace `JSON.parse(line)` sin `try`, y el
arranque (`server.ts`) llama a `contactosConocidos.cargarDesde(auditLog)`. Una
sola linea ilegible hace que el proceso muera al arrancar, y systemd lo
reinicia en loop: **el bot queda caido hasta que alguien edite el archivo a
mano en el servidor**. Hoy el archivo del servidor esta sano (329 lineas, 0
rotas), pero una linea rota es exactamente lo que deja un corte a mitad de un
`appendFile`: el proceso muere, queda media linea sin salto, y la siguiente
entrada se pega detras.

No es solo el arranque. `leerHistorial` atrapa el error y sigue sin historial,
y con eso el Bloque 31 **falla cerrado para siempre**: sin historial se
suprime toda plantilla fija, en todas las conversaciones, hasta que alguien
arregle el archivo. `pendientes` y las mediciones tambien mueren.

### Pre-mortem
**1. Leer tolerante convierte la purga en un borrado silencioso.**
`purgeOlderThan` reescribe el archivo con lo que devolvio `readAll()`. Si
`readAll()` saltea las lineas rotas, la primera purga que borre algo las
elimina del disco sin contarlas, y nadie puede revisarlas despues. Borrar
datos es decision del dueno del repo, no un efecto secundario de leer.
   *Mitigacion*: la purga no descarta las lineas ilegibles; las fecha por
   posicion y aplica la retencion como a cualquier entrada (ver "Revision del
   PR"). Test contra un archivo real, no contra el store en memoria.

**2. Tolerar en silencio esconde el problema.** Si algo empieza a escribir
basura, `readAll()` devuelve menos entradas y todo parece andar: el contexto
del clasificador se achica, `pendientes` muestra menos, la plantilla del
Bloque 31 se repite. Es el mismo silencio del Bloque 34 con otra causa.
   *Mitigacion*: un aviso en el log con la cantidad y el numero de linea (sin
   el contenido: son mensajes de clientes), cuando cambian las lineas rotas y
   no en cada mensaje. Test del aviso. Solo en el log: ver riesgos.

**3. La entrada que se pega a la media linea se pierde.** Despues de un corte,
la primera entrada nueva se escribe detras de la media linea, sin salto, y
las dos juntas son una sola linea ilegible. Tolerar la lectura no la
recupera: la entrada buena se pierde igual, y es la primera despues de un
reinicio, justo la que mas importa.
   *Mitigacion*: cada escritura mira si el archivo termina en salto de linea
   y, si no, lo antepone. Test con un archivo que termina en media linea.

### Descartado a proposito
- Intentar reparar las lineas rotas (separar `}{`, etc.): adivina, y una
  reparacion equivocada es peor que una linea marcada como ilegible.
- Los otros stores quedan fuera, pero **no porque esten a salvo** (lo crei al
  escribir este pre-mortem y lo verifique antes de dejarlo: era falso).
  Quedan como riesgo abierto, abajo.

### Como quedo
- [x] `parsearAuditLog` separa las entradas de las lineas ilegibles: JSON
      roto, o JSON valido que no es una entrada (sin `conversationId`, o sin
      un `timestamp` que se pueda fechar). `FileAuditLogStore.readAll()` la
      usa y ya no tira.
- [x] **La purga fecha las lineas rotas por posicion.** El archivo se escribe
      en orden, asi que una linea rota es anterior a la proxima entrada
      legible. Si esa entrada vencio, la rota tambien: se borra y se cuenta
      en el reporte (`linea ilegible N`, con la fecha que motivo borrarla).
      Si no vencio, o si no hay nada despues, se conserva **en su lugar**,
      para que la fecha por posicion siga valiendo en la purga siguiente.
      Verificado sobre los datos locales: 313 entradas, 0 fuera de orden.
- [x] Aviso en el log con la cantidad y los numeros de linea, sin el
      contenido, cada vez que cambian las lineas rotas (no la cantidad: tras
      una purga los numeros se corren).
- [x] **Cada escritura** mira si el archivo termina en media linea y, si
      hace falta, antepone el salto en la misma escritura. No una vez por
      proceso: el corte puede pasar con el proceso vivo (disco lleno) o por
      una edicion a mano.
- [x] `pendientes`, `medir:*` y `etiquetar` leen con `leerAuditLogExistente`:
      tolerante con las lineas rotas, pero un archivo que no existe es un
      error. Con `readAll()`, un symlink roto en el servidor hacia que
      `pendientes` dijera "nadie espera respuesta". `pendientes` da la misma
      salida que antes sobre los datos locales (mismo hash).
- [x] 15 tests nuevos, contra un archivo real; suite 629/629. Mutation testing, una por vez:
      - B1. la purga descarta las ilegibles: 2 tests en rojo
      - B2. la purga nunca borra ilegibles (retencion incumplida): 2 tests en rojo
      - B3. sin aviso: 3 tests en rojo
      - B4. aviso en cada lectura: 1 test en rojo
      - B5. aviso solo si cambia la cantidad: 1 test en rojo
      - B6. sin reparar la linea cortada: 3 tests en rojo
      - B7. reparar una vez por proceso: 1 test en rojo
      - B8. lectura no tolerante (lo de antes): 12 tests en rojo
      - B9. acepta JSON sin fecha ni telefono: 1 test en rojo
      - B10. los scripts toman un archivo inexistente como vacio: 1 test en rojo

### Revision del PR (#31)
La primera version tenia tres errores que la revision agarro:
- **Conservaba las lineas rotas para siempre.** Evitaba el borrado silencioso
  del modo de fallo 1, pero las lineas rotas son mensajes de clientes y la
  politica publicada promete borrarlos a los 12 meses. La retencion habria
  quedado incumplida con apariencia de cumplida, que es justo lo que
  `purge.ts` advierte. Ahora se fechan por posicion (arriba).
- **Reparaba el final del archivo una sola vez por proceso.** Un corte con el
  proceso vivo, por disco lleno, quedaba sin reparar.
- **`server.ts` arrancaba sin contactos conocidos** si la carga fallaba por un
  error de disco. Eso cambiaba un loop de reinicios, visible y que se
  reintenta solo, por un filtro del eco que descartaba a todos los clientes
  en silencio durante todo el proceso. Se saco: una linea rota ya no tira, y
  un error de disco tiene que verse.

**Pregunta que lo habria agarrado antes**: *"¿que pasa si el proceso muere a
mitad de esta escritura, y que lee el que arranca despues?"*. El audit log se
diseno para que nunca se pierda nada, y nadie se pregunto que queda en disco
cuando la escritura misma se corta.

### Riesgos abiertos
- [ ] **El aviso de lineas rotas va solo al log del servidor**, que nadie lee.
      Es la leccion del Bloque 36 ("¿que te avisa cuando nadie esta
      mirando?") otra vez: este bloque no la resuelve.
- [ ] Si la linea que se corta es justo la entrada que registro una
      plantilla fija, esa conversacion pierde el registro y la plantilla
      puede volver a salir una vez (Bloque 31). Antes, la misma linea tumbaba
      el bot entero.
- [x] *(Resuelto en el Bloque 39.)* **El reporte de retencion** (`retentionReportStore.ts`) tambien es JSONL
      con `JSON.parse` sin `try`. Con una linea rota, la corrida siguiente
      tira al guardar el reporte, **despues** de haber purgado: con el borrado
      prendido, se borran datos y no queda reporte. El lector de este bloque
      se puede generalizar a los tres JSONL (audit log, reporte, corpus de
      estilo).
- [ ] Una linea rota se reescribe desde el texto ya decodificado: si el corte
      partio un caracter con tilde o un emoji, al reescribirla ese byte queda
      como U+FFFD. Solo afecta a lineas que ya estaban rotas.
- [ ] Los scripts leen `apps/orchestrator/data/audit_log.jsonl` fijo e ignoran
      `AUDIT_LOG_PATH`. Hoy da igual, porque en el servidor `data` es un
      symlink al directorio real, pero si alguien configura la variable, los
      scripts leerian otro archivo sin avisar.
- [ ] La purga lee, filtra y reescribe sin lock: una entrada que se agrega
      entre la lectura y el rename se pierde. Ya pasaba antes de este bloque;
      la purga corre en cada vuelta del scheduler (cada 5 minutos en el
      servidor, visto en el log del 19/09) y la ventana es de milisegundos.
- [ ] **Los stores JSON enteros** (turnos, estado de conversacion, ultima
      interaccion: `jsonFileStore.ts`) se escriben con `writeFile` directo,
      sin temporal y rename. Un corte a mitad de la escritura deja el archivo
      truncado, y ese store entero queda ilegible hasta arreglarlo a mano.
      Es peor que una linea rota, y hoy no tiene mitigacion. Los de la
      purga del audit log y del reporte de retencion si usan temporal y
      rename.
- [ ] **El corpus de estilo** (`estiloBrokerStore.ts`) es JSONL con
      `appendFile`, igual que el audit log, y una linea rota hace que
      `all()` devuelva **vacio**: los borradores pierden el estilo sin
      aviso. Y `npm run estilo:reanonimizar` reescribe el archivo con lo que
      leyo, asi que con una linea rota **borra el corpus entero**.

## Bloque 38 — Escalamientos y avisos al broker (BLOQUEA APAGAR EL MODO SILENCIOSO)
Junta lo que dejaron abierto las revisiones de los PRs #29 (Bloque 31) y #30
(Bloque 34), el 2026-09-19. Ninguno de los dos PRs los introdujo todos: varios
vienen de antes y la revision los destapo. Se agrupan porque tocan el mismo
camino (que le llega al cliente y que le llega al broker cuando el agente
escala) y porque varios interactuan entre si.

Hay dos grupos, y el orden importa: el primero **afecta produccion hoy**, con
el modo silencioso prendido. El segundo solo muerde cuando se apague.

### Afecta hoy, con el modo silencioso prendido
- [ ] **La ventana de 24 hs de Meta tambien aplica al broker.** Todo lo que el
      bot le manda al broker es texto libre (`sendText`): los borradores del
      modo silencioso, los escalamientos, el aviso de fallos del Bloque 34.
      Si el ...6699 no le escribio a la linea del bot (...4543) en las
      ultimas 24 hs, Meta responde 200 y **no entrega**, sin error (Bloque
      10 ya lo vio con el numero de prueba). **El dueno del repo confirmo el
      19/09 que hoy le llegan**: el riesgo queda para cuando la ventana se
      cierre (un fin de semana sin escribirle al bot). Opciones: una
      plantilla aprobada para avisos al broker, o que el broker mantenga la
      ventana abierta escribiendole al bot.
- [x] *(38a, para los mensajes entrantes: si falla el borrador, el aviso sale
      igual; si falla el envio, queda en el audit log y `pendientes` lo
      muestra. El aviso del job de recontacto sigue sin cubrir: va con el
      Bloque 27.)*
      **Si falla la notificacion al broker, nadie se entera.** Si falla el
      borrador (Claude) o el envio, el escalamiento se pierde en su propio
      `catch`. Viene del Bloque 5. El aviso de fallos del Bloque 34 no lo
      cubre: ese salta cuando falla el procesamiento, no la notificacion.
- [x] *(Resuelto en 38b: 25 s por intento, 1 reintento; la cola, 90 s.)*
      **Una llamada a Anthropic que se cuelga no es un fallo.** El cliente del
      SDK no tiene timeout propio (10 minutos por intento, con reintentos).
      La cola descarta la tarea a los 60 s, pero no se escribe `fallido` ni
      sale aviso hasta que la llamada termine. Arreglo: timeout explicito en
      el cliente de Anthropic.

### Orden de trabajo (decidido al arrancar, 19/09)
Un PR por camino de codigo, para poder atribuir un fallo a un cambio:
38a aviso al broker sin borrador → 38g ordenes del broker en modo silencioso
(encontrado en la revision de 38a) → 38b timeout de Anthropic → 38c
plantillas crudas → 38d envios al cliente → 38e supresion de la plantilla →
38f deteccion de la respuesta del broker. La ventana de 24 hs espera una
decision del dueno del repo (plantilla aprobada o no).

### 38a — Si el borrador falla, el aviso al broker sale igual
Hoy `notifyBrokerBestEffort` redacta el borrador con Claude y manda el aviso
dentro del mismo `try`: si el borrador falla, **no sale nada** y el error
queda solo en consola. El clasificador y el borrador son llamadas distintas:
una puede andar y la otra no (un 529 de sobrecarga, un rate limit, un
timeout en la llamada mas larga). En modo silencioso el aviso es lo unico que
produce el bot, asi que ahi se pierde el mensaje entero para el broker.

**Pre-mortem**

**1. El aviso sin borrador sale, pero no se entiende.** Si el texto dice
`null` o deja el bloque del borrador vacio, el broker no sabe si falta el
borrador o si el bot no tenia nada que sugerir, y puede no contestar.
   *Mitigacion*: el aviso dice explicitamente que no hay borrador, por que, y
   que conteste el. Test del texto.

**2. El aviso tambien falla y el audit log dice que se escalo como siempre.**
Si lo que falla es el envio (WhatsApp caido, token vencido), no hay forma de
avisarle por el mismo canal. Si el audit log no lo registra, nadie puede
saber despues que ese escalamiento nunca le llego.
   *Mitigacion*: campo nuevo `avisoAlBroker` en la entrada del audit log
   (`enviado` / `sin_borrador` / `fallo`). Test de cada caso. Un fallo del
   aviso no hace fallar el mensaje: si tirara, el mensaje pasaria a
   `fallido` y el aviso de fallos del Bloque 34 mandaria otro aviso por el
   mismo canal que acaba de fallar.

**3. El borrador no falla: se cuelga.** Sin timeout, la llamada espera hasta
10 minutos por intento, con reintentos, y el aviso sin borrador no sale
hasta que se rinda.
   *No se mitiga aca*: es 38b. Hasta entonces, riesgo asumido.

**Como quedo**
- [x] `notifyBrokerBestEffort` separa el borrador del aviso y nunca tira. Si
      el borrador falla (o vuelve vacio), el aviso sale igual:
      - en modo silencioso, con la respuesta que el bot habria mandado como
        borrador, marcada como tal;
      - si no hay respaldo, con "Sin borrador: no se pudo redactar (motivo).
        Contestale vos."
- [x] Campos `avisoAlBroker` y `avisoAlBrokerMotivo` en el audit log.
      Valores: `enviado`, `respaldo`, `sin_borrador`, `fallo` y
      `sin_destinatario`. `enviado` significa que WhatsApp lo acepto, no
      que llego (la ventana de 24 hs sigue abierta como riesgo).
- [x] `pendientes` no esconde una conversacion cuyo aviso fallo, aunque el
      cliente haya recibido la plantilla de espera, y la marca "EL AVISO NO TE
      LLEGO". Misma salida que antes sobre los datos locales.
- [x] El aviso nunca pasa los 4096 caracteres de WhatsApp: el mensaje, el
      borrador y el motivo se recortan.
- [x] `docs/escalation_policy.md` paso 2: documentado el aviso sin borrador.
- [x] `appendAudit` recibe lo opcional por nombre: `escalationReason` y
      `responseSent` eran dos `string | undefined` seguidos por posicion.
- [x] 12 tests nuevos. Mutation testing, una por vez:
      - D1. si falla el borrador no sale el aviso (lo de antes): 4 tests en rojo
      - D2. un aviso que falla hace fallar el mensaje: 2 tests en rojo
      - D3. el audit log siempre dice `enviado`: 4 tests en rojo
      - D4. el audit log no registra el aviso: 7 tests en rojo
      - D5. el texto sin borrador muestra un borrador vacio: 2 tests en rojo
      - D6. el modo silencioso no registra el aviso: 1 test en rojo
      - D7. el aviso sin el motivo: 2 tests en rojo
      - E1. el motivo del modo silencioso habla de un borrador: **sobrevivio**,
        porque el test usaba un intent que escala y ese motivo va en el camino
        que no escala. Se agrego el test del camino correcto: 1 en rojo
      - E2. sin respaldo: 1 test en rojo
      - E3. el respaldo se registra como `sin_borrador`: 1 test en rojo
      - E4. un borrador vacio cuenta como borrador: 1 test en rojo
      - E5. sin tope de largo: 1 test en rojo
      - E6. "sin destinatario" no queda registrado: 1 test en rojo
      - E7. el motivo no va al audit log: 3 tests en rojo

**Revision del PR (#36)**: 14 hallazgos. Se arreglaron los que eran de 38a
(arriba). Quedan fuera, anotados:
- **Las ordenes del broker, en modo silencioso, no reciben respuesta** (38g,
  abajo). No es de este PR, pero es lo mas importante que encontro.
- El job de recontacto tiene su propio aviso al broker, que sigue tragandose
  el error sin registrarlo. No corre en modo silencioso; va con el Bloque 27.
- Pasar `draftReply` y `motivoFalloBorrador` a una union discriminada.
  Detalle de tipos, sin efecto hoy.

### 38b — Una llamada a Anthropic que se cuelga cuenta como fallo
El cliente de Anthropic se crea sin opciones, y el SDK (0.32) espera **10
minutos por intento, con 2 reintentos**: una llamada que se cuelga en vez de
fallar tarda hasta media hora en convertirse en error. Mientras tanto no hay
`fallido`, ni aviso de fallos (Bloque 34), ni aviso sin borrador (38a): la
cola descarta la tarea a los 60 s y sigue, pero la llamada sigue colgada.

**Lo que se midio antes de disenar** (audit log del servidor, 25 mensajes con
`recibido` y resolucion): de punta a punta, un mensaje tarda 7,6 s la mitad
de las veces, 9,9 s el 90% y 18,4 s como maximo (un `agendar_visita`), con 2
o 3 llamadas a Claude por mensaje. La mas pesada es la del planificador de
`broker_accion_directa` (1024 tokens de salida); las demas, 300 o menos.

**Decision** (corregida en la revision del PR, ver abajo): 25 s por intento y
1 reintento, y el techo por tarea de la cola sube de 60 a 90 s. Peor caso de
una llamada colgada: unos 51 s en vez de media hora, y falla antes de que la
cola abandone la tarea. Configurable con `ANTHROPIC_TIMEOUT_MS`, entre 1 y
30 s.

**Pre-mortem**

**1. El timeout es corto y convierte llamadas lentas pero sanas en fallos.**
En un rato de API lenta, los mensajes pasan a `fallido` y el aviso de fallos
le manda rafagas al broker por algo que se habria resuelto solo.
   *Mitigacion*: el valor sale de lo medido (arriba), con margen de 3 veces y
   con los reintentos. Configurable sin tocar codigo. Despues del deploy, mirar
   si aparecen `fallido` con "timed out" en el audit log.

**2. El timeout no llega a todas las llamadas.** Otro `new Anthropic(` en el
orchestrator, o la opcion mal escrita, y alguna llamada sigue esperando 10
minutos sin que ningun test lo note.
   *Mitigacion*: el cliente se crea en una sola funcion. Un test recorre el
   codigo del orchestrator y falla si aparece otro `new Anthropic(`. Otro test
   hace una llamada real del SDK contra un `fetch` que nunca responde y
   verifica que tire por timeout.

**3. Un valor mal escrito en el .env tumba el bot.** El SDK valida el timeout
al construir el cliente y tira si no es un entero positivo: con
`ANTHROPIC_TIMEOUT_MS=30s`, el proceso muere al arrancar y systemd lo
reinicia en loop, la misma clase de caida del Bloque 37.
   *Mitigacion*: un valor invalido se ignora con un aviso en el log y se usa el
   de por defecto. Test.

**Como quedo**
- [x] `agent/clienteAnthropic.ts`: el unico lugar donde se crea el cliente.
      Los numeros viven en `agent/limitesAnthropic.ts`, sin dependencias, asi
      la config no carga el SDK.
- [x] 25 s por intento, 1 reintento; el techo de la cola, 90 s. Un test
      verifica que cierren: el mensaje mas lento medido mas el peor caso de una
      llamada colgada tiene que quedar por debajo del techo, con el default y
      con el maximo que acepta el .env.
- [x] `ANTHROPIC_TIMEOUT_MS` se acepta entre 1 y 30 s; fuera de rango, o si no
      es un entero en decimal, se ignora con un aviso.
- [x] 11 tests nuevos. Uno hace una llamada real del SDK contra un `fetch` que
      nunca responde. La guarda contra un segundo cliente reconoce el SDK
      importado con otro nombre e ignora los comentarios, y tiene sus propios
      tests. Mutation testing, una por vez:
      - I1. el cliente sin timeout (lo de antes): 2 tests en rojo
      - I2. el timeout por default vuelve a 10 minutos: 3 tests en rojo
      - I3. dos reintentos (la primera version): 3 tests en rojo
      - I4. acepta cualquier entero positivo: 1 test en rojo
      - I5. la config ignora la variable: 1 test en rojo
      - I6a. `server.ts` crea su propio cliente: **sobrevivio** al principio,
        porque la guarda solo miraba nombres importados y la mutacion no
        importaba el SDK. Se reforzo: 1 test en rojo
      - I6b. otro archivo crea un cliente con otro nombre: 1 test en rojo
      - I7. la cola vuelve a 60 s: 2 tests en rojo
      - I8. el maximo del .env vuelve a 35 s: 1 test en rojo

**Revision del PR (#39)**: 8 hallazgos. El principal: con 30 s y 2
reintentos, una llamada colgada fallaba a los ~91 s, y la cola abandonaba la
tarea a los 60 s, antes del `fallido`. El problema quedaba resuelto a
medias. Arreglado con los numeros de arriba y el test que los ata. Tambien:
el rango del .env (un `30` pensado en segundos hacia fallar todas las
llamadas), la guarda con alias, y la config sin el SDK. Quedan anotados:
- [ ] **El timeout del SDK 0.32 cubre solo hasta los encabezados.** Si la
      conexion se traba a mitad del cuerpo de la respuesta, se espera hasta
      que el socket se da por inactivo (5 minutos). Las respuestas son chicas y
      no es comun, pero el peor caso de 51 s no vale ahi.
- [ ] Una llamada lenta pero sana (mas de 25 s dos veces seguidas) ahora es un
      fallo, y cada intento abortado se puede cobrar igual. El planificador de
      `broker_accion_directa` es el mas expuesto. Se puede subir hasta 30 s
      por .env.
- [ ] Lo de fondo: la cola no puede cancelar la tarea que abandona. Una fecha
      limite (`AbortSignal`) que baje de la cola a cada llamada ataria los dos
      numeros en vez de mantenerlos a mano.
- [ ] Despues del deploy, mirar si aparecen `fallido` con "timed out" en el
      audit log (modo de fallo 1).

### 38c — Ningun escalamiento le manda al cliente una plantilla con huecos
Cuando algo escala por **baja confianza**, `handleIncomingMessage` responde
con la plantilla **del propio intent**. Para los intents que escalan siempre
es una plantilla de espera, y esta bien. Para los demas es la plantilla del
caso exitoso, con huecos y afirmando algo que no paso: "Listo, {accion} tu
visita de {direccion_corta}...", "Te paso el material de {direccion_corta}:",
"Listo, {accion} para {alcance}.". Pasa desde el Bloque 5.

**Lo que se encontro al medir**, ademas de lo que decia el Bloque 38:
- El flujo de reprogramar manda la misma plantilla cruda en **dos
  escalamientos mas**: cuando no hay horarios libres, y cuando el cliente no
  elige ninguno de los que se le ofrecieron.
- El texto de espera para los intents sin plantilla ("Dejame confirmarlo con
  el asesor y te respondo enseguida.") esta escrito a mano en TypeScript en
  tres archivos, contra la regla de CLAUDE.md. Es el mismo texto que la
  plantilla de `fallback_low_confidence`.
- En el catalogo, los intents que escalan siempre tienen plantillas de espera
  sin huecos. Las plantillas con huecos son de intents que no escalan solos:
  `pedido_ficha_multimedia`, `reprogramar_cancelar_visita`,
  `recordatorio_visita`, `seguimiento_post_visita`, `broker_pausar_agente`.

**Pre-mortem**

**1. La plantilla de espera deja de existir o se rompe en el catalogo.** Si
alguien renombra `fallback_low_confidence`, le saca la plantilla o le agrega
un hueco, todo escalamiento responde con algo roto, y los tests del handler,
que stubbean el catalogo, no lo verian.
   *Mitigacion*: el catalogo dice cual es la plantilla de espera
   (`meta.escalation_waiting_template_from`) y la validacion del schema
   exige que el intent exista, tenga plantilla y no tenga huecos. Lo mismo
   para toda plantilla de un intent que escala siempre. Tests contra el
   catalogo real y contra catalogos rotos a proposito.

**2. Queda otro camino que manda una plantilla cruda.** Este bloque cierra
los que se encontraron; el proximo intent con plantilla, o el proximo flujo,
puede abrir otro sin que nadie lo note.
   *Mitigacion*: una red de ultima linea en el handler. Si la respuesta que
   va a salir tiene un hueco sin llenar (`{palabra}`), no sale: al cliente
   le va la plantilla de espera, y queda un error en el log. Test.

**3. La red salta con una respuesta legitima.** Si una respuesta generada
trae llaves por otra razon, el cliente recibiria la plantilla de espera en
vez de la respuesta.
   *Mitigacion*: el patron es estrecho, solo `{palabra_en_minusculas}`, que
   es la forma de los huecos del catalogo. Un texto generado que repite un
   hueco tal cual es, de todas formas, un error que conviene cortar. Test de
   que llaves con otro contenido pasan.

**Como quedo**
- [x] `meta.escalation_waiting_template_from: fallback_low_confidence` en el
      catalogo. La validacion del schema exige que ese intent exista, tenga
      plantilla y no tenga huecos, y que ninguna plantilla de un intent que
      escala siempre tenga huecos. Si no, el catalogo no carga.
- [x] `respuestaDeEspera`: un intent que escala siempre responde con su
      propia plantilla de espera; cualquier otro, con la de espera del
      catalogo. La usan el handler y los flujos de agendar y reprogramar, que
      ya no tienen el texto escrito en TypeScript.
- [x] Red de ultima linea en el handler, **solo para respuestas a clientes**:
      una respuesta con un hueco sin llenar no sale. Le llega la plantilla de
      espera, el mensaje **escala de verdad** (aviso al broker,
      `escalatedToBroker` en el audit log, sin las fotos) y la conversacion
      vuelve a idle, para que un "ok" no confirme algo que el cliente no vio.
      Queda un error en el log con el intent.
- [x] El patron de hueco (`HUECO_DE_PLANTILLA`, en shared-types) ve tambien
      tildes, mayusculas y numeros (`{direccion}`, `{Nombre}`, `{direccion2}`),
      y no cuenta llaves con espacios (`{USD 350.000}`).
- [x] `docs/escalation_policy.md` paso 1: que plantilla recibe el cliente.
- [x] Tests nuevos: un recorrido por **todos** los intents del catalogo real
      con confianza baja, que ademas verifica que la red no tuvo que actuar
      (si actuara, estaria tapando una regresion del camino principal); los
      escalamientos de agendar y reprogramar, mirando el texto que recibe el
      cliente (ningun test lo miraba: se vio al agregar la dependencia nueva y
      no fallar nada); la red escalando y reseteando el estado; el `{nombre}`
      legitimo del canal broker; y catalogos rotos a proposito. Mutation
      testing, una por vez:
      - J1. la baja confianza usa la plantilla del intent (lo de antes): 5 tests en rojo
      - J2. `respuestaDeEspera` usa siempre la propia: 5 tests en rojo
      - J3. sin red de ultima linea: 3 tests en rojo
      - J4. la red actua en el canal broker: 1 test en rojo
      - J5. reprogramar sin horarios manda la plantilla cruda: 1 test en rojo
      - J6. reprogramar sin eleccion manda la plantilla cruda: 1 test en rojo
      - J7. el schema no exige que exista el intent de espera: 1 test en rojo
      - J8. el schema acepta huecos en los que escalan siempre: 1 test en rojo
      - J9a. el patron de hueco acepta llaves con espacios: 3 tests en rojo
      - J9b. el patron de hueco no ve tildes ni mayusculas (la primera version): 1 test en rojo
      - J10. la red cambia el texto pero no escala (la primera version): 2 tests en rojo
      - J11. la red no resetea el estado: 1 test en rojo

**Revision del PR (#40)**: 15 hallazgos. Los mas serios eran sobre la red de
ultima linea, que en la primera version estaba mal pensada:
- en el camino que no escala cambiaba el texto por "te respondo enseguida"
  **sin avisarle al broker**: una promesa sin nadie que la cumpla;
- en el canal broker bloqueaba el `{nombre}` legitimo de los previews de
  ordenes masivas y dejaba el plan armado: el siguiente "dale" lo ejecutaba
  sin que el broker hubiera visto el preview;
- decia "no asumas que se hizo" sobre acciones que ya se habian hecho.
Arreglado (arriba), junto con el patron de hueco, la politica de
escalamiento, un test del schema que habia perdido sentido (fallaba por el
campo nuevo, no por lo que decia probar) y los spies de consola sin
restaurar. Quedan anotados:
- [ ] Un intent que escala siempre responde con su plantilla aunque la
      confianza sea bajisima: `rechazo_desinteres` a 0.2 le dice al cliente
      "Gracias por avisarme..." y cierra la conversacion. Ya pasaba; es del
      catalogo (Bloque 28).
- [ ] Con el modo silencioso apagado, una orden ambigua del broker le
      responde "Dejame confirmarlo con el asesor...", pensada para clientes.
      En modo silencioso no sale (38g).
- [ ] Lo de fondo: hay tres copias de `renderTemplate`, y ninguna avisa si
      queda un hueco sin llenar. Un reemplazo compartido que falle ahi, donde
      el llamador todavia sabe el contexto, cubriria tambien los envios que no
      pasan por el handler (jobs, acciones directas).
- [ ] La supresion de la plantilla repetida (Bloque 31) sigue decidiendo por
      id de intent: los escalamientos por baja confianza ahora mandan la frase
      de espera y no cuentan para el cupo. Es 38e.

**Pregunta que lo habria agarrado antes** (desde el Bloque 5): *"¿que texto
recibe el cliente cuando esto escala?"*. Los tests del escalamiento miraban
`escalate` y el motivo, nunca el texto que salia. Un flujo nuevo con
escalamientos tiene que tener un test del mensaje que recibe el cliente.

- [ ] Sigue igual, a proposito: la segunda reprogramacion responde "Listo, no
      pudimos reprogramar tu visita de ...". Esta completa, no tiene huecos,
      pero el "Listo," suena raro.

### 38d — Un envio al cliente que falla es un fallo
El handler registra la entrada del mensaje con `responseSent` **antes** de que
`app.ts` mande la respuesta. Si `sendText` falla (token vencido, un 5xx de
Meta), la tarea tira y la cola solo lo escribe en consola:
- el audit log dice que la respuesta salio;
- no hay `fallido` ni aviso al broker (la captura del Bloque 34 termina antes
  del envio);
- `pendientes` la marca como respondida;
- si era una plantilla fija, gasta el unico envio por conversacion del
  Bloque 31 sin que haya salido.
Ademas, el aviso "volvio a procesar" del Bloque 34 sale **antes** del envio: un
envio que falla despues de una caida igual lo dispara.

En modo silencioso hoy no pasa con clientes (no se les manda nada), pero si con
las respuestas a las ordenes del broker (38g).

**Diseno** (cambiado en la revision del PR, ver abajo): el handler recibe una
funcion para mandar, la llama **antes** de registrar, y escribe **una sola
entrada** con lo que salio de verdad. La primera version dejaba el registro
donde estaba y agregaba una entrada `envio_fallido` que la corregia al
colapsar; eso era compensar el sintoma.

**Pre-mortem**

**1. La entrada dice que la respuesta salio cuando no salio.** Es el bug que
el bloque viene a arreglar; el riesgo es que quede a medias, con lectores que
sigan mirando `responseSent` sin mas.
   *Mitigacion*: una sola entrada, escrita despues del envio, con
   `responseSent` cargado solo con lo que salio, y `envio` (`fallo` /
   `parcial`) con el motivo. `fueRespondida` —la regla que usa `pendientes`—
   vive en el orchestrator y tiene tests propios.

**2. El aviso le dice al broker que al cliente no le llego nada cuando si le
llego el texto.** Si falla una de las fotos de `pedido_ficha_multimedia`, el
texto ya salio, y el aviso del Bloque 34 dice "NO se le respondio nada".
   *Mitigacion*: el aviso acepta un detalle. Un envio que falla dice "Procese
   un mensaje pero NO pude mandarle la respuesta"; uno parcial, "Le llego el
   texto, pero no todo". Tests de los dos textos.

**3. Un envio al broker que falla le genera un aviso sobre su propio mensaje,
o se pierde.** Las respuestas a sus ordenes (38g) salen por el mismo camino.
   *Mitigacion*: queda la entrada con `envio: fallo`, sin aviso: el canal al
   broker es justo el que fallo. Test.

**Como quedo**
- [x] `handleIncomingMessage` recibe `enviarRespuesta` y registra despues de
      mandar. `app.ts` arma esa funcion con el sender real y ya no manda por
      su cuenta. Sin `enviarRespuesta` (tests del handler solo), se registra
      como antes.
- [x] Campos `envio` y `envioMotivo` en la entrada. Una sola entrada por
      mensaje: no hacen falta reglas de precedencia, ni un caso especial en
      `esResuelta`, ni un filtro en cada lector, y no se pierden las tools
      llamadas ni el estado del aviso al broker.
- [x] Si el envio falla, lo que el handler dejo armado se descarta (horarios
      propuestos, un plan masivo esperando confirmacion): el cliente no vio
      esa respuesta, asi que un "ok" suyo no puede confirmarla.
- [x] Un envio que el modo silencioso bloquea (devuelve la marca, no tira)
      tambien cuenta como fallo.
- [x] De las fotos que fallan quedan los motivos **distintos**, no solo el
      ultimo: el primero suele ser el que explica el problema.
- [x] `pendientes` usa `fueRespondida` y marca "NO SE PUDO MANDAR LA
      RESPUESTA" o "LE FALTAN LAS FOTOS". Misma salida que antes sobre los
      datos locales.
- [x] 13 tests nuevos (webhook real y `fueRespondida`). Mutation testing, una
      por vez:
      - L1. el handler registra antes de mandar (lo de antes): 2 tests en rojo
      - L2. un envio que falla no desarma lo que quedo esperando: 1 test en rojo
      - L3. un envio fallido no avisa: 3 tests en rojo
      - L4. el aviso dice "no pude procesar": 1 test en rojo
      - L5. el aviso de un parcial dice "no se le respondio nada": 1 test en rojo
      - L6. un envio parcial se da por recuperado: 1 test en rojo
      - L7. no se mira la marca del modo silencioso: 1 test en rojo
      - L8. de las fotos queda solo el ultimo motivo: 1 test en rojo
      - L9. el audit log no guarda que fallo el envio: 4 tests en rojo
      - L10. `fueRespondida` ignora el envio: 1 test en rojo

**Revision del PR (#41)**: 12 hallazgos. El principal es de altura: la primera
version compensaba el sintoma con una fila que corregia a la otra, con reglas
de rango, un caso especial en `esResuelta` y un filtro nuevo en cada lector;
y esa fila perdia las tools, el motivo del escalamiento y el estado del aviso.
Ademas, una reentrega de Meta despues de un reinicio podia hacer que esa fila
tapara una respuesta que el cliente si habia recibido. Se rehizo con una sola
entrada escrita despues del envio. Tambien salieron de ahi: el reseteo del
estado, la marca del modo silencioso, el texto del aviso, el aviso por las
fotos, los motivos distintos y los tests de `fueRespondida`. Quedan anotados:
- [ ] Un envio que WhatsApp acepta (200) pero no entrega (ventana de 24 hs,
      numero invalido) no es un fallo aca. Se veria en los statuses del
      webhook, que hoy no se leen.
- [ ] Si el aviso de fallos tampoco sale (el token que fallo es el mismo),
      `AvisoDeFallos` se lo traga con un `console.error` y la entrada no lo
      registra. Es el riesgo abierto del Bloque 34.
- [ ] Con el Graph API colgado, las N fotos se intentan igual: se acerca al
      techo de 90 s de la cola.

### 38e — La misma frase no se repite, venga del camino que venga
El Bloque 31 suprime la plantilla fija repetida, pero decide por **id de
intent**: solo cuentan los 7 intents cuya respuesta es una plantilla sin
huecos. Desde 38c, **todo** escalamiento que no es de un intent que escala
siempre manda la plantilla de espera del catalogo: baja confianza, los flujos
de agendar y reprogramar, y la red de ultima linea. Esos mandan la misma
frase y no cuentan para el cupo, asi que la repeticion vuelve por la ventana.

Ademas, de la revision del Bloque 31 (PR #29) quedaron dos cosas:
- `rechazo_desinteres` comparte el cupo aunque su plantilla no dice "te paso
  con el asesor": es una despedida ("Gracias por avisarme...").
- La entrada suprimida **reemplaza** el motivo real del escalamiento en el
  audit log por el de la supresion.

**Diseno**: la supresion se decide por **el texto que va a salir**, no por el
intent. El catalogo marca cuales de sus plantillas son frases de espera
(`response.espera`), y la decision vive dentro del cierre del escalamiento,
que es por donde pasan todos los caminos.

**Pre-mortem**

**1. Se suprime una respuesta legitima.** Si la regla mirara cualquier texto
repetido, dos respuestas generativas iguales ("Si, sigue disponible") dejarian
al cliente sin la segunda; y si mirara todas las plantillas fijas, la
despedida de `rechazo_desinteres` no saldria por haberle mandado antes una
frase de espera.
   *Mitigacion*: solo participan los textos marcados `espera: true` en el
   catalogo. La despedida no esta marcada. Tests de los dos casos.

**2. El catalogo cambia y la supresion deja de aplicar sin que nadie lo
note.** Si alguien agrega una plantilla de espera nueva y no la marca, esa
frase se repite como antes del Bloque 31, y ninguna metrica lo muestra: el
intent esta bien clasificado.
   *Mitigacion*: el schema exige que la plantilla de espera generica
   (`meta.escalation_waiting_template_from`) este marcada, y que lo marcado
   sea una plantilla sin huecos. Un test contra el catalogo real fija cuales
   estan marcadas hoy, asi agregar una obliga a mirar esta decision.

**3. El historial no se puede leer y la frase se suprime para siempre.** La
regla falla cerrado (decision del dueno del repo, Bloque 31): sin historial,
no se manda. Con un error de lectura persistente, ningun cliente recibe nunca
mas una frase de espera, y el sintoma es silencio.
   *Mitigacion*: la supresion queda en el audit log en su propio campo, con el
   motivo, sin pisar el del escalamiento; `pendientes` ya muestra esas
   conversaciones como sin responder, porque no hay `responseSent`. Test de que
   el motivo real del escalamiento sobrevive.

**Como quedo**
- [x] El catalogo marca sus frases de espera (`response.espera`): las 6 que
      dicen "te paso con el asesor". La despedida de `rechazo_desinteres`
      queda afuera y ya no comparte el cupo.
- [x] `frasesDeEspera` devuelve **textos**, y `decidirPlantilla` decide por el
      texto que iba a salir y por el que salio antes, no por el intent. Con
      eso cuentan todos los caminos: baja confianza, los flujos de visita y la
      red de ultima linea del Bloque 38c.
- [x] La decision se toma dentro de `finalizeEscalation`, que es por donde
      pasan todos los escalamientos. Los flujos de visita, que la salteaban,
      ahora cuentan.
- [x] La supresion va en su propio campo del audit log (`supresion`) y ya no
      pisa el motivo real del escalamiento.
- [x] El schema exige que la plantilla de espera generica este marcada: sin la
      marca, la repeticion volveria sin que nada lo muestre.
- [x] 6 tests nuevos; los del Bloque 31 migrados al criterio por texto.
      Mutation testing, una por vez:
      - M1. la supresion no mira el texto: 1 test en rojo
      - M2. el historial cuenta cualquier texto enviado: **sobrevivio**, porque
        ningun test mandaba antes una respuesta normal. Se agrego: 1 en rojo
      - M3. la despedida cuenta como frase de espera: 2 tests en rojo
      - M4. no se decide en el cierre del escalamiento: 5 tests en rojo
      - M5. la supresion vuelve a pisar el motivo del escalamiento: 1 test en rojo
      - M6. sin historial se manda igual (deja de fallar cerrado): 1 test en rojo
      - M7. el schema no exige marcar la plantilla generica: **sobrevivio**, por
        la misma razon. Se agrego el test del catalogo roto: 1 en rojo

**Revision del PR (#42)**

Seis hallazgos, todos arreglados en el mismo PR.

1. **Al broker se le suprimia igual, y su silencio no se destrababa nunca.**
   Lo que devuelve la palabra es que el broker responda, y eso se detecta por
   el eco de coexistencia sobre un lead conocido: su propio numero nunca
   aparece ahi. Una orden ambigua suya que escalaba le sacaba la frase de
   espera una vez y despues lo dejaba mudo **hasta el techo de 7 dias**. En
   su canal ya no se suprime nada.
2. **La continuacion de un flujo de visitas era el unico camino sin test.**
   Reemplazar la lectura del historial de `decidirEnvioDePlantilla` por un
   historial vacio dejaba la suite entera en verde: el camino que la usa
   (continuacion de `agendar_visita` / `reprogramar_cancelar_visita`, que no
   pasa por la lectura que arma el contexto del clasificador) no estaba
   cubierto. Test agregado, y ahora esa mutacion mata 2.
3. **En modo silencioso se decidia igual.** No sale nada, asi que no hay nada
   que suprimir — pero una continuacion pagaba una lectura completa del audit
   log por mensaje para decidir sobre algo que no se iba a enviar. Se saltea,
   con test.
4. **Dos relojes para el mismo mensaje.** El contexto del clasificador usaba
   `ahora` y la supresion un `new Date()` propio. Ahora el llamador pasa el
   suyo. No es observable en un test (los dos relojes caen en el mismo
   milisegundo): es consistencia, no una mitigacion testeada — se anota asi
   para no contarla como cubierta.
5. **El cupo dependia del texto vigente del catalogo.** Era el "queda
   abierto" de mas arriba, y tenia arreglo: el envio deja marcado en el audit
   log que lo que salio era una frase de espera (`fraseDeEspera`), y el
   historial se lee por ese marcador. Editar una frase ya no le devuelve el
   cupo a las conversaciones en curso. El texto queda como respaldo para las
   entradas anteriores a este bloque — sin eso, el dia del deploy toda
   conversacion viva recuperaba el cupo y recibia la frase otra vez.
6. **El catalogo dejaba agregar un intent que se caia del cupo sin ruido.**
   Tres reglas nuevas en el schema: una frase de espera necesita plantilla;
   solo puede marcarse en un intent que escala siempre (`requires_broker:
   true`), porque la supresion esta cableada en el cierre del escalamiento; y
   al reves, un intent que escala siempre con plantilla fija **tiene que
   decir** si es o no una frase de espera. `rechazo_desinteres` declara
   `espera: false` con el motivo al lado.

Mutation testing, la lista completa (15, todas mueren):

      - M1. la supresion no mira el texto: 1 test en rojo
      - M2. el historial cuenta cualquier texto enviado: 1 en rojo
      - M3. la despedida cuenta como frase de espera: 3 en rojo
      - M4. no se decide en el cierre del escalamiento: 8 en rojo
      - M5. la supresion pisa el motivo del escalamiento: 1 en rojo
      - M6. sin historial se manda igual: 1 en rojo
      - M7. el schema no exige marcar la plantilla generica: 1 en rojo
      - M8. al broker tambien se le suprime: 1 en rojo
      - M9. en modo silencioso se decide igual: 1 en rojo
      - M10. la continuacion decide con un historial vacio: 2 en rojo
      - M11. el envio no deja el marcador: 1 en rojo
      - M12. el marcador reemplaza al texto (las viejas dejan de contar): 6 en rojo
      - M13. el schema deja marcar como espera un intent sin plantilla: 1 en rojo
      - M14. ...un intent que no escala siempre: 1 en rojo
      - M15. ...y no obliga a decidir en uno nuevo que escala siempre: 1 en rojo

M7 **sobrevivio en la primera corrida de esta tanda**, y no por lo mismo que
la primera vez: su test pasaba por la regla nueva (M15), que da un mensaje
distinto sobre el mismo catalogo roto. Una regla tapando el agujero de otra
deja el test verde y la regla original borrable. El test ahora apunta a su
propio mensaje.

**Pregunta que lo habria agarrado antes**: *cuando agrego una regla que
valida algo parecido a una que ya existe, ¿el test de la vieja sigue fallando
si borro solo la vieja?* Dos reglas que se solapan parcialmente se tapan
entre si, y la que sobra se descubre el dia que hace falta la que falta.

**Lo que sigue abierto**
- [ ] La supresion sigue siendo por conversacion y por texto/marcador, no por
      significado: dos frases de espera distintas cuentan como una sola (es lo
      buscado), y una respuesta generativa que diga lo mismo con otras
      palabras no cuenta.

### 38f — Que el broker haya contestado no se pierde
Lo unico que le devuelve la palabra al agente, cuando se callo por el Bloque
31, es que el broker responda. Eso se detecta hoy de una sola forma: el eco de
coexistencia registra `origen: "manual"` en `ultimoContactoStore`, y
`decidirPlantilla` mira que el contacto manual sea posterior a la frase que
salio. Dos agujeros conocidos, los dos medidos abajo.

**Lo que se midio antes de disenar (servidor, 19/09)**
- `ultimo_contacto.json`: **32 leads, todos `manual`**. Ningun `sistema`
  todavia: el job de recontacto del Bloque 27 no esta cableado. El dia que se
  cablee, su escritura le pisa el origen al contacto manual y la senal se
  pierde — hoy el bug esta armado, no disparado.
- **El desfasaje de formato de telefono no existe**: los 32 leads del eco
  vienen en el mismo formato (len 13, con el 9 argentino) que los
  `conversationId` del audit log, y 31 de 32 cruzan **exacto** con una
  conversacion. El que falta no aparece ni canonizando: es alguien a quien el
  broker le escribio y que nunca le escribio al bot. Canonizar los dos lados
  no cambia ni un cruce. El hallazgo "posible diferencia de formato entre el
  `from` entrante y el `to` del eco" queda **descartado con datos**, no
  mitigado.
- **El eco no refleja los envios del propio bot**: de los 32 leads con eco,
  **0** caen a menos de 2 minutos de una respuesta que el bot registro, y a 31
  el bot nunca les respondio. Si el eco devolviera los envios propios, cada
  respuesta del bot destrabaria su propio silencio y el Bloque 31 no serviria
  de nada. *La prueba es debil y hay que decirlo*: en modo silencioso el bot
  casi no envia, asi que en 31 de los 32 casos no hubo ocasion de colisionar.
  Se re-verifica cuando el bot responda de verdad.
- `broker_accion_directa`: **0 ordenes en produccion** (hay 1
  `broker_resumen_agenda`, de la prueba en vivo del 38g). El agujero es real
  pero todavia no se disparo.
- Una conversacion recibio la misma frase de espera **4 veces** (...1181). Es
  el Bloque 31/38e en vivo: arreglado, sin desplegar.

**Pre-mortem**

**1. La repeticion vuelve porque el bot cree que el broker contesto.** Si
`manualAt` se escribe por algo que no es el broker —un eco que devuelva un
envio propio, un recordatorio, el recontacto— el cupo se libera en cada
respuesta y volvemos a las 16 frases iguales seguidas del Bloque 31, sin que
ninguna metrica lo muestre.
   *Mitigacion*: se escribe en exactamente dos lugares — el eco de
   coexistencia y la ejecucion de una orden del broker — y hay un test de que
   un contacto `sistema` no lo toca.
   *Riesgo asumido*: la medicion de "el eco no devuelve los envios propios" es
   debil por el modo silencioso (ver arriba). Si resultara falsa, esto empeora
   el Bloque 31 en vez de arreglarlo.

**2. Los 32 registros viejos pierden la senal el dia del deploy.** Si
`manualAt` solo se completa de ahora en mas, los 32 leads que ya tienen un
contacto manual dejan de contar como "el broker respondio": esas personas se
quedan sin frase de espera hasta el techo de 7 dias.
   *Mitigacion*: un registro sin `manualAt` y con `origen: "manual"` se lee
   como `manualAt = contactadoAt`. Test con un registro viejo.

**3. Registrar el envio rompe la orden del broker.** Si el registro se hace
dentro del executor y tira (disco lleno, JSON corrupto), la accion falla
**despues** de que el mensaje salio: el cliente lo recibio y el broker lee
"fallo", con el riesgo de que lo mande de nuevo.
   *Mitigacion*: best-effort, como todo el executor — el registro va en su
   propio catch y no cambia el resultado de la accion. Test de que una accion
   con el store roto sigue dando `ok`.

**Como quedo**
- [x] `UltimoContacto` gana `manualAt`: **cuando contacto el broker**, aparte
      de `contactadoAt`, que sigue siendo el ultimo contacto venga de donde
      venga (es lo que mira el recontacto). Antes los dos compartian `origen`,
      y por eso el primer contacto del sistema borraba la senal.
- [x] El store es monotono **por campo**: ni la fecha del ultimo contacto ni
      la del contacto del broker retroceden, y un contacto del sistema ya no
      pisa al del broker. Un eco del broker que llega tarde, despues de uno
      del sistema, igual deja su marca.
- [x] Los 32 registros que ya existen se leen bien sin migrar nada: sin
      `manualAt` y con `origen: "manual"`, la fecha del registro **es** la del
      contacto del broker (`contactoDelBroker`).
- [x] Una orden del broker que manda un mensaje (`broker_accion_directa`)
      cuenta como contacto suyo: es el broker contestando, aunque apriete el
      boton el bot. Con eso destraba el silencio del Bloque 31 y el recontacto
      no le escribe manana a alguien que acaba de recibir su respuesta.
- [x] Se registra con el `wa_id` que devuelve Meta cuando lo devuelve: el
      telefono que trae Tokko no tiene por que venir en el formato en que
      llegan los mensajes entrantes, que es por el que busca la supresion.
- [x] El registro es best-effort y va **despues** del envio: si falla, la
      accion sigue siendo un exito (el mensaje ya salio), y un envio que el
      modo silencioso bloqueo no cuenta como contacto.
- [x] 14 tests nuevos. Mutation testing, una por vez, las 9 mueren:
      - N1. un contacto manual no deja marca del broker: 1 test en rojo
      - N2. el contacto del sistema vuelve a pisar el del broker: 4 en rojo
      - N3. los registros anteriores al bloque dejan de contar: 2 en rojo
      - N4. la marca del broker retrocede con un eco viejo: 1 en rojo
      - N5. la supresion deja de mirar la marca del broker: 4 en rojo
      - N6. el executor no registra el envio del broker: 3 en rojo
      - N7. un registro que falla rompe la orden del broker: 1 en rojo
      - N8. se registra el telefono de Tokko y no el wa_id: 1 en rojo
      - N9. un envio bloqueado cuenta como contacto: 1 en rojo
- [ ] Sigue abierto: **la medicion de que el eco no devuelve los envios
      propios es debil** (ver arriba). Si resultara falsa, cada respuesta del
      bot destrabaria su propio silencio. Se re-verifica cuando el bot
      responda de verdad, con el modo silencioso apagado.
- [ ] Sigue abierto: el eco es best-effort (Meta no lo reintenta). Si se
      pierde el eco de la respuesta del broker, esa conversacion queda callada
      hasta el techo de los 7 dias. La orden via `broker_accion_directa` ya no
      depende del eco; la respuesta desde su celular, si.

**Revision del PR (#43)**

Dos hallazgos, los dos arreglados en el mismo PR.

1. **El mismo bug, en un segundo lugar que no habia mirado.** El contexto que
   se le pasa al clasificador arma `horasDesdeContactoDelBroker` con
   `contactadoAt` —el ultimo contacto, venga de donde venga— y el prompt dice
   literalmente *"el broker le escribio a esta persona hace N horas. Es muy
   probable que este mensaje sea una RESPUESTA a ese contacto"*. El dia que se
   cablee el recontacto del Bloque 27, el propio envio automatico del bot se
   le presenta a Claude como un mensaje del broker, y el clasificador lee la
   respuesta del cliente en un marco falso. Arreglado con la misma
   `contactoDelBroker`: 2 tests nuevos por el webhook real, no por la funcion
   suelta.
   **Lo que lo agarro**: buscar *todos* los lectores del registro antes de dar
   el cambio por completo (`grep` de `.origen` y `ultimoContacto`), en vez de
   arreglar el lector que motivo el bloque.
2. **Una fecha invalida rompia el registro.** El eco arma la fecha con el
   timestamp de Meta; uno absurdo da `Invalid Date`. Con el cambio de este
   bloque, un lead nuevo con esa fecha reventaba en `previo!.contactadoAt`
   (antes reventaba en `toISOString`: las dos estan mal). Ahora una fecha
   ilegible no se registra, y un `contactadoAt` ilegible que ya este en el
   archivo se repara con el proximo contacto en vez de congelar ese lead para
   siempre.

Mutation testing de la revision (3 mas, todas mueren):

      - N10. el contexto del clasificador vuelve a mirar cualquier contacto: 2 en rojo
      - N11. una fecha invalida se registra igual: 1 en rojo
      - N12. un `contactadoAt` ilegible congela el registro: 1 en rojo

**Pregunta que lo habria agarrado antes**: *¿quien mas lee este campo?* El
bloque nacio de un lector (`decidirPlantilla`), y el pre-mortem se escribio
alrededor de ese. El segundo lector estaba a un `grep` de distancia y hacia
exactamente lo mismo mal.


### 38g — En modo silencioso, las ordenes del broker no reciben respuesta
Encontrado en la revision de 38a y **confirmado en el codigo**: los intents
del canal broker (`broker_resumen_agenda`, `broker_resumen_leads`,
`broker_pausar_agente`, `broker_accion_directa`) terminan en
`finalizeNonEscalating`, que en modo silencioso no manda la respuesta y le
manda al broker un "Escalamiento" con un borrador sobre su propio mensaje. El
resumen, la confirmacion de la pausa o el preview del gate de confirmacion
nunca le llegan. `SilentModeSender` si deja pasar envios al broker, asi que
la respuesta podria salir. En produccion todavia no paso: 0 ordenes del
broker en el audit log.

**Lo que se midio antes de disenar**
- `SilentModeSender` **simula exito** en lo que bloquea: devuelve un resultado
  vacio en vez de tirar, para que los jobs no reintenten. Con eso, una orden
  `broker_accion_directa` de mandarle algo a un cliente, en modo silencioso,
  termina con "✓ Mensaje enviado a ..." sin que haya salido nada. Hoy no se
  ve porque la respuesta no le llega al broker; arreglar solo lo de la
  respuesta le mostraria un resumen falso. Las acciones de calendario si se
  ejecutan: el calendario es del broker y el modo silencioso no lo toca.
- En las 377 entradas del audit log del servidor **no hay ningun mensaje del
  numero del broker**: nunca le escribio una orden al bot. El formato en que
  llega su numero no se puede verificar con datos reales.

**Pre-mortem**

**1. El numero del broker llega en otro formato y la orden sigue sin
respuesta.** La deteccion del canal compara el numero exacto. Si Meta lo
manda distinto de `BROKER_WHATSAPP_NUMBER`, el broker se trata como cliente:
su orden se clasifica con los intents de cliente y no recibe nada.
   *No se puede mitigar con datos*: el broker nunca le escribio al bot.
   *Mitigacion parcial*: la decision "es el broker" sale de una sola funcion,
   la misma para el ruteo y para el modo silencioso, asi no pueden estar en
   desacuerdo. *Prueba en vivo despues del deploy*: el broker le manda
   "resumen de agenda" al bot.

**2. El resumen le dice al broker que se mando algo que el modo silencioso
bloqueo.** Ver arriba.
   *Mitigacion*: `SilentModeSender` marca lo que bloquea
   (`bloqueado: "modo_silencioso"`), y el ejecutor de `broker_accion_directa`
   lo cuenta como no enviado, con el motivo. Test.

**3. Un cliente recibe respuesta en modo silencioso.** Si la excepcion para
el broker se aplicara de mas (por ejemplo, sin numero de broker
configurado), el cliente volveria a recibir respuestas solas, que es el
incidente del 12/08 (Bloque 21).
   *Mitigacion*: tests de que un cliente sigue sin respuesta en modo
   silencioso, con y sin numero de broker configurado. Y `SilentModeSender`
   sigue bloqueando abajo: son dos capas.

**Como quedo**
- [x] `esElNumeroDelBroker` (`channels/whatsapp/numeroDelBroker.ts`) es la
      unica definicion de "este numero es el del broker": compara solo
      digitos, sin normalizar, y sin numero configurado (vacio o ausente)
      nadie es el broker. La usan el ruteo por canal, `SilentModeSender` y el
      aviso de fallos de `app.ts`. Antes eran tres, y el ruteo comparaba el
      texto exacto.
- [x] En modo silencioso, las **respuestas** a las ordenes del broker salen
      (`silenciarPara` calla solo a los clientes) y quedan en el audit log
      como enviadas. Los **escalamientos** de sus ordenes siguen en silencio:
      la plantilla de espera podria salir con los `{huecos}` sin llenar
      (38c) y decir que la orden se ejecuto. Le llega el aviso, con la
      confianza.
- [x] `SilentModeSender` marca lo que bloquea (`bloqueado: "modo_silencioso"`).
      El ejecutor de `broker_accion_directa` lo cuenta como no enviado, con el
      telefono del destinatario para que el broker lo mande a mano.
- [x] El preview de una accion masiva, en modo silencioso y con mensajes a
      clientes, avisa que esos mensajes no van a salir.
- [x] El resumen describe lo que fallo en infinitivo ("✗ Enviar mensaje a
      ...", "✗ Agendar visita para ..."), sin afirmar ni negar lo que paso.
- [x] 21 tests nuevos. Los del ejecutor usan el `SilentModeSender` real.
      Mutation testing, una por vez:
      - G1. el camino que no escala silencia al broker (lo de antes): 1 test en rojo
      - G2. `silenciarPara` ignora al broker: 1 test en rojo
      - G3. `silenciarPara` no silencia a nadie: 8 tests en rojo
      - G4. sin numero de broker, todos son el broker: 16 tests en rojo
      - G5. el sender no marca lo bloqueado: 3 tests en rojo
      - G6. el ejecutor ignora la marca: 2 tests en rojo
      - G7. el fallo dice "enviado": 1 test en rojo
      - G8. la plantilla no se controla: 1 test en rojo
      - H1. el escalamiento de una orden del broker no se silencia: 1 test en rojo
      - H2. el numero se compara exacto (lo de antes): 4 tests en rojo
      - H3. el preview no avisa: 1 test en rojo
      - H4. el preview avisa aunque no haya envios a clientes: 1 test en rojo
      - H5. el fallo no lleva el telefono: 2 tests en rojo
      - H6. sin guarda contra un resultado vacio: 1 test en rojo
      - H7. `app.ts` compara exacto: 1 test en rojo

**Revision del PR (#37)**: 13 hallazgos. Lo mas serio, reproducido con un
test: la excepcion para el broker tambien alcanzaba a los escalamientos, y
una orden ambigua (por ejemplo "reactiva el agente" con confianza baja) le
devolvia "Listo, {accion} para {alcance}.", que se lee como hecha. Se
arreglaron 8 (arriba). Quedan anotados:
- [ ] El resultado del envio sigue teniendo forma de exito con una marca
      opcional: cada llamador tiene que acordarse de mirarla. Hoy solo la mira
      el ejecutor; los jobs no corren en modo silencioso. Un resultado
      discriminado haria que el compilador lo exija.
- [ ] En modo silencioso, cada envio de un plan masivo igual consulta el lead
      en Tokko antes de que el sender lo bloquee.
- [ ] `toolsCalled` del audit log sigue listando los envios que el modo
      silencioso bloqueo. El resumen, que queda en `responseSent`, si dice
      cuales no salieron.
- [x] **Prueba en vivo, despues del deploy** (19/09, 14:26): el broker le
      escribio "resumen de agenda" a la linea del bot desde el ...6699. Su
      numero llego igual al configurado (modo de fallo 1 descartado), se
      clasifico `broker_resumen_agenda` con 0.97, no escalo, y la respuesta
      salio a su numero (WhatsApp la acepto y llegaron los statuses). En el
      audit log quedaron las dos entradas, `recibido` y la resuelta.
      Detalle a mirar: el texto ("Cuando quieras coordinar alguna, avisame y
      lo arreglamos enseguida") suena escrito para un cliente, no para el
      broker.


### Muerde al apagar el modo silencioso
- [x] *(Resuelto en 38c, junto con dos escalamientos mas del flujo de
      reprogramar que hacian lo mismo.)*
      **Plantillas crudas, desde el Bloque 5 (26/07).** Un escalamiento por baja
      confianza de un intent cuya plantilla tiene variables manda la
      plantilla sin llenar: *"Listo, {accion} tu visita de
      {direccion_corta}"*, que ademas le dice al cliente que el cambio se
      hizo. Afecta a 5 intents: `pedido_ficha_multimedia`,
      `reprogramar_cancelar_visita`, `recordatorio_visita`,
      `seguimiento_post_visita`, `broker_pausar_agente`.
- [x] *(Resuelto en 38e: se decide por el texto que sale.)*
      **La misma frase se puede repetir por caminos que el Bloque 31 no
      cubre.**
- [x] *(Resuelto en el Bloque 38d.)* **Un envio al cliente que falla no es un fallo.** La captura del Bloque
      34 termina antes de `sendText`: si el envio falla, no hay `fallido` ni
      aviso, y `pendientes` la marca como respondida.
- [x] *(Resuelto en 38d: la entrada se escribe despues del envio, asi que no
      dice que salio algo que no salio ni gasta el cupo.)* `responseSent` se
      registra antes de enviar: si el envio falla, igual se
      gasta el unico envio de plantilla permitido (Bloque 31).
- [x] *(Resuelto en 38f: el contacto del broker va en su propio campo y una
      orden suya que manda un mensaje cuenta como contacto suyo.)*
      La deteccion de "el broker respondio" no ve los envios de
      `broker_accion_directa`, y un contacto `sistema` posterior pisa uno
      `manual`.
- [x] *(Resuelto en 38e: la supresion va en su propio campo.)*
      La entrada suprimida reemplaza el motivo real del escalamiento en el
      audit log.
- [x] *(Resuelto en 38e: el catalogo marca cuales son frases de espera y la
      despedida no lo es.)* `rechazo_desinteres` no dice "te paso con el
      asesor", y sin embargo comparte el cupo con las otras seis plantillas
      fijas.
- [x] *(Medido en 38f y **descartado**: los 32 leads del eco vienen en el
      mismo formato que los `conversationId` del audit log, 31 de 32 cruzan
      exacto y canonizar los dos lados no cambia ni un cruce. No se toco
      nada.)* Posible diferencia de formato de telefono entre el `from`
      entrante y el `to` del eco de coexistencia.
- [ ] Fallar cerrado ante un error de lectura **persistente** suprime la
      plantilla para todos, indefinidamente (Bloque 31).

## Bloque 39 — Una linea rota del reporte de retencion
Mismo problema que el Bloque 37, en el otro JSONL que importa: el reporte de
cada corrida de la retencion (`retentionReportStore.ts`). Salio de la
revision del #31.

### Lo que se midio antes de disenar (servidor, 19/09)
- **Todavia no se borro nada**: 1132 corridas desde el 15/09, todas con 0
  registros. La entrada mas vieja del audit log es del 26/07/2026, asi que el
  primer borrado real sera a fines de julio de 2027. **No es urgente**: tiene
  una mecha de unos 10 meses. Cuando lo propuse lo presente como "lo mas
  urgente del backlog", y no lo era.
- El scheduler aisla los jobs: si la retencion tira, los demas siguen.
- `append` escribe el reporte y **despues** lee el archivo entero para
  recortarlo a las ultimas 12 corridas. Con una linea rota:
  - el reporte nuevo ya esta escrito, pero `readAll` tira;
  - el recorte no se hace nunca mas y el archivo crece (288 lineas por dia);
  - el job tira **antes** del `console.log` del resumen, asi que tambien se
    pierde la linea del journal, que hoy es el unico rastro de un borrado con
    mas de una hora (ver Bloque 40).

### Pre-mortem
**1. El reporte que se pega a la media linea se pierde.** Un corte a mitad de
un `appendFile` deja media linea; el reporte siguiente se escribe detras y
los dos quedan como una linea ilegible. Si ese reporte era el de una corrida
que borro datos, no queda registro de que se borraron.
   *Mitigacion*: antes de escribir se mira si el archivo termina en media
   linea y se antepone el salto, en la misma escritura. Test con un archivo
   que termina cortado.

**2. Una linea rota frena el recorte para siempre y calla el resumen.** Ver
arriba.
   *Mitigacion*: lectura tolerante; las lineas rotas se avisan en el log (sin
   repetir el aviso en cada corrida). Test de que `append` no tira y recorta
   aunque haya una linea rota.

**3. El recorte descarta lineas rotas recientes.** Si el recorte reescribiera
solo los reportes legibles, una linea rota de la ultima hora desapareceria
sin que nadie la pudiera revisar: el mismo borrado silencioso del modo de
fallo 1 del Bloque 37.
   *Mitigacion*: el recorte es **por posicion**, como la rotacion misma. Se
   conserva todo desde el primer reporte que queda, lineas rotas incluidas;
   las rotas anteriores a ese punto son mas viejas que lo que se conserva y
   caen con la rotacion, igual que caeria un reporte legible. Test de las dos
   mitades.

### Decisiones
- El lector tolerante y la reparacion del final viven en un modulo nuevo,
  `agent/jsonl.ts`, que por ahora usa solo este store. **No se migra el
  audit log** a ese modulo en este bloque: es otro camino, recien
  desplegado, y mezclarlo impediria atribuir un fallo a un cambio
  concreto. El corpus de estilo, cuando
  se arregle, deberia usar el mismo modulo.

### Como quedo
- [x] `agent/jsonl.ts`: lectura tolerante con un validador por store
      (`leerLineasJsonl`, `leerArchivoJsonl`), el aviso sin contenido
      (`AvisoDeIlegibles`) y `saltoQueFalta`, que se mira en cada escritura
      y nunca tira.
- [x] `FileRetentionReportStore`:
      - un reporte legible necesita `id`, una `corridaAt` fechable,
        `totalBorrados`, `borradosPorStore` y `muestra`;
      - las escrituras van en cola, de a una;
      - el recorte corre recien al pasar el doble de `maxCorridas`, es por
        posicion y, si falla, no hace fallar la corrida;
      - el aviso sale con los numeros del archivo ya recortado.
- [x] `jobs/retention.ts`: si guardar el reporte falla por cualquier causa,
      se loguea el error y el resumen sale igual.
- [x] 17 tests nuevos contra un archivo real, dos del job completo. Mutation
      testing, una por vez:
      - C1. sin reparar la linea cortada: 2 tests en rojo
      - C2. reparar una vez por proceso: 1 test en rojo
      - C3. lectura no tolerante (lo de antes): 8 tests en rojo
      - C4. el recorte descarta las ilegibles: 2 tests en rojo
      - C5. el recorte conserva todas las ilegibles (no rota): 1 test en rojo
      - C6. sin aviso: 2 tests en rojo
      - C7. aviso en cada lectura: 2 tests en rojo
      - C8a. acepta una fecha vacia: **sobrevivio**, porque la linea del test
        tambien fallaba por otros campos. Se corrigio el test: 1 en rojo
      - C8b. acepta un reporte sin muestra: 1 test en rojo
      - C9. recorte en cada corrida: 2 tests en rojo
      - C10. aviso con los numeros de antes del recorte: **sobrevivio**,
        porque el append siguiente disparaba el aviso correcto y lo tapaba.
        Se corrigio el test: 1 en rojo
      - C11. un recorte que falla hace fallar el append: 1 test en rojo
      - C12. sin cola: 1 test en rojo
      - C13. un fallo corta la cola: 1 test en rojo
      - C14. el resumen depende de guardar el reporte: 1 test en rojo

### Revision del PR (#33)
La primera version arreglaba la linea rota y nada mas. La revision encontro
que el objetivo del bloque, que el resumen del journal sobreviva, seguia
dependiendo de que guardar el reporte no fallara **por ninguna otra causa**
(disco lleno). Tambien encontro:
- el recorte rompia la corrida si fallaba, aunque el reporte ya estuviera
  escrito;
- dos corridas superpuestas chocaban en el temporal: el scheduler no espera
  a que termine la vuelta anterior. En Windows, ademas, `rename` falla si
  otra operacion tiene el archivo abierto; se vio al probarlo. La solucion
  de fondo fue la cola, no el nombre del temporal;
- el recorte reescribia el archivo entero cada 5 minutos para agregar una
  linea, y con eso los numeros de linea del aviso se corrian en cada corrida;
- un error al cerrar el archivo en `saltoQueFalta` reemplazaba el valor de
  retorno y hacia tirar la funcion.

**Pregunta que lo habria agarrado antes** (la misma del Bloque 37, que no se
aplico a los otros stores al cerrarlo): *"¿donde mas se escribe con
`appendFile` y se lee con `JSON.parse`?"*. Un arreglo de una clase de bug
no esta cerrado hasta buscar las otras instancias; el Bloque 37 las anoto
como riesgo, y dejo el corpus de estilo todavia abierto.

### Riesgos abiertos
- [ ] El corpus de estilo (`estiloBrokerStore.ts`) sigue sin arreglar: con una
      linea rota, `all()` devuelve vacio y `estilo:reanonimizar` lo borraria
      entero. Deberia usar `jsonl.ts`.
- [ ] El audit log tiene su propia copia de la misma logica (Bloque 37), con
      el bug del `close()` que aca se arreglo: si cerrar el archivo falla, su
      `saltoQueFalta` tira y la escritura no se hace. Se arregla al migrarlo
      a `jsonl.ts`, en un cambio aparte.
- [ ] **El scheduler no espera a que termine la vuelta anterior**
      (`setInterval` + `void tick()`). Una vuelta de mas de 5 minutos
      superpone todos los jobs, no solo la retencion: dos purgas del audit log
      a la vez, dos corridas de recontacto. La cola de este bloque cubre solo
      el reporte. Va con el Bloque 40.

## Bloque 40 — La retencion corre cada 5 minutos y el reporte dura una hora
Encontrado al disenar el Bloque 39; no se toco ahi porque es el mismo camino.
El dueno del repo lo desbloqueo el 19/09, despues de desplegar el Bloque 38
completo.

- La retencion esta registrada en el scheduler, que corre cada 5 minutos
  (`SCHEDULER_INTERVAL_MS`). El reporte conserva las ultimas 12 corridas:
  **una hora**. El diseno del Bloque 15 decia "comparar la corrida de esta
  semana con la de la anterior", pensando en corridas espaciadas.
- Consecuencia desde julio de 2027: el reporte de una corrida que borro algo
  desaparece en una hora, reemplazado por corridas nuevas. El unico rastro
  que queda es una linea de resumen en el journal del servidor, sin muestra.
- Consecuencia aparte: cada corrida que borra algo reescribe el audit log
  entero. Cada 5 minutos, eso multiplica la ventana de la carrera entre la
  purga y un `append` (riesgo abierto del Bloque 37).
- Propuesta: la retencion corre **una vez por dia**, en horario tranquilo; y
  el reporte se conserva por tiempo (por ejemplo 90 dias), no por cantidad.
  Correr una vez por dia borra lo mismo, con hasta un dia de demora sobre los
  12 meses.

**Lo que se midio antes de tocar nada (servidor, 19/09 23:0x)**
- `retention_reports.jsonl`: 5265 bytes, **15 reportes, que cubren 72
  minutos** (01:13 a 02:25 UTC). El recorte deja entre 12 y 24, asi que el
  reporte de un borrado vive entre una y dos horas. El diagnostico del Bloque
  39 queda confirmado con el archivo real.
- **286 corridas en 24 hs**, todas con `dryRun: false` (el borrado real esta
  habilitado en el servidor) y **0 registros borrados**: la entrada mas vieja
  del audit log es del 26/07/2026, asi que el primer borrado real cae a fines
  de julio de 2027.
- **La superposicion no se dio nunca**: el intervalo entre corridas es 300 s
  de mediana, minimo 300 s, y **ninguno por debajo de 290 s**. Hubo una vuelta
  de 494 s — 194 s de trabajo extra en un tick — que igual no llego a
  solaparse. O sea: el riesgo es de diseno, no un incidente.
- Un reporte pesa 351 bytes. Una corrida por dia durante 90 dias son ~32 KB,
  contra los ~100 KB **por dia** que generarian las 288 de hoy si se
  conservaran.
- El audit log pesa 253 KB y se **reescribe entero** en cada corrida que borra
  algo. Pasar de 288 a 1 corrida por dia divide por 288 la ventana de la
  carrera entre la purga y un `append` (riesgo abierto del Bloque 37).

**Pre-mortem**

**1. La retencion deja de correr y nadie se entera.** Al pasar de "en cada
vuelta" a "una vez por dia", cualquier error en la condicion —la hora mal
configurada, el proceso caido justo en la ventana, un cambio de huso— hace
que no corra **nunca**, y el sintoma es silencio: exactamente lo mismo que se
ve cuando corre y no borra nada. La politica de privacidad se incumple sin
que nada lo muestre.
   *Mitigacion*: la condicion no es "es tal hora" sino "ya paso la hora de hoy
   y la ultima corrida es anterior a esa hora". Si el proceso estuvo caido
   durante la ventana, corre en la primera vuelta despues de levantar, no al
   dia siguiente. Tests de las dos cosas, y el arranque loguea cuando fue la
   ultima corrida.

**2. Corre varias veces el mismo dia y reescribe el audit log de mas.** Si la
marca de "ya corri hoy" vive solo en memoria, cada deploy la borra (hubo dos
el 19/09); si vive solo en el reporte, la borra un fallo al guardarlo — y ese
`append` ya esta envuelto en un `catch` que lo deja pasar a proposito.
   *Mitigacion*: la ultima corrida es el **maximo** entre la memoria del
   proceso y la ultima del reporte. Un test por cada uno de los dos caminos.

**3. El recorte por tiempo se lleva el reporte de un borrado.** Es lo que el
bloque existe para evitar. Si el corte se calcula sobre fechas y una linea
tiene la fecha ilegible, o el reloj de la maquina salta, el corte puede caer
donde no debe y llevarse justo los reportes que importan.
   *Mitigacion*: el corte sigue siendo **por posicion**, como en el Bloque 39
   — se conserva desde el primer reporte dentro de la ventana, con las lineas
   rotas que vengan despues; las anteriores a ese punto son mas viejas que lo
   que se conserva. El reporte recien escrito siempre esta dentro de la
   ventana, asi que el archivo nunca queda vacio. Test de que una linea rota
   no arrastra a las posteriores.

**Como quedo**
- [x] La retencion corre **una vez por dia**, a la hora local del servidor que
      diga `RETENTION_HORA` (default 4). El scheduler sigue pasando cada 5
      minutos por los demas jobs; la retencion decide si le toca.
- [x] La condicion es "ya paso la hora de hoy y la ultima corrida es anterior
      a esa hora", **no** "es tal hora": si el proceso estuvo caido durante la
      ventana, corre en la primera vuelta despues de levantar en vez de
      saltearse el dia.
- [x] "Cuando fue la ultima" es el **maximo** entre lo que recuerda el proceso
      y lo que dice el reporte. Cada una sola falla en un caso real: la
      memoria se borra en cada deploy (hubo dos el 19/09), y la del reporte
      desaparece si el `append` falla — ese `catch` existe a proposito.
- [x] Si el reporte no se puede leer, corre igual: purgar de mas es preferible
      a no purgar nunca. Si se pudiera leer y estuviera al dia, no corre.
- [x] El reporte se conserva **por tiempo** (`RETENTION_DIAS_DE_REPORTES`,
      default 90 dias) y ya no por cantidad. El corte sigue siendo por
      posicion, como en el Bloque 39, asi que una linea rota no define el
      corte ni arrastra a las posteriores; y si ningun reporte entra en la
      ventana —reloj de la maquina para atras— no se recorta nada.
- [x] El scheduler **no arranca una vuelta si la anterior sigue corriendo**.
      Una vuelta en la que un job falla no lo deja trabado.
- [x] Una `RETENTION_HORA` que no sea una hora del dia (25, -1, 4.5, texto) se
      ignora con un aviso y se usa el default. Con la hora rota la retencion
      no correria nunca, y eso se ve igual que una corrida que no borro nada.
- [x] El arranque loguea a que hora corre, cuantos dias de reportes conserva y
      cuando fue la ultima corrida. Sin eso, "no corrio nunca" y "corrio y no
      borro nada" se siguen viendo igual.
- [x] 19 tests nuevos y los del reporte migrados del criterio por cantidad al
      de por tiempo. Mutation testing, una por vez, las 11 mueren:
      - P1. la retencion vuelve a correr en cada vuelta: 2 tests en rojo
      - P2. la condicion es "es tal hora": 2 en rojo
      - P3. no se mira lo que dice el reporte: 1 en rojo
      - P4. no se recuerda en memoria: 1 en rojo
      - P5. la memoria pisa al reporte en vez de tomarse el maximo: 1 en rojo
      - P6. un reporte ilegible frena la retencion para siempre: 1 en rojo
      - P7. el reporte se recorta por cantidad otra vez: 7 en rojo
      - P8. el recorte borra todo si ningun reporte entra en la ventana: 1 en rojo
      - P9. el scheduler vuelve a superponer vueltas: 1 en rojo
      - P10. una vuelta que falla deja el scheduler trabado: 3 en rojo
      - P11. una hora invalida en el env se propaga: **sobrevivio**, no habia
        ningun test de la config. Se agregaron: 4 en rojo
- [ ] Consecuencia asumida: el borrado puede demorar **hasta un dia** sobre el
      plazo de 12 meses. La politica publicada dice "cumplido el plazo, los
      datos se eliminan", sin frecuencia, asi que entra — pero queda escrito
      para que sea una decision y no un descubrimiento.
- [ ] Sigue abierto: la carrera entre la purga y un `append` (Bloque 37) no se
      cierra, se achica. Pasa de 288 ventanas por dia a 1.

**Revision del PR (#46)**

Dos hallazgos, los dos arreglados en el mismo PR.

1. **La hora se validaba y los plazos no.** El bloque agrego `horaValida`
   porque una hora rota deja a la retencion sin correr en silencio — y dejo
   `Number(env.RETENTION_MESES_MENSAJES)` y `Number(env.RETENTION_DIAS_DE_REPORTES)`
   como estaban, a un par de lineas de distancia. `Number("abc")` es `NaN`, y
   un `NaN` en los meses **apaga la purga sin decir nada** (las comparaciones
   contra una fecha invalida dan todas falso); uno en los dias hace que el
   reporte no se recorte nunca. Es exactamente el mismo modo de fallo que
   motivo la guarda, en el campo de al lado. Ahora los tres pasan por la misma
   validacion, con aviso.
   **Lo que lo agarro**: preguntarse *que otro valor del mismo bloque entra
   sin validar por el mismo camino*, en vez de dar por cerrado el campo que
   motivo la guarda.
2. **Dos instancias del store del reporte.** El log del arranque construia una
   segunda `FileRetentionReportStore` **sin** los dias configurados. Hoy no
   hace dano (esa instancia solo lee), pero es una bomba para el que manana le
   agregue un `append`: recortaria con 90 dias aunque el env diga otra cosa.
   Una sola instancia, compartida.

Mutation testing de la revision (2 mas):

      - P12. un plazo invalido apaga la purga en silencio: 3 en rojo
      - P13. el arranque no dice cuando fue la ultima corrida: **sobrevive**

**P13 queda sin test, y hay que decirlo**: el log del arranque vive en
`server.ts`, que no se puede ejercitar sin levantar el servidor entero (MCPs y
puerto incluidos), y no hay hoy ningun test que lo haga. Asi que la mitigacion
**testeada** del modo de fallo 1 es la condicion de puesta al dia (P1, P2) y
el maximo entre las dos marcas (P3, P4, P5), no el log: el log ayuda al que
mire el journal, pero nada garantiza que siga saliendo.

**Pregunta que lo habria agarrado antes**: *cuando agrego una validacion
porque un valor roto falla en silencio, ¿que otros valores del mismo camino
entran sin validar?*



## Bloque 33 — Persistencia real (Postgres), si el volumen ya lo justifica
- [ ] Evaluar si los archivos JSON (`AuditLogStore`, `AppointmentStore`,
      `ConversationStateStore`, todos con interfaz ya lista desde la Fase
      1) siguen alcanzando una vez que hay jobs corriendo periódicamente
      + el canal broker escribiendo estado. Es probable que acá ya no.
      **Este es el punto donde instalar Docker se vuelve necesario de
      verdad** (venimos avisando desde el Bloque 3 que todavía no hacía
      falta).
- [ ] Migrar las 3 interfaces a implementaciones Postgres
      (`docker-compose.yml` ya provisiona el servicio) — es swap de
      implementación detrás de una interfaz que ya existe, no reescritura.
- [ ] Redis/BullMQ (docs/SOW.md secc. 4.6) solo si el cron simple del
      Bloque 6 no alcanza en volumen real — no implementarlo
      especulativamente si nadie lo necesitó todavía.

## Fuera de alcance permanente (no reabrir sin pedido explícito del usuario)
- Multi-tenant, pagos, firma electrónica, publicación en portales — "Out
  of scope" de `docs/SOW.md` sección 2.
