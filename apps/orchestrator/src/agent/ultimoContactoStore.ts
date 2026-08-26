import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableByLeadStore } from "./purge.js";

/**
 * Cuándo se contactó por última vez a cada lead, **venga el contacto del
 * sistema o del broker a mano desde su celular**.
 *
 * El caso que motivó esto: Tokko no tiene fecha de última actividad (sólo
 * `created_at`), así que si el broker le escribe a alguien desde el teléfono,
 * el sistema no se entera y puede recontactarlo igual. Mandarle "hace tiempo
 * que no sabemos de vos" a alguien con quien habló ayer es peor que no
 * escribirle nunca.
 *
 * La señal del contacto manual llega por el eco de coexistencia
 * (`smb_message_echoes`), que trae `to` y `timestamp`. **El eco es
 * best-effort: Meta no lo reintenta**, así que esto reduce el agujero pero no
 * lo cierra. Por eso el reporte del simulacro, con nombres, sigue siendo la
 * defensa principal.
 *
 * Sólo se registra si el destinatario **coincide con un lead conocido**
 * (decisión del dueño del repo). Registrar todos los ecos habría creado una
 * base de "a quién le escribió el broker" que incluye su vida privada — la
 * misma clase de dato que se borró a mano en agosto de 2026.
 */
export interface UltimoContacto {
  leadId: string;
  /** ISO. La última, sin importar el origen. */
  contactadoAt: string;
  origen: "sistema" | "manual";
}

export interface UltimoContactoStore extends PurgeableByLeadStore {
  get(leadId: string): Promise<UltimoContacto | null>;
  /** Monótono: nunca retrocede la fecha. */
  registrar(leadId: string, cuando: Date, origen: UltimoContacto["origen"]): Promise<void>;
  all(): Promise<UltimoContacto[]>;
}

type Mapa = Record<string, UltimoContacto>;

function aplicar(todo: Mapa, leadId: string, cuando: Date, origen: UltimoContacto["origen"]): Mapa {
  const previo = todo[leadId];
  // Monótono a propósito: un eco que llega tarde o desordenado no puede
  // "rejuvenecer" el registro y habilitar un recontacto que no corresponde.
  if (previo && new Date(previo.contactadoAt).getTime() >= cuando.getTime()) return todo;
  return { ...todo, [leadId]: { leadId, contactadoAt: cuando.toISOString(), origen } };
}

function purgar(todo: Mapa, leadIds: ReadonlySet<string>, cutoff: Date, dryRun: boolean) {
  const vencidos = leadIds;
  const sobreviven: Mapa = {};
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const [leadId, registro] of Object.entries(todo)) {
    const vencido = vencidos.has(leadId) && new Date(registro.contactadoAt).getTime() < cutoff.getTime();
    if (vencido) {
      borrados += 1;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({
          store: "ultimo_contacto",
          id: leadId,
          fecha: registro.contactadoAt,
          lead: enmascararTelefono(leadId),
        });
      }
    } else {
      sobreviven[leadId] = registro;
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

export class InMemoryUltimoContactoStore implements UltimoContactoStore {
  private datos: Mapa = {};

  async get(leadId: string): Promise<UltimoContacto | null> {
    return this.datos[leadId] ?? null;
  }

  async registrar(leadId: string, cuando: Date, origen: UltimoContacto["origen"]): Promise<void> {
    this.datos = aplicar(this.datos, leadId, cuando, origen);
  }

  async all(): Promise<UltimoContacto[]> {
    return Object.values(this.datos);
  }

  async purgeLeads(leadIds: ReadonlySet<string>, cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = purgar(this.datos, leadIds, cutoff, dryRun);
    if (!dryRun) this.datos = sobreviven;
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileUltimoContactoStore implements UltimoContactoStore {
  constructor(private readonly filePath: string) {}

  async get(leadId: string): Promise<UltimoContacto | null> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    return todo[leadId] ?? null;
  }

  async registrar(leadId: string, cuando: Date, origen: UltimoContacto["origen"]): Promise<void> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    const nuevo = aplicar(todo, leadId, cuando, origen);
    if (nuevo !== todo) await writeJsonFile(this.filePath, nuevo);
  }

  async all(): Promise<UltimoContacto[]> {
    return Object.values(await readJsonFile<Mapa>(this.filePath, {}));
  }

  async purgeLeads(leadIds: ReadonlySet<string>, cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const todo = await readJsonFile<Mapa>(this.filePath, {});
    const { result, sobreviven } = purgar(todo, leadIds, cutoff, dryRun);
    if (!dryRun && result.borrados > 0) await writeJsonFile(this.filePath, sobreviven);
    return result;
  }
}
