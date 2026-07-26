import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/orchestrator/src -> repo root
export const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface OrchestratorConfig {
  port: number;
  intentCatalogPath: string;
  defaultConfidenceThreshold: number;
  auditLogPath: string;
  anthropicApiKey?: string;
  whatsapp: {
    webhookVerifyToken?: string;
    appSecret?: string;
    accessToken?: string;
    phoneNumberId?: string;
    brokerWhatsappNumber?: string;
  };
  mcpTokko: {
    entryPath: string;
    cwd: string;
  };
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  return {
    port: env.PORT ? Number(env.PORT) : 3000,
    intentCatalogPath: env.INTENT_CATALOG_PATH ?? path.join(REPO_ROOT, "docs/intent_catalog.yaml"),
    defaultConfidenceThreshold: env.DEFAULT_CONFIDENCE_THRESHOLD
      ? Number(env.DEFAULT_CONFIDENCE_THRESHOLD)
      : 0.75,
    // TODO(Bloque 4+): migrar a Postgres (ver docker-compose.yml) cuando haya
    // Docker disponible y/o se necesite concurrencia real entre procesos.
    auditLogPath: env.AUDIT_LOG_PATH ?? path.join(REPO_ROOT, "apps/orchestrator/data/audit_log.jsonl"),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    whatsapp: {
      webhookVerifyToken: env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      brokerWhatsappNumber: env.BROKER_WHATSAPP_NUMBER,
    },
    mcpTokko: {
      entryPath:
        env.MCP_TOKKO_ENTRY_PATH ?? path.join(REPO_ROOT, "mcp-servers/mcp-tokko/src/index.ts"),
      cwd: path.join(REPO_ROOT, "mcp-servers/mcp-tokko"),
    },
  };
}
