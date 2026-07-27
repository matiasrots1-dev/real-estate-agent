import type { ConversationState } from "shared-types";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

export interface ConversationStateStore {
  get(conversationId: string): Promise<ConversationState | null>;
  save(state: ConversationState): Promise<void>;
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
}
