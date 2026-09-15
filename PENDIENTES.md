# Pendientes

Tablero corto para abrir al empezar a trabajar. El detalle de cada bloque vive
en [docs/TASKS.md](docs/TASKS.md); esto solo ordena y apunta.

**Se actualiza en el mismo PR que cierra un bloque o registra una decisión.**
Si un tema queda a medias porque se pasa a otra cosa, se anota acá dónde quedó.

Última actualización: 2026-09-15

## Estado ahora

- **El bot está apagado desde el 30/8.** Corría en la laptop. Mientras siga
  así no queda registro de quién escribe: los mensajes están en WhatsApp, pero
  no en el audit log ni en `npm run pendientes`.
- Modo silencioso: **prendido** (default de fábrica). No le responde a clientes.
- En curso: **subir el bot a un servidor**, para que no dependa de la laptop.

## Esperan una decisión tuya

- [ ] **Plataforma de hosting**: Render o Railway (las dos que nombra el SOW,
      secc. 4.7).
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
- [ ] Sumar el hosting a la tabla "Con quién se comparten" cuando el bot corra
      en un servidor.

## Después

- [ ] **Bloque 29**: el 44% de los que escriben no está en Tokko.
- [ ] **Bloque 17**: `leadId` inconsistente. Se decidió dejarlo para después
      de salir.
- [ ] **Bloque 33**: Postgres, solo si el volumen lo justifica.
- [ ] Pedirle a DoubleTick la exportación del historial de chats, para el
      corpus de estilo.

## Riesgos asumidos (no son trabajo pendiente)

Las casillas abiertas de los Bloques 18, 19, 21, 22, 24 y 25 de `docs/TASKS.md`
son riesgos anotados y aceptados, como la cola en memoria o la falta de drain
al apagar. No son trabajo sin terminar.
