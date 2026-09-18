#!/usr/bin/env bash
# Sube una versión del repo al servidor, la activa y verifica que el bot quedó
# sano. Si la verificación falla, lo dice y sale con error.
#
#   infra/aws/deploy.sh               -> despliega origin/main
#   infra/aws/deploy.sh <rama o sha>  -> despliega esa versión (sirve para volver atrás)
#
# Sube exactamente lo commiteado (git archive): nada sin commitear, ni el .env,
# ni los datos de la laptop.
#
# El reinicio corta los mensajes que se estén procesando (el apagado no drena
# la cola, pre-mortem del Bloque 35): conviene desplegar en horario tranquilo.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh
sin_crlf remoto/activar-release.sh

REF="${1:-origin/main}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
git -C "$REPO_ROOT" fetch -q origin
SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 "${REF}^{commit}")"
IP="$(ip_servidor)"

echo "Desplegando $REF ($SHA) en $IP"
TAR="$(mktemp)"
git -C "$REPO_ROOT" archive --format=tar.gz -o "$TAR" "$SHA"
ssh_bot "cat > /tmp/bot-inmobiliaria-$SHA.tar.gz" < "$TAR"
rm -f "$TAR"

ssh_bot "sudo SHA='$SHA' bash -s" < remoto/activar-release.sh
