# real-estate-agent

Agente de IA para automatizar tareas repetitivas de un broker inmobiliario
vía WhatsApp: consultas típicas de clientes, agenda de visitas contra
Google Calendar, recordatorios, recontacto de leads, y escalamiento al
broker humano cuando corresponde.

Fase 1 y Fase 2 del roadmap ya están completas y mergeadas — esto no es
un esqueleto vacío. Ver `docs/TASKS.md` para el estado exacto (qué está
hecho, qué falta, y los pendientes conocidos).

## Para arrancar

- Si estás usando Claude Code, andá directo a **`CLAUDE.md`** — tiene el
  contexto de negocio, las decisiones ya tomadas, y las convenciones de
  trabajo.
- Si sos humano y nunca viste este proyecto, empezá por
  **`docs/ONBOARDING.md`** — recorrido completo pensado para alguien sin
  contexto previo (qué problema resuelve, cómo funciona de punta a punta,
  por qué las decisiones grandes son como son, y cómo levantarlo en tu
  máquina).

Para el flujo de git (rama por bloque, Pull Request, nunca commit directo
a `main`), ver `CONTRIBUTING.md`.

## Estructura

```
real-estate-agent/
├── CLAUDE.md              # brief para Claude Code
├── docs/                  # SOW, intent catalog, políticas, arquitectura, onboarding, backlog
├── apps/orchestrator/     # servicio principal
├── mcp-servers/           # integraciones (Tokko, Google Calendar, Weather) como MCP servers
├── packages/shared-types/ # tipos compartidos + loader del intent catalog
└── docker-compose.yml     # Postgres, provisionado para cuando se migre desde JSON local (ver docs/TASKS.md)
```

## Stack

TypeScript + Node.js (monorepo con npm workspaces), Claude API con
tool-use, MCP para las integraciones externas, WhatsApp Business Platform
(Cloud API oficial), Google Calendar API, Tokko Broker API. Persistencia
hoy en archivos JSON locales — Postgres está provisionado pero todavía no
en uso (ver `docs/TASKS.md`).
