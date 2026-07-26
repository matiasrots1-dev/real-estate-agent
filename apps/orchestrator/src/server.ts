import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfigFromEnv } from "./config.js";
import { loadCatalog } from "./agent/intentCatalog.js";
import { ClaudeIntentClassifier } from "./agent/classifier.js";
import { ClaudeResponseComposer } from "./agent/composer.js";
import { FileAuditLogStore } from "./agent/auditLog.js";
import { TokkoMcpClient } from "./mcp/tokkoMcpClient.js";
import { GraphApiWhatsAppSender } from "./channels/whatsapp/sender.js";
import { createRequestListener } from "./app.js";

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

  const listener = createRequestListener({
    catalog,
    classifier: new ClaudeIntentClassifier(anthropic),
    composer: new ClaudeResponseComposer(anthropic),
    auditLog: new FileAuditLogStore(config.auditLogPath),
    tokko,
    sender,
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
