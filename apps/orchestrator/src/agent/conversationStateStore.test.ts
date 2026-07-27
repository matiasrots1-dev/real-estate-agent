import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileConversationStateStore,
  idleState,
  InMemoryConversationStateStore,
  type ConversationStateStore,
} from "./conversationStateStore.js";

function runSharedTests(makeStore: () => ConversationStateStore) {
  it("get devuelve null si la conversación no existe todavía", async () => {
    const store = makeStore();
    expect(await store.get("5491100000001")).toBeNull();
  });

  it("guarda y recupera el estado", async () => {
    const store = makeStore();
    const state = idleState("5491100000001", "5491100000001");
    state.step = "esperando_confirmacion_horario";
    state.context = { propertyId: "prop-1", proposedSlots: ["2026-08-01T15:00:00"] };

    await store.save(state);
    const loaded = await store.get("5491100000001");

    expect(loaded?.step).toBe("esperando_confirmacion_horario");
    expect(loaded?.context).toEqual({ propertyId: "prop-1", proposedSlots: ["2026-08-01T15:00:00"] });
  });

  it("save sobrescribe el estado previo de la misma conversación", async () => {
    const store = makeStore();
    await store.save(idleState("5491100000001", "5491100000001"));
    const updated = idleState("5491100000001", "5491100000001");
    updated.step = "esperando_ok_broker";
    await store.save(updated);

    expect((await store.get("5491100000001"))?.step).toBe("esperando_ok_broker");
  });
}

describe("idleState", () => {
  it("arranca en step idle, sin pausa y sin contexto", () => {
    const state = idleState("conv-1", "5491100000001");
    expect(state.step).toBe("idle");
    expect(state.pausedByBroker).toBe(false);
    expect(state.context).toEqual({});
  });
});

describe("InMemoryConversationStateStore", () => {
  runSharedTests(() => new InMemoryConversationStateStore());
});

describe("FileConversationStateStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "conversation-state-store-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runSharedTests(() => new FileConversationStateStore(path.join(dir, "conversations.json")));
});
