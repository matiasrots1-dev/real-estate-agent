#!/usr/bin/env bash
# Corre un script de npm EN el servidor, contra los datos reales.
#
#   infra/aws/npm-en-servidor.sh pendientes
#   infra/aws/npm-en-servidor.sh etiquetar
#
# Existe porque después de migrar, apps/orchestrator/data/ de la laptop queda
# congelado: `npm run pendientes` corrido localmente mostraría una lista vieja
# de clientes sin responder. Así además los datos personales no vuelven a la
# laptop (pre-mortem del Bloque 35).
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

if [ $# -lt 1 ]; then
  echo "Uso: $0 <script de npm> [argumentos]" >&2
  exit 1
fi

IP="$(ip_servidor)"
ssh -t "${SSH_OPTS[@]}" "$USUARIO_SSH@$IP" \
  "cd /opt/bot-inmobiliaria/current && sudo -u bot -H env -u NODE_ENV npm run --silent $(printf '%q ' "$@")"
