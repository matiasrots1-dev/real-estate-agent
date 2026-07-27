import { describe, expect, it } from "vitest";
import { parseOffsetToMs } from "./scheduleOffset.js";

describe("parseOffsetToMs", () => {
  it('parsea "-24h" a -24 horas en ms', () => {
    expect(parseOffsetToMs("-24h")).toBe(-24 * 60 * 60 * 1000);
  });

  it('parsea "-2h" a -2 horas en ms', () => {
    expect(parseOffsetToMs("-2h")).toBe(-2 * 60 * 60 * 1000);
  });

  it('parsea "+3h" a +3 horas en ms (seguimiento_post_visita)', () => {
    expect(parseOffsetToMs("+3h")).toBe(3 * 60 * 60 * 1000);
  });

  it("tira un error legible ante un formato inesperado", () => {
    expect(() => parseOffsetToMs("24h")).toThrow(/formato inesperado/);
    expect(() => parseOffsetToMs("-1d")).toThrow(/formato inesperado/);
    expect(() => parseOffsetToMs("")).toThrow(/formato inesperado/);
  });
});
