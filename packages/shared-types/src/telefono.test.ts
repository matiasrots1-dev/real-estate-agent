import { describe, expect, it } from "vitest";
import { normalizarTelefono } from "./telefono.js";

describe("normalizarTelefono", () => {
  describe("celulares argentinos, en todas las formas que los cargan", () => {
    // Todas estas son la MISMA persona escrita distinto. Salen del análisis de
    // los contactos reales del CRM: hay con +, sin +, con espacios al inicio,
    // con guiones y con el 0/15 doméstico.
    it.each([
      "91155551234",
      "5491155551234",
      "+5491155551234",
      "011 15 5555 1234",
      "+54 9 11 5555-1234",
      "  5491155551234  ",
    ])("%s -> 5491155551234", (entrada) => {
      const r = normalizarTelefono(entrada);
      expect(r.usable).toBe(true);
      expect(r.paraEnviar).toBe("5491155551234");
    });

    it("un celular del interior también funciona", () => {
      expect(normalizarTelefono("93514567890").paraEnviar).toBe("5493514567890");
    });
  });

  describe("lo que se manda nunca lleva + ni espacios", () => {
    it("paraEnviar son solo dígitos", () => {
      const r = normalizarTelefono("+54 9 11 5555-1234");
      expect(r.paraEnviar).toMatch(/^\d+$/);
    });

    // El formato de lectura va aparte a propósito: mezclarlos es lo que hace
    // que alguien mande a la API un número con espacios.
    it("paraMostrar es legible y distinto de paraEnviar", () => {
      const r = normalizarTelefono("5491155551234");
      expect(r.paraMostrar).toBeDefined();
      expect(r.paraMostrar).not.toBe(r.paraEnviar);
      expect(r.paraMostrar).toMatch(/\s|-/);
    });
  });

  // LA TRAMPA. Un celular cargado sin el 9 y sin el 15 parsea como fijo
  // válido: isValid() da true y no tiene WhatsApp. Si el filtro fuera
  // isValid(), este número pasaría y el mensaje no llegaría a ningún lado,
  // sin error visible.
  describe("no alcanza con que sea válido: tiene que ser móvil", () => {
    it("un fijo se rechaza aunque la librería lo dé por válido", () => {
      const r = normalizarTelefono("1155551234");
      expect(r.usable).toBe(false);
      expect(r.motivo).toBe("no_es_movil");
      expect(r.tipo).toBe("FIXED_LINE");
      // Se conserva el original para poder ir a corregirlo al CRM.
      expect(r.original).toBe("1155551234");
    });

    it.each(["541155551234", "+541155551234", "01155551234"])(
      "%s también es fijo y se rechaza",
      (entrada) => {
        expect(normalizarTelefono(entrada).usable).toBe(false);
      }
    );
  });

  describe("entradas que no se pueden usar", () => {
    it.each([
      ["", "sin_telefono"],
      ["   ", "sin_telefono"],
      ["sin datos", "sin_telefono"],
      [null, "sin_telefono"],
      [undefined, "sin_telefono"],
    ])("%o -> %s", (entrada, motivo) => {
      const r = normalizarTelefono(entrada as string);
      expect(r.usable).toBe(false);
      expect(r.motivo).toBe(motivo);
    });

    it("un número incompleto se marca inválido, no se completa a mano", () => {
      const r = normalizarTelefono("15-5555-1234");
      expect(r.usable).toBe(false);
      expect(["invalido", "no_parseable", "no_es_movil"]).toContain(r.motivo);
    });

    it("nunca devuelve paraEnviar cuando no es usable", () => {
      for (const malo of ["", "1155551234", "15-5555-1234", "abc"]) {
        expect(normalizarTelefono(malo).paraEnviar).toBeUndefined();
      }
    });
  });

  describe("región por defecto", () => {
    it("asume AR cuando no hay código de país", () => {
      expect(normalizarTelefono("91155551234").paraEnviar).toBe("5491155551234");
    });

    // Números ficticios a propósito (corrida de dígitos repetidos): hay
    // contactos internacionales en el CRM y el default AR no debe pisarlos.
    it("respeta el código de país cuando viene explícito", () => {
      const r = normalizarTelefono("+59891111111");
      expect(r.usable).toBe(true);
      expect(r.paraEnviar?.startsWith("598")).toBe(true);
    });

    it("se le puede pasar otra región", () => {
      const r = normalizarTelefono("91111111", "UY");
      expect(r.paraEnviar?.startsWith("598")).toBe(true);
    });
  });
});
