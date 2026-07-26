import { createServer } from "node:http";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfigFromEnv, REPO_ROOT } from "./config.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { ClaudeIntentClassifier } from "./agent/classifier.js";
import { ClaudeResponseComposer } from "./agent/composer.js";
import { ClaudeDraftReplyComposer } from "./agent/draftComposer.js";
import { WhatsAppBrokerNotifier } from "./agent/brokerNotifier.js";
import { FileAuditLogStore } from "./agent/auditLog.js";
import { TokkoMcpClient } from "./mcp/tokkoMcpClient.js";
import { GraphApiWhatsAppSender } from "./channels/whatsapp/sender.js";
import { createRequestListener } from "./app.js";

// Ruta absoluta al `.env` de la raíz del repo: `npm run dev --workspace=...`
// (y por lo tanto `npm run dev:orchestrator` desde la raíz) corre este
// script con cwd = apps/orchestrator, no la raíz. Un `dotenv.config()` sin
// path buscaría apps/orchestrator/.env y nunca encontraría el de la raíz.
loadDotenv({ path: path.join(REPO_ROOT, ".env") });

async function main() {
  const config = loadConfigFromEnv();

  if (!config.anthropicApiKey) {
    throw new Error(
      "Falta ANTHROPIC_API_KEY en el entorno. Copiá .env.example a .env y completá la clave (ver CLAUDE.md secc. 3)."
    );
  }

  const catalog = loadCatalog(config.intentCatalogPath);
  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  const tokko = new TokkoMcpClient({
    entryPath: config.mcpTokko.entryPath,
    cwd: config.mcpTokko.cwd,
  });
  await tokko.connect();

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

  const listener = createRequestListener({
    catalog,
    classifier: new ClaudeIntentClassifier(anthropic),
    composer: new ClaudeResponseComposer(anthropic),
    draftComposer: new ClaudeDraftReplyComposer(anthropic),
    auditLog: new FileAuditLogStore(config.auditLogPath),
    tokko,
    sender,
    brokerNotifier,
    whatsappWebhookVerifyToken: config.whatsapp.webhookVerifyToken,
    whatsappAppSecret: config.whatsapp.appSecret,
  });

  const httpServer = createServer(listener);
  httpServer.listen(config.port, () => {
    console.log(`orchestrator escuchando en :${config.port}`);
  });

  const shutdown = async () => {
    httpServer.close();
    await tokko.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("orchestrator no pudo iniciar:", error);
  process.exit(1);
});
