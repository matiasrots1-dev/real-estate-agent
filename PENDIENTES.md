# Pendientes

Tablero corto para abrir al empezar a trabajar. El detalle de cada bloque vive
en [docs/TASKS.md](docs/TASKS.md); esto solo ordena y apunta.

**Se actualiza en el mismo PR que cierra un bloque o registra una decisión.**
Si un tema queda a medias porque se pasa a otra cosa, se anota acá dónde quedó.

Última actualización: 2026-09-19

## Estado ahora

- **Los numeros, para no confundirlos otra vez**: la linea del bot, a la que
  le escriben los clientes, es la que termina en **...4543**. Los borradores
  y las ordenes al bot van por el celular personal, el **...6699**
  (`BROKER_WHATSAPP_NUMBER`). Ese valor **nunca** puede ser ...4543: seria el
  bot mandandose mensajes a si mismo, con riesgo de lazo.
- **Canal restablecido el 18/09.** Entran eventos y el envio funciona otra
  vez: el numero volvio a conectarse a la plataforma desde el panel de
  DoubleTick, `status: CONNECTED`, y el `phone_number_id` no cambio. Prueba de
  punta a punta OK: `consulta_disponibilidad` con 0.98 y **sin respuesta al
  cliente**. Ver `docs/TASKS.md` Bloque 36.
- **El bot corre en AWS desde el 15/9** (Lightsail, Ohio, `3.133.173.247`), y
  recibe trafico real desde el 18/09. `infra/aws/` ya esta en `main`: los
  deploys se hacen con `infra/aws/deploy.sh`, sin argumentos.
- Modo silencioso: **prendido y forzado por systemd**. No le responde a
  clientes; apagarlo exige un PR.
- **Desplegado el 19/09 a las 14:23** (`963a78f`): Bloques 31, 34, 37, 39,
  38a y 38g. Verificado despues del deploy: `/health` OK, los tres MCP
  corriendo, modo silencioso forzado, 63 contactos conocidos cargados. Prueba
  en vivo de 38g OK: el broker pidio "resumen de agenda" desde el ...6699 y
  le llego el resumen.
- **Desplegado el 19/09 a las 23:00** (`f979d72`): 38b, 38c, 38d, 38e y 38f
  — con eso **el Bloque 38 esta entero en produccion**. Verificado despues
  del deploy: `/health` OK, los tres MCP corriendo, modo silencioso forzado,
  70 contactos conocidos cargados. No hay prueba en vivo de 38e ni 38f: las
  dos dependen de que el bot le responda a un cliente, y con el modo
  silencioso prendido eso no pasa.
- **Desplegado el 19/09 a las 23:41** (`70de897`): Bloque 40. La retencion
  pasa a correr **una vez por dia a las 04:00** del servidor, y su reporte se
  conserva 90 dias en vez de una hora. Verificado en el arranque: "Retención:
  corre a las 04:00 (hora del servidor), y conserva 90 días de reportes".
- **`main` protegida desde el 19/09**: PR obligatorio, 0 aprobaciones, sin
  excepcion para administradores. Verificado por la API de GitHub.
- **Los borradores al ...6699 llegan** (confirmado el 19/09). Ojo: todo lo que
  el bot le manda al broker es texto libre, y Meta solo lo entrega si el
  ...6699 le escribio a la linea del bot (...4543) en las ultimas 24 hs. Si
  pasas un dia sin escribirle, Meta responde 200 y no entrega nada, sin
  error. Ver `docs/TASKS.md` Bloque 38.
- **No levantar el bot en la laptop**: serían dos bots con las mismas
  credenciales.
- **Después de migrar, los datos de verdad quedan en el servidor.**
  `npm run pendientes` en la laptop mostraría una lista vieja: hay que usar
  `infra/aws/npm-en-servidor.sh pendientes`.

## Esperan una decisión tuya

- [ ] **Activar el MFA del usuario raíz de AWS.** Verificado por CLI el 15/9:
      no está activo (`AccountMFAEnabled = 0`). El plan pago y la alarma de
      gasto sí quedaron bien.
- [ ] **Dominio del webhook**: arrancó con sslip.io, que es gratis pero si ese
      servicio se cae no llegan los mensajes. Pasar a un subdominio propio
      implica volver a avisarle a DoubleTick.
- [ ] **El repo de GitHub es público.** `.env` y `data/` nunca se commitearon,
      pero conviene revisar el historial por los incidentes de datos de los
      Bloques 10 y 12, y decidir si el repo debería ser privado.
- [ ] **Mensajes que no son texto** (audios, fotos): hoy se cuentan pero no
      quedan en el audit log ni te avisan. ¿Querés que queden registrados, y
      que te avise uno por uno?
- [ ] **Documentación desactualizada**: `CLAUDE.md` dice que Tokko corre contra
      el mock y que la retención no borra, y hoy las dos cosas son falsas.
      `docs/ONBOARDING.md` tiene unos 25 commits de atraso. ¿Se actualizan antes
      de pasárselo a un programador?

## PRs esperando revisión

Ninguno. Desde el 19/09 los PRs los revisa y mergea Claude, salvo tres cosas
que siguen necesitando tu OK: apagar el modo silencioso, cualquier cambio que
haga que el bot le escriba a clientes, y borrar datos.

## Bloquea apagar el modo silencioso

- [ ] **Bloque 38**: escalamientos y avisos al broker. Lo que dejaron abierto
      las revisiones del 31 y del 34. Hecho y desplegado: 38a (si falla el
      borrador, el aviso te llega igual), 38g (tus ordenes al bot reciben
      respuesta en modo silencioso; probado en vivo) y 38b (una llamada
      colgada a Anthropic falla en unos 51 s en vez de media hora). Tambien
      desplegado: 38c (ningun escalamiento le manda al cliente una plantilla
      con `{huecos}` sin llenar) y 38d (si falla mandarle la respuesta a un
      cliente, queda registrado, te llega el aviso y `pendientes` lo muestra).
      Tambien desplegado el 19/09 a las 23:00: 38e (la misma frase de espera
      no se repite, venga del camino que venga) y 38f (que hayas contestado
      vos no se pierde). **El bloque esta completo y en produccion.** Lo que
      **afecta hoy**: la ventana de 24 hs (arriba).
- [ ] **Tu calendario personal no cuenta para ofrecer horarios.** El bot mira
      un solo calendario, el dedicado a visitas. Para ofrecerle horarios a un
      cliente consulta "ocupado/libre" solo ahi, asi que con el modo silencioso
      apagado podria ofrecer una visita a la misma hora que un compromiso tuyo.
      Google permite sumar tu calendario personal a esa consulta viendo solo
      ocupado/libre, sin el detalle, si lo compartis con la cuenta del bot.
      Detectado el 19/09.
- [ ] **Bloque 27**: recontacto. **El código está hecho (20/09) y falta tu
      decisión para habilitarlo.** Lo que se encontró: el job ya estaba en el
      scheduler, pero no usaba ninguna de las tres salvaguardas —las usaba
      sólo el simulacro que vos mirás para aprobar. O sea, aprobabas 29
      personas y el job le habría escrito a ~3600. Ahora el job corre
      exactamente el mismo cálculo que `npm run recontacto:simulacro`:
      criterio, topes, ventana horaria, 60 días entre mensajes y deduplicado
      de fichas repetidas.
      **Para habilitarlo**: revisar varias corridas del simulacro y recién ahí
      poner `RECONTACTO_ENVIO_HABILITADO=true`. Aunque lo pongas, hoy sigue en
      simulacro porque falta cablear una de las tres fuentes de números
      internos (los teléfonos de los usuarios de Tokko) y el job falla cerrado
      si no sabe a quién NO escribirle. Y con el modo silencioso prendido ni
      se registra.
      *Medido el 20/09*: el servidor corre en hora local -03, así que la
      ventana de 9 a 20 son horas de Argentina. El riesgo del huso sigue vivo
      sólo si alguien cambia la zona horaria del servidor.
- [ ] **Bloque 28**: catálogo. Está en 52% de precisión y 81% de recall. La
      señal "el broker le escribió" no se pudo validar sobre el histórico. El
      umbral queda quieto por decisión.

## Bloquea publicar la política de privacidad

- [ ] **Bloque 30**: palabra clave de BAJA y lista de no contactar.
- [ ] Completar los `[CORCHETES]` de
      [docs/politica-privacidad.md](docs/politica-privacidad.md).
- [ ] Sumar AWS a la tabla "Con quién se comparten", con la base de la
      transferencia internacional: para la Ley 25.326, EE.UU. no es un destino
      "adecuado". Conviene que lo revise alguien que conozca la ley.

## Después

- [x] *(Hecho el 19/09, Bloque 40.)* **La retencion corria cada 5 minutos y
      su reporte duraba una hora.** Ahora corre una vez por dia a las 4 de la
      manana (`RETENTION_HORA`), el reporte se conserva 90 dias
      (`RETENTION_DIAS_DE_REPORTES`) y el scheduler no arranca una vuelta si
      la anterior sigue corriendo. **Desplegado el 19/09 a las 23:41**
      (`70de897`).
- [ ] **Tercer numero dedicado como canal broker** (mejora, no bloquea nada).
      Hoy los borradores y las ordenes al bot van por el celular personal
      ...6699, asi que trabajo y vida privada comparten linea. Un numero
      aparte, aunque sea un chip barato, dejaria el canal de ordenes en una
      linea usada solo para eso. Alternativa sin numero nuevo: cambiar el
      canal de aviso en lugar del numero, por ejemplo un panel en el servidor
      o un mail.
- [ ] **Bloque 29**: el 44% de los que escriben no está en Tokko.
- [ ] **Bloque 17**: `leadId` inconsistente. Se decidió dejarlo para después
      de salir.
- [ ] **Bloque 33**: Postgres, solo si el volumen lo justifica.
- [ ] Pedirle a DoubleTick la exportación del historial de chats, para el
      corpus de estilo.
- [ ] **Riesgos abiertos del Bloque 35**: una guarda en el código contra dos
      schedulers (laptop y servidor), drenar la cola al apagar, y una copia de
      los datos fuera de AWS.
- [ ] **Riesgos abiertos de los Bloques 37 y 39**: el corpus de estilo tiene el
      mismo problema de línea rota que tenían el audit log y el reporte de
      retención (y `estilo:reanonimizar` lo borraría entero); ya está el
      módulo `jsonl.ts` para arreglarlo. Los stores JSON enteros se escriben
      sin temporal y rename.

## Riesgos asumidos (no son trabajo pendiente)

Las casillas abiertas de los Bloques 18, 19, 21, 22, 24 y 25 de `docs/TASKS.md`
son riesgos anotados y aceptados, como la cola en memoria o la falta de drain
al apagar. No son trabajo sin terminar.
