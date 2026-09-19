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
- **Bloques 31, 34 y 37 mergeados y desplegados el 19/09** (03:21, `aa2ad15`).
  Verificado despues del deploy: `/health` OK, los tres MCP corriendo, modo
  silencioso forzado, 57 contactos conocidos cargados, ninguna linea rota.
- **A verificar: ¿te llegan los borradores al ...6699?** Todo lo que el bot le
  manda al broker es texto libre, y Meta solo lo entrega si el ...6699 le
  escribio a la linea del bot (...4543) en las ultimas 24 hs. Si no, responde
  200 y no entrega nada, sin error. Vale para los borradores y para el aviso
  de fallos del Bloque 34. Ver `docs/TASKS.md` Bloque 38.
- **No levantar el bot en la laptop**: serían dos bots con las mismas
  credenciales.
- **Después de migrar, los datos de verdad quedan en el servidor.**
  `npm run pendientes` en la laptop mostraría una lista vieja: hay que usar
  `infra/aws/npm-en-servidor.sh pendientes`.

## Esperan una decisión tuya

- [ ] **Proteger `main` en GitHub.** Verificado el 19/09: no tiene ninguna
      regla, así que un push directo entra sin PR. Ahora que Claude mergea
      solo, conviene una regla mínima: Settings → Branches → Add rule →
      `main` → "Require a pull request before merging", con **0
      aprobaciones** (si pide aprobaciones, Claude no puede mergear sus
      propios PRs), y tildar "Do not allow bypassing the above settings":
      Claude trabaja con tu cuenta, que es administradora, y sin ese tilde la
      regla no le aplica. Es un cambio de un minuto, desde tu cuenta.
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
      las revisiones del 31 y del 34. Tres cosas **afectan hoy**, con el modo
      silencioso prendido: la ventana de 24 hs (arriba), que nadie se entera
      si falla el aviso al broker, y que una llamada colgada a Anthropic no
      cuenta como fallo. El resto muerde al apagarlo; lo mas grave es que una
      escalada por baja confianza le manda al cliente la plantilla con los
      `{huecos}` sin llenar (pasa desde el Bloque 5).
- [ ] **Bloque 27**: recontacto. Falta cablearlo al scheduler. Ojo:
      `recontactoPolicy.ts` y `topeDiarioStore.ts` usan la hora local del
      proceso. En un servidor en UTC, la ventana de 9 a 20 queda corrida 3 horas
      y el tope diario se reinicia a las 21:00.
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
- [ ] **Riesgos abiertos del Bloque 37**: el reporte de retención tiene el
      mismo problema de línea rota que tenía el audit log, y con el borrado
      prendido es el más serio: la corrida tiraría **después** de purgar, y
      quedarían datos borrados sin reporte. El corpus de estilo, igual (y
      `estilo:reanonimizar` lo borraría entero). Los stores JSON enteros se
      escriben sin temporal y rename.

## Riesgos asumidos (no son trabajo pendiente)

Las casillas abiertas de los Bloques 18, 19, 21, 22, 24 y 25 de `docs/TASKS.md`
son riesgos anotados y aceptados, como la cola en memoria o la falta de drain
al apagar. No son trabajo sin terminar.
