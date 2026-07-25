export interface GcalConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
}

const REQUIRED_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_CALENDAR_ID",
] as const;

/** Lee las credenciales OAuth y el calendario dedicado del entorno (ver .env.example). */
export function loadGcalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GcalConfig {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno para Google Calendar: ${missing.join(", ")} (ver .env.example).`
    );
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID as string,
    clientSecret: env.GOOGLE_CLIENT_SECRET as string,
    refreshToken: env.GOOGLE_REFRESH_TOKEN as string,
    calendarId: env.GOOGLE_CALENDAR_ID as string,
  };
}
