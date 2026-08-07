import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableByLeadStore } from "./purge.js";

/**
 * A diferencia de `Appointment.remindersSent` (que vive en el propio
 * Appointment porque es de nuestro dominio), no metemos este tracking en
 * `Lead` — `Lead` espeja lo que Tokko devuelve, y cuáles intentos de
 * recontacto ya mandamos es contabilidad interna nuestra, no un dato de
 * Tokko. Por eso un store separado, mismo patrón que AppointmentStore/
 * ConversationStateStore.
 */
export interface RecontactState {
  leadId: string;
  /** Las `condition` de docs/intent_catalog.yaml ya disparadas para este lead, ej. ["dias_sin_respuesta >= 5"]. */
  attemptsSent: string[];
  /**
   * Agregado en el Bloque 15: sin esto no había NINGÚN campo de fecha acá,
   * así que era imposible saber si un registro tenía 3 días o 3 años y la
   * retención por tiempo no se podía implementar. Opcional porque los
   * registros que ya existen en disco no lo tienen — esos se purgan por el
   * lead (ver `purgeLeads`) y se auto-reparan en el próximo `save()`.
   */
  updatedAt?: string;
}

export interface RecontactStateStore extends PurgeableByLeadStore {
  get(leadId: string): Promise<RecontactState | null>;
  save(state: RecontactState): Promise<void>;
  /**
   * Última actividad de recontacto por lead. La usa `jobs/retention.ts` como
   * señal de último recurso para fechar a un lead que solo aparece acá — sin
   * esto, un registro huérfano (sin interacciones ni visitas) no tendría
   * ninguna fecha asociada y no se purgaría nunca.
   *
   * Se aporta al cálculo de "última interacción efectiva", que toma el
   * **máximo** de todas las señales. Así un recontacto viejo nunca acorta la
   * retención de un lead que volvió hace poco: la decisión sigue siendo por
   * vencimiento del lead, no por antigüedad de este registro.
   */
  ultimaActividadPorLead(): Promise<Record<string, string>>;
}

const STORE_NAME = "recontacts";

function particionar(todos: Record<string, RecontactState>, leadIds: ReadonlySet<string>) {
  const sobreviven: Record<string, RecontactState> = {};
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const [leadId, state] of Object.entries(todos)) {
    if (leadIds.has(leadId)) {
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({
          store: STORE_NAME,
          id: enmascararTelefono(leadId),
          fecha: state.updatedAt ?? "(sin updatedAt — purgado por vencimiento del lead)",
          lead: enmascararTelefono(leadId),
        });
      }
    } else {
      sobreviven[leadId] = state;
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

export class InMemoryRecontactStateStore implements RecontactStateStore {
  private readonly states = new Map<string, RecontactState>();

  async get(leadId: string): Promise<RecontactState | null> {
    return this.states.get(leadId) ?? null;
  }

  async save(state: RecontactState): Promise<void> {
    this.states.set(state.leadId, { ...state, updatedAt: state.updatedAt ?? new Date().toISOString() });
  }

  async ultimaActividadPorLead(): Promise<Record<string, string>> {
    const porLead: Record<string, string> = {};
    for (const [leadId, state] of this.states) if (state.updatedAt) porLead[leadId] = state.updatedAt;
    return porLead;
  }

  async purgeLeads(leadIds: ReadonlySet<string>, _cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar(Object.fromEntries(this.states), leadIds);
    if (!dryRun) {
      this.states.clear();
      for (const [k, v] of Object.entries(sobreviven)) this.states.set(k, v);
    }
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres cuando haga falta concurrencia real
// entre procesos (mismo caveat que AppointmentStore/ConversationStateStore).
export class FileRecontactStateStore implements RecontactStateStore {
  constructor(private readonly filePath: string) {}

  async get(leadId: string): Promise<RecontactState | null> {
    const all = await readJsonFile<Record<string, RecontactState>>(this.filePath, {});
    return all[leadId] ?? null;
  }

  async save(state: RecontactState): Promise<void> {
    const all = await readJsonFile<Record<string, RecontactState>>(this.filePath, {});
    all[state.leadId] = { ...state, updatedAt: state.updatedAt ?? new Date().toISOString() };
    await writeJsonFile(this.filePath, all);
  }

  async ultimaActividadPorLead(): Promise<Record<string, string>> {
    const all = await readJsonFile<Record<string, RecontactState>>(this.filePath, {});
    const porLead: Record<string, string> = {};
    for (const [leadId, state] of Object.entries(all)) if (state.updatedAt) porLead[leadId] = state.updatedAt;
    return porLead;
  }

  async purgeLeads(leadIds: ReadonlySet<string>, _cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const all = await readJsonFile<Record<string, RecontactState>>(this.filePath, {});
    const { result, sobreviven } = particionar(all, leadIds);
    if (!dryRun && result.borrados > 0) await writeJsonFile(this.filePath, sobreviven);
    return result;
  }
}
