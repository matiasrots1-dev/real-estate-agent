import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import type { PurgeResult } from "./purge.js";
import { enmascararTelefono } from "./purge.js";

/**
 * Dónde queda guardado el `wa_id` que devuelve Meta.
 *
 * Cuando mandamos un mensaje, la respuesta de `POST /messages` trae
 * `contacts[].wa_id`: **el id canónico según Meta**. Puede diferir de lo que
 * mandamos (Meta resuelve `54111155559999` y `5491155559999` a la misma
 * cuenta, verificado en vivo — docs/TASKS.md Bloque 6).
 *
 * Guardarlo hace que la normalización deje de depender de que acertemos las
 * reglas de Argentina: la primera vez normalizamos con libphonenumber, y a
 * partir de ahí usamos lo que Meta confirmó. No se recalcula en cada corrida.
 *
 * **La clave es el número al que efectivamente se envió**, en E.164 sin `+`.
 * Nunca el nombre ni el id de lead: una colisión de clave acá mandaría el
 * mensaje de un cliente a otro, y eso no se deshace.
 */
export interface TelefonoCanonico {
  /** Lo que mandamos a la Graph API. Es la clave. */
  enviadoA: string;
  /** Lo que Meta respondió como `wa_id`. */
  waId: string;
  /** Cuándo lo confirmó Meta. */
  confirmadoAt: string;
}

export interface TelefonoCanonicoStore {
  /** El canónico confirmado por Meta para este número, si lo hay. */
  get(enviadoA: string): Promise<string | null>;
  /** Registra lo que Meta respondió. Idempotente. */
  registrar(enviadoA: string, waId: string, cuando?: Date): Promise<void>;
  all(): Promise<TelefonoCanonico[]>;
  /**
   * Este store guarda teléfonos, o sea datos personales. Nace implementando el
   * purgado desde el día uno, para no crear una base de datos de contactos
   * fuera de la política de retención (docs/TASKS.md Bloque 15).
   */
  purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult>;
}

type Mapa = Record<string, TelefonoCanonico>;

function purgar(todo: Mapa, cutoff: Date, dryRun: boolean): { result: PurgeResult; sobreviven: Mapa } {
  const sobreviven: Mapa = {};
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const [clave, registro] of Object.entries(todo)) {
    if (new Date(registro.confirmadoAt).getTime() < cutoff.getTime()) {
      borrados += 1;
      if (muestra.length < 20) {
        // Enmascarado: el reporte de purgado no puede ser, él mismo, un
        // listado de teléfonos.
        muestra.push({ store: "telefonos_canonicos", id: enmascararTelefono(clave), fecha: registro.confirmadoAt });
      }
    } else {
      sobreviven[clave] = registro;
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

export class InMemoryTelefonoCanonicoStore implements TelefonoCanonicoStore {
  private readonly datos: Mapa = {};

  async get(enviadoA: string): Promise<string | null> {
    return this.datos[enviadoA]?.waId ?? null;
  }

  async registrar(enviadoA: string, waId: string, cuando: Date = new Date()): Promise<void> {
    this.datos[enviadoA] = { enviadoA, waId, confirmadoAt: cuando.toISOString() };
  }

  async all(): Promise<TelefonoCanonico[]> {
    return Object.values(this.datos);
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = purgar(this.datos, cutoff, dryRun);
    if (!dryRun) {
      for (const k of Object.keys(this.datos)) delete this.datos[k];
      Object.assign(this.datos, sobreviven);
    }
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileTelefonoCanonicoStore implements TelefonoCanonicoStore {
  constructor(private readonly filePath: string) {}

  async get(enviadoA: string): Promise<string | null> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    return todo[enviadoA]?.waId ?? null;
  }

  async registrar(enviadoA: string, waId: string, cuando: Date = new Date()): Promise<void> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    todo[enviadoA] = { enviadoA, waId, confirmadoAt: cuando.toISOString() };
    await writeJsonFile(this.filePath, todo);
  }

  async all(): Promise<TelefonoCanonico[]> {
    return Object.values(await readJsonFile<Mapa>(this.filePath, {}));
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    const { result, sobreviven } = purgar(todo, cutoff, dryRun);
    if (!dryRun && result.borrados > 0) await writeJsonFile(this.filePath, sobreviven);
    return result;
  }
}
