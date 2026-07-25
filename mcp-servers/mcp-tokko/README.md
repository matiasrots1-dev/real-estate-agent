# mcp-tokko

MCP server que expone la API de Tokko Broker: `search_properties`,
`get_property`, `search_leads`, `get_lead`, `log_activity`.

No hay server de referencia público para Tokko — hay que implementarlo
contra su documentación real de API. **Antes de implementar, confirmar con
el usuario qué endpoints expone su plan actual** (no todos los planes de
Tokko exponen el mismo nivel de API, ver `docs/SOW.md` sección 4.2).

Si todavía no hay credenciales/confirmación, implementar con mocks y dejar
marcado `// TODO: validar contra API real de Tokko` en cada tool — no
bloquear el resto del proyecto por esto.

**Estado**: esqueleto vacío, sin implementar. Ver `docs/TASKS.md` bloque 2.
