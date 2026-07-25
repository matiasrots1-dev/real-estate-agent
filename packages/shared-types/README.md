# shared-types

Tipos TypeScript compartidos entre `apps/orchestrator` y los
`mcp-servers/*`, más el loader/parser de `docs/intent_catalog.yaml`.

**Primer paso** (ver `docs/TASKS.md` bloque 1): definir `Intent`,
`IntentCatalog`, `ConversationState`, `Property`, `Lead`, `Appointment`,
`AuditLogEntry` a partir de lo que describen `docs/SOW.md` y
`docs/intent_catalog.yaml`, y un loader con validación de schema (zod)
para el YAML — el orchestrator lo consume en runtime, el catálogo nunca se
hardcodea en TypeScript.

**Estado**: esqueleto vacío, sin implementar.
