import { z } from "zod";

/**
 * Extrae de un eco de coexistencia a quién le escribió el broker y cuándo.
 *
 * El eco (`smb_message_echoes`) sólo se dispara para mensajes mandados desde
 * la app de WhatsApp Business o un dispositivo vinculado — **no** para los que
 * manda la Cloud API. O sea que es exactamente la señal "el broker escribió a
 * mano", sin duplicar lo que manda el agente.
 *
 * Se sigue **sin procesar como mensaje entrante**: de acá sólo salen un
 * teléfono y una fecha. El canal broker no se toca.
 */

const EcoSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string().optional(),
          value: z
            .object({
              message_echoes: z
                .array(
                  z
                    .object({
                      to: z.string().optional(),
                      timestamp: z.union([z.string(), z.number()]).optional(),
                      type: z.string().optional(),
                      text: z.object({ body: z.string().optional() }).passthrough().optional(),
                    })
                    .passthrough()
                )
                .optional(),
            })
            .passthrough()
            .optional(),
        })
      ).optional(),
    })
  ).optional(),
});

export interface ContactoSaliente {
  /** Teléfono del destinatario, tal como lo manda Meta (E.164 sin `+`). */
  telefono: string;
  cuando: Date;
  /**
   * Lo que escribió el broker. **Se devuelve pero NO se guarda en crudo**: el
   * llamador lo anonimiza antes de persistirlo (ver estiloBrokerStore.ts).
   * Ausente para tipos sin texto (revoke, imagen).
   */
  texto?: string;
}

/**
 * Devuelve un contacto por cada destinatario del eco.
 *
 * Incluye el texto **para que el llamador lo anonimice**, no para guardarlo:
 * el corpus de estilo persiste sólo la versión sin identificadores, y el
 * registro de último contacto no guarda texto en absoluto. Persistir esto en
 * crudo sería armar un archivo de conversaciones privadas.
 */
export function extraerContactosSalientes(rawBody: unknown): ContactoSaliente[] {
  const parsed = EcoSchema.safeParse(rawBody);
  if (!parsed.success) return [];

  const salida: ContactoSaliente[] = [];

  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const eco of change.value?.message_echoes ?? []) {
        const telefono = String(eco.to ?? "").replace(/\D/g, "");
        if (!telefono) continue;

        // Un `revoke` significa que el broker BORRÓ el mensaje. Cuenta como
        // contacto igual: la persona ya lo vio o pudo verlo, y suprimir de más
        // es el lado seguro de este error.
        const segundos = Number(eco.timestamp);
        const cuando = Number.isFinite(segundos) && segundos > 0 ? new Date(segundos * 1000) : new Date();

        salida.push({ telefono, cuando, texto: eco.text?.body });
      }
    }
  }

  return salida;
}
