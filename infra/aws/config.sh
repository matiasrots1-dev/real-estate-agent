# Configuración compartida de los scripts de infra/aws (docs/TASKS.md Bloque 35).
#
# Sin secretos: las credenciales de AWS viven en el perfil de AWS CLI de la
# máquina del dueño del repo (`aws configure --profile bot-inmobiliaria`), y las
# del bot en /etc/bot-inmobiliaria/.env, dentro del servidor.

AWS_PROFILE_BOT="${AWS_PROFILE_BOT:-bot-inmobiliaria}"
AWS_REGION_BOT="${AWS_REGION_BOT:-us-east-2}"
ZONA="${ZONA:-us-east-2a}"
INSTANCIA="${INSTANCIA:-bot-inmobiliaria}"
IP_ESTATICA="${IP_ESTATICA:-bot-inmobiliaria-ip}"
CLAVE_SSH="${CLAVE_SSH:-$HOME/.ssh/bot-inmobiliaria-aws}"
USUARIO_SSH="ubuntu"

# AWS CLI en Windows no siempre queda en el PATH de Git Bash hasta reiniciar
# la terminal, así que se busca también en su ruta de instalación.
#
# MSYS_NO_PATHCONV=1: Git Bash "traduce" a rutas de Windows los argumentos que
# parecen rutas POSIX cuando llama a un .exe nativo, y rompería el script de
# primer arranque (`#!/bin/bash`).
aws_bot() {
  local bin
  bin="$(command -v aws 2>/dev/null || true)"
  if [ -z "$bin" ] && [ -x "/c/Program Files/Amazon/AWSCLIV2/aws.exe" ]; then
    bin="/c/Program Files/Amazon/AWSCLIV2/aws.exe"
  fi
  if [ -z "$bin" ]; then
    echo "No encuentro AWS CLI. Instalalo con: winget install -e --id Amazon.AWSCLI" >&2
    return 1
  fi
  MSYS_NO_PATHCONV=1 "$bin" --profile "$AWS_PROFILE_BOT" --region "$AWS_REGION_BOT" "$@"
}

# Para capturar texto: en Windows AWS CLI termina las líneas con \r\n, y ese \r
# pegado a una IP rompe cualquier ssh posterior sin un error claro.
aws_txt() {
  aws_bot "$@" | tr -d '\r'
}

# IP_SERVIDOR permite operar sin la clave de AWS: la clave solo hace falta para
# crear o cambiar el servidor, no para desplegar ni ver logs. Así se puede dejar
# desactivada en IAM el resto del tiempo.
ip_servidor() {
  if [ -n "${IP_SERVIDOR:-}" ]; then
    echo "$IP_SERVIDOR"
    return
  fi
  aws_txt lightsail get-static-ip --static-ip-name "$IP_ESTATICA" \
    --query 'staticIp.ipAddress' --output text
}

# Se niega a mandar al servidor un script con finales de línea de Windows:
# bash en Linux lo ejecutaría con \r pegado a cada comando.
sin_crlf() {
  local archivo
  for archivo in "$@"; do
    if grep -q $'\r' "$archivo"; then
      echo "$archivo tiene finales de línea CRLF. Revisá .gitattributes y volvé a hacer checkout." >&2
      exit 1
    fi
  done
}

# accept-new: confía en la clave del servidor la primera vez, y rechaza la
# conexión si esa clave cambia después.
SSH_OPTS=(-i "$CLAVE_SSH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)

# Usan la variable IP, que cada script carga con `IP="$(ip_servidor)"`.
ssh_bot() { ssh "${SSH_OPTS[@]}" "$USUARIO_SSH@$IP" "$@"; }
scp_bot() { scp "${SSH_OPTS[@]}" "$@"; }
