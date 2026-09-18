#!/usr/bin/env bash
# Hace que la AWS CLI confíe en el antivirus que inspecciona HTTPS en la laptop.
#
# Norton 360 (Web/Mail Shield) intercepta el HTTPS y firma los certificados con
# su propia raíz. Windows y Node confían en ella (el propio Norton define
# NODE_EXTRA_CA_CERTS apuntando a esa raíz), pero la AWS CLI trae su propia
# lista de certificados y falla en cualquier llamada a AWS, incluido
# `aws login`, con:
#   SSL: CERTIFICATE_VERIFY_FAILED ... unable to get local issuer certificate
#
# Arma un paquete con la lista de la AWS CLI más la raíz del antivirus, y lo
# configura como `ca_bundle` SOLO en los perfiles del bot. No toca Norton ni
# ningún otro programa.
#
# Hay que volver a correrlo si se reinstala la AWS CLI o si cambia la raíz del
# antivirus. Ver infra/aws/README.md y docs/TASKS.md Bloque 35.
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PAGER=""
AWS="$(command -v aws 2>/dev/null || echo '/c/Program Files/Amazon/AWSCLIV2/aws.exe')"
# MSYS_NO_PATHCONV solo para aws.exe, como en config.sh. Aplicado a todo el
# script, Git Bash deja de traducir las rutas también para openssl (que es un
# ejecutable nativo de /mingw64) y openssl no encuentra los archivos.
aws_cli() { MSYS_NO_PATHCONV=1 "$AWS" "$@"; }
PERFILES=(bot-inmobiliaria admin-temporal)
LISTA_AWS="/c/Program Files/Amazon/AWSCLIV2/awscli/botocore/cacert.pem"
DESTINO="$HOME/.aws/ca-bundle-con-antivirus.pem"

if [ ! -f "$LISTA_AWS" ]; then
  echo "No encuentro la lista de certificados de la AWS CLI en $LISTA_AWS" >&2
  exit 1
fi

RAIZ_ANTIVIRUS=""
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  RAIZ_ANTIVIRUS="$(cygpath -u "$NODE_EXTRA_CA_CERTS")"
fi
if [ -z "$RAIZ_ANTIVIRUS" ] || [ ! -f "$RAIZ_ANTIVIRUS" ]; then
  echo "No encuentro la raíz del antivirus: NODE_EXTRA_CA_CERTS no apunta a un archivo." >&2
  exit 1
fi
if ! openssl x509 -in "$RAIZ_ANTIVIRUS" -noout >/dev/null 2>&1; then
  echo "$RAIZ_ANTIVIRUS no es un certificado válido." >&2
  exit 1
fi
echo "Raíz del antivirus: $(openssl x509 -in "$RAIZ_ANTIVIRUS" -noout -subject | sed 's/.*CN *= *//')"

mkdir -p "$HOME/.aws"
cat "$LISTA_AWS" "$RAIZ_ANTIVIRUS" | tr -d '\r' > "$DESTINO"
echo "Paquete: $DESTINO ($(grep -c 'BEGIN CERTIFICATE' "$DESTINO") certificados)"

DESTINO_WINDOWS="$(cygpath -w "$DESTINO")"
for PERFIL in "${PERFILES[@]}"; do
  aws_cli configure set ca_bundle "$DESTINO_WINDOWS" --profile "$PERFIL"
  aws_cli configure set region us-east-2 --profile "$PERFIL"
  echo "Perfil $PERFIL: usa el paquete."
done

# Sin firmar, AWS rechaza el pedido por autenticación. Lo que importa es que
# el rechazo llegue: si la conexión HTTPS falla, el error es de SSL.
echo "Verificando la conexión HTTPS con AWS..."
SALIDA="$(aws_cli lightsail get-regions --no-sign-request --profile bot-inmobiliaria 2>&1 | tr -d '\r' || true)"
if echo "$SALIDA" | grep -q "SSL validation failed"; then
  echo "Sigue fallando el certificado:" >&2
  echo "$SALIDA" | tail -2 >&2
  exit 1
fi
echo "La AWS CLI ya confía en la conexión. OK"
