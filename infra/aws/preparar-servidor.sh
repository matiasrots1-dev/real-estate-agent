#!/usr/bin/env bash
# Deja el servidor listo para correr el bot: zona horaria argentina, parches de
# seguridad automáticos, Node 24, Caddy con HTTPS y el usuario de sistema `bot`.
# Idempotente: se puede volver a correr.
#
#   infra/aws/preparar-servidor.sh                    -> usa <ip>.sslip.io
#   infra/aws/preparar-servidor.sh bot.midominio.com  -> usa ese nombre
#
# Con dominio propio, el registro DNS (A -> IP del servidor) tiene que existir
# antes: si no, Caddy no puede sacar el certificado y reintenta hasta que exista.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh
sin_crlf remoto/provisionar.sh

IP="$(ip_servidor)"
DOMINIO="${1:-${IP//./-}.sslip.io}"
echo "Preparando $IP con el nombre $DOMINIO"
ssh_bot "sudo DOMINIO='$DOMINIO' bash -s" < remoto/provisionar.sh
echo
echo "URL del webhook: https://$DOMINIO/webhook"
echo "Siguiente paso:  infra/aws/migrar.sh"
