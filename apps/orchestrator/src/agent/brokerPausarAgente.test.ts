import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IntentCatalog } from "shared-types";
import { findIntent, loadCatalog } from "./intentCatalog.js";
import { InMemoryConversationStateStore, idleState } from "./conversationStateStore.js";
import { InMemoryGlobalPauseStore } from "./globalPauseStore.js";
import type { PausarAgenteAction, PausarAgenteActionClassifier } from "./pausarAgenteClassifier.js";
import { runBrokerPausarAgente } from "./brokerPausarAgente.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");
const catalog: IntentCatalog = loadCatalog(path.join(repoRoot, "docs/intent_catalog.yaml"));
const intent = findIntent(catalog, "broker_pausar_agente")!;

function stubActionClassifier(action: PausarAgenteAction): PausarAgenteActionClassifier {
  return { extractAction: vi.fn(async () => action) };
}

describe("runBrokerPausarAgente", () => {
  it("alcance global + pausar: prende el GlobalPauseStore y no toca ConversationStateStore", async () => {
    const globalPauseStore = new InMemoryGlobalPauseStore();
    const conversationStateStore = new InMemoryConversationStateStore();
    const saveSpy = vi.spyOn(conversationStateStore, "save");

    const result = await runBrokerPausarAgente("pausá el agente por hoy", intent, {
      conversationStateStore,
      globalPauseStore,
      pausarAgenteActionClassifier: stubActionClassifier({ accion: "pausar", alcance: "global" }),
    });

    expect(await globalPauseStore.isPaused()).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(result.toolsCalled).toEqual(["state.set_global_flag"]);
    expect(result.responseText).toBe(
      intent.response.template!.replace("{accion}", "pausé el agente").replace("{alcance}", "todas las conversaciones")
    );
  });

  it("alcance global + reactivar: apaga el GlobalPauseStore", async () => {
    const globalPauseStore = new InMemoryGlobalPauseStore();
    await globalPauseStore.setPaused(true);

    await runBrokerPausarAgente("reactivá el agente", intent, {
      conversationStateStore: new InMemoryConversationStateStore(),
      globalPauseStore,
      pausarAgenteActionClassifier: stubActionClassifier({ accion: "reactivar", alcance: "global" }),
    });

    expect(await globalPauseStore.isPaused()).toBe(false);
  });

  it("alcance conversacion con teléfono: marca pausedByBroker en el ConversationState de ese cliente", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();

    const result = await runBrokerPausarAgente("no le respondas más a 5491100000001, lo manejo yo", intent, {
      conversationStateStore,
      globalPauseStore: new InMemoryGlobalPauseStore(),
      pausarAgenteActionClassifier: stubActionClassifier({
        accion: "pausar",
        alcance: "conversacion",
        telefonoCliente: "5491100000001",
      }),
    });

    const state = await conversationStateStore.get("5491100000001");
    expect(state?.pausedByBroker).toBe(true);
    expect(result.toolsCalled).toEqual(["state.set_conversation_flag"]);
  });

  it("alcance conversacion: preserva el resto del ConversationState existente (no lo resetea a idle)", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    await conversationStateStore.save({
      ...idleState("5491100000001", "5491100000001"),
      step: "esperando_confirmacion_horario",
      currentIntentId: "agendar_visita",
    });

    await runBrokerPausarAgente("pausá a 5491100000001", intent, {
      conversationStateStore,
      globalPauseStore: new InMemoryGlobalPauseStore(),
      pausarAgenteActionClassifier: stubActionClassifier({
        accion: "pausar",
        alcance: "conversacion",
        telefonoCliente: "5491100000001",
      }),
    });

    const state = await conversationStateStore.get("5491100000001");
    expect(state?.pausedByBroker).toBe(true);
    expect(state?.step).toBe("esperando_confirmacion_horario");
    expect(state?.currentIntentId).toBe("agendar_visita");
  });

  it("alcance conversacion sin teléfono identificado: no toca ningún store y pide el número", async () => {
    const conversationStateStore = new InMemoryConversationStateStore();
    const saveSpy = vi.spyOn(conversationStateStore, "save");

    const result = await runBrokerPausarAgente("no le respondas más al bot a Juan", intent, {
      conversationStateStore,
      globalPauseStore: new InMemoryGlobalPauseStore(),
      pausarAgenteActionClassifier: stubActionClassifier({ accion: "pausar", alcance: "conversacion" }),
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(result.toolsCalled).toEqual([]);
    expect(result.responseText).toMatch(/número de teléfono/);
  });
});
