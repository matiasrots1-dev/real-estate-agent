#!/usr/bin/env bash
# Corre EN el servidor, como root (lo lanza infra/aws/preparar-servidor.sh).
# Idempotente. Ver docs/TASKS.md Bloque 35.
set -euo pipefail
: "${DOMINIO:?falta DOMINIO}"

APP_DIR=/opt/bot-inmobiliaria
DATA_DIR=/var/lib/bot-inmobiliaria/data
ETC_DIR=/etc/bot-inmobiliaria
NODE_MAJOR=24
export DEBIAN_FRONTEND=noninteractive
# En el primer arranque, unattended-upgrades suele tener tomado el lock de apt:
# se espera en vez de fallar.
APT=(apt-get -o DPkg::Lock::Timeout=600 -y -q)

echo "== Zona horaria =="
# Del sistema entero, no solo la variable TZ del servicio: los MCP servers no
# heredan el entorno completo del orchestrator (mcpToolClient.ts).
timedatectl set-timezone America/Argentina/Buenos_Aires
date

echo "== Paquetes base y parches de seguridad automáticos =="
"${APT[@]}" update
"${APT[@]}" install unattended-upgrades curl ca-certificates xz-utils gnupg \
  debian-keyring debian-archive-keyring apt-transport-https
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Los parches del kernel necesitan reiniciar. Se reinicia solo si hace falta, y
# a las 06:00 hora argentina: un reinicio corta los mensajes en curso
# (el apagado no drena la cola; ver el pre-mortem del Bloque 35).
cat > /etc/apt/apt.conf.d/52bot-inmobiliaria-reinicio <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "06:00";
EOF

echo "== SSH solo con clave =="
cat > /etc/ssh/sshd_config.d/60-bot-inmobiliaria.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF
# Se valida ANTES de recargar: una configuración rota recargada dejaría el
# servidor sin SSH. Con set -e, si la validación falla el script corta acá.
sshd -t
systemctl reload ssh 2>/dev/null || true

echo "== Swap de 1 GB (margen para npm ci) =="
if ! swapon --show | grep -q '^/swapfile'; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Node.js $NODE_MAJOR (binario oficial de nodejs.org, con checksum) =="
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "Arquitectura no soportada: $(uname -m)" >&2; exit 1 ;;
esac
NODE_ACTUAL="$(command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo ninguno)"
if [ "$NODE_ACTUAL" != "$NODE_MAJOR" ]; then
  TMP="$(mktemp -d)"
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  ARCHIVO="$(grep -o "node-v${NODE_MAJOR}\.[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
  curl -fsSL "$BASE/$ARCHIVO" -o "$TMP/$ARCHIVO"
  (cd "$TMP" && grep " ${ARCHIVO}\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$TMP/$ARCHIVO" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi
node --version
npm --version

echo "== Caddy (HTTPS automático) =="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  "${APT[@]}" update
  "${APT[@]}" install caddy
fi

# Solo se publica /webhook. /health queda accesible únicamente desde el propio
# servidor (expone la fuente de Tokko y los contadores del webhook).
#
# Sin log de accesos A PROPÓSITO: la verificación del webhook de Meta manda el
# verify token en la query string, y un log de accesos lo guardaría en texto
# plano.
cat > /etc/caddy/Caddyfile <<EOF
# Generado por infra/aws/remoto/provisionar.sh — no editar a mano.
${DOMINIO} {
	handle /webhook {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		respond 404
	}
}
EOF
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== Usuario y carpetas del bot =="
id bot >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin bot
install -d -o bot -g bot -m 750 "$APP_DIR" "$APP_DIR/releases"
install -d -o bot -g bot -m 700 "$DATA_DIR"
install -d -o root -g bot -m 750 "$ETC_DIR"

echo
echo "Servidor preparado para $DOMINIO."
