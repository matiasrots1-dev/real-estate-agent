# CLAUDE.md — Brief del proyecto para Claude Code

Este archivo es el punto de entrada. Leelo completo antes de tocar código.
Sos vos (Claude Code) quien va a llevar adelante el desarrollo desde acá en
adelante, sin supervisión turno a turno de un chat externo. Este documento
te da el contexto de negocio, las decisiones ya tomadas, y por dónde empezar.

## 1. Qué es este proyecto

Un agente de IA que automatiza tareas repetitivas de un broker inmobiliario
individual (no una agencia grande), operado por WhatsApp. Responde consultas
típicas de clientes, agenda visitas contra Google Calendar, dispara
recordatorios y recontacto proactivo, y **escala al broker humano** cuando
la consulta lo amerita (negociación, reclamo, algo legal, baja confianza).

El dueño del proyecto es un broker inmobiliario con conocimientos técnicos
(no es un desarrollador de tiempo completo). Andá directo al grano en tus
respuestas y explicaciones — no hace falta simplificar conceptos técnicos,
pero tampoco asumas que va a revisar cada línea de código.

## 2. Documentos que ya existen — leelos en este orden

1. **`docs/SOW.md`** — el documento de alcance completo: arquitectura,
   fases del roadmap, riesgos, APIs a integrar. Es la fuente de verdad del
   *qué* y el *por qué*. Si algo en el código contradice este documento,
   el documento gana a menos que el usuario diga explícitamente lo
   contrario.
2. **`docs/intent_catalog.yaml`** — el catálogo de intents: qué consultas
   reconoce el agente, qué tools dispara cada una, y cuándo escala al
   broker. **Es la fuente de verdad de las reglas de negocio**, no un
   ejemplo. El código del router/agente debe leer este archivo en runtime,
   no hardcodear los intents en el prompt ni en TypeScript.
3. **`docs/escalation_policy.md`** — la política de escalamiento en detalle
   (cuándo el agente puede actuar solo vs. cuándo espera al broker).
4. **`docs/architecture.md`** — diagrama de arquitectura (Mermaid) y
   explicación del flujo de mensajes.

No dupliques información entre estos documentos y el código — el código
implementa lo que estos documentos especifican.

## 3. Decisiones ya tomadas (no las reabras sin preguntar)

- **Stack**: TypeScript + Node.js en todo el monorepo (orchestrator y MCP
  servers). Elegido por el ecosistema MCP y porque simplifica compartir
  tipos entre `packages/shared-types` y el resto.
- **Canal**: WhatsApp Business Platform (Cloud API oficial de Meta). No usar
  librerías no oficiales (whatsapp-web.js, Baileys) en ningún entorno que no
  sea un experimento local descartable — violan los ToS de Meta.
- **LLM**: Claude API (Anthropic) con tool-use nativo. Modelo por defecto:
  `claude-sonnet-4-6` para el agente; evaluar un modelo más chico solo si
  el router de intents se vuelve el cuello de botella de costo/latencia.
- **CRM**: Tokko Broker API (REST) — confirmar con el usuario el nivel de
  acceso de su plan antes de asumir que un endpoint existe.
- **Calendario**: Google Calendar API, un calendario dedicado (no el
  personal del broker) — confirmar con el usuario si ya lo creó.
- **Clima**: OpenWeatherMap o WeatherAPI.com, tier gratuito alcanza.
- **Persistencia**: SQLite en desarrollo/POC, Postgres en producción (ver
  `docker-compose.yml`). Redis se suma recién en fase 2 (colas de jobs).
- **Integraciones como MCP servers separados** (`mcp-servers/mcp-tokko`,
  `mcp-servers/mcp-gcal`, `mcp-servers/mcp-weather`), no como llamadas HTTP
  sueltas dentro del orchestrator. Cada uno debe ser testeable de forma
  aislada con un cliente MCP genérico.
- **Auditoría desde el día 1**: toda respuesta del agente debe loguear en
  `audit_log` qué intent matcheó, con qué confianza, y qué tools se
  llamaron. Esto no es opcional ni se pospone a una fase posterior.

## 4. Cómo está organizado el repo

```
real-estate-agent/
├── CLAUDE.md                  # este archivo
├── docs/                      # SOW, intent catalog, políticas, arquitectura
├── apps/orchestrator/         # el servicio principal (webhook + agente + jobs)
├── mcp-servers/                # un paquete por integración externa
│   ├── mcp-tokko/
│   ├── mcp-gcal/
│   └── mcp-weather/
├── packages/shared-types/      # tipos TS compartidos entre orchestrator y MCP servers
├── infra/                      # scripts de infra/seed
└── docker-compose.yml          # postgres + redis para desarrollo local
```

Cada carpeta de `apps/` y `mcp-servers/` tiene su propio `package.json` —
es un monorepo con npm/pnpm workspaces (ver `package.json` raíz).

## 5. Estado actual (importante: leé esto antes de generar código)

**Esto ya no es un repo vacío.** Fase 1 (Bloques 0-5) y Fase 2 (Bloques
6-11) están completas y mergeadas a `main`: hay un agente funcional de
punta a punta — webhook de WhatsApp, loop de clasificación + tool-use con
Claude, escalamiento al broker, máquina de estados para agendar/
reprogramar visitas, recordatorios y recontacto proactivo (scheduler), y
el canal broker completo (resúmenes de agenda/leads, pausar el agente, y
`broker_accion_directa` — el broker da órdenes en lenguaje libre y el
agente las ejecuta, con un gate de confirmación obligatorio si la orden
afecta a más de un contacto). El detalle bloque por bloque — qué se
construyó, qué se decidió y por qué, qué tests lo cubren — vive en
`docs/TASKS.md`. No lo dupliques acá: leelo antes de tocar un área que no
conocés, y agregá una entrada ahí cuando cierres un bloque nuevo.

**Blocker activo, no resuelto en código**: el camino ENTRANTE de WhatsApp
(que Meta le entregue al orchestrator un mensaje real de un cliente) está
técnicamente armado y verificado contra Meta real (webhook, firma HMAC,
túnel, verify token) pero **hoy no recibe mensajes de producción**.
Publicar la app no lo resolvió. La causa más probable — investigada, pero
sin confirmación 100% oficial de Meta — es que el número de prueba
gratuito que se está usando es de solo salida (no puede recibir). Ver
Bloque 11/12 de `docs/TASKS.md` para el detalle completo, y las dos
opciones evaluadas para resolverlo (registrar un número propio, o
Coexistence con el número laboral existente del broker — esta última
requiere pasar por un Tech Provider externo, no es self-service).

**Integraciones reales vs. mock, estado actual de `.env`**: WhatsApp
Business Cloud API, Google Calendar y OpenWeatherMap tienen credenciales
reales cargadas y en uso. **Tokko sigue sin credenciales** (`TOKKO_API_KEY`
vacío) — todo lo que toca Tokko corre contra `MockTokkoClient`
(`mcp-servers/mcp-tokko/src/mockTokkoClient.ts`). Si necesitás confirmar
el estado exacto de una credencial antes de asumir nada, no adivines:
`grep` el nombre de la variable en `.env` (nunca imprimas el valor) o
preguntale al usuario.

**Persistencia sigue siendo JSON local** (`apps/orchestrator/data/`,
gitignoreado), no Postgres — el swap de implementación detrás de las
interfaces ya existentes (`AuditLogStore`, `AppointmentStore`,
`ConversationStateStore`) es el Bloque 12/13 de `docs/TASKS.md`, todavía
sin arrancar.

**Para una introducción completa pensada para alguien nuevo en el
proyecto** (no solo para vos, Claude Code, que ya tenés todo este
contexto de sesiones anteriores) **ver `docs/ONBOARDING.md`.**

## 6. Por dónde empezar — plan de trabajo sugerido

`docs/TASKS.md` es el backlog ordenado y la fuente de verdad de qué está
hecho. Abrilo y andá al primer bloque sin `[x]` — ese es el punto de
partida real, no una lista fija escrita acá (que quedaría desactualizada
apenas se cierre el próximo bloque, como pasó con la versión anterior de
esta sección). Al momento de escribir esto, eso es el Bloque 12
(persistencia real en Postgres) — pero no lo des por hecho, confirmalo en
`docs/TASKS.md` antes de arrancar nada.

Mismo criterio que siempre: no saltes a un bloque nuevo sin haber cerrado
el anterior con tests en verde, y no implementes algo fuera del bloque
activo por iniciativa propia — si te parece que falta algo, decíselo al
usuario en vez de agregarlo por tu cuenta.

## 7. Convenciones de trabajo

- **Flujo de git: rama por bloque + Pull Request, nunca commit directo a
  `main`.** `main` está protegida contra push directo (GitHub → Settings →
  Branches). Al arrancar un bloque de `docs/TASKS.md`, creá una rama
  (`bloque-N-slug-corto`); al cerrarlo con tests en verde, actualizá
  `docs/TASKS.md` y abrí un PR contra `main` con un resumen — el dueño del
  repo lo revisa y aprueba desde GitHub, no asumas el merge. Detalle
  completo del flujo en `CONTRIBUTING.md`.
- Commits chicos y descriptivos, en español o inglés (consistente con lo
  que ya haya en el repo).
- Cada MCP server debe tener su propio test que lo ejercite de forma
  aislada (no dependas del orchestrator corriendo para testear un MCP
  server).
- No hardcodees ningún intent, umbral de confianza, ni plantilla de
  WhatsApp en TypeScript — todo eso vive en `docs/intent_catalog.yaml` y el
  código lo lee en runtime. Si `intent_catalog.yaml` no cubre un caso que
  necesitás, primero editá el YAML, después el código.
- Nunca inventes datos de una propiedad, precio o disponibilidad si el
  tool correspondiente no los devolvió — es una regla de negocio dura, no
  una preferencia de estilo (ver `response.style: generative_grounded` en
  el catálogo de intents).
- Variables de entorno: usá `.env.example` como referencia de qué necesita
  el proyecto: completalo a medida que agregues integraciones, nunca
  hardcodees una credencial en el código.
- Si en algún punto te encontrás bloqueado por falta de una credencial o
  una decisión de negocio (no técnica), preguntale al usuario directamente
  en la sesión de Claude Code — no lo asumas ni lo dejes sin resolver
  silenciosamente.

## 8. Qué no hacer

- No agregues pagos, firma electrónica, ni multi-tenant — están fuera de
  alcance explícito en `docs/SOW.md` sección "Out of scope".
- No uses WhatsApp no oficial en ningún entorno que no sea un experimento
  local descartable.
- No le des al agente permiso de ejecutar acciones irreversibles de alto
  impacto sin pasar por la política de escalamiento (ver sección 5.1 del
  SOW / `docs/escalation_policy.md`).
