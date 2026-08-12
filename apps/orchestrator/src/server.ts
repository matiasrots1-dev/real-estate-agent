import { createServer } from "node:http";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfigFromEnv, REPO_ROOT } from "./config.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { ClaudeIntentClassifier } from "./agent/classifier.js";
import { ClaudeResponseComposer } from "./agent/composer.js";
import { ClaudeDraftReplyComposer } from "./agent/draftComposer.js";
import { ClaudeSlotConfirmationClassifier } from "./agent/slotConfirmation.js";
import { ClaudeReprogramActionClassifier } from "./agent/reprogramActionClassifier.js";
import { ClaudePausarAgenteActionClassifier } from "./agent/pausarAgenteClassifier.js";
import { ClaudeBrokerAccionDirectaPlanner } from "./agent/brokerAccionDirectaPlan.js";
import { ClaudeConfirmationClassifier } from "./agent/confirmationClassifier.js";
import { WhatsAppBrokerNotifier } from "./agent/brokerNotifier.js";
import { FileAuditLogStore } from "./agent/auditLog.js";
import { FileAppointmentStore } from "./agent/appointmentStore.js";
import { FileConversationStateStore } from "./agent/conversationStateStore.js";
import { FileRecontactStateStore } from "./agent/recontactStateStore.js";
import { FileGlobalPauseStore } from "./agent/globalPauseStore.js";
import { FileLastInteractionStore } from "./agent/lastInteractionStore.js";
import { FileRetentionReportStore } from "./agent/retentionReportStore.js";
import { TokkoMcpClient } from "./mcp/tokkoMcpClient.js";
import { GcalMcpClient } from "./mcp/gcalMcpClient.js";
import { WeatherMcpClient } from "./mcp/weatherMcpClient.js";
import { GraphApiWhatsAppSender } from "./channels/whatsapp/sender.js";
import { createRequestListener } from "./app.js";
import { Scheduler } from "./jobs/scheduler.js";
import { createReminderJob } from "./jobs/reminders.js";
import { createRecontactJob } from "./jobs/recontact.js";
import { createSeguimientoPostVisitaJob } from "./jobs/seguimientoPostVisita.js";
import { createRetentionJob } from "./jobs/retention.js";

// Ruta absoluta al `.env` de la raíz del repo: `npm run dev --workspace=...`
// (y por lo tanto `npm run dev:orchestrator` desde la raíz) corre este
// script con cwd = apps/orchestrator, no la raíz. Un `dotenv.config()` sin
// path buscaría apps/orchestrator/.env y nunca encontraría el de la raíz.
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

// Última red, por debajo del catch de la cola de background. La cola ya
// contiene todo lo suyo (backgroundQueue.ts), pero desde que el webhook
// responde 200 y procesa después, cualquier promesa suelta en cualquier parte
// del proceso deja de tener a alguien que la espere — y Node 24 termina el
// proceso ante un unhandledRejection. Preferimos un orchestrator vivo con un
// error ruidoso en el log a uno caído por un mensaje raro.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[proceso] promesa rechazada sin manejar. El proceso sigue vivo a propósito; " +
      "esto es un bug que hay que arreglar, no un estado normal:",
    reason
  );
});

async function main() {
  const config = loadConfigFromEnv();

  if (!config.anthropicApiKey) {
    throw new Error(
      "Falta ANTHROPIC_API_KEY en el entorno. Copiá .env.example a .env y completá la clave (ver CLAUDE.md secc. 3)."
    );
  }

  const catalog = loadCatalog(config.intentCatalogPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const tokko = new TokkoMcpClient({ entryPath: config.mcpTokko.entryPath, cwd: config.mcpTokko.cwd });
  const gcal = new GcalMcpClient({ entryPath: config.mcpGcal.entryPath, cwd: config.mcpGcal.cwd });
  const weather = new WeatherMcpClient({ entryPath: config.mcpWeather.entryPath, cwd: config.mcpWeather.cwd });
  await Promise.all([tokko.connect(), gcal.connect(), weather.connect()]);

  const sender =
    config.whatsapp.phoneNumberId && config.whatsapp.accessToken
      ? new GraphApiWhatsAppSender(config.whatsapp.phoneNumberId, config.whatsapp.accessToken)
      : undefined;
  if (!sender) {
    console.warn(
      "WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN no configurados: las respuestas se procesan y auditan pero no se envían por WhatsApp."
    );
  }

  const brokerNotifier =
    sender && config.whatsapp.brokerWhatsappNumber
      ? new WhatsAppBrokerNotifier(sender, config.whatsapp.brokerWhatsappNumber)
      : undefined;
  if (!brokerNotifier) {
    console.warn(
      "BROKER_WHATSAPP_NUMBER no configurado (o falta el sender): los mensajes escalados se auditan pero no se notifican por WhatsApp al broker."
    );
  }

  const appointmentStore = new FileAppointmentStore(config.appointmentStorePath);
  const conversationStateStore = new FileConversationStateStore(config.conversationStateStorePath);
  const recontactStateStore = new FileRecontactStateStore(config.recontactStateStorePath);
  const lastInteractionStore = new FileLastInteractionStore(config.lastInteractionStorePath);
  const auditLog = new FileAuditLogStore(config.auditLogPath);
  const composer = new ClaudeResponseComposer(anthropic);

  const listener = createRequestListener({
    catalog,
    classifier: new ClaudeIntentClassifier(anthropic),
    composer,
    draftComposer: new ClaudeDraftReplyComposer(anthropic),
    slotConfirmationClassifier: new ClaudeSlotConfirmationClassifier(anthropic),
    reprogramActionClassifier: new ClaudeReprogramActionClassifier(anthropic),
    pausarAgenteActionClassifier: new ClaudePausarAgenteActionClassifier(anthropic),
    globalPauseStore: new FileGlobalPauseStore(config.globalPauseStorePath),
    brokerAccionDirectaPlanner: new ClaudeBrokerAccionDirectaPlanner(anthropic, tokko),
    confirmationClassifier: new ClaudeConfirmationClassifier(anthropic),
    auditLog,
    appointmentStore,
    conversationStateStore,
    lastInteractionStore,
    tokko,
    gcal,
    weather,
    defaultLat: config.defaultLat,
    defaultLng: config.defaultLng,
    sender,
    brokerNotifier,
    brokerWhatsappNumber: config.whatsapp.brokerWhatsappNumber,
    whatsappWebhookVerifyToken: config.whatsapp.webhookVerifyToken,
    whatsappAppSecret: config.whatsapp.appSecret,
    skipWebhookSignatureCheck: config.whatsapp.skipWebhookSignatureCheck,
  });

  // Dos formas distintas de quedar sin verificación de firma, las dos ruidosas
  // al arrancar. La segunda es la traicionera: no requiere prender ningún flag,
  // alcanza con que falte el App Secret, y antes no avisaba nada.
  if (config.whatsapp.skipWebhookSignatureCheck) {
    console.warn(
      "\n" +
        "  ############################################################\n" +
        "  #  INSEGURO: validación de firma del webhook DESACTIVADA   #\n" +
        "  ############################################################\n" +
        "  WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK=true — /webhook acepta\n" +
        "  CUALQUIER POST, venga de Meta o de quien sea que conozca la URL.\n" +
        "  Es una escotilla TEMPORAL para probar contra un reenviador que no\n" +
        "  puede firmar como Meta. Apagala apenas termine la prueba y\n" +
        "  reemplazala por un secreto compartido con el proveedor\n" +
        "  (riesgo abierto en docs/TASKS.md).\n"
    );
  } else if (!config.whatsapp.appSecret) {
    console.warn(
      "\n" +
        "  ############################################################\n" +
        "  #  INSEGURO: WHATSAPP_APP_SECRET vacío                     #\n" +
        "  ############################################################\n" +
        "  Sin App Secret no hay nada contra qué validar la firma, así que\n" +
        "  /webhook acepta cualquier POST igual que si el flag estuviera\n" +
        "  prendido. Cargá WHATSAPP_APP_SECRET en .env.\n"
    );
  }

  const httpServer = createServer(listener);
  httpServer.listen(config.port, () => {
    console.log(`orchestrator escuchando en :${config.port}`);
  });

  const scheduler = new Scheduler({ intervalMs: config.schedulerIntervalMs });
  if (sender) {
    scheduler.register(
      createReminderJob({
        catalog,
        appointmentStore,
        auditLog,
        tokko,
        weather,
        sender,
        defaultLat: config.defaultLat,
        defaultLng: config.defaultLng,
      })
    );
    scheduler.register(
      createRecontactJob({
        catalog,
        tokko,
        composer,
        sender,
        recontactStateStore,
        auditLog,
        brokerNotifier,
      })
    );
    scheduler.register(
      createSeguimientoPostVisitaJob({
        catalog,
        appointmentStore,
        auditLog,
        tokko,
        sender,
      })
    );
  } else {
    console.warn(
      "Jobs de mensajería (recordatorios, recontacto, seguimiento) sin registrar: no hay WhatsAppSender configurado."
    );
  }

  // El purgado por retención va fuera del `if (sender)`: no manda mensajes, y
  // es una obligación de la política de privacidad publicada — tiene que
  // correr aunque WhatsApp no esté configurado (docs/TASKS.md Bloque 15).
  scheduler.register(
    createRetentionJob({
      auditLog,
      conversationStateStore,
      appointmentStore,
      recontactStateStore,
      lastInteractionStore,
      reportStore: new FileRetentionReportStore(config.retentionReportPath),
      mesesMensajes: config.retention.mesesMensajes,
      mesesGestionComercial: config.retention.mesesGestionComercial,
      borradoHabilitado: config.retention.borradoHabilitado,
    })
  );
  if (!config.retention.borradoHabilitado) {
    console.warn(
      `Retención en modo SIMULACRO: reporta qué borraría pero no borra nada. ` +
        `Revisá ${config.retentionReportPath} y poné RETENTION_BORRADO_HABILITADO=true para activarlo.`
    );
  }

  scheduler.start();

  const shutdown = async () => {
    httpServer.close();
    scheduler.stop();
    await Promise.all([tokko.close(), gcal.close(), weather.close()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("orchestrator no pudo iniciar:", error);
  process.exit(1);
});
