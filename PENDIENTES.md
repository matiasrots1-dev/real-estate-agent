# Pendientes

Tablero corto para abrir al empezar a trabajar. El detalle de cada bloque vive
en [docs/TASKS.md](docs/TASKS.md); esto solo ordena y apunta.

**Se actualiza en el mismo PR que cierra un bloque o registra una decisión.**
Si un tema queda a medias porque se pasa a otra cosa, se anota acá dónde quedó.

Última actualización: 2026-09-15

## Estado ahora

- **El bot corre en AWS desde el 15/9** (Lightsail, Ohio, `3.133.173.247`),
  pero **todavía no recibe mensajes**: DoubleTick sigue apuntando a la URL
  vieja. Hasta que la cambien, no queda registro de quién escribe.
- Modo silencioso: **prendido y forzado por systemd**. No le responde a
  clientes; apagarlo exige un PR.
- En curso: **Bloque 35**. Falta que DoubleTick cambie la URL a
  `https://3-133-173-247.sslip.io/webhook` y confirmar que llegan mensajes.
  Después, abrir el PR de `bloque-35-deploy-aws`: hasta mergearlo, `main` no
  tiene `infra/aws/` y `deploy.sh` sin argumentos no funciona.
- **No levantar el bot en la laptop**: serían dos bots con las mismas
  credenciales.
- **Después de migrar, los datos de verdad quedan en el servidor.**
  `npm run pendientes` en la laptop mostraría una lista vieja: hay que usar
  `infra/aws/npm-en-servidor.sh pendientes`.

## Esperan una decisión tuya

- [ ] **Dominio del webhook**: arrancó con sslip.io, que es gratis pero si ese
      servicio se cae no llegan los mensajes. Pasar a un subdominio propio
      implica volver a avisarle a DoubleTick.
- [ ] **Confirmar el plan pago y el MFA de AWS.** La CLI mostró la cuenta en
      Free plan y sin MFA; se dio por hecho al terminar la alarma de gasto,
      pero no se volvió a verificar.
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
