/**
 * El número de la línea de WhatsApp Business del bot, según Meta.
 *
 * No está en el `.env`: lo que hay ahí es el `phone_number_id`, que es otra
 * cosa. Y la autoridad sobre cuál es el número es Meta, no una variable que
 * alguien copió a mano (docs/TASKS.md Bloque 27).
 */
export async function consultarLineaDelBot(args: {
  phoneNumberId: string;
  accessToken: string;
  graphVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const hacerFetch = args.fetchImpl ?? fetch;
  const version = args.graphVersion ?? "v21.0";
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), args.timeoutMs ?? 10_000);
  try {
    const res = await hacerFetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(args.phoneNumberId)}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${args.accessToken}` }, signal: control.signal }
    );
    if (!res.ok) throw new Error(`Meta respondió HTTP ${res.status}`);
    const json = (await res.json()) as { display_phone_number?: string };
    return json.display_phone_number || undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/** `undefined` si faltan credenciales: el llamador lo cuenta como fuente faltante. */
export function lineaDelBotSiHayCredenciales(
  phoneNumberId: string | undefined,
  accessToken: string | undefined
): (() => Promise<string | undefined>) | undefined {
  if (!phoneNumberId || !accessToken) return undefined;
  return () => consultarLineaDelBot({ phoneNumberId, accessToken });
}
