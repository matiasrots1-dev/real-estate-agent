import { describe, expect, it } from "vitest";
import type { Lead } from "shared-types";
import {
  CONFIG_POR_DEFECTO,
  formatearReporte,
  planificarRecontacto,
  type EstadoDeContacto,
} from "./recontactoPolicy.js";

const AHORA = new Date("2026-08-25T12:00:00Z");

function lead(id: string, nombre = "Cliente " + id, telefono = "5491155551234"): Lead {
  return {
    id,
    tokkoId: id,
    nombre,
    telefonoWhatsapp: telefono,
    temperatura: "frio",
    propiedadesDeInteres: [],
    diasSinRespuesta: 90,
  };
}

function haceDias(n: number): string {
  return new Date(AHORA.getTime() - n * 86_400_000).toISOString();
}

function estados(pares: Array<[string, EstadoDeContacto]>): Map<string, EstadoDeContacto> {
  return new Map(pares);
}

describe("ventana de 60 días", () => {
  // Es el caso que motivó todo el bloque: escribirle "hace tiempo que no
  // sabemos de vos" a alguien con quien el broker habló ayer.
  it("suprime a quien fue contactado hace menos de 60 días", () => {
    const plan = planificarRecontacto(
      [lead("1")],
      estados([["1", { intentos: 0, ultimoContactoAt: haceDias(1) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toEqual([]);
    expect(plan.suprimidos[0]).toMatchObject({ motivo: "contactado_hace_poco", detalle: "contactado hace 1 día" });
  });

  it("deja pasar a quien fue contactado hace más de 60 días", () => {
    const plan = planificarRecontacto(
      [lead("1")],
      estados([["1", { intentos: 0, ultimoContactoAt: haceDias(61) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toHaveLength(1);
  });

  it("el borde exacto de 60 días todavía suprime", () => {
    const plan = planificarRecontacto(
      [lead("1")],
      estados([["1", { intentos: 0, ultimoContactoAt: haceDias(59) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toEqual([]);
  });

  it("sin registro previo, se puede contactar", () => {
    const plan = planificarRecontacto([lead("1")], estados([]), 0, AHORA);

    expect(plan.aEnviar).toHaveLength(1);
    expect(plan.aEnviar[0]?.intentoNumero).toBe(1);
  });
});

describe("máximo de 2 intentos", () => {
  it("permite el segundo intento", () => {
    const plan = planificarRecontacto(
      [lead("1")],
      estados([["1", { intentos: 1, ultimoContactoAt: haceDias(90) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar[0]?.intentoNumero).toBe(2);
  });

  it("no hay tercer intento, aunque hayan pasado años", () => {
    const plan = planificarRecontacto(
      [lead("1")],
      estados([["1", { intentos: 2, ultimoContactoAt: haceDias(900) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toEqual([]);
    expect(plan.suprimidos[0]).toMatchObject({ motivo: "agotó_intentos" });
  });
});

describe("topes", () => {
  it("corta en 3 por corrida", () => {
    const plan = planificarRecontacto([lead("1"), lead("2"), lead("3"), lead("4"), lead("5")], estados([]), 0, AHORA);

    expect(plan.aEnviar).toHaveLength(3);
    expect(plan.topeAlcanzado).toBe(true);
  });

  // El tope diario cuenta lo ya enviado hoy, que se persiste: un tope que vive
  // en memoria deja de ser un tope si el proceso se reinicia.
  it("respeta el tope diario contando lo ya enviado hoy", () => {
    const plan = planificarRecontacto([lead("1"), lead("2"), lead("3")], estados([]), 9, AHORA);

    expect(plan.aEnviar).toHaveLength(1);
    expect(plan.suprimidos.filter((s) => s.motivo === "tope_por_dia")).toHaveLength(2);
  });

  it("con el día completo no sale nada", () => {
    const plan = planificarRecontacto([lead("1")], estados([]), 10, AHORA);

    expect(plan.aEnviar).toEqual([]);
    expect(plan.topeAlcanzado).toBe(true);
  });

  // Alguien inelegible no debe consumir cupo ni figurar como frenado por el
  // tope: se reporta por su motivo real.
  it("los inelegibles no consumen cupo", () => {
    const plan = planificarRecontacto(
      [lead("1"), lead("2"), lead("3"), lead("4")],
      estados([
        ["1", { intentos: 2 }],
        ["2", { intentos: 0, ultimoContactoAt: haceDias(3) }],
      ]),
      0,
      AHORA
    );

    expect(plan.aEnviar.map((d) => d.leadId)).toEqual(["3", "4"]);
    expect(plan.topeAlcanzado).toBe(false);
  });
});

describe("teléfono inutilizable", () => {
  it("no se lo cuenta como destinatario pero se reporta", () => {
    const plan = planificarRecontacto([lead("1", "Sin Tel", "")], estados([]), 0, AHORA);

    expect(plan.aEnviar).toEqual([]);
    expect(plan.suprimidos[0]).toMatchObject({ motivo: "sin_telefono_usable", nombre: "Sin Tel" });
  });
});

describe("el reporte muestra nombres, no sólo conteos", () => {
  // La supresión automática puede fallar (el eco es best-effort y Meta no lo
  // reintenta), así que esta lista es la defensa principal. Un conteo no
  // permite detectar que se coló alguien que no corresponde.
  it("lista nombre y teléfono de cada destinatario", () => {
    const plan = planificarRecontacto([lead("1", "Ana Pérez", "5491155551234")], estados([]), 0, AHORA);

    const texto = formatearReporte(plan, true);

    expect(texto).toContain("Ana Pérez");
    expect(texto).toContain("5491155551234");
    expect(texto).toContain("intento 1");
  });

  it("dice claramente que es un simulacro", () => {
    const texto = formatearReporte(planificarRecontacto([lead("1")], estados([]), 0, AHORA), true);

    expect(texto).toContain("SIMULACRO");
    expect(texto).toContain("no se mandó nada");
  });

  it("en envío real lo dice también, sin ambigüedad", () => {
    const texto = formatearReporte(planificarRecontacto([lead("1")], estados([]), 0, AHORA), false);

    expect(texto).toContain("ENVÍO REAL");
    expect(texto).not.toContain("SIMULACRO");
  });

  it("muestra a los suprimidos con nombre y motivo", () => {
    const plan = planificarRecontacto(
      [lead("1", "Juan Recién")],
      estados([["1", { intentos: 0, ultimoContactoAt: haceDias(5) }]]),
      0,
      AHORA
    );

    const texto = formatearReporte(plan, true);

    expect(texto).toContain("Juan Recién");
    expect(texto).toContain("contactado hace 5 días");
  });

  it("avisa cuando se alcanzó el tope, en vez de callarlo", () => {
    const plan = planificarRecontacto([lead("1"), lead("2"), lead("3"), lead("4")], estados([]), 0, AHORA);

    expect(formatearReporte(plan, true)).toContain("Se alcanzó el tope");
  });
});

describe("los valores por defecto son los acordados", () => {
  it("60 días, 2 intentos, 3 por corrida, 10 por día", () => {
    expect(CONFIG_POR_DEFECTO).toEqual({
      diasEntreMensajes: 60,
      intentosMaximos: 2,
      topePorCorrida: 3,
      topePorDia: 10,
    });
  });
});
