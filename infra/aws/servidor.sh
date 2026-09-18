#!/usr/bin/env bash
# Entra al servidor por SSH, o corre un comando ahí.
#
#   infra/aws/servidor.sh                                        -> sesión interactiva
#   infra/aws/servidor.sh 'journalctl -u bot-inmobiliaria -f'    -> logs en vivo
#   infra/aws/servidor.sh 'curl -s localhost:3000/health'        -> estado del bot
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

IP="$(ip_servidor)"
if [ $# -eq 0 ]; then
  ssh -t "${SSH_OPTS[@]}" "$USUARIO_SSH@$IP"
else
  ssh -t "${SSH_OPTS[@]}" "$USUARIO_SSH@$IP" "$@"
fi
