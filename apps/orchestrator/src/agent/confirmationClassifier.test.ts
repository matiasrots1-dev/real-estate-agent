import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeConfirmationClassifier } from "./confirmationClassifier.js";

/** Fake mínimo del cliente Anthropic: devuelve una respuesta enlatada, sin red real. */
function fakeAnthropicClient(response: unknown): Anthropic {
  return { messages: { create: vi.fn(async () => response) } } as unknown as Anthropic;
}

describe("ClaudeConfirmationClassifier", () => {
  it("confirmed: true cuando Claude devuelve el tool_use completo", async () => {
    const client = fakeAnthropicClient({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "extract_confirmation", input: { confirmed: true } }],
    });
    const classifier = new ClaudeConfirmationClassifier(client);
    await expect(classifier.extractConfirmation("sí, dale, confirmado")).resolves.toEqual({ confirmed: true });
  });

  it("confirmed: false cuando Claude devuelve el tool_use completo con un no", async () => {
    const client = fakeAnthropicClient({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "extract_confirmation", input: { confirmed: false } }],
    });
    const classifier = new ClaudeConfirmationClassifier(client);
    await expect(classifier.extractConfirmation("no, mejor no")).resolves.toEqual({ confirmed: false });
  });

  it("respuesta truncada por max_tokens (input vacío): tira un error explícito, no asume confirmed: false", async () => {
    // Caso real encontrado en vivo (docs/TASKS.md Bloque 10, 2026-07-28):
    // Claude se queda sin tokens antes de escribir "confirmed" en el JSON.
    const client = fakeAnthropicClient({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "tu-1", name: "extract_confirmation", input: {} }],
    });
    const classifier = new ClaudeConfirmationClassifier(client);
    await expect(classifier.extractConfirmation("sí, dale, confirmado")).rejects.toThrow(/incompleta o mal formada/);
  });

  it("input.confirmed con un tipo que no es boolean: también lo trata como respuesta mal formada", async () => {
    const client = fakeAnthropicClient({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu-1", name: "extract_confirmation", input: { confirmed: "yes" } }],
    });
    const classifier = new ClaudeConfirmationClassifier(client);
    await expect(classifier.extractConfirmation("sí")).rejects.toThrow(/incompleta o mal formada/);
  });

  it("sin ningún tool_use en la respuesta: tira un error explícito", async () => {
    const client = fakeAnthropicClient({ stop_reason: "end_turn", content: [{ type: "text", text: "no sé qué responder" }] });
    const classifier = new ClaudeConfirmationClassifier(client);
    await expect(classifier.extractConfirmation("sí")).rejects.toThrow(/no devolvió ningún tool_use/);
  });
});
