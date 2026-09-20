// docs/TASKS.md Bloque 27. El recontacto es el único job que le escribe a
// gente que no escribió primero, y la línea de WhatsApp Business del broker
// está cargada como un contacto más en el CRM: pasa el criterio. Escribirle
// es escribirle a la misma línea que recibe a los clientes, y como ese número
// le manda mensajes al sistema, puede armar un lazo.
import { describe, expect, it, vi } from "vitest";
import { envioDeRecontactoPermitido, reunirNumerosInternos } from "./numerosInternosDelSistema.js";

describe("reunirNumerosInternos", () => {
  it("junta las tres fuentes", async () => {
    const { internos, faltantes } = await reunirNumerosInternos({
      brokerWhatsappNumber: "5491166669999",
      lineaDelBot: async () => "+54 9 11 4444 5555",
      usuariosDeTokko: async () => ["1155551234"],
    });

    expect(faltantes).toEqual([]);
    expect(internos.contiene("5491166669999")).toBe(true);
    expect(internos.contiene("5491144445555")).toBe(true);
    expect(internos.contiene("5491155551234")).toBe(true);
  });

  it("una fuente que falla se reporta en vez de tragarse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { faltantes } = await reunirNumerosInternos({
      brokerWhatsappNumber: "5491166669999",
      lineaDelBot: async () => {
        throw new Error("Meta respondió HTTP 500");
      },
      usuariosDeTokko: async () => [],
    });

    expect(faltantes).toHaveLength(1);
    expect(faltantes[0]).toContain("la línea del bot");
    vi.restoreAllMocks();
  });

  it("una fuente sin configurar también cuenta como faltante", async () => {
    const { faltantes } = await reunirNumerosInternos({});
    expect(faltantes).toHaveLength(3);
  });

  it("Meta que no devuelve el número no es lo mismo que no haber preguntado", async () => {
    const { faltantes } = await reunirNumerosInternos({
      brokerWhatsappNumber: "5491166669999",
      lineaDelBot: async () => undefined,
      usuariosDeTokko: async () => [],
    });

    expect(faltantes[0]).toContain("Meta no devolvió");
  });
});

describe("envioDeRecontactoPermitido", () => {
  it("con todo en orden y habilitado, permite", () => {
    expect(envioDeRecontactoPermitido({ habilitadoPorConfig: true, faltantes: [] })).toEqual({ permitido: true });
  });

  it("sin habilitar, no permite y no hace falta explicar nada", () => {
    expect(envioDeRecontactoPermitido({ habilitadoPorConfig: false, faltantes: [] })).toEqual({ permitido: false });
  });

  // Falla cerrado: habilitado pero sin saber a quién NO escribirle es peor
  // que no enviar.
  it("habilitado pero con fuentes faltantes, queda en simulacro y dice por qué", () => {
    const r = envioDeRecontactoPermitido({
      habilitadoPorConfig: true,
      faltantes: ["la línea del bot (falló la consulta a Meta)"],
    });

    expect(r.permitido).toBe(false);
    expect(r.motivo).toContain("SIMULACRO");
    expect(r.motivo).toContain("la línea del bot");
  });
});
