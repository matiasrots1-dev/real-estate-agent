#!/usr/bin/env bash
# Configuración inicial de la cuenta de AWS, UNA vez (docs/TASKS.md Bloque 35).
#
# Requiere una sesión temporal de administrador, que abre el dueño del repo con:
#   aws login --profile admin-temporal
#
# Con esa sesión:
#   1. verifica plan pago, MFA en la cuenta raíz y alarma de gasto (si no hay
#      alarma, la crea);
#   2. crea el usuario `claude-lightsail`, con permiso SOLO sobre Lightsail;
#   3. le crea una clave y la guarda en el perfil `bot-inmobiliaria` SIN
#      mostrarla: va directo de AWS al archivo de credenciales de la laptop;
#   4. lista las instancias de Lightsail que ya existan en cualquier región,
#      para no crear un servidor duplicado;
#   5. cierra la sesión de administrador, pase lo que pase.
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PAGER="" MSYS_NO_PATHCONV=1
AWS="$(command -v aws 2>/dev/null || echo '/c/Program Files/Amazon/AWSCLIV2/aws.exe')"
ADMIN=admin-temporal
PERFIL=bot-inmobiliaria
USUARIO=claude-lightsail
POLITICA=SoloLightsail

# La sesión de administrador se cierra SIEMPRE, también si algo falla a mitad.
cerrar_sesion_admin() {
  "$AWS" logout --profile "$ADMIN" >/dev/null 2>&1 || true
  echo
  echo "Sesión de administrador cerrada."
}
trap cerrar_sesion_admin EXIT

# IAM, Budgets, Account y Free Tier son servicios globales: van por us-east-1.
adm() { "$AWS" --profile "$ADMIN" --region us-east-1 "$@" | tr -d '\r'; }
bot() { "$AWS" --profile "$PERFIL" "$@" | tr -d '\r'; }

QUIEN="$(adm sts get-caller-identity --query Arn --output text)"
CUENTA="$(adm sts get-caller-identity --query Account --output text)"
echo "Sesión de administrador: ${QUIEN##*:}"

echo
echo "== 1. Estado de la cuenta =="
PLAN="$(adm freetier get-account-plan-state --query 'accountPlanType' --output text 2>/dev/null || echo desconocido)"
case "$PLAN" in
  PAID) echo "Plan: pago. OK" ;;
  FREE) echo "Plan: FREE. ATENCIÓN: la cuenta se cierra sola a los 6 meses y borra todo 90 días después. Hay que pasarla a plan pago antes de crear el servidor." ;;
  *) echo "Plan: no pude leerlo ($PLAN). Revisalo en Billing and Cost Management." ;;
esac

MFA="$(adm iam get-account-summary --query 'SummaryMap.AccountMFAEnabled' --output text)"
if [ "$MFA" = "1" ]; then
  echo "MFA en la cuenta raíz: activado. OK"
else
  echo "MFA en la cuenta raíz: NO activado. Hay que activarlo."
fi

PRESUPUESTOS="$(adm budgets describe-budgets --account-id "$CUENTA" --query 'length(Budgets || `[]`)' --output text 2>/dev/null || echo 0)"
if [ "$PRESUPUESTOS" != "0" ]; then
  echo "Alarma de gasto: ya hay $PRESUPUESTOS presupuesto(s). OK"
else
  EMAIL="$(adm account get-primary-email --account-id "$CUENTA" --output text 2>/dev/null || true)"
  if [ -z "$EMAIL" ]; then
    echo "Alarma de gasto: no hay, y no pude leer el email de la cuenta para crearla. Hay que crearla a mano."
  else
    adm budgets create-budget --account-id "$CUENTA" \
      --budget '{"BudgetName":"bot-inmobiliaria-mensual","BudgetLimit":{"Amount":"15","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
      --notifications-with-subscribers "[
        {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},
        {\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}
      ]" >/dev/null
    echo "Alarma de gasto: creada. USD 15 por mes; avisa por mail al llegar al 80% y si el pronóstico pasa el 100%."
  fi
fi

echo
echo "== 2. Usuario $USUARIO, solo Lightsail =="
ARN_POLITICA="arn:aws:iam::${CUENTA}:policy/${POLITICA}"
if adm iam get-policy --policy-arn "$ARN_POLITICA" >/dev/null 2>&1; then
  echo "Política $POLITICA: ya existía."
else
  adm iam create-policy --policy-name "$POLITICA" \
    --description "Solo Lightsail, para el bot inmobiliaria (docs/TASKS.md Bloque 35)" \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"lightsail:*","Resource":"*"}]}' >/dev/null
  echo "Política $POLITICA: creada."
fi
if adm iam get-user --user-name "$USUARIO" >/dev/null 2>&1; then
  echo "Usuario $USUARIO: ya existía."
else
  adm iam create-user --user-name "$USUARIO" >/dev/null
  echo "Usuario $USUARIO: creado."
fi
adm iam attach-user-policy --user-name "$USUARIO" --policy-arn "$ARN_POLITICA" >/dev/null
echo "Permisos del usuario: $(adm iam list-attached-user-policies --user-name "$USUARIO" --query 'AttachedPolicies[].PolicyName' --output text | tr '\t' ' ')"

echo
echo "== 3. Clave del perfil $PERFIL =="
if "$AWS" --profile "$PERFIL" sts get-caller-identity >/dev/null 2>&1; then
  echo "El perfil $PERFIL ya funciona: no se crea otra clave."
else
  CLAVES="$(adm iam list-access-keys --user-name "$USUARIO" --query 'length(AccessKeyMetadata)' --output text)"
  if [ "$CLAVES" != "0" ]; then
    echo "El usuario ya tiene $CLAVES clave(s) que no están cargadas en esta laptop." >&2
    echo "Borralas en IAM (usuario $USUARIO > Security credentials) y volvé a correr este script." >&2
    exit 1
  fi
  # La clave secreta NUNCA se imprime: pasa por la tubería directo al archivo
  # de credenciales de la laptop.
  adm iam create-access-key --user-name "$USUARIO" \
    --query '[AccessKey.AccessKeyId, AccessKey.SecretAccessKey]' --output text | {
    read -r ID SECRETO
    "$AWS" configure set aws_access_key_id "$ID" --profile "$PERFIL"
    "$AWS" configure set aws_secret_access_key "$SECRETO" --profile "$PERFIL"
  }
  "$AWS" configure set region us-east-2 --profile "$PERFIL"
  "$AWS" configure set output json --profile "$PERFIL"
  echo "Clave creada y guardada en el perfil $PERFIL, sin mostrarla."
fi

echo
echo "== 4. Verificación con el perfil $PERFIL =="
# Una clave recién creada tarda unos segundos en valer en todo AWS.
OK=""
QUIEN_BOT=""
for _ in $(seq 1 24); do
  if QUIEN_BOT="$(bot sts get-caller-identity --query Arn --output text 2>/dev/null)" \
    && bot lightsail get-regions >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 5
done
if [ -z "$OK" ]; then
  echo "El perfil $PERFIL todavía no responde. Esperá un minuto y volvé a correr el script." >&2
  exit 1
fi
echo "Perfil $PERFIL: ${QUIEN_BOT##*:}, con acceso a Lightsail. OK"

echo
echo "== 5. Instancias de Lightsail que ya existen =="
HAY=""
for REGION in $(bot lightsail get-regions --query 'regions[].name' --output text); do
  NOMBRES="$(bot --region "$REGION" lightsail get-instances --query 'instances[].name' --output text 2>/dev/null || true)"
  if [ -n "$NOMBRES" ]; then
    echo "  $REGION: $NOMBRES"
    HAY=1
  fi
done
[ -n "$HAY" ] || echo "  Ninguna."
