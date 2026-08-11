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

**Funcionando pero deliberadamente apagado**: el purgado por retención de
datos corre con el resto de los jobs, calcula qué habría que borrar según
la política publicada, y lo deja por escrito en un reporte — **sin borrar
nada**. Encenderlo es un paso manual y consciente (ver el pendiente en la
sección 6).

**No funcionando todavía — bloqueante para uso real**: el camino
ENTRANTE de WhatsApp. Un mensaje real de un cliente hoy **no le llega**
al servidor — pero el webhook de prueba que dispara el propio panel de
Meta ("Probar", en Configuration → Webhook) **sí llega y se procesa
completo** (clasifica, escala, notifica al broker). Esa es justamente la
evidencia de que el problema es específico de los mensajes reales de
producción, no del webhook, la firma o el túnel en sí — todo eso ya está
armado y verificado. La causa más probable (investigada, sin
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

**Dos cosas que se activan solas y conviene que sepas de entrada:**

- **Un escaneo de datos sensibles corre antes de cada `git commit` y lo
  bloquea** si detecta tokens con forma de credencial, URLs de túnel, o
  números de teléfono con forma real fuera de archivos de test/mock. Se
  instala solo en tu primer `npm install` (apunta git a los hooks
  versionados en `.githooks/`), así que no tenés que configurar nada.
  Existe porque ya pasó tres veces: números de teléfono reales entrando
  al repo durante sesiones de testing en vivo. Si te bloquea un falso
  positivo, la salida te sugiere el arreglo; `git commit --no-verify` es
  el escape, con criterio y explicándolo en el PR. Detalle en
  `CONTRIBUTING.md`.
- **Antes de codear un bloque se hace un pre-mortem**: imaginar que ya
  está mergeado y falló, y plantear 3 modos de fallo concretos, cada uno
  mitigado o anotado como riesgo asumido. No pide ningún artefacto nuevo
  — va en el hilo de trabajo. Aplica a cambios de código o comportamiento;
  para documentación o texto se saltea, dejando una línea en el commit que
  lo diga. La convención completa (incluido un catálogo de los modos de
  fallo que este proyecto ya sufrió, para no arrancar de cero) está en
  `CLAUDE.md` secc. 7 y `CONTRIBUTING.md`.

**Tres trampas operativas que ya costaron horas de diagnóstico — evitalas
de entrada:**
- **El token de acceso de WhatsApp (`WHATSAPP_ACCESS_TOKEN`) vence cada
  24hs** si es uno de los temporales que da la pantalla rápida de "API
  Setup" de Meta. Si un envío que antes funcionaba empieza a devolver 401
  `Authentication Error`, es casi siempre esto — no un bug. Para no
  repetir el ciclo, considerá un token de System User (no vence en
  minutos/horas).
- **El `.env` se lee una sola vez, al arrancar el proceso.** Si cambiás
  una variable (ej. renovaste el token de arriba) y el servidor ya está
  corriendo, no la va a ver hasta que lo reinicies — no alcanza con
  guardar el archivo.
- **La URL del túnel cambia cada vez que se levanta de nuevo** (port
  forwarding de VS Code o cualquier otro). Si reiniciaste el túnel,
  tenés que volver a pegar la URL nueva como Callback URL en Meta for
  Developers — la vieja va a dejar de funcionar silenciosamente.

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
- **`leadId` significa dos cosas distintas según quién agendó la visita**
  (encontrado en el Bloque 16, documentado como Bloque 17, sin arreglar).
  En el flujo del cliente es su **teléfono**; en el del broker es el **id
  de Tokko**. Consecuencia concreta: si el broker agenda una visita con
  una orden directa y después el cliente escribe "quiero reprogramar", el
  agente no la encuentra y le responde *"no te veo ninguna visita
  agendada"*. Riesgo: **medio-alto** — rompe un flujo real de cara al
  cliente, y además ensucia el barrido de retención, que cruza los stores
  por `leadId`.
- **Sin tracking de entrega de WhatsApp** (delivered/read/failed) — el
  sistema solo sabe si Meta *aceptó* mandar un mensaje, no si realmente
  llegó. Riesgo: **medio-alto** para confiabilidad — el agente puede
  creer que avisó algo a un cliente que nunca lo vio, sin ninguna señal
  de que algo falló.
- **Retención de datos: el código está listo pero el borrado está
  APAGADO.** El purgado por retención existe desde el Bloque 15 y cumple
  la política publicada (12 meses mensajes/logs, 24 meses desde la última
  interacción para gestión comercial), pero arranca en **modo simulacro**:
  reporta qué borraría en `data/retention_reports.jsonl` y no borra nada
  hasta que alguien ponga `RETENTION_BORRADO_HABILITADO=true`. Riesgo:
  **alto mientras siga apagado** — la política publicada sigue
  incumpliéndose. El default es a propósito (el borrado es irreversible y
  no hay backup de los JSON), pero es un paso pendiente, no un estado
  final: hay que revisar unas cuantas corridas del reporte y encenderlo.
- **Sobre-exposición de datos al planificador: resuelta en lo
  innecesario, no en lo inevitable** (Bloque 16). Antes se le mandaba a
  la API de Claude el `Lead` entero de cada coincidencia; hoy solo salen
  `{id, temperatura, diasSinRespuesta, propiedadesDeInteres}` — nunca
  nombre, teléfono ni email. Lo que **sigue** yendo: los nombres que el
  broker escribe en su propia orden, y el texto del mensaje que Claude
  redacta. Riesgo: **bajo**, pero no es cero, y conviene tenerlo presente
  al declarar tratamiento de datos.
- **Persistencia en JSON, no Postgres** — no soporta concurrencia real
  entre procesos. Riesgo: **bajo** mientras el volumen sea el de un
  broker individual; es el techo conocido, no una sorpresa.
- **Cobertura de tests no llega al comportamiento real de la API de
  Claude** (truncamiento por `max_tokens`, respuestas mal formadas,
  etc.) — ya causó un bug real que ningún test automatizado agarró,
  encontrado recién en testing manual con credenciales reales. Hay una
  mitigación parcial: varios tests usan un cliente Anthropic falso que
  simula respuestas truncadas, así que el **código reacciona bien** a
  una. Lo que sigue sin cubrirse es si el prompt y el schema de cada
  classifier se truncan **en la práctica** — eso solo se ve contra la API
  real, y no hay una rutina periódica que lo chequee. Riesgo: **medio**.

Para el detalle de cualquiera de estos puntos, `docs/TASKS.md` tiene la
investigación completa bloque por bloque.
