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
      todo funciona correctamente contra un webhook real de Meta. Lo
      único que falta para recibir mensajes reales de clientes es
      **publicar la app** — no es un problema de código ni de
      configuración de este proyecto.
- [ ] **Publicar la app queda como bloque aparte** (número a definir
      cuando se arranque), por la razón original de no meterlo acá:
      depende de tiempos de Meta (verificación del negocio, App Review) —
      ver el resumen de requisitos que se armó para el usuario antes de
      decidir si arrancarlo.

## Bloque 12 — Persistencia real (Postgres), si el volumen ya lo justifica
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
