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

**Lo que existe hoy**: documentación (`docs/`) y el esqueleto de carpetas
vacío. **Ningún código funcional está escrito todavía.** Todo lo que hay en
`apps/` y `mcp-servers/` son carpetas vacías o `package.json` mínimos sin
implementación real. Vas a partir de cero en la implementación.

**Lo que falta decidir con el usuario antes de escribir código** (preguntale
si no está en `docs/`):
- ¿Ya tiene un número de WhatsApp Business verificado, o arrancamos con el
  sandbox de Meta for Developers?
- ¿Tiene el token/credenciales de la API de Tokko a mano? ¿Confirmó qué
  endpoints expone su plan?
- ¿Ya creó un Google Calendar dedicado para visitas, o usamos el personal
  en el POC?

Si no tenés esas respuestas, no bloquees el trabajo por eso: avanzá con
mocks/stubs de esas integraciones y dejalo explícito en el código
(`// TODO: reemplazar por credenciales reales de Tokko`) para no frenar el
progreso esperando una respuesta.

## 6. Por dónde empezar — plan de trabajo sugerido

Seguí `docs/TASKS.md` como backlog ordenado. Resumen de las primeras
iteraciones:

1. **Setup del monorepo**: completar `package.json` raíz con workspaces,
   configurar TypeScript compartido (`tsconfig.base.json`), levantar
   `docker-compose.yml` (Postgres + Redis) y confirmar que todo compila con
   `npm run build` aunque no haya lógica todavía.
2. **`packages/shared-types`**: definir los tipos base (`Intent`,
   `ConversationState`, `Property`, `Appointment`, `Lead`, `AuditLogEntry`)
   a partir de lo que describe `docs/intent_catalog.yaml` y `docs/SOW.md`.
3. **`mcp-servers/mcp-weather`**: empezá por este, es el más simple — sirve
   para validar el patrón de MCP server del proyecto antes de meterte con
   Tokko o Calendar, que tienen más superficie de API.
4. **`mcp-servers/mcp-gcal`**: hay servers MCP de referencia públicos para
   Google Calendar — partí de uno existente y adaptalo a las funciones que
   necesita este proyecto (`freebusy`, `create_event`, `patch_event`,
   `delete_event`, `list_events`) en vez de escribirlo desde cero.
5. **`mcp-servers/mcp-tokko`**: wrapper de la API de Tokko Broker. No hay
   server de referencia público — implementalo contra la documentación
   real de la API una vez que el usuario confirme el acceso. Si todavía no
   la tiene, armá el server con mocks y dejalo marcado como pendiente de
   validar contra la API real.
6. **`apps/orchestrator`**: recién acá arranca el servicio principal —
   webhook de WhatsApp, loader de `intent_catalog.yaml`, loop de tool-use
   con Claude API, máquina de estados de conversación, y la lógica de
   escalamiento de `docs/escalation_policy.md`.
7. **Loop end-to-end mínimo**: un mensaje de WhatsApp de prueba que
   dispare `consulta_disponibilidad` contra un mock de Tokko y devuelva
   una respuesta. Este es el primer hito verificable — no sigas con más
   intents hasta que este loop funcione de punta a punta.

No implementes las fases 2+ del roadmap (recordatorios, recontacto,
multi-tenant) hasta que el loop mínimo de la fase 1 esté probado.

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
