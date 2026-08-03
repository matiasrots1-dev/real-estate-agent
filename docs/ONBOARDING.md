# Onboarding — para alguien que nunca vio este proyecto

Este documento asume que no sabés nada de este repo todavía. Es un
recorrido, no una referencia — para el detalle técnico exacto de cada
pieza, este documento te va a mandar a `CLAUDE.md` (brief del proyecto,
convenciones de trabajo) y `docs/TASKS.md` (qué se construyó, bloque por
bloque, con las decisiones y los tests que lo prueban). No dupliques
información entre este archivo y esos dos — si algo cambia, se actualiza
allá, y este documento en todo caso se ajusta para seguir apuntando bien.

## 1. Qué problema de negocio resuelve, y para quién

El dueño de este proyecto es un **broker inmobiliario individual** — no
una inmobiliaria grande con equipo de atención al cliente, una sola
persona que además de vender tiene que contestar WhatsApp todo el día.

La mayoría de esos mensajes son repetitivos: "¿sigue disponible el
depto?", "¿cuánto sale?", "mandame fotos", "quiero ir a verlo", "¿va a
llover el día de la visita?". Contestar eso a mano es tiempo que no se
dedica a lo que realmente mueve una venta. Además hay tareas que se
olvidan si no hay un sistema atrás: recordarle a alguien la visita
agendada, volver a contactar a un lead que se quedó frío, hacer el
seguimiento después de una visita.

Este proyecto es un agente de IA que se hace cargo de eso — responde por
WhatsApp, agenda contra Google Calendar, manda recordatorios y reintentos
de contacto solo, y **nunca improvisa cuando la cosa se pone seria**:
negociación de precio, un reclamo, algo con implicancia legal, o
simplemente cuando no está seguro de qué le están preguntando. En esos
casos no inventa una respuesta — le escribe al broker con un borrador
sugerido y espera su OK antes de mandar nada.

El broker también tiene su propio canal con el agente (reconocido por su
número de WhatsApp): puede pedirle un resumen de la agenda o de los
leads, pausarlo para un cliente puntual o en general, y darle órdenes
compuestas en lenguaje libre ("mandale la ficha del depto de Palermo a
Juan y ofrecele el sábado a las 11").

## 2. Cómo funciona de punta a punta — un mensaje, paso a paso

Seguí el recorrido de un mensaje real de un cliente:

1. **El cliente escribe por WhatsApp.** Meta (dueño de la infraestructura
   de WhatsApp Business) le pega un webhook HTTP al servidor de este
   proyecto (el "orchestrator"), en `POST /webhook`. Antes de hacer nada,
   se valida que el pedido realmente venga de Meta (firma HMAC con un
   secreto compartido) — si no valida, se rechaza.
2. **Se detecta el canal.** Si el número que escribió es el número
   configurado como el del broker, el mensaje entra por el "canal
   broker" — el resto de esta explicación asume que es un cliente
   normal, pero el mismo webhook atiende los dos canales.
3. **¿Está pausado?** Si el broker pausó el agente para ese cliente
   puntual, o pausó todo en general, acá se corta: se audita que llegó
   el mensaje, pero no se clasifica nada (para no gastar una llamada a
   Claude al pedo) ni se responde nada.
4. **¿Hay una conversación en curso?** Si el cliente ya estaba a mitad de
   agendar una visita (por ejemplo, el agente le propuso 3 horarios y
   está esperando cuál elige), el mensaje se rutea directo a esa
   continuación — no se vuelve a clasificar el intent desde cero.
5. **Si es un mensaje nuevo, se clasifica.** El texto del cliente se le
   manda a Claude junto con el catálogo de intents posibles (filtrado
   según el canal — un cliente nunca puede matchear un intent que es
   solo del broker, y viceversa). Claude devuelve qué intent matcheó y
   con qué confianza.
6. **Se decide si escala.** Si el intent es de los que siempre requieren
   al broker (negociación, reclamo, algo legal, el cliente pide hablar
   con una persona), o si la confianza de la clasificación fue baja, el
   agente no improvisa: le responde al cliente con una plantilla de
   espera, y le manda al broker un mensaje con el contexto completo y un
   borrador de respuesta (redactado por Claude) para que apruebe o edite.
7. **Si no escala, se ejecuta el handler del intent.** Cada intent tiene
   su propia lógica en código, que llama a las integraciones que
   necesite — buscar una propiedad o un lead en Tokko (el CRM), consultar
   disponibilidad o crear un evento en Google Calendar, pedir el
   pronóstico del clima. La respuesta final se arma de dos formas
   posibles: con una plantilla fija (rellenada con datos reales), o
   redactada por Claude pero **siempre "grounded"** — nunca se inventa un
   precio, una disponibilidad o un dato que el tool correspondiente no
   devolvió.
8. **Se manda la respuesta** por WhatsApp, y **queda todo registrado en
   el audit log**: qué intent matcheó, con qué confianza, qué tools se
   llamaron, si escaló y por qué.

Aparte de este loop reactivo, hay un **scheduler** corriendo en paralelo
(no cron real, un polling simple) que revisa periódicamente si hay que
mandar un recordatorio de visita, reintentar contacto con un lead que se
quedó frío, o hacer un seguimiento después de una visita ya realizada.

## 3. Por qué las decisiones grandes son como son

**Por qué cada integración externa es un servidor MCP aparte** (no
llamadas HTTP sueltas dentro del código del agente): Tokko, Google
Calendar y el clima son tres servidores [MCP](https://modelcontextprotocol.io)
independientes que el orchestrator levanta como procesos hijos y con los
que habla por el protocolo real (no una simulación). Esto separa "qué
puede hacer cada integración" de "cómo la usa el agente", y permite
testear cada una de forma completamente aislada, sin necesitar que el
resto del sistema esté corriendo.

**Por qué JSON local y no Postgres todavía**: el proyecto es el POC de un
broker individual — bajo volumen, un solo usuario real del lado del
broker. Postgres ya está provisionado (`docker-compose.yml`) y las
interfaces de cada store (`AuditLogStore`, `AppointmentStore`,
`ConversationStateStore`, etc.) ya están escritas pensando en ese
reemplazo — migrar es cambiar la implementación detrás de una interfaz
que ya existe, no reescribir nada. Se decidió posponerlo a propósito
hasta que el volumen real lo justifique, en vez de construirlo de
entrada sin necesidad concreta todavía.

**Por qué el gate de confirmación en las órdenes del broker**: cuando el
broker le da al agente una orden en lenguaje libre que afecta a varios
contactos a la vez (ej. "avisale a todos los leads fríos que bajamos el
precio"), es lo más parecido a una acción irreversible de alto impacto
que tiene el sistema. Por eso nunca se ejecuta directo: el agente arma un
plan, se lo muestra al broker como preview con el conteo exacto de
contactos, y **recién ejecuta si el broker confirma explícitamente**.
Está construido a propósito en dos fases separadas — planificar (Claude
solo puede usar tools de lectura) y ejecutar (código propio, sin
Claude) — así el plan se puede interceptar antes de tocar Calendar o
WhatsApp de verdad, sin depender de que el modelo "se porte bien" y
respete una instrucción de esperar en medio de un loop donde ya tiene las
tools de escritura en la mano. Si la orden afecta a un solo contacto,
ejecuta directo — ahí el que ya confirmó es el broker, con su propia
orden.

## 4. Qué está funcionando hoy y qué no

**Funcionando y probado** (incluye testing en vivo con credenciales
reales, no solo tests automatizados): todo el loop reactivo de arriba,
escalamiento, agendar/reprogramar/cancelar visitas, recordatorios y
recontacto proactivo por scheduler, y el canal completo del broker
(resúmenes, pausar, y las órdenes compuestas con su gate de
confirmación). El detalle bloque por bloque está en `docs/TASKS.md`.

**No funcionando todavía — bloqueante para uso real**: el camino
ENTRANTE de WhatsApp. Un mensaje real de un cliente hoy **no le llega**
al servidor, aunque el webhook, la firma, el túnel y la app de Meta ya
están armados y verificados. La causa más probable (investigada, sin
confirmación 100% oficial de Meta) es que el número de prueba gratuito
que se está usando solo puede mandar mensajes, no recibirlos. Publicar la
app en Meta no lo resolvió. Ver Bloque 11 y 12 de `docs/TASKS.md` para
el detalle completo y las alternativas evaluadas.

**Corriendo en mock, no contra el servicio real**: Tokko (el CRM) —
todavía no hay credenciales reales cargadas, así que ninguna propiedad,
precio o lead que el agente menciona es un dato real todavía. WhatsApp,
Google Calendar y el clima sí corren contra las APIs reales.

## 5. Cómo levantarlo en tu máquina

1. Node.js instalado, cloná el repo.
2. `npm install` desde la raíz (es un monorepo con npm workspaces — instala
   todo de una).
3. `cp .env.example .env` y completá lo que tengas: como mínimo hace
   falta `ANTHROPIC_API_KEY` para que el servidor arranque. Sin
   credenciales de Tokko, Google Calendar o el clima, esas integraciones
   corren contra implementaciones mock — el proyecto está pensado para
   avanzar así, no hace falta tener todo para empezar.
4. `npm run build` desde la raíz — confirma que compila todo el monorepo.
5. `npm run test` desde la raíz — corre toda la suite (Vitest). No
   necesita ninguna credencial real: lo que toca Claude/Tokko/Calendar/
   clima está stubeado o corre contra mocks.
6. `npm run dev:orchestrator` levanta el servidor real, escuchando en el
   puerto de `PORT` (`.env`, default 3000).
7. Si además querés probarlo contra WhatsApp real: hace falta exponer ese
   puerto públicamente (el Bloque 11 de `docs/TASKS.md` documenta cómo se
   hizo con el port forwarding nativo de VS Code, sin instalar nada) y
   cargar la Callback URL + verify token en Meta for Developers.

Para el flujo de git (rama por bloque, PR, nunca commit directo a
`main`), ver `CONTRIBUTING.md`.

## 6. Pendientes conocidos y el riesgo de cada uno

- **Camino entrante de WhatsApp no resuelto** — sin esto el agente no
  puede recibir mensajes reales de clientes en producción. Riesgo: **alto**,
  es bloqueante para cualquier uso real hoy.
- **Tokko sigue en mock** — nada de lo que el agente dice sobre
  propiedades es un dato real todavía. Riesgo: **alto** para un
  despliegue real, pero depende de conseguir el acceso (no es un
  problema de código).
- **Identidad de números de teléfono no normalizada** — el sistema no
  sabe que dos formatos del mismo número (ej. con o sin el "9" de
  Argentina) son la misma persona. Riesgo: **medio**, puede hacer que el
  gate de confirmación bulk cuente mal, o que pausar un cliente puntual
  no encuentre la conversación correcta — depende de cuán consistentes
  sean los datos reales de Tokko.
- **Sin tracking de entrega de WhatsApp** (delivered/read/failed) — el
  sistema solo sabe si Meta *aceptó* mandar un mensaje, no si realmente
  llegó. Riesgo: **medio-alto** para confiabilidad — el agente puede
  creer que avisó algo a un cliente que nunca lo vio, sin ninguna señal
  de que algo falló.
- **Retención de datos indefinida** — ningún store tiene borrado
  automático; todo se acumula para siempre en archivos locales. Riesgo:
  **bajo hoy, crece con el volumen** — ya es relevante para la política
  de privacidad de la app.
- **Persistencia en JSON, no Postgres** — no soporta concurrencia real
  entre procesos. Riesgo: **bajo** mientras el volumen sea el de un
  broker individual; es el techo conocido, no una sorpresa.
- **Cobertura de tests no llega al comportamiento real de la API de
  Claude** (truncamiento por `max_tokens`, respuestas mal formadas,
  etc.) — ya causó un bug real que ningún test automatizado agarró,
  encontrado recién en testing manual con credenciales reales. Riesgo:
  **medio** — es plausible que haya bugs parecidos sin descubrir en otros
  puntos donde se llama a Claude.

Para el detalle de cualquiera de estos puntos, `docs/TASKS.md` tiene la
investigación completa bloque por bloque.
