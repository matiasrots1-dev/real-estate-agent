// Una entrada por mensaje (docs/TASKS.md Bloque 34, modo de fallo 2 del
// pre-mortem): desde que cada mensaje deja una `recibido` y la que lo
// resuelve, todo lo que cuenta mensajes pasaría a contar el doble.

import { describe, expect, it } from "vitest";
import { colapsarPorMensaje, esResuelta, fueRespondida } from "./auditPorMensaje.js";

const entrada = (id: string, extra: { messageId?: string; etapa?: "recibido" | "fallido" } = {}) => ({
  id,
  ...extra,
});

describe("colapsarPorMensaje", () => {
  it("la entrada que resuelve reemplaza a su recibido, en el lugar del recibido", () => {
    const entradas = [
      entrada("llego-1", { messageId: "m1", etapa: "recibido" }),
      entrada("llego-2", { messageId: "m2", etapa: "recibido" }),
      entrada("resuelto-1", { messageId: "m1" }),
      entrada("resuelto-2", { messageId: "m2" }),
    ];

    // El orden es el de llegada, no el de resolución.
    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["resuelto-1", "resuelto-2"]);
  });

  it("un recibido que quedó solo se conserva: llegó y nunca se resolvió", () => {
    const entradas = [entrada("llego", { messageId: "m1", etapa: "recibido" })];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["llego"]);
  });

  it("un fallido reemplaza a su recibido", () => {
    const entradas = [
      entrada("llego", { messageId: "m1", etapa: "recibido" }),
      entrada("fallo", { messageId: "m1", etapa: "fallido" }),
    ];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["fallo"]);
  });

  it("un recibido que aparece después de su resolución no la pisa", () => {
    const entradas = [
      entrada("resuelto", { messageId: "m1" }),
      entrada("llego-tarde", { messageId: "m1", etapa: "recibido" }),
    ];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["resuelto"]);
  });

  // Reinicio del proceso: el dedup en memoria se pierde, Meta reentrega un
  // mensaje ya contestado, y el reproceso falla.
  it("un fallido de un reproceso no tapa la respuesta que el cliente ya recibió", () => {
    const entradas = [
      entrada("llego", { messageId: "m1", etapa: "recibido" }),
      entrada("resuelto", { messageId: "m1" }),
      entrada("llego-de-nuevo", { messageId: "m1", etapa: "recibido" }),
      entrada("fallo-el-reproceso", { messageId: "m1", etapa: "fallido" }),
    ];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["resuelto"]);
  });

  it("un reproceso que se resuelve reemplaza a la resolución anterior", () => {
    const entradas = [
      entrada("resuelto", { messageId: "m1" }),
      entrada("resuelto-de-nuevo", { messageId: "m1" }),
    ];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["resuelto-de-nuevo"]);
  });

  it("las entradas sin messageId pasan sin tocar: las viejas y las de los jobs", () => {
    const entradas = [
      entrada("vieja-1"),
      entrada("llego", { messageId: "m1", etapa: "recibido" }),
      entrada("vieja-2"),
      entrada("resuelto", { messageId: "m1" }),
    ];

    expect(colapsarPorMensaje(entradas).map((e) => e.id)).toEqual(["vieja-1", "resuelto", "vieja-2"]);
  });
});

// docs/TASKS.md Bloques 38a y 38d. Lo usa `pendientes`, que no tiene tests
// propios: acá se prueba la regla, no el script.
describe("fueRespondida", () => {
  it("con la respuesta enviada y el aviso al broker OK, está respondida", () => {
    expect(fueRespondida({ responseSent: "listo", avisoAlBroker: "enviado" })).toBe(true);
    expect(fueRespondida({ responseSent: "listo" })).toBe(true);
  });

  it("sin respuesta enviada, no", () => {
    expect(fueRespondida({})).toBe(false);
  });

  it("si el aviso al broker falló, no: el cliente tiene la plantilla de espera y el broker no sabe nada", () => {
    expect(fueRespondida({ responseSent: "Dejame confirmarlo...", avisoAlBroker: "fallo" })).toBe(false);
  });

  it("si el envío falló o salió a medias, no", () => {
    expect(fueRespondida({ responseSent: undefined, envio: "fallo" })).toBe(false);
    expect(fueRespondida({ responseSent: "Te paso el material:", envio: "parcial" })).toBe(false);
  });
});

describe("esResuelta", () => {
  it("solo las entradas sin etapa tienen un intent real", () => {
    expect(esResuelta(entrada("x"))).toBe(true);
    expect(esResuelta(entrada("x", { etapa: "recibido" }))).toBe(false);
    expect(esResuelta(entrada("x", { etapa: "fallido" }))).toBe(false);
  });
});
