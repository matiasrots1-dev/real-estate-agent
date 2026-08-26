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
    /**
     * Secreto compartido con el proveedor que reenvia los webhooks
     * (header `X-DoubleTick-Secret`). Convive con la HMAC de Meta: si el
     * header no viene, se valida la firma como siempre. Vacio = no
     * configurado, y el header se ignora.
     */
    providerSecret?: string;
    accessToken?: string;
    phoneNumberId?: string;
    brokerWhatsappNumber?: string;
    /**
     * TEMPORAL (docs/TASKS.md, riesgo abierto): acepta webhooks sin firma HMAC.
     * Default `false`. Existe sólo para poder probar contra un proveedor que
     * reenvía los webhooks de Meta desde su propia infraestructura y por lo
     * tanto no puede firmarlos con el App Secret. Hay que reemplazarlo por un
     * secreto compartido con el proveedor antes de operar en serio: mientras
     * esté prendido, el endpoint no puede distinguir a Meta de cualquiera que
     * conozca la URL.
     */
    skipWebhookSignatureCheck: boolean;
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
  globalPauseStorePath: string;
  lastInteractionStorePath: string;
  retentionReportPath: string;
  /** Donde se registra que el broker contacto a alguien a mano (eco de coexistencia). */
  ultimoContactoStorePath: string;
  /** Corpus de estilo del broker (texto ya anonimizado). */
  estiloBrokerStorePath: string;
  /**
   * Retención (docs/TASKS.md Bloque 15). **Estos valores tienen que coincidir
   * con la política de privacidad publicada de la app** — no son un ajuste
   * técnico, son un compromiso declarado públicamente. Si cambian acá, hay
   * que cambiar la política, y al revés.
   */
  retention: {
    /** Mensajes y logs (audit_log, conversaciones). */
    mesesMensajes: number;
    /** Gestión comercial (visitas, recontactos): meses desde la última interacción del lead. */
    mesesGestionComercial: number;
    /**
     * Default `false` a propósito: el purgado arranca en modo reporte. El
     * borrado es irreversible y no hay backup de los JSON, así que hay que
     * habilitarlo explícitamente después de revisar unos cuantos reportes.
     */
    borradoHabilitado: boolean;
  };
  /**
   * Coordenadas por defecto para consulta_clima_visita cuando la propiedad
   * no tiene lat/lng cargados en Tokko. Centro de CABA — ajustar si el
   * mercado real del broker es otra zona. Nunca se inventa el pronóstico en
   * sí (eso lo devuelve weather.get_forecast), solo la ubicación a
   * consultar cuando no hay una más precisa.
   */
  /**
   * Modo silencioso (docs/TASKS.md Bloque 21): el agente recibe, clasifica y
   * le manda el borrador al broker, pero **no le responde nada al cliente**.
   *
   * **Default `true`, a diferencia de todos los demás flags del proyecto.** Los
   * dos errores no son simétricos: silencioso cuando lo querías activo
   * significa que al broker le llegan los borradores y responde a mano —
   * molesto, y se nota en el acto. Activo cuando lo querías silencioso
   * significa mandarle mensajes de un bot a personas reales, y eso no se
   * deshace. Ya pasó una vez (2026-08-12). Se apaga sólo con el string exacto
   * `"false"`.
   */
  modoSilencioso: boolean;
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
      providerSecret: env.DOUBLETICK_WEBHOOK_SECRET,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      brokerWhatsappNumber: env.BROKER_WHATSAPP_NUMBER,
      // Comparación explícita contra "true": cualquier otra cosa (incluido
      // "1", "yes" o la variable vacía) deja la validación PRENDIDA. Para un
      // flag que apaga un control de seguridad, el default seguro tiene que
      // ganar ante cualquier valor ambiguo.
      skipWebhookSignatureCheck: env.WHATSAPP_WEBHOOK_SKIP_SIGNATURE_CHECK === "true",
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
    globalPauseStorePath:
      env.GLOBAL_PAUSE_STORE_PATH ?? path.join(REPO_ROOT, "apps/orchestrator/data/global_pause.json"),
    lastInteractionStorePath:
      env.LAST_INTERACTION_STORE_PATH ??
      path.join(REPO_ROOT, "apps/orchestrator/data/last_interaction.json"),
    estiloBrokerStorePath:
      env.ESTILO_BROKER_STORE_PATH ??
      path.join(REPO_ROOT, "apps/orchestrator/data/estilo_broker.jsonl"),
    ultimoContactoStorePath:
      env.ULTIMO_CONTACTO_STORE_PATH ??
      path.join(REPO_ROOT, "apps/orchestrator/data/ultimo_contacto.json"),
    retentionReportPath:
      env.RETENTION_REPORT_PATH ?? path.join(REPO_ROOT, "apps/orchestrator/data/retention_reports.jsonl"),
    retention: {
      mesesMensajes: env.RETENTION_MESES_MENSAJES ? Number(env.RETENTION_MESES_MENSAJES) : 12,
      mesesGestionComercial: env.RETENTION_MESES_GESTION_COMERCIAL
        ? Number(env.RETENTION_MESES_GESTION_COMERCIAL)
        : 24,
      borradoHabilitado: env.RETENTION_BORRADO_HABILITADO === "true",
    },
    // Invertido respecto de los demás flags a propósito: acá el valor seguro
    // es el `true`, así que cualquier cosa que no sea exactamente "false"
    // (incluido un typo, un "0" o la variable vacía) deja el modo PRENDIDO.
    modoSilencioso: env.AGENTE_MODO_SILENCIOSO !== "false",
    defaultLat: env.DEFAULT_LAT ? Number(env.DEFAULT_LAT) : -34.6037,
    defaultLng: env.DEFAULT_LNG ? Number(env.DEFAULT_LNG) : -58.3816,
    schedulerIntervalMs: env.SCHEDULER_INTERVAL_MS ? Number(env.SCHEDULER_INTERVAL_MS) : 5 * 60 * 1000,
  };
}
