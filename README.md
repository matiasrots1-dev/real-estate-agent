# real-estate-agent

Agente de IA para automatizar tareas repetitivas de un broker inmobiliario
vía WhatsApp: consultas típicas de clientes, agenda de visitas contra
Google Calendar, recordatorios, recontacto de leads, y escalamiento al
broker humano cuando corresponde.

## Para arrancar a desarrollar

Si estás usando Claude Code, andá directo a **`CLAUDE.md`** — tiene todo
el contexto y el plan de trabajo.

Si sos humano y estás onboardeando manualmente:

1. Leé `docs/SOW.md` (alcance y arquitectura completa).
2. Leé `docs/intent_catalog.yaml` (reglas de negocio: qué reconoce el
   agente y cuándo escala).
3. `cp .env.example .env` y completá las credenciales que tengas
   disponibles (ver `docs/TASKS.md` si te faltan algunas — el proyecto
   está pensado para avanzar con mocks donde falte una credencial).
4. `docker compose up -d` (levanta Postgres local).
5. `npm install` en la raíz (instala todos los workspaces).
6. Seguí el backlog de `docs/TASKS.md` en orden.

## Estructura

```
real-estate-agent/
├── CLAUDE.md              # brief para Claude Code
├── docs/                  # SOW, intent catalog, políticas, arquitectura, backlog
├── apps/orchestrator/     # servicio principal
├── mcp-servers/           # integraciones (Tokko, Google Calendar, Weather) como MCP servers
├── packages/shared-types/ # tipos compartidos + loader del intent catalog
└── docker-compose.yml     # Postgres local
```

## Stack

TypeScript + Node.js (monorepo con npm workspaces), Claude API con
tool-use, MCP para las integraciones externas, WhatsApp Business Platform
(Cloud API oficial), Google Calendar API, Tokko Broker API, Postgres.
