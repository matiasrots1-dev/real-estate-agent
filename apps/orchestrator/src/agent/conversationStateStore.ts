import type { ConversationState } from "shared-types";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";
import { enmascararTelefono, MUESTRA_MAX, type PurgeResult, type PurgeableStore } from "./purge.js";

export interface ConversationStateStore extends PurgeableStore {
  get(conversationId: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
}

const STORE_NAME = "conversations";

function particionar(todos: Record<string, ConversationState>, cutoff: Date) {
  const corte = cutoff.getTime();
  const sobreviven: Record<string, ConversationState> = {};
  const muestra: PurgeResult["muestra"] = [];
  let borrados = 0;

  for (const [id, state] of Object.entries(todos)) {
    if (new Date(state.updatedAt).getTime() < corte) {
      borrados++;
      if (muestra.length < MUESTRA_MAX) {
        muestra.push({ store: STORE_NAME, id: enmascararTelefono(id), fecha: state.updatedAt, lead: enmascararTelefono(id) });
      }
    } else {
      sobreviven[id] = state;
    }
  }

  return { result: { borrados, muestra }, sobreviven };
}

export function idleState(conversationId: string, phoneNumber: string): ConversationState {
  return {
    conversationId,
    channel: "cliente",
    phoneNumber,
    step: "idle",
    pausedByBroker: false,
    context: {},
    updatedAt: new Date().toISOString(),
  };
}

export class InMemoryConversationStateStore implements ConversationStateStore {
  private readonly states = new Map<string, ConversationState>();

  async get(conversationId: string): Promise<ConversationState | null> {
    return this.states.get(conversationId) ?? null;
  }

  async save(state: ConversationState): Promise<void> {
    this.states.set(state.conversationId, state);
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const { result, sobreviven } = particionar(Object.fromEntries(this.states), cutoff);
    if (!dryRun) {
      this.states.clear();
      for (const [k, v] of Object.entries(sobreviven)) this.states.set(k, v);
    }
    return result;
  }
}

// TODO(fase 2+): migrar a Postgres cuando haga falta concurrencia real
// entre procesos (mismo caveat que FileAppointmentStore).
export class FileConversationStateStore implements ConversationStateStore {
  constructor(private readonly filePath: string) {}

  async get(conversationId: string): Promise<ConversationState | null> {
    const all = await readJsonFile<Record<string, ConversationState>>(this.filePath, {});
    return all[conversationId] ?? null;
  }

  async save(state: ConversationState): Promise<void> {
    const all = await readJsonFile<Record<string, ConversationState>>(this.filePath, {});
    all[state.conversationId] = state;
    await writeJsonFile(this.filePath, all);
  }

  async purgeOlderThan(cutoff: Date, dryRun: boolean): Promise<PurgeResult> {
    const all = await readJsonFile<Record<string, ConversationState>>(this.filePath, {});
    const { result, sobreviven } = particionar(all, cutoff);
    if (!dryRun && result.borrados > 0) await writeJsonFile(this.filePath, sobreviven);
    return result;
  }
}
