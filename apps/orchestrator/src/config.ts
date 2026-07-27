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
  mcpGcal: {
    entryPath: string;
    cwd: string;
  };
  mcpWeather: {
    entryPath: string;
    cwd: string;
  };
  appointmentStorePath: string;
  conversationStateStorePath: string;
  recontactStateStorePath: string;
  /**
   * Coordenadas por defecto para consulta_clima_visita cuando la propiedad
   * no tiene lat/lng cargados en Tokko. Centro de CABA — ajustar si el
   * mercado real del broker es otra zona. Nunca se inventa el pronóstico en
   * sí (eso lo devuelve weather.get_forecast), solo la ubicación a
   * consultar cuando no hay una más precisa.
   */
  defaultLat: number;
  defaultLng: number;
  /** Cada cuánto corre el scheduler de jobs (recordatorios, etc). Ver jobs/scheduler.ts. */
  schedulerIntervalMs: number;
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
    mcpGcal: {
      entryPath: env.MCP_GCAL_ENTRY_PATH ?? path.join(REPO_ROOT, "mcp-servers/mcp-gcal/src/index.ts"),
      cwd: path.join(REPO_ROOT, "mcp-servers/mcp-gcal"),
    },
    mcpWeather: {
      entryPath:
        env.MCP_WEATHER_ENTRY_PATH ?? path.join(REPO_ROOT, "mcp-servers/mcp-weather/src/index.ts"),
      cwd: path.join(REPO_ROOT, "mcp-servers/mcp-weather"),
    },
    appointmentStorePath:
      env.APPOINTMENT_STORE_PATH ?? path.join(REPO_ROOT, "apps/orchestrator/data/appointments.json"),
    conversationStateStorePath:
      env.CONVERSATION_STATE_STORE_PATH ??
      path.join(REPO_ROOT, "apps/orchestrator/data/conversations.json"),
    recontactStateStorePath:
      env.RECONTACT_STATE_STORE_PATH ?? path.join(REPO_ROOT, "apps/orchestrator/data/recontacts.json"),
    defaultLat: env.DEFAULT_LAT ? Number(env.DEFAULT_LAT) : -34.6037,
    defaultLng: env.DEFAULT_LNG ? Number(env.DEFAULT_LNG) : -58.3816,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS ? Number(env.SCHEDULER_INTERVAL_MS) : 5 * 60 * 1000,
  };
}
