import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditLogEntry } from "shared-types";
import { FileAuditLogStore, InMemoryAuditLogStore } from "./auditLog.js";

function sampleEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: randomUUID(),
    conversationId: "5491100000001",
    timestamp: new Date().toISOString(),
    incomingMessage: "¿el depto de Palermo sigue disponible?",
    matchedIntentId: "consulta_disponibilidad",
    confidence: 0.9,
    toolsCalled: ["tokko.search_properties", "tokko.get_property"],
    escalatedToBroker: false,
    responseSent: "Sigue disponible.",
    ...overrides,
  };
}

describe("InMemoryAuditLogStore", () => {
  it("acumula entries en orden y no expone el array interno", async () => {
    const store = new InMemoryAuditLogStore();
    await store.append(sampleEntry({ id: "a" }));
    await store.append(sampleEntry({ id: "b" }));

    const entries = await store.readAll();
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);

    entries.push(sampleEntry({ id: "c" }));
    expect((await store.readAll()).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("FileAuditLogStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audit-log-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("devuelve [] si el archivo todavía no existe", async () => {
    const store = new FileAuditLogStore(path.join(dir, "nested", "audit_log.jsonl"));
    expect(await store.readAll()).toEqual([]);
  });

  it("crea el directorio, appendea JSONL, y lo relee en orden", async () => {
    const filePath = path.join(dir, "nested", "audit_log.jsonl");
    const store = new FileAuditLogStore(filePath);

    await store.append(sampleEntry({ id: "a" }));
    await store.append(sampleEntry({ id: "b", escalatedToBroker: true, escalationReason: "test" }));

    const entries = await store.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("a");
    expect(entries[1]).toMatchObject({ id: "b", escalatedToBroker: true, escalationReason: "test" });
  });
});
