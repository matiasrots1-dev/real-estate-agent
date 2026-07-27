# Flujo de trabajo

Este documento describe cómo se desarrolla este repo — pensado tanto para
Claude Code en futuras sesiones como para cualquier persona que se sume al
proyecto. Es el complemento operativo de `CLAUDE.md` (que tiene el contexto
de negocio) y `docs/TASKS.md` (que tiene el backlog).

## Regla central

**Nunca se commitea directo a `main`.** La rama está protegida (GitHub →
Settings → Branches) para que un push directo falle. Todo cambio entra por
una rama + Pull Request, revisado y aprobado por el dueño del repo antes de
mergear.

## Paso a paso

1. **Elegí el próximo ítem sin marcar de `docs/TASKS.md`** (Fase 1 o Fase 2,
   el que esté activo). No arranques un bloque nuevo sin haber cerrado el
   anterior.
2. **Creá una rama desde `main` actualizado**:
   ```
   git checkout main
   git pull
   git checkout -b bloque-N-slug-corto
   ```
   Ejemplos: `bloque-6-recordatorios`, `bloque-7-recontacto`,
   `bloque-8-broker-resumenes`. Para trabajo que no corresponde a un bloque
   del backlog (un fix puntual, una tarea de infra), usá un prefijo
   descriptivo: `fix/...`, `chore/...`.
3. **Implementá el bloque completo**: código + tests. Commits chicos y
   descriptivos a medida que avanzás, no un commit gigante al final.
4. **Antes de abrir el PR, confirmá en verde**:
   ```
   npm run build
   npm run test
   ```
   en la raíz del repo (corre los 5 paquetes del monorepo). Un bloque no
   está terminado si esto no pasa.
5. **Actualizá `docs/TASKS.md`**: marcá los checkboxes del bloque que se
   cierra, con el mismo nivel de detalle que ya tienen los bloques
   anteriores (qué se hizo, qué quedó pendiente de credenciales externas,
   cuántos tests nuevos).
6. **Pusheá la rama y abrí el Pull Request contra `main`**:
   ```
   git push -u origin bloque-N-slug-corto
   gh pr create --title "Bloque N: título corto" --body "..."
   ```
   El cuerpo del PR resume: qué se implementó, decisiones de diseño no
   obvias, qué quedó mockeado/pendiente de una credencial real, y el
   conteo de tests. Mismo tono que las entradas de `docs/TASKS.md`.

   Si no tenés `gh` instalado/autenticado, pusheá la rama igual — Git te da
   la URL para abrir el PR a mano desde la web de GitHub.
7. **Esperá la revisión.** No mergees el PR vos mismo ni asumas que va a
   aprobarse — el dueño del repo lo revisa y aprueba desde GitHub. Si pide
   cambios, hacé los commits nuevos en la misma rama.
8. **Después de que se mergea**, volvé a `main` y actualizá antes de
   arrancar el próximo bloque:
   ```
   git checkout main
   git pull
   ```

## Por qué este flujo

- **Puntos de revisión reales**: el dueño del repo tiene conocimientos
  técnicos pero no revisa cada línea en tiempo real — el PR es el momento
  en que sí lo hace, con el diff completo a la vista.
- **`main` siempre en un estado conocido y andando**: si un bloque queda a
  mitad de camino, vive en su rama, no rompe lo que ya funciona.
- **Historia legible por bloque**: cada PR mapea 1:1 a un ítem de
  `docs/TASKS.md`, así que el historial de PRs *es* la bitácora del
  proyecto.

## Convenciones que ya rigen (ver `CLAUDE.md`)

- No hardcodear intents, umbrales de confianza, ni plantillas de WhatsApp
  en TypeScript — viven en `docs/intent_catalog.yaml`.
- Nunca inventar datos de una propiedad/precio/disponibilidad si el tool
  correspondiente no los devolvió.
- Si falta una credencial real (Tokko, Google Calendar, WhatsApp,
  templates aprobadas), avanzar con mocks/stubs y `// TODO` explícito —
  nunca bloquear el bloque por eso.
