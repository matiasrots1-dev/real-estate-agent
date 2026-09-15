#!/usr/bin/env bash
# Corre EN el servidor, como root (lo lanza infra/aws/deploy.sh).
# Instala un release subido a /tmp, lo activa y verifica que el bot quedó sano.
set -euo pipefail
: "${SHA:?falta SHA}"

APP_DIR=/opt/bot-inmobiliaria
DATA_DIR=/var/lib/bot-inmobiliaria/data
ETC_DIR=/etc/bot-inmobiliaria
UNIDAD=/etc/systemd/system/bot-inmobiliaria.service
REL="$APP_DIR/releases/$SHA"
TAR="/tmp/bot-inmobiliaria-$SHA.tar.gz"

if [ ! -f "$ETC_DIR/.env" ]; then
  echo "Falta $ETC_DIR/.env: corré primero infra/aws/migrar.sh" >&2
  exit 1
fi

echo "== Instalando $SHA =="
rm -rf "$REL.nuevo"
install -d -o bot -g bot -m 750 "$REL.nuevo"
tar -xzf "$TAR" -C "$REL.nuevo"
chown -R bot:bot "$REL.nuevo"
rm -f "$TAR"

# Instalación COMPLETA, con devDependencies y sin NODE_ENV: el orchestrator
# lanza los MCP servers con tsx, que es devDependency. Con NODE_ENV=production
# npm la omitiría, y el bot arrancaría con /health en verde y los MCP muertos.
sudo -u bot -H env -u NODE_ENV bash -c "cd '$REL.nuevo' && npm ci --no-audit --no-fund --loglevel=error"

# shared-types se consume por su `main`, que es dist/index.js. dist/ está en
# .gitignore, así que git archive no lo trae: sin compilarlo acá, el
# orchestrator y los MCP servers no arrancan (ERR_MODULE_NOT_FOUND). En la
# laptop no se nota porque dist/ quedó de una compilación anterior.
sudo -u bot -H env -u NODE_ENV bash -c "cd '$REL.nuevo' && npm run build --workspace=shared-types --silent"

# El .env y los datos viven fuera del release, así sobreviven a cada deploy.
ln -sfn "$ETC_DIR/.env" "$REL.nuevo/.env"
rm -rf "$REL.nuevo/apps/orchestrator/data"
ln -sfn "$DATA_DIR" "$REL.nuevo/apps/orchestrator/data"

rm -rf "$REL"
mv "$REL.nuevo" "$REL"
ln -sfn "$REL" "$APP_DIR/current"

install -m 644 "$REL/infra/aws/bot-inmobiliaria.service" "$UNIDAD"
systemctl daemon-reload
systemctl enable bot-inmobiliaria >/dev/null

echo "== Reiniciando =="
INICIO="$(date '+%Y-%m-%d %H:%M:%S')"
systemctl restart bot-inmobiliaria

fallar() {
  echo "DEPLOY FALLIDO: $1" >&2
  journalctl -u bot-inmobiliaria --since "$INICIO" --no-pager | tail -40 >&2
  exit 1
}

echo "== Verificando =="
SANO=""
for _ in $(seq 1 45); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null 2>&1; then
    SANO=1
    break
  fi
  sleep 2
done
[ -n "$SANO" ] || fallar "el bot no responde /health."
echo "/health: $(curl -fsS --max-time 3 http://127.0.0.1:3000/health)"

# /health en verde no alcanza: si faltara tsx, el HTTP respondería igual con
# los MCP servers muertos (pre-mortem 1 del Bloque 35).
FALTAN=""
for _ in $(seq 1 15); do
  FALTAN=""
  for mcp in mcp-tokko mcp-gcal mcp-weather; do
    pgrep -u bot -f "mcp-servers/$mcp/src/index.ts" >/dev/null || FALTAN="$FALTAN $mcp"
  done
  [ -z "$FALTAN" ] && break
  sleep 2
done
[ -z "$FALTAN" ] || fallar "no están corriendo los MCP servers:$FALTAN"
echo "MCP servers corriendo: tokko, gcal, weather."

# El valor EFECTIVO del proceso, no lo que dice un archivo: si el .env pudiera
# pisar la unidad de systemd, esto lo detecta (pre-mortem 4 del Bloque 35).
PID="$(systemctl show -p MainPID --value bot-inmobiliaria)"
ESPERADO="$(sed -n 's/^Environment=AGENTE_MODO_SILENCIOSO=//p' "$UNIDAD")"
REAL="$(tr '\0' '\n' < "/proc/$PID/environ" | sed -n 's/^AGENTE_MODO_SILENCIOSO=//p')"
[ "$REAL" = "$ESPERADO" ] || fallar "el modo silencioso del proceso ('$REAL') no coincide con la unidad ('$ESPERADO')."
if [ "$REAL" = "false" ]; then
  echo "ATENCIÓN: MODO SILENCIOSO APAGADO. El agente les responde solo a los clientes."
else
  echo "Modo silencioso: prendido (forzado por systemd)."
fi

echo "Hora del servidor: $(date '+%Y-%m-%d %H:%M %Z')"

# Se guardan los últimos 3 releases, para poder volver atrás rápido.
ls -1dt "$APP_DIR"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

echo
echo "Deploy de $SHA OK."
