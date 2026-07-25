# apps/orchestrator

Servicio principal: recibe el webhook de WhatsApp, corre el router de
intents contra `docs/intent_catalog.yaml`, ejecuta el loop de tool-use con
Claude API, y aplica la política de `docs/escalation_policy.md`.

**Estado**: esqueleto vacío. Ver `docs/TASKS.md` bloque 3 en adelante.

## Estructura esperada de `src/`
- `channels/whatsapp/` — webhook handler, envío de mensajes/plantillas.
- `agent/router.ts` — clasificador de intents (primera pasada).
- `agent/llm_agent.ts` — loop de tool-use con Claude API.
- `agent/intents/` — loader del catálogo YAML + handlers por intent.
- `agent/state_machine.ts` — estado de conversación multi-turno.
- `agent/escalation.ts` — implementación de `docs/escalation_policy.md`.
- `jobs/` — recordatorios y recontacto (recién en fase 2, ver TASKS.md).
- `db/` — schema y repositorios (conversations, messages, audit_log, etc).
