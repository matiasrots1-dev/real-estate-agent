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
   está terminado si esto no pasa. (Cada commit, además, pasa solo por el
   escaneo de datos sensibles — ver la sección dedicada más abajo.)
5. **Actualizá `docs/TASKS.md`**: marcá los checkboxes del bloque que se
   cierra, con el mismo nivel de detalle que ya tienen los bloques
   anteriores (qué se hizo, qué quedó pendiente de credenciales externas,
   cuántos tests nuevos).
6. **Pusheá la rama**:
   ```
   git push -u origin bloque-N-slug-corto
   ```
   Git devuelve en la salida la URL directa para abrir el Pull Request
   ("Create a pull request for '...' on GitHub by visiting: ..."). No hay
   `gh` CLI configurado en este entorno, así que **quien empujó la rama le
   pasa ese link al dueño del repo** (o lo abre él mismo si es quien
   pushea) — el PR se crea a mano desde la web de GitHub con ese link,
   completando título y cuerpo con el resumen del bloque: qué se
   implementó, decisiones de diseño no obvias, qué quedó
   mockeado/pendiente de una credencial real, y el conteo de tests. Mismo
   tono que las entradas de `docs/TASKS.md`.

   (Si en algún momento se instala y autentica `gh` CLI, `gh pr create`
   hace este paso sin pasar por la web — pero no es el flujo actual.)
7. **Esperá la revisión.** Quien pushea no mergea su propio PR ni asume que
   va a aprobarse — el dueño del repo lo revisa y aprueba desde GitHub. Si
   pide cambios, hacé los commits nuevos en la misma rama.
8. **Después de que se mergea**, volvé a `main` y actualizá antes de
   arrancar el próximo bloque:
   ```
   git checkout main
   git pull
   ```

## Escaneo de datos sensibles antes de cada commit

`git commit` corre automáticamente `scripts/check-sensitive-data.mjs` antes
de crear el commit, y **lo bloquea** si detecta:

- tokens con forma de credencial (Meta/Graph API, Anthropic, headers
  `Bearer ...`),
- URLs de túnel (Dev Tunnels, ngrok, Cloudflare Tunnel),
- números de teléfono con forma real (Argentina, Israel), en cualquier
  archivo que no sea de test o mock.

Esto existe porque ya pasó dos veces (docs/TASKS.md, Bloques 10 y 12):
números de teléfono reales del usuario entraron a `main` durante sesiones
de live testing porque nadie los escaneó antes de commitear. No depende de
que alguien se acuerde de correrlo a mano — se activa solo la primera vez
que corrés `npm install` en un clone nuevo (script `prepare` del
`package.json` raíz, que apunta git a los hooks versionados en
`.githooks/` vía `core.hooksPath`), así que un colaborador nuevo lo tiene
desde el día uno sin hacer nada extra.

**Los archivos de test/mock quedan exentos del chequeo de teléfonos a
propósito** (usan números ficticios en todos lados, por diseño) — el
chequeo de tokens y URLs de túnel sí aplica siempre, en cualquier archivo.
Un número se considera "obviamente ficticio" (y no bloquea) si tiene una
corrida de 4+ dígitos iguales seguidos — la convención que ya usa el
proyecto para sus propios placeholders (ej. `...5559999`).

Correrlo a mano en cualquier momento:
```
npm run check:sensitive-data           # lo que está staged ahora
npm run check:sensitive-data -- --all  # todo el árbol de trabajo actual (auditoría puntual)
```

Si el hook bloquea un falso positivo real (no un dato sensible de
verdad), la salida ya sugiere el arreglo más simple (un placeholder con
la corrida de dígitos repetidos). Si hace falta saltearlo a propósito,
`git commit --no-verify` — con criterio, no de rutina, y dejando claro en
el PR por qué se saltó.

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
