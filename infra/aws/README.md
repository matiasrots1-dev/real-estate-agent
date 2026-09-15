# Servidor en AWS Lightsail

Cómo está armado el servidor del bot, cómo se despliega y qué hacer cuando algo
falla. La decisión y el pre-mortem están en `docs/TASKS.md`, Bloque 35.

Todos los comandos se corren **desde Git Bash, en la raíz del repo**.

## Cómo está armado

- **Lightsail**, región Ohio (`us-east-2`), Ubuntu 24.04, 2 GB, IP estática.
  Firewall con solo 22, 80 y 443 abiertos.
- **Caddy** recibe el HTTPS y le pasa **solo `/webhook`** al bot, en
  `127.0.0.1:3000`. `/health` se consulta únicamente desde el propio servidor.
- **systemd** corre el bot como usuario `bot`. Lo reinicia si se cae y lo
  levanta cuando arranca la máquina.
- **Código:** `/opt/bot-inmobiliaria/releases/<sha>`. El symlink `current`
  apunta al activo, y se guardan los últimos 3 releases.
- **Datos:** `/var/lib/bot-inmobiliaria/data`. Viven fuera del release, así que
  sobreviven a cada deploy.
- **Credenciales del bot:** `/etc/bot-inmobiliaria/.env`.
- **Snapshots automáticos** diarios a las 06:00 hora argentina; se guardan 7.
- **Parches de seguridad automáticos.** Si alguno necesita reiniciar la
  máquina, reinicia a las 06:00.
- **Modo silencioso forzado** en `infra/aws/bot-inmobiliaria.service`.

## Qué hace falta en la laptop

- Git Bash.
- AWS CLI con el perfil `bot-inmobiliaria`: un usuario de IAM con permiso
  **solo** sobre Lightsail. La clave se carga con
  `aws configure --profile bot-inmobiliaria`, nunca en el repo ni en un chat.
- La clave SSH `~/.ssh/bot-inmobiliaria-aws`.

La clave de AWS solo se usa para crear o modificar el servidor. Para
desplegar o ver logs alcanza con la IP: si la clave está desactivada en IAM,
anteponé `IP_SERVIDOR=<ip>` a cualquier comando.

## Primera vez, en orden

1. `infra/aws/crear-servidor.sh`
2. `infra/aws/preparar-servidor.sh` (usa `<ip>.sslip.io`) o
   `infra/aws/preparar-servidor.sh bot.midominio.com`. Con dominio propio, el
   registro DNS tiene que apuntar a la IP **antes** de correrlo.
3. **Apagar el bot de la laptop**, y después `infra/aws/migrar.sh`.
4. `infra/aws/deploy.sh`
5. Probar desde afuera: `curl -i https://<dominio>/webhook`. Tiene que
   contestar el bot, no un error de conexión ni de certificado.
6. **Pasarle a DoubleTick la URL nueva.** Recién desde ese momento entra
   tráfico real al servidor.
7. Confirmar que llegan mensajes: el contador del webhook en
   `infra/aws/servidor.sh 'curl -s localhost:3000/health'` tiene que subir.

## Día a día

| Para | Comando |
|---|---|
| Desplegar `main` | `infra/aws/deploy.sh` |
| Volver a una versión anterior | `infra/aws/deploy.sh <sha>` |
| Ver logs en vivo | `infra/aws/servidor.sh 'journalctl -u bot-inmobiliaria -f'` |
| Estado del bot | `infra/aws/servidor.sh 'curl -s localhost:3000/health'` |
| Reiniciar | `infra/aws/servidor.sh 'sudo systemctl restart bot-inmobiliaria'` |
| Clientes sin responder | `infra/aws/npm-en-servidor.sh pendientes` |
| Etiquetar conversaciones | `infra/aws/npm-en-servidor.sh etiquetar` |
| Cambiar una credencial del bot | `infra/aws/servidor.sh 'sudo nano /etc/bot-inmobiliaria/.env'` y después reiniciar |
| Entrar al servidor | `infra/aws/servidor.sh` |

El deploy verifica solo que `/health` responda, que los tres MCP servers estén
corriendo y que el modo silencioso efectivo del proceso coincida con la unidad
de systemd. Si algo falla, muestra los logs y sale con error.

**Desplegá en horario tranquilo:** el reinicio corta los mensajes que se estén
procesando en ese momento.

## Lo que NO hay que hacer

- **Levantar el bot en la laptop con el `.env` de producción.** Serían dos
  bots con las mismas credenciales: recordatorios dobles y dos audit logs
  distintos.
- **Apagar el modo silencioso editando el `.env` del servidor.** No tiene
  efecto, porque lo fuerza systemd. Se apaga cambiando
  `infra/aws/bot-inmobiliaria.service` en un PR.
- **Correr `npm run pendientes` en la laptop.** Los datos locales quedaron
  congelados al migrar; usá `infra/aws/npm-en-servidor.sh`.
- **Usar la cuenta de AWS para otros servicios.** La alarma de gasto llega con
  horas de retraso y no hay tope duro. Lightsail tiene precio fijo; lo demás
  cobra por uso.

## Si algo se rompe

- **El bot no contesta.** Mirá los logs y reiniciá. Si un deploy lo rompió,
  volvé al sha anterior con `infra/aws/deploy.sh <sha>`.
- **Se perdieron o corrompieron datos.** En la consola de Lightsail: instancia
  → *Snapshots* → *Create new instance* desde el snapshot del día que sirva.
  Después, en *Networking*, pasale la IP estática a la instancia nueva y borrá
  la vieja. Los snapshots de Lightsail restauran la máquina entera, no
  archivos sueltos.
- **No puedo entrar por SSH.** La consola de Lightsail tiene SSH desde el
  navegador, que no depende de tu clave.

## Mantenimiento de fondo

- **Node.js:** se instala la última 24.x. Para subir de versión mayor, cambiá
  `NODE_MAJOR` en `infra/aws/remoto/provisionar.sh` y volvé a correr
  `preparar-servidor.sh`.
- **Ubuntu 24.04** tiene soporte de seguridad hasta 2029.
