import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileGlobalPauseStore, InMemoryGlobalPauseStore, type GlobalPauseStore } from "./globalPauseStore.js";

function runSharedTests(makeStore: () => GlobalPauseStore) {
  it("arranca sin pausar", async () => {
    const store = makeStore();
    expect(await store.isPaused()).toBe(false);
  });

  it("setPaused(true) pausa, setPaused(false) reactiva", async () => {
    const store = makeStore();
    await store.setPaused(true);
    expect(await store.isPaused()).toBe(true);
    await store.setPaused(false);
    expect(await store.isPaused()).toBe(false);
  });
}

describe("InMemoryGlobalPauseStore", () => {
  runSharedTests(() => new InMemoryGlobalPauseStore());
});

describe("FileGlobalPauseStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "global-pause-store-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runSharedTests(() => new FileGlobalPauseStore(path.join(dir, "global_pause.json")));

  it("persiste entre instancias distintas apuntando al mismo archivo", async () => {
    const filePath = path.join(dir, "global_pause.json");
    await new FileGlobalPauseStore(filePath).setPaused(true);
    expect(await new FileGlobalPauseStore(filePath).isPaused()).toBe(true);
  });
});
