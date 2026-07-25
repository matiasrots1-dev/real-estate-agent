# SOW / Roadmap — Agente de IA para gestión inmobiliaria vía WhatsApp

**Proyecto:** Asistente conversacional (LLM + tools) para automatizar tareas repetitivas de un broker inmobiliario, integrado a Tokko Broker, Google Calendar y WhatsApp Business.
**Versión:** 0.1 (borrador de trabajo)

---

## 1. Resumen ejecutivo

El objetivo es construir un **agente orquestado por un LLM con tool-use**, accesible por WhatsApp (tanto para vos como para tus clientes), que:

- Responda consultas típicas de clientes (disponibilidad, precios, características, ubicación, financiación, requisitos) sin tu intervención.
- Agende, reprograme y cancele visitas contra Google Calendar, cruzando disponibilidad tuya y del cliente.
- Dispare recordatorios (visitas, vencimientos de reserva, seguimientos de leads fríos).
- Haga recontacto proactivo de clientes según reglas (lead sin respuesta hace N días, visita realizada sin feedback, etc.).
- Detecte cuándo una consulta **no** es típica o tiene ambigüedad/riesgo comercial (negociación de precio, reclamos, algo legal) y **escale a vos** en lugar de improvisar.
- Te permita a vos, por WhatsApp, pedirle resúmenes, estado de agenda, clima para una visita, o dispararle acciones ("mandale la ficha del depto de Palermo a Juan y ofrecele el sábado a las 11").

La pieza central no es "un bot que contesta": es un **agente con memoria de estado por conversación, un catálogo de intents con acciones asociadas, acceso a tools externos vía function-calling/MCP, y una política de escalamiento humano explícita.**

---

## 2. Alcance

### In scope (fase 1–3)
- Integración WhatsApp Business Platform (Cloud API) — canal cliente y canal broker.
- Integración Tokko Broker API (lectura de propiedades/fichas, leads, contactos; escritura de notas/actividades).
- Integración Google Calendar API (lectura de disponibilidad, creación/edición/cancelación de eventos, invitaciones).
- Motor de intents (diccionario + fallback LLM) para consultas típicas y no típicas.
- Política de escalamiento a humano configurable.
- Recordatorios automáticos (visitas, seguimientos) vía WhatsApp.
- Recontacto proactivo basado en reglas temporales/estado del lead.
- Weather API para contexto de visitas.
- Resúmenes on-demand para el broker ("¿cómo viene mi agenda de mañana?", "resumen de leads de esta semana").
- Persistencia de conversaciones y estado (para no perder contexto entre mensajes).

### Out of scope (fase 1, revisar en fase 4+)
- Firma electrónica de reservas/contratos.
- Pagos o señas online.
- Multi-broker / multi-tenant (arrancamos con un solo broker: vos).
- Publicación automática de propiedades en portales (Zonaprop, Argenprop, etc.) — Tokko ya sindica esto.
- Voz (audio de WhatsApp) — se puede sumar en fase 3 con transcripción, no es bloqueante para el POC.

---

## 3. Arquitectura de alto nivel

*(ver diagrama arriba)*

Flujo resumido:

1. **Cliente** o **vos** mandan un mensaje por WhatsApp.
2. **WhatsApp Business API (Meta Cloud API)** recibe el webhook y lo reenvía a tu backend.
3. El **orquestador** (servicio propio, con el LLM en el centro) clasifica el mensaje contra el diccionario de intents, decide qué tools invocar, ejecuta, y compone la respuesta.
4. El orquestador llama a **Tokko API**, **Google Calendar API**, **Weather API** y a la **DB de estado** según el intent.
5. Si el intent requiere criterio humano (negociación, reclamo, ambigüedad, monto, algo fuera del diccionario con baja confianza), el orquestador **no responde solo**: te notifica a vos con el contexto y una respuesta sugerida, y espera tu OK o edición antes de (o en lugar de) enviarla.
6. La respuesta final sale por el mismo canal WhatsApp.

Un punto de diseño importante: **el orquestador no es "un prompt gigante"**. Es un servicio con:
- Router de intents (barato, determinístico donde se pueda).
- LLM con tool-use para los casos ambiguos o de lenguaje libre.
- Máquina de estados por conversación (para saber "estamos en medio de agendar una visita" vs "consulta suelta").
- Capa de políticas/guardrails (qué puede hacer solo, qué no).

---

## 4. Stack técnico: APIs y MCPs

### 4.1 Canales
| Componente | Opción recomendada | Notas |
|---|---|---|
| WhatsApp | **WhatsApp Business Platform (Cloud API)**, oficial de Meta | Directa de Meta, sin intermediario (BSP) para el POC. Para producción con más volumen/plantillas, evaluar un BSP (360dialog, Twilio, Gupshup) que te da UI de gestión de templates y mejor soporte. |
| Alternativa rápida para prototipar | `whatsapp-web.js` / Baileys (no oficial) | Útil solo para probar UX en días, **no** para producción (viola ToS de Meta, riesgo de baneo). Usalo solo en tu laptop para validar prompts, no lo despliegues. |

Restricciones clave de WhatsApp Cloud API que van a condicionar el diseño:
- Ventana de 24hs: fuera de esa ventana desde el último mensaje del usuario, solo podés mandar **plantillas pre-aprobadas** (ideal para recordatorios y recontacto).
- Opt-in explícito requerido para mensajes proactivos.
- Rate limits por número/calidad del número.

### 4.2 CRM inmobiliario
- **Tokko Broker API** (REST): propiedades, contactos/leads, actividades/tareas, búsquedas guardadas. Vas a necesitar el token de API de tu cuenta y revisar el rate limit y los endpoints disponibles para tu plan (no todos los planes exponen el mismo nivel de API).
- Casos de uso: buscar propiedad por dirección/barrio/código, traer ficha (fotos, precio, m², estado), crear/actualizar lead, loguear actividad ("visita agendada", "consulta respondida por bot"), marcar temperatura del lead.

### 4.3 Calendario
- **Google Calendar API**: `freebusy` para disponibilidad, `events.insert`/`patch`/`delete` para agendar, invitados con notificación automática al cliente (si tenés su mail) o manejo manual si solo tenés WhatsApp.

### 4.4 Clima
- **OpenWeatherMap** o **WeatherAPI.com**: ambas tienen tier gratuito suficiente para este volumen. Uso: dar contexto en el recordatorio de visita ("mañana 24°C, soleado, buen día para la terraza").

### 4.5 LLM y orquestación
- **Claude API** (Sonnet como motor principal por costo/latencia; se puede evaluar un modelo más chico para el router de intents y Sonnet solo para los casos que lo requieren).
- **Tool use / function calling** nativo de la API para invocar Tokko, Calendar, Weather.
- **MCP (Model Context Protocol)**: la forma prolija de exponer cada integración como un servicio de tools reutilizable y testeable por separado. Te conviene armar:
  - `mcp-tokko`: wrapper de la API de Tokko Broker (search_properties, get_property, create_lead_note, get_lead, etc.)
  - `mcp-gcal`: wrapper de Google Calendar (ya existen servers MCP de referencia para Calendar, podés partir de uno público y adaptarlo a tus reglas de negocio en vez de escribirlo desde cero)
  - `mcp-weather`: wrapper fino de la API de clima
  - `mcp-whatsapp` (opcional): si preferís que el envío de mensajes también sea un tool MCP en vez de lógica directa en el orquestador

  Ventaja de este enfoque: podés testear cada integración de forma aislada, versionarlas por separado, y en el futuro reusar los mismos MCP servers desde Claude Desktop/Claude Code para vos mismo (ej: pedirle a Claude desde tu compu "mostrame los leads fríos de Tokko" sin pasar por WhatsApp).

### 4.6 Estado, cola y persistencia
- **PostgreSQL**: conversaciones, mensajes, estado de la máquina de conversación, leads espejo (cache liviano de Tokko para no pegarle a su API en cada mensaje), reglas de recontacto, log de acciones del agente (auditoría — importante para poder revisar qué contestó solo el bot).
- **Redis** (opcional en POC, recomendado en MVP): cola de jobs para recordatorios/recontacto programados, y lock por conversación para evitar dobles respuestas si llegan mensajes muy seguidos.
- **Scheduler**: cron simple al inicio (ej. APScheduler en Python o node-cron) para chequear recordatorios/recontactos pendientes; en MVP se puede migrar a una cola con jobs programados (ej. BullMQ si es Node, Celery+beat si es Python).

### 4.7 Hosting
- Cualquier PaaS con soporte de webhooks estables y HTTPS: Railway, Render, Fly.io, o un VM chico en GCP/AWS. Para el POC, Railway o Render son los más rápidos de tener andando (deploy en minutos, HTTPS gratis, fácil de exponer el webhook de WhatsApp).

---

## 5. Diccionario de intents (tu idea, formalizada)

La idea que planteaste es correcta y es, de hecho, el patrón estándar para este tipo de agentes: **no le pidas al LLM que decida todo desde cero en cada mensaje**. Definí un catálogo de intents con:

- **Trigger**: ejemplos de frases / embeddings para matchear (no reglas rígidas de keywords, para que tolere variación de lenguaje).
- **Acción(es) asociada(s)**: qué tools se llaman.
- **Requiere confirmación del cliente**: sí/no.
- **Requiere intervención tuya**: sí/no/condicional.
- **Respuesta**: plantilla o generación libre acotada.

| Intent | Ejemplo de consulta | Acción | ¿Requiere vos? |
|---|---|---|---|
| `consulta_disponibilidad` | "¿el depto de Palermo sigue disponible?" | `tokko.get_property` + responder | No |
| `consulta_precio_condiciones` | "¿cuánto sale y qué garantía piden?" | `tokko.get_property` (campos precio/requisitos) | No |
| `agendar_visita` | "quiero ir a verlo el sábado" | `gcal.freebusy` → proponer horarios → `gcal.create_event` → `tokko.log_activity` | No (salvo conflicto de agenda) |
| `reprogramar_cancelar_visita` | "no puedo el sábado, ¿el domingo?" | `gcal.patch/delete` | No |
| `consulta_clima_visita` | "¿va a llover el sábado?" (tuya o del cliente) | `weather.get_forecast` | No |
| `pedido_ficha_multimedia` | "mandame fotos/planos" | `tokko.get_property` (media) | No |
| `negociacion_precio` | "¿hacen descuento por pago contado?" | Notificar a vos con contexto | **Sí** |
| `reclamo_queja` | cualquier tono de disconformidad | Notificar a vos, no responder con plantilla genérica | **Sí** |
| `consulta_legal_contractual` | "¿qué pasa si rescindo antes?" | Notificar a vos | **Sí** |
| `fuera_de_catalogo_baja_confianza` | intent no matcheado con confianza suficiente | Notificar a vos con la transcripción y una respuesta borrador | **Sí** (con sugerencia) |
| `recontacto_lead_frio` | disparado por regla temporal, no por mensaje entrante | Generar mensaje personalizado + `whatsapp.send_template` | Depende de política (ver 5.1) |
| `broker_resumen_agenda` (canal tuyo) | "resumen de mañana" | `gcal.list_events` + `tokko` cross-ref | No |
| `broker_accion_directa` (canal tuyo) | "mandale la ficha de X a Juan y ofrecele el sábado 11" | Compone y ejecuta multi-tool | No (sos vos dando la orden) |

### 5.1 Regla general de escalamiento
Un mensaje se escala a vos si se cumple **cualquiera** de:
1. El intent matcheado tiene `requiere_vos = true` (tabla arriba).
2. La confianza del clasificador de intent está debajo de un umbral (ej. <0.75).
3. El mensaje incluye señales de negociación/monto fuera de lo publicado, disconformidad, o términos legales/contractuales.
4. Hay una acción irreversible de alto impacto (cancelar una visita ya confirmada dos veces, por ejemplo) — el agente puede *proponer* pero no *ejecutar* sin tu OK.
5. El cliente pide explícitamente hablar con una persona.

Cuando se escala: el agente **no queda mudo** — le dice al cliente algo tipo "dejame confirmarlo con el asesor y te respondo en breve" (plantilla, dentro de la ventana de 24hs) y te manda a vos el mensaje + contexto + borrador de respuesta para que apruebes/edites con un solo tap.

---

## 6. Roadmap por fases

### Fase 0 — Descubrimiento y accesos (3–5 días)
- Confirmar plan de Tokko y nivel de acceso a su API (algunos planes limitan endpoints).
- Alta de app en Meta for Developers + WhatsApp Business Platform, verificación de número.
- Credenciales Google Calendar (proyecto en Google Cloud, OAuth o service account según si es tu calendario personal o uno dedicado al negocio).
- Definir qué calendario usar (¿tu Calendar personal o uno nuevo "Visitas Inmobiliaria"?). Recomendado: uno dedicado, para no mezclar y facilitar permisos de escritura del agente.

### Fase 1 — POC (2–3 semanas)
Objetivo: demostrar el loop completo con alcance reducido.
- 1 canal WhatsApp (sandbox de Meta, número de prueba).
- 5–8 intents del diccionario (los de mayor volumen: disponibilidad, precio, agendar visita, clima, escalamiento genérico).
- Lectura de Tokko (sin escritura todavía, o escritura mínima de logs).
- Calendar: lectura de disponibilidad + creación de eventos.
- Sin recontacto proactivo todavía (eso es fase 2).
- Sin dashboard — todo por WhatsApp y logs.

**Ver sección 8 para cómo armar esto en días, no semanas.**

### Fase 2 — MVP en producción (3–4 semanas)
- Número de WhatsApp de producción + plantillas aprobadas por Meta (recordatorios, recontacto).
- Recordatorios automáticos (visita en T-24h, T-2h).
- Recontacto por reglas (lead sin respuesta a los N días, visita sin feedback post-visita).
- Escritura completa en Tokko (notas de actividad, cambio de estado de lead).
- Persistencia robusta (Postgres) + panel mínimo de auditoría (aunque sea una tabla consultable, no hace falta UI todavía).
- Política de escalamiento afinada con datos reales del POC.

### Fase 3 — Optimización (continuo)
- RAG sobre catálogo de propiedades si el volumen de fichas es alto (para consultas más abiertas tipo "algo con balcón cerca de Plaza Francia hasta 300 mil").
- Afinar el router de intents con los casos reales que cayeron en "baja confianza".
- Métricas: % de mensajes resueltos sin intervención, tiempo de respuesta, tasa de conversión de recontacto.
- Opcional: transcripción de audios de WhatsApp (Whisper o similar) si tus clientes mandan mucho audio.

### Fase 4 — Escalado (si aplica)
- Multi-broker / multi-agencia (multi-tenant).
- Dashboard web propio en vez de solo WhatsApp.
- Integración con portales adicionales si hace falta más allá de lo que ya sindica Tokko.

---

## 7. Estructura de repositorio propuesta

```
real-estate-agent/
├── README.md
├── docker-compose.yml                 # postgres, redis, servicios locales para dev
├── .env.example
│
├── apps/
│   ├── orchestrator/                  # servicio principal: recibe webhooks, corre el agente
│   │   ├── src/
│   │   │   ├── channels/
│   │   │   │   └── whatsapp/          # webhook handler, envío de mensajes/plantillas
│   │   │   ├── agent/
│   │   │   │   ├── router.ts          # clasificador de intents (barato, primera pasada)
│   │   │   │   ├── llm_agent.ts       # loop de tool-use con Claude API
│   │   │   │   ├── intents/           # diccionario de intents (config + handlers)
│   │   │   │   │   ├── catalog.yaml   # tabla de la sección 5, versionada como config
│   │   │   │   │   └── handlers/
│   │   │   │   ├── state_machine.ts   # estado de conversación (agendando, esperando confirmación, etc.)
│   │   │   │   └── escalation.ts      # reglas de la sección 5.1
│   │   │   ├── jobs/
│   │   │   │   ├── reminders.ts       # recordatorios T-24h/T-2h
│   │   │   │   └── recontact.ts       # reglas de recontacto proactivo
│   │   │   ├── db/
│   │   │   │   ├── schema/            # migraciones (conversations, messages, leads_cache, appointments, audit_log)
│   │   │   │   └── repositories/
│   │   │   └── server.ts
│   │   └── package.json (o pyproject.toml si Python)
│   │
│   └── broker-console/ (opcional, fase 2+) # mini panel web de auditoría/config, no bloqueante para POC
│
├── mcp-servers/
│   ├── mcp-tokko/                     # wrapper de Tokko Broker API como MCP server
│   ├── mcp-gcal/                      # wrapper de Google Calendar (partir de uno de referencia)
│   └── mcp-weather/                   # wrapper de OpenWeatherMap/WeatherAPI
│
├── packages/
│   └── shared-types/                  # tipos/contratos compartidos entre orchestrator y mcp-servers
│
├── infra/
│   ├── terraform/ (o simplemente notas si el POC no lo justifica)
│   └── scripts/
│       └── seed_intent_catalog.ts
│
└── docs/
    ├── intent_catalog.md              # espejo human-readable de la sección 5
    ├── escalation_policy.md
    └── runbook.md                     # qué hacer si el agente responde mal, cómo reentrenar el router, etc.
```

Notas de diseño del repo:
- El **`intent catalog` como YAML versionado** (no hardcodeado en prompts) es clave: te permite ajustar reglas de negocio sin tocar código, y es lo primero que vas a iterar en las primeras semanas reales de uso.
- Los **MCP servers como paquetes separados** te dan testeo aislado (podés pegarle a `mcp-tokko` con un cliente MCP genérico y validar que devuelve lo esperado, sin correr todo el orquestador).
- La tabla `audit_log` desde el día 1 — vas a necesitar poder responder "¿por qué el bot le dijo esto a este cliente?" y eso solo es posible si guardás el intent detectado, la confianza, y qué tools se llamaron por cada respuesta.

---

## 8. Cómo armar la POC más rápido posible

Dos caminos, elegí según cuánto código querés escribir vos:

### Camino A — Low-code para validar el concepto en días (recomendado para arrancar)
Usar **n8n** (self-hosted o cloud) como orquestador visual del POC:
1. Nodo webhook de WhatsApp Cloud API (o nodo nativo de WhatsApp si tu versión de n8n lo trae).
2. Nodo HTTP a Tokko API.
3. Nodo Google Calendar (n8n tiene nodo nativo).
4. Nodo HTTP a Claude API (o nodo de Anthropic si está disponible) con tool-use manejado vía un sub-flow por cada intent, o directamente pasándole el catálogo de intents como parte del system prompt y dejando que el LLM decida qué nodo/rama disparar (usando el nodo "Switch" de n8n basado en la clasificación que devuelve el LLM).
5. Nodo de clima (HTTP simple a OpenWeatherMap).

Esto te da un demo funcional **en días**, no semanas, y te sirve para:
- Validar el diccionario de intents contra conversaciones reales.
- Mostrarte a vos mismo qué tan bien clasifica el LLM antes de invertir en código custom.
- Detectar qué endpoints de Tokko realmente necesitás.

Limitación: no es el diseño final (no tenés máquina de estados robusta ni auditoría fina), pero es la forma más rápida de **no equivocarte de arquitectura** antes de escribir el sistema serio.

### Camino B — Código custom desde el día 1 (si ya sabés que vas a producción rápido)
- Backend mínimo: FastAPI (Python) o Express/Fastify (Node) — lo que te resulte más cómodo, no hay una ventaja fuerte de uno sobre otro acá.
- Un solo endpoint de webhook de WhatsApp.
- Router de intents inicial: **no hace falta ML propio** — el primer router puede ser directamente el LLM con function calling, pasándole el catálogo de intents como "tools" disponibles más una tool genérica `escalate_to_broker`. Esto es más lento/caro por mensaje que un clasificador liviano, pero te ahorra semanas de desarrollo en el POC, y podés optimizar después separando un clasificador barato (ej. embeddings + similitud contra los ejemplos de cada intent) para los intents de alto volumen, dejando el LLM completo solo para lo ambiguo.
- SQLite en el POC (subís a Postgres en MVP) para no perder tiempo con infra.
- Deploy en Render/Railway con el webhook expuesto — ambos dan HTTPS automático, necesario para que Meta acepte el webhook.

### Mi recomendación concreta
**Camino A durante 1–2 semanas para validar intents y UX real con 2-3 clientes piloto, después migrar el "cerebro" (catálogo + reglas de escalamiento) 1:1 al Camino B para producción.** El catálogo YAML de la sección 7 es justamente lo que te permite portar ese conocimiento sin reescribirlo.

---

## 9. Riesgos y consideraciones

- **Ventana de 24hs de WhatsApp**: todo mensaje proactivo (recordatorio, recontacto) fuera de esa ventana necesita plantilla pre-aprobada por Meta — armá esas plantillas temprano, la aprobación puede tardar días.
- **Rate limits y calidad de número de WhatsApp**: empezá con volumen bajo y calidad del número alta; mandar mensajes proactivos mal targeteados baja la calidad y puede limitar tu cuenta.
- **Rate limits/alcance de la API de Tokko**: confirmá con Tokko qué expone tu plan antes de comprometerte a fechas — es la dependencia externa con menos control de tu lado.
- **Datos personales**: estás guardando conversaciones y datos de contacto de clientes — tené en cuenta la Ley 25.326 de protección de datos personales (Argentina) al definir retención y acceso al `audit_log`.
- **Sobreconfianza del agente**: el riesgo más caro no es que el bot no sepa responder — es que responda mal con confianza y comprometa algo (precio, condición, disponibilidad) frente a un cliente. Por eso el umbral de escalamiento conviene arrancarlo conservador (escalar de más) y aflojarlo con datos reales, no al revés.

---

## 10. Próximos pasos concretos
1. Confirmar acceso y documentación real de tu plan de Tokko API (esto define qué tan rico puede ser el intent de disponibilidad/precio desde el día 1).
2. Elegir Camino A o B para el POC (recomiendo A).
3. Armar la primera versión del `intent_catalog.yaml` con los 6-8 intents de mayor volumen real (no los que "deberían" ser más comunes — los que de hecho más te preguntan hoy).
4. Levantar número de WhatsApp sandbox + credenciales Google Calendar + credenciales Tokko.
5. Primer ciclo de prueba con 2-3 clientes reales (o con vos mismo simulando), midiendo % de resolución sin tu intervención.
