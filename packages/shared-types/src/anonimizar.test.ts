import { describe, expect, it } from "vitest";
import { anonimizar } from "./anonimizar.js";

describe("anonimizar", () => {
  describe("saca identificadores", () => {
    it("teléfonos", () => {
      expect(anonimizar("llamame al 11 5555-9999")).toContain("[TELEFONO]");
      expect(anonimizar("mi numero es +54 9 11 5555 9999")).toContain("[TELEFONO]");
      expect(anonimizar("llamame al 11 5555-9999")).not.toMatch(/5555/);
    });

    it("mails", () => {
      const r = anonimizar("escribime a juan.perez@gmail.com");
      expect(r).toContain("[MAIL]");
      expect(r).not.toContain("juan.perez");
    });

    it("links", () => {
      expect(anonimizar("mirá https://zonaprop.com.ar/propiedad-123")).toBe("mirá [LINK]");
    });

    it("direcciones con calle y altura", () => {
      expect(anonimizar("el de Olleros 3700")).toContain("[DIRECCION]");
      expect(anonimizar("Av. Santa Fe 3253 esta libre")).toContain("[DIRECCION]");
      expect(anonimizar("Mariano Acha 1653 lo vemos")).toContain("[DIRECCION]");
    });

    it("direcciones conocidas que se le pasan", () => {
      const r = anonimizar("el depto de Virrey Arredondo", { direcciones: ["Virrey Arredondo"] });
      expect(r).toContain("[DIRECCION]");
      expect(r).not.toContain("Arredondo");
    });

    it("nombres conocidos, en cualquier parte", () => {
      const r = anonimizar("le dije a Marcela que el sabado si", { nombres: ["Marcela Gomez"] });
      expect(r).toContain("[NOMBRE]");
      expect(r).not.toContain("Marcela");
    });

    // Esto cubre a los contactos que no estan en ninguna lista.
    it("el nombre detrás de un saludo, aunque no lo conozca", () => {
      expect(anonimizar("Hola Fernando, como va?")).toBe("Hola [NOMBRE], como va?");
      expect(anonimizar("Gracias Vitaliia!")).toContain("[NOMBRE]");
      expect(anonimizar("Buenas tardes Rocio")).toContain("[NOMBRE]");
    });
  });

  // Modo de fallo 2 del pre-mortem: si redacta de mas, el ejemplo no ensena
  // nada. El tono ES la senal.
  describe("no destruye el tono", () => {
    it("deja los precios: son parte de como negocia", () => {
      expect(anonimizar("Cerramos en 178")).toBe("Cerramos en 178");
      expect(anonimizar("estan pidiendo 425000 pero se puede hablar")).toContain("425000");
    });

    it("deja muletillas, emojis y signos", () => {
      const t = "Dale, buenisimo 😄 lo vemos mañana sin falta!!";
      expect(anonimizar(t)).toBe(t);
    });

    it("no redacta palabras comunes detrás de un saludo", () => {
      expect(anonimizar("Gracias igualmente")).toBe("Gracias igualmente");
      expect(anonimizar("Hola buenas, como andas?")).toBe("Hola buenas, como andas?");
      expect(anonimizar("Buenas tardes")).toBe("Buenas tardes");
    });

    // Redactar toda palabra capitalizada se llevaria puesto medio texto.
    it("no redacta capitalizadas sueltas que no son nombres", () => {
      const t = "El lunes tengo libre. Palermo esta complicado a esa hora";
      expect(anonimizar(t)).toBe(t);
    });

    it("deja horarios y fechas", () => {
      expect(anonimizar("nos vemos a las 10:30 del 27/8")).toBe("nos vemos a las 10:30 del 27/8");
    });

    it("un texto sin identificadores queda idéntico", () => {
      const t = "Perfecto, cualquier cosa avisame y lo coordinamos";
      expect(anonimizar(t)).toBe(t);
    });
  });

  describe("casos degenerados", () => {
    it("vacío y espacios no rompen", () => {
      expect(anonimizar("")).toBe("");
      expect(anonimizar("   ")).toBe("   ");
    });

    it("nombres muy cortos no se usan: romperían el texto", () => {
      const r = anonimizar("el de la esquina", { nombres: ["De", "La"] });
      expect(r).toBe("el de la esquina");
    });
  });

  // Un mensaje real completo, con todo junto.
  describe("un mensaje real", () => {
    it("saca lo identificable y deja el resto", () => {
      const original =
        "Hola Marcos! Te confirmo Olleros 3700 para el jueves 10hs. " +
        "Cualquier cosa escribime al 11 5555-9999 o a matias@moderna.com.ar. " +
        "Estan pidiendo 550000 pero hay margen 😉";

      const r = anonimizar(original, { nombres: ["Marcos"] });

      expect(r).not.toContain("Marcos");
      expect(r).not.toContain("Olleros");
      expect(r).not.toContain("5555");
      expect(r).not.toContain("matias@");
      // Lo que hace al tono, intacto:
      expect(r).toContain("550000");
      expect(r).toContain("hay margen");
      expect(r).toContain("😉");
      expect(r).toContain("jueves 10hs");
    });
  });
});
