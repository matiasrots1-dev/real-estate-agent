// Aviso de fallos al broker (docs/TASKS.md Bloque 34). Opción B, decisión del
// dueño del repo: los primeros 5 de una caída salen sueltos, desde el sexto un
// resumen cada 15 minutos, y un aviso cuando se recupera.

import { describe, expect, it } from "vitest";
import { AvisoDeFallos, SUELTOS_MAXIMOS } from "./avisoDeFallos.js";

function canalEspia() {
  const enviados: string[] = [];
  return {
    enviados,
    canal: {
      enviar: async (texto: string) => {
        enviados.push(texto);
      },
    },
  };
}

/** Reloj falso: los resúmenes se disparan a mano, sin esperar 15 minutos reales. */
function relojFalso() {
  const programados: Array<{ fn: () => void; cancelado: boolean }> = [];
  return {
    programar: (fn: () => void) => {
      const tarea = { fn, cancelado: false };
      programados.push(tarea);
      return () => {
        tarea.cancelado = true;
      };
    },
    activos: () => programados.filter((t) => !t.cancelado).length,
    vencer: async () => {
      for (const tarea of programados.splice(0)) if (!tarea.cancelado) tarea.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function armar() {
  const { enviados, canal } = canalEspia();
  const reloj = relojFalso();
  const aviso = new AvisoDeFallos({ canal, programar: reloj.programar });
  return { enviados, reloj, aviso };
}

const fallo = (n: number) => ({ telefono: `549110000${String(n).padStart(4, "0")}`, texto: `mensaje ${n}` });
const ultimo = (lista: string[]) => lista[lista.length - 1];

describe("aviso de fallos al broker", () => {
  it("un fallo aislado se avisa enseguida, con el teléfono y el texto crudo", async () => {
    const { enviados, aviso } = armar();

    await aviso.registrarFallo({ telefono: "5491155550000", texto: "Hola, ¿sigue disponible el de Palermo?" });

    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain("5491155550000");
    expect(enviados[0]).toContain("Hola, ¿sigue disponible el de Palermo?");
    expect(enviados[0]).toContain("NO se le respondió");
  });

  it(`los primeros ${SUELTOS_MAXIMOS} de una caída salen sueltos, y el último avisa que se van a agrupar`, async () => {
    const { enviados, aviso } = armar();

    for (let i = 1; i <= SUELTOS_MAXIMOS; i++) await aviso.registrarFallo(fallo(i));

    expect(enviados).toHaveLength(SUELTOS_MAXIMOS);
    expect(enviados[0]).not.toContain("resumen");
    expect(ultimo(enviados)).toContain("resumen cada 15 minutos");
  });

  it("desde el sexto se agrupan, y el resumen sale cuando vence el intervalo", async () => {
    const { enviados, reloj, aviso } = armar();

    for (let i = 1; i <= SUELTOS_MAXIMOS + 3; i++) await aviso.registrarFallo(fallo(i));
    // Los tres agrupados todavía no salieron.
    expect(enviados).toHaveLength(SUELTOS_MAXIMOS);

    await reloj.vencer();

    expect(enviados).toHaveLength(SUELTOS_MAXIMOS + 1);
    expect(ultimo(enviados)).toContain("3 mensajes");
    for (const i of [6, 7, 8]) expect(ultimo(enviados)).toContain(`mensaje ${i}`);
  });

  it("programa un solo resumen por intervalo, no uno por mensaje", async () => {
    const { reloj, aviso } = armar();

    for (let i = 1; i <= SUELTOS_MAXIMOS + 7; i++) await aviso.registrarFallo(fallo(i));

    expect(reloj.activos()).toBe(1);
  });

  it("al recuperarse manda lo pendiente y avisa que volvió, con el total de la caída", async () => {
    const { enviados, reloj, aviso } = armar();

    for (let i = 1; i <= SUELTOS_MAXIMOS + 2; i++) await aviso.registrarFallo(fallo(i));
    await aviso.registrarExito();

    expect(enviados).toHaveLength(SUELTOS_MAXIMOS + 2);
    expect(enviados[enviados.length - 2]).toContain(`mensaje ${SUELTOS_MAXIMOS + 2}`);
    expect(ultimo(enviados)).toContain("volvió a procesar");
    expect(ultimo(enviados)).toContain(`${SUELTOS_MAXIMOS + 2} mensajes`);
    // El resumen programado se cancela: ya salió.
    expect(reloj.activos()).toBe(0);
  });

  it("después de recuperarse, una caída nueva vuelve a empezar por los sueltos", async () => {
    const { enviados, aviso } = armar();
    for (let i = 1; i <= SUELTOS_MAXIMOS + 2; i++) await aviso.registrarFallo(fallo(i));
    await aviso.registrarExito();
    const antes = enviados.length;

    await aviso.registrarFallo(fallo(99));

    expect(enviados).toHaveLength(antes + 1);
    expect(ultimo(enviados)).toContain("mensaje 99");
  });

  it("un éxito sin caída no manda nada", async () => {
    const { enviados, aviso } = armar();

    await aviso.registrarExito();

    expect(enviados).toEqual([]);
  });

  it("el resumen lista hasta 20 y cuenta el resto", async () => {
    const { enviados, reloj, aviso } = armar();

    for (let i = 1; i <= SUELTOS_MAXIMOS + 30; i++) await aviso.registrarFallo(fallo(i));
    await reloj.vencer();

    expect(ultimo(enviados)).toContain("30 mensajes");
    expect(ultimo(enviados)).toContain("y 10 más");
  });

  it("si el aviso no se puede mandar, no tira", async () => {
    const aviso = new AvisoDeFallos({
      canal: {
        enviar: async () => {
          throw new Error("WhatsApp caído");
        },
      },
      programar: () => () => {},
    });

    await expect(aviso.registrarFallo(fallo(1))).resolves.toBeUndefined();
    await expect(aviso.registrarExito()).resolves.toBeUndefined();
  });
});
