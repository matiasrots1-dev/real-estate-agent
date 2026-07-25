# Política de escalamiento

Este documento formaliza la sección 5.1 del SOW. El código de
`apps/orchestrator/src/agent/escalation.ts` debe implementar exactamente
esta lógica — si hay que cambiarla, se edita acá primero y después en el
código, no al revés.

## Regla general

Un mensaje se escala al broker (no se responde solo) si se cumple
**cualquiera** de las siguientes condiciones:

1. El intent matcheado en `docs/intent_catalog.yaml` tiene
   `requires_broker: true`.
2. `requires_broker: "conditional"` y se cumple la condición específica
   descripta en `escalation_reason` de ese intent (por ejemplo: segunda
   reprogramación de la misma visita, o pedido de horario fuera de rango
   habitual).
3. La confianza del match de intent es menor a `confidence_threshold` del
   intent (o al `default_confidence_threshold` global si el intent no
   define uno propio).
4. El mensaje contiene señales de negociación de precio/condiciones fuera
   de lo publicado en Tokko.
5. El mensaje contiene señales de disconformidad, enojo o reclamo.
6. El mensaje toca términos legales o contractuales (rescisión, cláusulas,
   plazos legales).
7. La acción a ejecutar es irreversible y de alto impacto (cancelar una
   visita ya reprogramada dos veces, por ejemplo).
8. El cliente pide explícitamente hablar con una persona.

## Qué pasa cuando se escala

El agente **nunca queda mudo** frente al cliente. La secuencia es:

1. Responde al cliente con la plantilla de espera correspondiente al
   intent (campo `response.template` en el catálogo), dentro de la
   ventana de 24hs de WhatsApp.
2. Genera una notificación al broker con:
   - Transcripción completa del mensaje del cliente.
   - Intent matcheado (o `fallback_low_confidence` si no matcheó nada).
   - Confianza del match.
   - Contexto de la conversación (últimos N mensajes, estado de la
     máquina de conversación).
   - Un borrador de respuesta sugerido (generado por el LLM, marcado
     claramente como borrador, nunca enviado sin aprobación).
3. Espera la respuesta del broker (aprobación tal cual, edición, o
   respuesta manual directa) antes de continuar la conversación con el
   cliente en ese hilo.

## Umbral de confianza

`meta.default_confidence_threshold` en `intent_catalog.yaml` arranca en
`0.75`. Este valor es deliberadamente conservador (mejor escalar de más al
principio). Se ajusta con datos reales del uso en producción, nunca a
priori — no lo bajes en el código sin que el usuario lo pida
explícitamente con datos que lo justifiquen.

Excepción: `reclamo_queja` y `hablar_con_persona` usan un umbral más bajo
(`0.6`) a propósito — el costo de una falsa alarma ahí es mínimo, el costo
de no escalar es alto.

## Auditoría

Cada decisión de escalamiento (y cada decisión de **no** escalar) debe
quedar registrada en `audit_log` con: intent, confianza, regla que
disparó (o no) el escalamiento, y timestamp. Esto es lo que permite,
más adelante, ajustar el catálogo de intents con datos reales en vez de
intuición.
