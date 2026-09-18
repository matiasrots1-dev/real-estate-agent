#!/usr/bin/env bash
# Crea el servidor en AWS Lightsail (docs/TASKS.md Bloque 35):
#   - Ubuntu 24.04, el plan Linux más barato de 2 GB con IPv4
#   - IP estática
#   - firewall con solo 22, 80 y 443 abiertos
#   - snapshots automáticos diarios (se guardan 7)
#
# Idempotente: lo que ya existe no se vuelve a crear.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

if [ ! -f "$CLAVE_SSH.pub" ]; then
  echo "Falta $CLAVE_SSH.pub. Generala con: ssh-keygen -t ed25519 -f $CLAVE_SSH -N ''" >&2
  exit 1
fi

echo "Cuenta de AWS: $(aws_txt sts get-caller-identity --query Arn --output text)"

BLUEPRINT="$(aws_txt lightsail get-blueprints \
  --query "blueprints[?isActive && contains(blueprintId, 'ubuntu_24')].blueprintId | [0]" --output text)"
if [ -z "$BLUEPRINT" ] || [ "$BLUEPRINT" = "None" ]; then
  echo "No encontré la imagen de Ubuntu 24.04 en Lightsail." >&2
  exit 1
fi

# El plan se elige por RAM y precio, no por un id fijo: Lightsail renombra sus
# planes por generación (`small_3_0`, ...) y un id viejo fallaría.
BUNDLE="$(aws_txt lightsail get-bundles \
  --query "sort_by(bundles[?isActive && ramSizeInGb==\`2.0\` && contains(supportedPlatforms, 'LINUX_UNIX') && !contains(bundleId, 'ipv6')], &price)[0].bundleId" \
  --output text)"
if [ -z "$BUNDLE" ] || [ "$BUNDLE" = "None" ]; then
  echo "No encontré un plan Linux de 2 GB con IPv4." >&2
  exit 1
fi
PRECIO="$(aws_txt lightsail get-bundles --query "bundles[?bundleId=='$BUNDLE'].price | [0]" --output text)"
echo "Plan: $BUNDLE (USD $PRECIO/mes) | imagen: $BLUEPRINT | zona: $ZONA"

# Lightsail solo importa claves RSA, así que la clave ed25519 del dueño del
# repo se instala en el primer arranque. Si esto fallara, sigue funcionando la
# clave por defecto de Lightsail y el SSH desde el navegador de la consola.
CLAVE_PUBLICA="$(tr -d '\r' < "$CLAVE_SSH.pub")"
LANZAMIENTO="#!/bin/bash
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
echo '$CLAVE_PUBLICA' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys"

if aws_bot lightsail get-instance --instance-name "$INSTANCIA" >/dev/null 2>&1; then
  echo "La instancia $INSTANCIA ya existe: no se crea de nuevo."
else
  echo "Creando la instancia $INSTANCIA..."
  # 09:00 UTC = 06:00 hora argentina, el horario con menos mensajes.
  aws_bot lightsail create-instances \
    --instance-names "$INSTANCIA" \
    --availability-zone "$ZONA" \
    --blueprint-id "$BLUEPRINT" \
    --bundle-id "$BUNDLE" \
    --user-data "$LANZAMIENTO" \
    --add-ons 'addOnType=AutoSnapshot,autoSnapshotAddOnRequest={snapshotTimeOfDay=09:00}' >/dev/null
fi

printf "Esperando que arranque"
ESTADO=""
for _ in $(seq 1 60); do
  ESTADO="$(aws_txt lightsail get-instance-state --instance-name "$INSTANCIA" --query 'state.name' --output text)"
  [ "$ESTADO" = "running" ] && break
  printf "."
  sleep 5
done
echo " $ESTADO"
if [ "$ESTADO" != "running" ]; then
  echo "La instancia no llegó a estar corriendo." >&2
  exit 1
fi

if ! aws_bot lightsail get-static-ip --static-ip-name "$IP_ESTATICA" >/dev/null 2>&1; then
  echo "Reservando IP estática $IP_ESTATICA..."
  aws_bot lightsail allocate-static-ip --static-ip-name "$IP_ESTATICA" >/dev/null
fi
ADJUNTA="$(aws_txt lightsail get-static-ip --static-ip-name "$IP_ESTATICA" --query 'staticIp.attachedTo' --output text)"
if [ "$ADJUNTA" != "$INSTANCIA" ]; then
  aws_bot lightsail attach-static-ip --static-ip-name "$IP_ESTATICA" --instance-name "$INSTANCIA" >/dev/null
fi

# Reemplaza TODAS las reglas del firewall: lo que no está acá queda cerrado.
# El 3000 del bot nunca se publica; entra solo por Caddy.
aws_bot lightsail put-instance-public-ports --instance-name "$INSTANCIA" --port-infos \
  fromPort=22,toPort=22,protocol=tcp \
  fromPort=80,toPort=80,protocol=tcp \
  fromPort=443,toPort=443,protocol=tcp >/dev/null

IP="$(ip_servidor)"
printf "Esperando SSH en %s" "$IP"
for _ in $(seq 1 40); do
  if ssh_bot true 2>/dev/null; then
    break
  fi
  printf "."
  sleep 5
done
if ! ssh_bot true; then
  echo " no pude entrar por SSH." >&2
  exit 1
fi
echo " listo."
echo
echo "Servidor:        $IP"
echo "Nombre sslip.io: ${IP//./-}.sslip.io"
echo "Siguiente paso:  infra/aws/preparar-servidor.sh [dominio]"
