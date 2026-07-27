import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

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
}

export interface RecontactStateStore {
  get(leadId: string): Promise<RecontactState | null>;
  save(state: RecontactState): Promise<void>;
}

export class InMemoryRecontactStateStore implements RecontactStateStore {
  private readonly states = new Map<string, RecontactState>();

  async get(leadId: string): Promise<RecontactState | null> {
    return this.states.get(leadId) ?? null;
  }

  async save(state: RecontactState): Promise<void> {
    this.states.set(state.leadId, state);
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
    all[state.leadId] = state;
    await writeJsonFile(this.filePath, all);
  }
}
