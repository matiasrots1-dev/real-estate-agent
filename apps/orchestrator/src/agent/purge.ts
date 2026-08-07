// Tipos compartidos del purgado por retención (docs/TASKS.md Bloque 15).
// Cada store que guarda datos personales implementa `purgeOlderThan`, y
// `jobs/retention.ts` los coordina para que el corte se aplique parejo en
// todos — purgar uno solo dejaría el mismo teléfono vivo en los otros y la
// política seguiría incumplida, con apariencia de resuelta.

/**
 * Un registro que fue (o sería) borrado. Lo consume el reporte del job para
 * que el dueño del repo pueda juzgar si el criterio está bien aplicado.
 *
 * **No lleva contenido de mensajes a propósito**: el reporte se persiste
 * para comparar corridas, así que si guardara el texto se convertiría en un
 * archivo lleno de exactamente los datos personales que este bloque existe
 * para borrar. Con la fecha que motivó la decisión y el registro
 * identificado alcanza para auditar el criterio.
 */
export interface PurgedRecord {
  store: string;
  id: string;
  /** La fecha que motivó la decisión (ISO) — es lo que hay que mirar para juzgar el corte. */
  fecha: string;
  /** Teléfono enmascarado, para poder rastrear un caso sin exponer el número. */
  lead?: string;
}

export interface PurgeResult {
  borrados: number;
  /** Muestra acotada (no todos), para que el reporte no crezca sin límite. */
  muestra: PurgedRecord[];
}

export const MUESTRA_MAX = 20;

export interface PurgeableStore {
  /**
   * Borra lo anterior a `cutoff`. Con `dryRun: true` calcula y reporta sin
   * borrar nada — es el modo por default del job (ver `jobs/retention.ts`):
   * el borrado es irreversible y no hay backup de los JSON.
   */
  purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult>;
}

/**
 * Stores de gestión comercial (visitas, recontactos). No se purgan por su
 * propia antigüedad sino por la del **lead**: la política los retiene
 * "mientras dure la relación comercial", operacionalizado como 24 meses
 * desde la última interacción de esa persona. El coordinador
 * (`jobs/retention.ts`) calcula qué leads vencieron y pasa el conjunto.
 */
export interface PurgeableByLeadStore {
  purgeLeads(leadIds: ReadonlySet<string>, cutoff: Date, dryRun: boolean): Promise<PurgeResult>;
}

/** `5491155559999` -> `549•••9999`. Suficiente para rastrear un caso sin exponer el número. */
export function enmascararTelefono(telefono: string): string {
  if (telefono.length <= 7) return "•••";
  return `${telefono.slice(0, 3)}•••${telefono.slice(-4)}`;
}

export function vacio(): PurgeResult {
  return { borrados: 0, muestra: [] };
}

/** Suma resultados de varios stores en uno solo, recortando la muestra. */
export function combinar(resultados: PurgeResult[]): PurgeResult {
  return {
    borrados: resultados.reduce((total, r) => total + r.borrados, 0),
    muestra: resultados.flatMap((r) => r.muestra).slice(0, MUESTRA_MAX),
  };
}
