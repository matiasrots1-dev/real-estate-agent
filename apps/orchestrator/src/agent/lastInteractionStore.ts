import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import { enmascararTelefono, type PurgeResult, type PurgeableStore, MUESTRA_MAX } from "./purge.js";

/**
 * Última interacción conocida de cada lead (docs/TASKS.md Bloque 15).
 *
 * Existe para romper una circularidad: la política retiene los datos de
 * gestión comercial (visitas, recontactos) mientras dure la relación
 * comercial — operacionalizado como "24 meses desde la última interacción
 * del lead" — pero el `audit_log`, que es de donde saldría naturalmente esa
 * fecha, se purga a los 12 meses. Calcularla desde el audit funcionaría
 * dentro de una corrida y se rompería entre corridas: a partir del mes 13 el
 * audit ya no alcanza para distinguir "no interactuó nunca" de "interactuó
 * antes de lo que recuerdo", y appointments no se purgaría jamás.
 *
 * Guardarla como dato propio desacopla los dos plazos: el audit puede irse a
 * los 12 meses sin llevarse la señal que necesita el corte de 24.
 *
 * Este store también tiene datos personales (el teléfono es la clave), así
 * que se purga a sí mismo con el mismo corte de 24 meses.
 */
export interface LastInteractionStore extends PurgeableStore {
  /** Idempotente y monótono: solo avanza hacia adelante, nunca retrocede la fecha. */
  record(leadId: string, at: Date): Promise<void>;
  get(leadId: string): Promise<string | null>;
  all(): Promise<Record<string, string>>;
}

const STORE_NAME = "last_interaction";

function purgar(
  todos: Record<string, string>,
  cutoff: Date,
  dryRun: boolean
): { result: PurgeResult; restantes: Record<string, string> } {
  const corte = cutoff.getTime();
  const restantes: Record<string, string> = {};
  const muestra = [];
  let borrados = 0;

  for (const [leadId, fecha] of Object.entries(todos)) {
    // Comparar instantes, no strings: los ISO pueden venir con offsets
    // distintos y la comparación lexicográfica da resultados incorrectos
    // (mismo bug que se corrigió en appointmentStore, Bloque 14).
    if (new Date(fecha).getTime() < corte) {
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({ store: STORE_NAME, id: enmascararTelefono(leadId), fecha, lead: enmascararTelefono(leadId) });
      }
    } else {
      restantes[leadId] = fecha;
    }
  }

  return { result: { borrados, muestra }, restantes: dryRun ? todos : restantes };
}

export class InMemoryLastInteractionStore implements LastInteractionStore {
  private readonly fechas = new Map<string, string>();

  async record(leadId: string, at: Date): Promise<void> {
    const previa = this.fechas.get(leadId);
    if (previa && new Date(previa).getTime() >= at.getTime()) return;
    this.fechas.set(leadId, at.toISOString());
  }

  async get(leadId: string): Promise<string | null> {
    return this.fechas.get(leadId) ?? null;
  }

  async all(): Promise<Record<string, string>> {
    return Object.fromEntries(this.fechas);
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, restantes } = purgar(Object.fromEntries(this.fechas), cutoff, dryRun);
    if (!dryRun) {
      this.fechas.clear();
      for (const [k, v] of Object.entries(restantes)) this.fechas.set(k, v);
    }
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres cuando haga falta concurrencia real entre
// procesos (mismo caveat que el resto de los stores de archivo).
export class FileLastInteractionStore implements LastInteractionStore {
  constructor(private readonly filePath: string) {}

  private readAll(): Promise<Record<string, string>> {
    return readJsonFile(this.filePath, {});
  }

  async record(leadId: string, at: Date): Promise<void> {
    const todos = await this.readAll();
    const previa = todos[leadId];
    if (previa && new Date(previa).getTime() >= at.getTime()) return;
    todos[leadId] = at.toISOString();
    await writeJsonFile(this.filePath, todos);
  }

  async get(leadId: string): Promise<string | null> {
    return (await this.readAll())[leadId] ?? null;
  }

  async all(): Promise<Record<string, string>> {
    return this.readAll();
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, restantes } = purgar(await this.readAll(), cutoff, dryRun);
    if (!dryRun) await writeJsonFile(this.filePath, restantes);
    return result;
  }
}
