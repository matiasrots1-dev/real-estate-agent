import { describe, expect, it } from "vitest";
import { NumerosInternos } from "./numerosInternos.js";

// Numeros con estructura real pero ficticios donde alcanza; los que replican
// un caso concreto van comentados con que caso son.
const LINEA_BROKER = "5491155559999";
const FIJO_AGENTE = "541144449999";
const MOVIL_AGENTE = "5491144449999";
const CLIENTE = "5491133339999";

describe("numeros internos", () => {
  // EL caso que motivo todo: la linea de WhatsApp Business del broker estaba
  // cargada como contacto en el CRM y pasaba el criterio de recontacto. El job
  // estaba por escribirle a la misma linea que recibe a los clientes.
  it("reconoce la linea del broker escrita en cualquier formato", () => {
    const i = new NumerosInternos().agregar("+54 9 11 5555 9999");

    expect(i.contiene(LINEA_BROKER)).toBe(true);
    expect(i.contiene("54111555559999")).toBe(true); // formato viejo con 15
    expect(i.contiene("011 15 5555 9999")).toBe(true);
    expect(i.contiene("+5491155559999")).toBe(true);
  });

  // En /user/ figura el fijo del agente; en su ficha de contacto, el movil.
  // Como strings no coinciden, y por eso se colaba.
  it("une el fijo y el movil de la misma persona", () => {
    const i = new NumerosInternos().agregar(FIJO_AGENTE);

    expect(i.contiene(FIJO_AGENTE)).toBe(true);
    expect(i.contiene(MOVIL_AGENTE)).toBe(true);
  });

  it("no excluye a un cliente cualquiera", () => {
    const i = new NumerosInternos().agregar(LINEA_BROKER, FIJO_AGENTE);

    expect(i.contiene(CLIENTE)).toBe(false);
    expect(i.contiene("5491144445555")).toBe(false);
  });

  it("acepta varias fuentes de una", () => {
    const i = new NumerosInternos().agregar(LINEA_BROKER, FIJO_AGENTE, "", null, undefined);

    expect(i.contiene(LINEA_BROKER)).toBe(true);
    expect(i.contiene(MOVIL_AGENTE)).toBe(true);
  });

  describe("entradas degeneradas", () => {
    it("un set vacio no excluye a nadie", () => {
      expect(new NumerosInternos().contiene(CLIENTE)).toBe(false);
    });

    it("vacios y basura no rompen ni excluyen de mas", () => {
      const i = new NumerosInternos().agregar("", "   ", "abc", null, undefined);

      expect(i.contiene(CLIENTE)).toBe(false);
      expect(i.contiene("")).toBe(false);
      expect(i.contiene(null)).toBe(false);
    });

    // Un numero que no parsea igual se indexa por sus digitos crudos: no poder
    // normalizarlo no puede significar dejarlo pasar.
    it("un numero que no normaliza se reconoce por digitos crudos", () => {
      const i = new NumerosInternos().agregar("15-5555-1234");

      expect(i.contiene("15-5555-1234")).toBe(true);
      expect(i.contiene("1555551234")).toBe(true);
    });
  });
});
