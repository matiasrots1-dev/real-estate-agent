// docs/TASKS.md Bloque 38g: una sola definición de "este número es el del
// broker", para el ruteo, el modo silencioso y el aviso de fallos.

import { describe, expect, it } from "vitest";
import { esElNumeroDelBroker } from "./numeroDelBroker.js";

describe("esElNumeroDelBroker", () => {
  it("compara solo los dígitos: el + y los espacios de la configuración no importan", () => {
    expect(esElNumeroDelBroker("972500006699", "+972 50-000-6699")).toBe(true);
  });

  it("no normaliza: el 9 de los celulares argentinos cuenta", () => {
    expect(esElNumeroDelBroker("541155550000", "5491155550000")).toBe(false);
  });

  it("sin número del broker configurado, nadie es el broker", () => {
    expect(esElNumeroDelBroker("5491155550000", undefined)).toBe(false);
    expect(esElNumeroDelBroker("5491155550000", "")).toBe(false);
    // Un remitente vacío tampoco coincide con una configuración vacía.
    expect(esElNumeroDelBroker("", "")).toBe(false);
  });

  it("un número distinto no es el broker", () => {
    expect(esElNumeroDelBroker("5491133339999", "5491155550000")).toBe(false);
  });
});
