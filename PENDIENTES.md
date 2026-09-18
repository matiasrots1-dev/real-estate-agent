# Pendientes

Tablero corto para abrir al empezar a trabajar. El detalle de cada bloque vive
en [docs/TASKS.md](docs/TASKS.md); esto solo ordena y apunta.

**Se actualiza en el mismo PR que cierra un bloque o registra una decisión.**
Si un tema queda a medias porque se pasa a otra cosa, se anota acá dónde quedó.

Última actualización: 2026-09-18

## Estado ahora

- **BLOQUEANTE (15/9): el numero no recibe eventos de Meta desde el 8/09 a las
  17:30**, y el token con el que el bot enviaria (un usuario de sistema de la
  app del proveedor) perdio todo acceso al numero. El servidor nuevo esta sano
  y probado, pero no hay eventos para reenviar. Ver `docs/TASKS.md` Bloque 36.
  **Causa confirmada** (15/9, captura del iPhone): el numero esta
  **desconectado de la plataforma**. En *Ajustes > Cuenta > Plataforma para
  empresas* ofrece *Conectate*, no *Desconectar cuenta*. Hay que rehacer el
  alta con el QR de onboarding de DoubleTick, y el QR se escanea desde el
  iPhone: no se puede hacer por CLI ni desde el servidor.
  **18/09**: el dueno del repo reconecto desde el panel de DoubleTick, y el
  servidor **sigue sin recibir eventos**: contador en 0 desde el reinicio
  automatico del 17/09 06:00, y 0 entradas de audit log el 17 y el 18. El
  token sigue sin activos y sin acceso al numero. Nuestro lado esta sano: la
  URL publica devuelve 403 a un GET y 401 a un POST sin secreto. Falta
  confirmar en el iPhone si ahora ofrece *Desconectar cuenta*, y pedirle a
  DoubleTick los identificadores nuevos (`phone_number_id`, `waba_id`, token)
  y que el reenvio apunte a nuestra URL para la suscripcion nueva.
- **El bot corre en AWS desde el 15/9** (Lightsail, Ohio, `3.133.173.247`).
  DoubleTick **ya cambio la URL** (15/9 20:09) y su evento de prueba llego:
  200 en 762 ms, cruzado con los logs. No llega nada mas porque el numero
  esta desconectado de la plataforma, no por el servidor.
- Modo silencioso: **prendido y forzado por systemd**. No le responde a
  clientes; apagarlo exige un PR.
- En curso: **Bloque 36**, reconectar el numero. El Bloque 35 (servidor) esta
  terminado y probado contra `https://3-133-173-247.sslip.io/webhook`; su PR
  se abre cuando lleguen mensajes reales. Hasta mergearlo, `main` no tiene
  `infra/aws/` y `deploy.sh` sin argumentos no funciona.
- Al reconectar hay que verificar si cambian `phone_number_id`, `waba_id` y
  el token: de eso dependen el envio, la deteccion del canal del broker y la
  exclusion de numeros internos en el recontacto.
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
- [ ] **Bloque 34, avisos durante una caída de la API**: ¿agrupados cada N
      minutos, o uno por mensaje?
- [ ] **Documentación desactualizada**: `CLAUDE.md` dice que Tokko corre contra
      el mock y que la retención no borra, y hoy las dos cosas son falsas.
      `docs/ONBOARDING.md` tiene unos 25 commits de atraso. ¿Se actualizan antes
      de pasárselo a un programador?

## PRs esperando revisión

- [ ] `bloque-31-plantilla-una-vez`: la plantilla fija sale una sola vez por
      conversación.

## Bloquea apagar el modo silencioso

- [ ] **Bloque 34**: el audit log se escribe antes de clasificar, para que una
      caída de la API no vuelva a perder mensajes. El pre-mortem está commiteado
      en la rama `bloque-34-audit-antes-de-clasificar`, sin código. **En pausa**
      mientras se sube el bot.
- [ ] **Bloque 31**: mergear (ver arriba).
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

- [ ] **Bloque 29**: el 44% de los que escriben no está en Tokko.
- [ ] **Bloque 17**: `leadId` inconsistente. Se decidió dejarlo para después
      de salir.
- [ ] **Bloque 33**: Postgres, solo si el volumen lo justifica.
- [ ] Pedirle a DoubleTick la exportación del historial de chats, para el
      corpus de estilo.
- [ ] **Riesgos abiertos del Bloque 35**: una guarda en el código contra dos
      schedulers (laptop y servidor), drenar la cola al apagar, y una copia de
      los datos fuera de AWS.

## Riesgos asumidos (no son trabajo pendiente)

Las casillas abiertas de los Bloques 18, 19, 21, 22, 24 y 25 de `docs/TASKS.md`
son riesgos anotados y aceptados, como la cola en memoria o la falta de drain
al apagar. No son trabajo sin terminar.
