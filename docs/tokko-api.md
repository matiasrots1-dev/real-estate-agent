# API de Tokko Broker — comportamiento medido

> **Esta es la fuente de verdad del comportamiento de la API de Tokko en este
> proyecto.** Todo lo que está acá fue verificado empíricamente contra la
> cuenta real. Lo que sale de la documentación oficial y no se probó está
> marcado como **no verificado**.
>
> **Tokko puede cambiar sin avisar.** Si observás algo que contradice este
> archivo: **re-medilo y actualizá el archivo**, no trabajes alrededor. Un
> workaround silencioso sobre un comportamiento que cambió es exactamente cómo
> se pierde una tarde — ya pasó tres veces acá con la paginación.
>
> Si necesitás saber algo que no está documentado: **medilo primero y anotalo
> acá**. No lo asumas.
>
> **Fecha de la medición: 2026-08-25**, salvo donde se indique otra.

---

## 0. Los cinco (ahora seis) hallazgos que costaron tiempo

Resumidos acá porque cada uno se descubrió tarde y por separado.

| # | Hallazgo | Consecuencia si no se sabe |
|---|---|---|
| 1 | `/contact/` topea la página en **50** aunque se pida 200 | Avanzar el offset por lo *pedido* saltea 150 por vuelta: una muestra dispersa del 25% que parece un barrido completo |
| 2 | Paginar un dataset **vivo** devuelve registros repetidos | El mismo lead aparece dos veces y el job de recontacto le escribe dos veces |
| 3 | Sin `order_by`, cada corrida lee un **subconjunto distinto** | La lista a revisar antes de aprobar cambia sola; hay registros que no se leen nunca |
| 4 | `?branch_id=` en `/property/` devuelve **200 e ignora el filtro** | Se cree que se filtró por sucursal y el agente cita propiedades ajenas |
| 5 | El header `Authorization: Token` **no autentica**: devuelve el catálogo público | El agente le cita a los clientes propiedades de **otras inmobiliarias** |
| 6 | `order_by` **no es uniforme por endpoint**: `/contact/` lo acepta, `/property/` devuelve 400 | Agregarlo "a todas las llamadas" rompe la búsqueda de propiedades |

El patrón común de 4, 5 y 6: **la API falla de formas que parecen éxito**.
Un 200 no significa que el parámetro se haya aplicado.

---

## 1. Autenticación

*Verificado 2026-08-25 contra `/property/`.*

| Forma | HTTP | `total_count` | Veredicto |
|---|---|---|---|
| `?key=<válida>` | 200 | **76** | ✅ **La única que autentica** |
| `?key=<inválida>` | 401 | — | Rechaza bien |
| Header `Authorization: Token <válida>` | 200 | 7613 | ⚠️ **Ignorado** — catálogo público |
| **Sin key** | 200 | 7613 | ⚠️ **Devuelve datos igual** |
| `?api_key=<válida>` | 200 | 7613 | ⚠️ Nombre de parámetro equivocado, ignorado |

**Verificación al arranque**: `mcp-tokko` no sirve nada hasta confirmar que la
key autentica. La comprobación es **diferencial** — pide el total con key y sin
key, y falla si dan lo mismo — y no por umbral: un umbral del tipo "más de N
propiedades es sospechoso" rompería para una inmobiliaria grande y es una
adivinanza. Ver `RealTokkoClient.verificarAutenticacion()`.

**Lo peligroso**: cualquier forma que no sea `?key=` devuelve **200 con datos**
— no un 401. Los 7613 son el catálogo público de Tokko, no los 76 de esta
cuenta. Un cliente mal configurado no falla: devuelve datos ajenos con total
confianza.

**La key viaja en la URL** y aparece en texto plano dentro de `meta.next` y
`meta.previous` de cada respuesta. Cualquier log o volcado de la respuesta la
expone. *(Así se filtró una vez en este proyecto, el 2026-08-25.)*

---

## 2. Paginación

### Tamaño de página: pedido vs devuelto

*Verificado 2026-08-25.*

| Endpoint | `limit` pedido | Devueltos | `meta.limit` |
|---|---|---|---|
| `/property/` | 1 / 10 / 50 | 1 / 10 / 50 | refleja lo pedido |
| `/property/` | 100 / 200 / 1000 | 76 (= total) | refleja lo pedido |
| `/contact/` | 1 / 10 / 50 | 1 / 10 / 50 | refleja lo pedido |
| `/contact/` | **100 / 200 / 1000** | **50** | **50** |

**`/contact/` topea en 50.** `/property/` no se pudo medir por encima de 76
porque ese es el total de la cuenta — **no verificado** si tiene tope propio.

**Regla práctica: avanzar el offset por lo que la API DEVOLVIÓ, nunca por lo
que se pidió.** `meta.limit` no es confiable como indicador (en `/property/`
repite lo pedido aunque devuelva menos).

### Valores límite

| Parámetro | Resultado |
|---|---|
| `limit=0` | 200 — **devuelve TODO** (76). No es "cero resultados" |
| `limit=-5` | 400, `Invalid limit '-5' provided` |
| `limit=abc` | 400, mismo formato de error |
| `offset=999999` | 200 con `objects: []` |
| `offset=-1` | 400, `Invalid offset '-1' provided` |

### Forma de `meta`

```json
{ "limit": 2, "offset": 2, "total_count": 76,
  "next": "/api/v1/property/?offset=4&limit=2&key=<LA KEY EN CLARO>&format=json",
  "previous": "/api/v1/property/?offset=0&limit=2&key=<LA KEY EN CLARO>&format=json" }
```

**No hay cursor.** Sólo `offset`/`limit`. `next`/`previous` son URLs armadas —
útiles para seguir, pero **contienen la key**.

### Datasets vivos

`/contact/` crece durante el uso normal (4682 → 4684 en una sesión de trabajo).
Paginando por offset sin orden garantizado:

- se **repiten** registros (un insert corre los offsets y la página siguiente
  repite el final de la anterior);
- se **saltean** registros por el mismo motivo;
- cada corrida lee un **subconjunto distinto**.

**Mitigaciones que aplicamos**: `order_by` donde el endpoint lo acepta, y
deduplicación por `id` mientras se pagina. El corte del loop va por *offset
recorrido*, no por cantidad de únicos — contando únicos, con registros
repetidos el loop no termina nunca.

---

## 3. Filtros

**Método**: se compara el `total_count` contra el baseline sin filtros
(`/property/` = 76, `/contact/` = 4684). Si es igual, el parámetro se ignoró.
Un parámetro inventado (`filtro_inventado=xyz`) sirve de control: devuelve el
baseline en los dos endpoints.

### `/property/` — baseline 76

*Verificado 2026-08-25.*

| Parámetro | Resultado | Veredicto |
|---|---|---|
| `type=2` | 60 | ✅ **Funciona** |
| `id=6682898` | 1 | ✅ **Funciona** |
| `reference_code=NOEXISTE` | 0 | ✅ **Funciona** |
| `development__isnull=false` | 1 | ✅ **Funciona** |
| `branch_id=94185` | **76** | ⚠️ **IGNORADO en silencio** |
| `property_type=2` | 76 | ⚠️ Ignorado |
| `operation_type=Sale` | 76 | ⚠️ Ignorado |
| `price__gte=999999999` | 76 | ⚠️ Ignorado |
| `deleted_at__gte=2015-12-31T00:00:00` | 76 | ⚠️ Inconcluso (todas coinciden) |
| `filtro_inventado=xyz` | 76 | ⚠️ Ignorado *(control)* |
| `branch=` / `branch__id=` | 400 | Rechaza |
| `status=2` / `status=99` | 400 | Rechaza (¡aunque `status` **es** un campo!) |
| `room_amount=4` | 400 | Rechaza |
| `order_by=created_at` / `order_by=id` | **400** | Rechaza |

**`branch_id` es la trampa**: la [documentación](https://developers.tokkobroker.com/docs/pegadas-utiles-a-la-api)
lo muestra para `/development/`, y en `/property/` lo acepta y lo ignora.
**El filtro por sucursal hay que hacerlo del lado del cliente.**

### `/contact/` — baseline 4684

*Verificado 2026-08-25.*

| Parámetro | Resultado | Veredicto |
|---|---|---|
| `agent=129318` | **1354** | ✅ **Funciona** (id de usuario, no nombre) |
| `created_at__gte=2026-01-01T00:00:00` | 2372 | ✅ **Funciona** |
| `order_by=created_at` | 4684 | ✅ **Aceptado** (ordena, no filtra) |
| `branch_id=94185` | 4684 | ⚠️ Ignorado |
| `agent_id=129318` | 4684 | ⚠️ Ignorado |
| `filtro_inventado=xyz` | 4684 | ⚠️ Ignorado *(control)* |
| `agent__id=` | 400 | Rechaza |
| `lead_status=Cerrado` | 400 | Rechaza |
| `tags=Web` / `tags__name=Web` | 400 | Rechaza |
| `name=Clara` | 400 | Rechaza |
| `email__isnull=false` | 400 | Rechaza |
| `order_by=name` / `order_by=id` | 400 | Rechaza |

**Nota sobre `agent=`** *(resuelto 2026-08-25)*: en una medición anterior el
filtro del servidor daba 1354 y el mismo criterio del lado del cliente daba
1377. **La diferencia era del lado nuestro, no de la API**: los 23 de más eran
registros repetidos por la paginación rota (sin `order_by` ni deduplicación).
Re-medido con la paginación arreglada: los dos dan **1354** y los conjuntos de
ids son **idénticos** — 0 en cada dirección. `agent=<user_id>` es confiable
para filtrar del lado del servidor.

### `order_by` por endpoint

| Endpoint | `created_at` | `id` |
|---|---|---|
| `/contact/` | ✅ 200 | 400 |
| `/property/` | **400** | 400 |
| `/branch/` | 400 | 400 |
| `/user/` | 400 | 400 |

**No es uniforme.** Mandar `order_by=created_at` "a todas las llamadas" rompe
`/property/` con un 400. En este repo eso vive en `ORDEN_POR_ENDPOINT`, dentro
de `realTokkoClient.ts`.

---

## 4. Endpoints

*Verificado 2026-08-25.*

| Endpoint | HTTP | Contenido |
|---|---|---|
| `/property/` | 200 | Propiedades (76 en esta cuenta) |
| `/contact/` | 200 | Contactos (4684) |
| `/contact/<id>/` | 200 | **Los mismos 21 campos que el listado** — no trae nada extra |
| `/branch/` | 200 | Sucursales (2) |
| `/user/` | 200 | Usuarios/agentes (4) |
| `/development/` | — | **No verificado** (documentado oficialmente) |
| `/webcontact/` | 405 | Existe pero sólo acepta POST |
| `/inquiry/`, `/opportunity/`, `/query/`, `/contact_inquiry/`, `/search/`, `/agent/` | 404 | No existen |

**No hay forma de saber por qué propiedad consultó un contacto.** No existe
endpoint de consultas y el contacto no tiene el dato. Lo más cercano son las
etiquetas de barrio.

---

## 5. Campos: tipos reales

*Verificado 2026-08-25. El tipo no es uniforme: algunos campos son objetos y
otros strings planos, sin que el nombre lo sugiera.*

### `/contact/` (21 campos)

| Campo | Tipo real | Notas |
|---|---|---|
| `id` | number | |
| `name` | string | Puede venir vacío |
| `agent` | **objeto** | `{id, name, email, phone, cellphone, picture, position}` |
| `lead_status` | **string plano** | `"Cerrado"`, `"Sin Contactar"`, `"Tomar Accion"`, `"Esperando respuesta"`, `"Pendiente contactar"` |
| `opportunity_status` | string plano | Misma distribución que `lead_status`, pero **no son idénticos campo a campo** |
| `tags` | array de objetos | `{id, name, group_name}`; `group_name` puede ser `null` |
| `cellphone` / `phone` / `other_phone` | string | **Sin validación** — ver abajo |
| `email` / `other_email` / `work_email` | string | Pueden venir vacíos |
| `created_at` | string ISO sin zona | `"2026-08-03T01:24:33"` |

**No existe campo de última actividad.** El único dato temporal es
`created_at`. No se puede saber desde la API cuándo se habló por última vez con
un contacto.

**Los teléfonos no tienen ninguna normalización** — quedan como los tipeó el
agente. Sobre 200 contactos medidos:

| Forma | Casos |
|---|---|
| `+` y 13 dígitos | 50 |
| 12 dígitos pelados | 24 |
| 13 dígitos pelados | 4 |
| **espacio inicial** + dígitos | 6 |
| con guiones (`NN N NN NNNN-NNNN`) | 2 |
| **10 dígitos, sin código de país** | 1 |

No hay campo de código de país separado (las **sucursales** sí tienen
`phone_country_code`; los contactos no).

### `/property/` (89 campos)

| Campo | Tipo real | Notas |
|---|---|---|
| `id` | number | |
| `type` | **objeto** | `{id, code, name}`, `name` **en inglés**: `Apartment`, `House`, `Condo`, `Office`, `Warehouse`, `Land` |
| `status` | number | **Vale `2` en las 76** — no distingue disponibilidad |
| `situation` | string | `"In use"`, `"Empty"`, `"---"` — es ocupación, no disponibilidad |
| `operations` | array | `{operation_id, operation_type, prices[]}`; `operation_type` ∈ `Sale`, `Rent`, `Temporary rent` |
| `operations[].prices[]` | array | `{currency, price, period, is_promotional}` |
| `expenses` | **string** | `"290000"` — hay que convertir |
| `geo_lat` / `geo_long` | **string** | `"-34.5774547"` |
| `room_amount` / `total_surface` | string | Numéricos como string |
| `photos` | array | `{image, description, is_blueprint}` — `is_blueprint` separa planos de fotos |
| `tags` / `custom_tags` | array de objetos | `tags` son amenities (Water, Gas…); `custom_tags` está **vacío** en esta cuenta |
| `publication_title` | string | **Acá se marca la disponibilidad a mano** (ver abajo) |
| `branch` | objeto | `{id, name, …}` |
| `public_url` | string | Link al portal |

**La disponibilidad no existe como dato estructurado.** El broker escribe
`RESERVADO` / `VENDIDO` en `publication_title`. Medido sobre las 76: 13
`RESERVADO`, 1 `VENDIDO`, 0 `ALQUILADO`, 62 sin marca.

Una propiedad puede estar publicada **en venta y en alquiler a la vez**: el
precio no es un valor único.

---

## 6. Límites, timeouts y errores

*Parcialmente verificado.*

- **Timeout del servidor: 30 segundos** — documentado, **no verificado**.
- **Máximo 1000 propiedades por request** — documentado, **no verificado**
  (esta cuenta tiene 76).
- **Página recomendada: 20** — documentado. Medido: `/contact/` topea en 50.
- **Errores**: los 400 devuelven JSON con `{"error": "…"}` y un mensaje
  legible (`Invalid limit '-5' provided…`). Los 401 devuelven **cuerpo vacío**.
- **Rate limits**: **no verificado.** No se observó throttling leyendo los 4684
  contactos en ~94 requests seguidos, pero no se buscó el límite a propósito.
- **Escritura**: **no verificado.** `logActivity` no está implementado porque
  falta confirmar con el soporte de Tokko si el plan lo permite y si hay
  ambiente de prueba.

---

## 7. Cómo re-medir

Los sondeos que produjeron este documento son consultas de **solo lectura**.
Para rehacerlos, el patrón es:

```js
// SIEMPRE con redacción global de la key: aparece en meta.next.
const log = (...a) => console.log(a.join(" ").split(KEY).join("[KEY]"));

// Un filtro "funciona" sólo si cambia total_count respecto del baseline.
// Comparar siempre contra un parámetro inventado como control.
```

Reglas aprendidas al medir:

1. **Un 200 no significa que el parámetro se aplicó.** Comparar `total_count`.
2. **Usar un parámetro inventado como control** en cada endpoint.
3. **Probar cada parámetro en cada endpoint**: el comportamiento no se
   generaliza (`order_by` es el ejemplo).
4. **Redactar la key en toda la salida**, no sólo en el camino de error.
5. **Los dobles de test tienen que rechazar lo que la API rechaza.** Un doble
   más permisivo que el original no prueba compatibilidad: prueba que el doble
   es permisivo. Así pasó la regresión de `order_by` con 16 tests en verde.
