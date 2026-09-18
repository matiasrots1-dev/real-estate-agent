#!/usr/bin/env bash
# Copia UNA VEZ el .env y los datos de la laptop al servidor.
#
# Frena el bot del servidor mientras copia, para que no escriba sobre datos a
# medio copiar. Si en el servidor ya había datos, los guarda aparte con fecha:
# nunca los pisa.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
IP="$(ip_servidor)"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "No hay .env en $REPO_ROOT." >&2
  exit 1
fi

# Dos bots con las mismas credenciales mandan todo doble y dejan dos audit logs
# que divergen (pre-mortem del Bloque 35).
if curl -fsS --max-time 2 http://localhost:3000/health >/dev/null 2>&1; then
  echo "El bot de la laptop está corriendo. Apagalo antes de migrar." >&2
  exit 1
fi

echo "Subiendo .env a $IP..."
# Por la entrada de ssh y con umask 077: el .env nunca queda legible para
# otros usuarios del servidor, ni siquiera un instante en /tmp.
ssh_bot 'umask 077 && cat > /tmp/bot-inmobiliaria.env' < "$REPO_ROOT/.env"

echo "Subiendo datos..."
TAR="$(mktemp)"
tar -czf "$TAR" -C "$REPO_ROOT/apps/orchestrator" data
ssh_bot 'umask 077 && cat > /tmp/bot-inmobiliaria-data.tar.gz' < "$TAR"
rm -f "$TAR"

ssh_bot 'sudo bash -s' <<'REMOTO'
set -euo pipefail
DATA=/var/lib/bot-inmobiliaria/data
systemctl stop bot-inmobiliaria 2>/dev/null || true

install -o root -g bot -m 640 /tmp/bot-inmobiliaria.env /etc/bot-inmobiliaria/.env
shred -u /tmp/bot-inmobiliaria.env

if [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
  RESGUARDO="$DATA.antes-de-migrar.$(date +%Y%m%d-%H%M%S)"
  mv "$DATA" "$RESGUARDO"
  echo "Había datos en el servidor: quedaron en $RESGUARDO"
fi
install -d -o bot -g bot -m 700 "$DATA"
tar -xzf /tmp/bot-inmobiliaria-data.tar.gz -C /var/lib/bot-inmobiliaria
chown -R bot:bot "$DATA"
chmod 700 "$DATA"
shred -u /tmp/bot-inmobiliaria-data.tar.gz
echo "Migrados $(ls "$DATA" | wc -l) archivos a $DATA"
REMOTO

echo "Siguiente paso: infra/aws/deploy.sh"
