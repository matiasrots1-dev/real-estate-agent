# Flujo de trabajo

Este documento describe cómo se desarrolla este repo — pensado tanto para
Claude Code en futuras sesiones como para cualquier persona que se sume al
proyecto. Es el complemento operativo de `CLAUDE.md` (que tiene el contexto
de negocio) y `docs/TASKS.md` (que tiene el backlog).

## Regla central

**Nunca se commitea directo a `main`.** Todo cambio entra por una rama +
Pull Request, revisado antes de mergear (paso 7).

`main` está protegida en GitHub desde el 2026-09-19 (regla de rama
clásica, Settings → Branches): exige PR para mergear, con **0 aprobaciones**
(así Claude Code puede mergear sus propios PRs después de revisarlos), y
**aplica también a los administradores**, así que un push directo falla
para cualquiera. No se permiten force push ni borrar la rama.

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
3. **Hacé el pre-mortem** (ver la sección dedicada más abajo) y después
   **implementá el bloque completo**: código + tests. Commits chicos y
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
   Después abrí el PR con `gh pr create` (el `gh` CLI está instalado y
   autenticado en la laptop del dueño del repo; en Windows vive en
   `C:\Program Files\GitHub CLI\gh.exe` y puede no estar en el PATH de la
   terminal). Título y cuerpo con el resumen del bloque: qué se
   implementó, decisiones de diseño no obvias, qué quedó
   mockeado/pendiente de una credencial real, y el conteo de tests. Mismo
   tono que las entradas de `docs/TASKS.md`.
7. **Revisión y merge.** Desde el 2026-09-19, por decisión del dueño del
   repo, **los PRs de Claude Code los revisa y los mergea Claude Code**:
   - corre un code review sobre el PR;
   - arregla en la misma rama lo que sea del propio bloque (regresiones, o
     promesas que el bloque hace y no cumple), con tests y mutation testing;
   - anota el resto como riesgo abierto en `docs/TASKS.md`;
   - deja la revisión como comentario en el PR, para que el dueño la pueda
     leer después;
   - mergea con merge commit (`gh pr merge N --merge`).

   **Tres cosas siguen necesitando el OK explícito del dueño antes de
   mergear**: apagar el modo silencioso, cualquier cambio que haga que el
   bot le escriba a clientes, y borrar datos. Nunca se usa `--admin` para
   saltear una protección de la rama.
8. **Después de que se mergea**, volvé a `main` y actualizá antes de
   arrancar el próximo bloque:
   ```
   git checkout main
   git pull
   ```

## Pre-mortem antes de codear

**Cuándo aplica**: a bloques que tocan **código o comportamiento**. Un
cambio que solo toca documentación, texto, o configuración sin lógica se
lo saltea — pero dejando **una línea en el commit diciendo que se saltó y
por qué**, para que la omisión sea una decisión visible y no un olvido.

Ojo con la palabra "configuración": `docs/intent_catalog.yaml` **no**
cuenta como config exenta. Es la fuente de verdad de las reglas de
negocio del agente (umbrales de confianza, `requires_broker`, plantillas
de respuesta), así que editarlo es tocar comportamiento aunque sea un
YAML — el pre-mortem aplica igual.

Antes de escribir código en un bloque: imaginá que ya está mergeado y
falló en producción, y planteá **3 modos de fallo concretos**. La barra
es que cada uno sea lo bastante específico como para poder testearlo o
descartarlo — *"el classifier devuelve algo que no es boolean y el gate
nunca destraba"* sirve; *"podría haber un bug"* no. Con cada uno hacé una
de dos cosas, nunca lo dejes implícito: mitigarlo ya (un test, una guarda
en el código), o anotarlo en `docs/TASKS.md` como riesgo conocido y
asumido.

No es ceremonia ni pide un artefacto nuevo: va en el hilo de trabajo, y a
`docs/TASKS.md` solo llega lo que sobrevive como riesgo asumido.

**Antes de escribir el tuyo, leé los obituarios previos** — las
retrospectivas de fracasos que ya están en `docs/TASKS.md`. Y cuando algo
falle, la entrada nueva no alcanza con contar qué lo mató: agregá **qué
pregunta lo habría agarrado antes**. Esa cláusula es la que alimenta los
pre-mortems siguientes; sin ella cada bloque arranca de cero.

Existe porque este proyecto ya pagó varias veces por no tenerlo: 255
tests en verde con un gate que no podía destrabarse nunca, datos
personales entrando al repo dos veces, y una app publicada en Meta
asumiendo que era lo que bloqueaba el webhook entrante cuando no lo era.
El catálogo completo de modos de fallo ya vividos está en `CLAUDE.md`
secc. 7, como semilla para no arrancar de cero.

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

- **Puntos de revisión reales**: el PR es el momento de la revisión, con el
  diff completo a la vista. El dueño del repo tiene conocimientos técnicos
  pero no revisa cada línea: la revisión queda escrita como comentario en
  el PR, para que la pueda leer y discutir cuando quiera.
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
