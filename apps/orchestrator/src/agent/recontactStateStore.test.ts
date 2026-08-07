import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileRecontactStateStore,
  InMemoryRecontactStateStore,
  type RecontactStateStore,
} from "./recontactStateStore.js";

function runSharedTests(makeStore: () => RecontactStateStore) {
  it("get devuelve null si el lead no tiene estado todavía", async () => {
    const store = makeStore();
    expect(await store.get("lead-1")).toBeNull();
  });

  it("guarda y recupera los intentos ya mandados", async () => {
    const store = makeStore();
    await store.save({ leadId: "lead-1", attemptsSent: ["dias_sin_respuesta >= 5"] });
    expect(await store.get("lead-1")).toMatchObject({
      leadId: "lead-1",
      attemptsSent: ["dias_sin_respuesta >= 5"],
    });
  });

  it("estampa updatedAt al guardar, aunque el caller no lo pase (Bloque 15)", async () => {
    // Sin fecha no hay forma de saber la antigüedad de un registro, y la
    // retención por tiempo era imposible. El caller no tiene que acordarse.
    const store = makeStore();
    await store.save({ leadId: "lead-1", attemptsSent: [] });
    const guardado = await store.get("lead-1");
    expect(guardado?.updatedAt).toBeTruthy();
    expect(new Date(guardado!.updatedAt!).getTime()).not.toBeNaN();
  });

  it("save sobrescribe el estado previo del mismo lead", async () => {
    const store = makeStore();
    await store.save({ leadId: "lead-1", attemptsSent: ["dias_sin_respuesta >= 5"] });
    await store.save({
      leadId: "lead-1",
      attemptsSent: ["dias_sin_respuesta >= 5", "dias_sin_respuesta >= 15"],
    });
    expect((await store.get("lead-1"))?.attemptsSent).toHaveLength(2);
  });

  it("los estados de distintos leads no se pisan", async () => {
    const store = makeStore();
    await store.save({ leadId: "lead-1", attemptsSent: ["dias_sin_respuesta >= 5"] });
    await store.save({ leadId: "lead-2", attemptsSent: [] });
    expect((await store.get("lead-1"))?.attemptsSent).toEqual(["dias_sin_respuesta >= 5"]);
    expect((await store.get("lead-2"))?.attemptsSent).toEqual([]);
  });
}

describe("InMemoryRecontactStateStore", () => {
  runSharedTests(() => new InMemoryRecontactStateStore());
});

describe("FileRecontactStateStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "recontact-state-store-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  runSharedTests(() => new FileRecontactStateStore(path.join(dir, "recontacts.json")));
});
