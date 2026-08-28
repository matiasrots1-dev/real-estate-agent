import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryEstiloBrokerStore, sirveComoEjemplo } from "./estiloBrokerStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../..");

describe("corpus de estilo", () => {
  it("devuelve los mas recientes del intent pedido", async () => {
    const s = new InMemoryEstiloBrokerStore();
    await s.guardar({ intent: "agendar_visita", texto: "viejo", cuando: "2026-01-01T00:00:00.000Z" });
    await s.guardar({ intent: "agendar_visita", texto: "nuevo", cuando: "2026-08-01T00:00:00.000Z" });
    await s.guardar({ intent: "reclamo_queja", texto: "otro intent", cuando: "2026-08-02T00:00:00.000Z" });

    const r = await s.ejemplosDe("agendar_visita", 5);

    expect(r.map((e) => e.texto)).toEqual(["nuevo", "viejo"]);
  });

  it("respeta el limite de cuantos ejemplos se piden", async () => {
    const s = new InMemoryEstiloBrokerStore();
    for (let i = 0; i < 10; i++) {
      await s.guardar({ intent: "x", texto: `t${i}`, cuando: `2026-08-0${(i % 9) + 1}T00:00:00.000Z` });
    }

    expect((await s.ejemplosDe("x", 3)).length).toBe(3);
  });

  describe("que sirve como ejemplo", () => {
    it("descarta lo demasiado corto: no ensena tono", () => {
      expect(sirveComoEjemplo("ok")).toBe(false);
      expect(sirveComoEjemplo("dale")).toBe(false);
    });

    it("descarta lo demasiado largo: se come el prompt", () => {
      expect(sirveComoEjemplo("a".repeat(700))).toBe(false);
    });

    it("acepta un mensaje normal", () => {
      expect(sirveComoEjemplo("Perfecto, lo coordinamos para el jueves entonces")).toBe(true);
    });
  });

  // DECISION EXPLICITA del dueno del repo: el corpus se conserva sin plazo,
  // porque va anonimizado y sin destinatario. Este test existe para que nadie
  // lo cablee al barrido de retencion por inercia, viendo que los demas stores
  // si estan.
  describe("no se purga por antiguedad", () => {
    it("el job de retencion NO lo incluye", () => {
      const retention = fs.readFileSync(path.join(REPO, "apps/orchestrator/src/jobs/retention.ts"), "utf-8");

      expect(retention.toLowerCase()).not.toContain("estilo");
    });

    // El metodo sigue existiendo aunque nadie lo llame: es la via para vaciar
    // el corpus si la decision se revisa, o para un pedido puntual de borrado.
    it("pero se puede vaciar a mano si hace falta", async () => {
      const s = new InMemoryEstiloBrokerStore();
      await s.guardar({ intent: "x", texto: "algo viejo", cuando: "2020-01-01T00:00:00.000Z" });

      const r = await s.purgeOlderThan(new Date("2026-01-01"), false);

      expect(r.borrados).toBe(1);
      expect(await s.all()).toHaveLength(0);
    });

    // El reporte de purgado no puede ser una copia de lo que borra: en este
    // store el registro ES el texto.
    it("el reporte de purgado no incluye el texto", async () => {
      const s = new InMemoryEstiloBrokerStore();
      await s.guardar({ intent: "x", texto: "un texto identificable", cuando: "2020-01-01T00:00:00.000Z" });

      const r = await s.purgeOlderThan(new Date("2026-01-01"), true);

      expect(JSON.stringify(r)).not.toContain("identificable");
    });
  });
});
