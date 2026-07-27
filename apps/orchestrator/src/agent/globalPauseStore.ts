import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

/**
 * Flag global de "el agente no responde a ningún cliente" (docs/TASKS.md
 * Bloque 9, `broker_pausar_agente` con `alcance: global`). Separado de
 * `ConversationState.pausedByBroker` (que es por conversación puntual)
 * porque no hay una única conversación dueña de este estado.
 */
export interface GlobalPauseStore {
  isPaused(): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
}

export class InMemoryGlobalPauseStore implements GlobalPauseStore {
  private paused = false;

  async isPaused(): Promise<boolean> {
    return this.paused;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
  }
}

// TODO(fase 2+): migrar a Postgres cuando haga falta concurrencia real entre
// procesos (mismo caveat que AppointmentStore/ConversationStateStore).
export class FileGlobalPauseStore implements GlobalPauseStore {
  constructor(private readonly filePath: string) {}

  async isPaused(): Promise<boolean> {
    const data = await readJsonFile<{ paused: boolean }>(this.filePath, { paused: false });
    return data.paused;
  }

  async setPaused(paused: boolean): Promise<void> {
    await writeJsonFile(this.filePath, { paused });
  }
}
