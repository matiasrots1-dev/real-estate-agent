import { describe, expect, it } from "vitest";
import type { Lead } from "shared-types";
import {
  CONFIG_POR_DEFECTO,
  detectarDuplicados,
  formatearReporte,
  planificarRecontacto,
  puedeCorrer,
  type EstadoDeContacto,
} from "./recontactoPolicy.js";

const AHORA = new Date("2026-08-25T12:00:00Z");

// Cada lead con un telefono DISTINTO por default: desde que la supresion
// mira tambien el telefono, compartirlo haria que se deduplicaran entre si y
// los tests medirian otra cosa.
function lead(id: string, nombre = "Cliente " + id, telefono = "54911555" + String(id).padStart(5, "0")): Lead {
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

function estados(
  pares: Array<[string, EstadoDeContacto]>,
  porTelefono: Array<[string, EstadoDeContacto]> = []
) {
  return { porLead: new Map(pares), porTelefono: new Map(porTelefono) };
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
  it("60 dias, 2 intentos, 3 por corrida, 10 por dia, 45 min, 9 a 20", () => {
    expect(CONFIG_POR_DEFECTO).toEqual({
      diasEntreMensajes: 60,
      intentosMaximos: 2,
      topePorCorrida: 3,
      topePorDia: 10,
      intervaloEntreCorridasMinutos: 45,
      horaInicio: 9,
      horaFin: 20,
    });
  });
});

describe("fichas duplicadas en Tokko", () => {
  const MISMO_TEL = "5491155559999";

  // Dos fichas de la misma persona en el CRM no pueden significar dos
  // mensajes. La supresion mira el telefono ademas del leadId.
  it("dos fichas con el mismo telefono reciben UN solo mensaje", () => {
    const plan = planificarRecontacto(
      [lead("1", "Clara", MISMO_TEL), lead("2", "Clara Duplicada", MISMO_TEL)],
      estados([]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toHaveLength(1);
    expect(plan.suprimidos[0]).toMatchObject({ motivo: "duplicado_en_esta_corrida", nombre: "Clara Duplicada" });
  });

  it("hereda la historia de la otra ficha: si a una ya se le escribio, la otra no escribe", () => {
    const plan = planificarRecontacto(
      [lead("2", "Clara Duplicada", MISMO_TEL)],
      estados([], [[MISMO_TEL, { intentos: 0, ultimoContactoAt: haceDias(3) }]]),
      0,
      AHORA
    );

    expect(plan.aEnviar).toEqual([]);
    expect(plan.suprimidos[0]).toMatchObject({ motivo: "contactado_hace_poco" });
  });

  it("los intentos tambien se heredan por telefono", () => {
    const plan = planificarRecontacto(
      [lead("2", "Clara Duplicada", MISMO_TEL)],
      estados([], [[MISMO_TEL, { intentos: 2, ultimoContactoAt: haceDias(400) }]]),
      0,
      AHORA
    );

    expect(plan.suprimidos[0]).toMatchObject({ motivo: "agotó_intentos" });
  });

  it("los detecta y los lista para poder unificarlos en el CRM", () => {
    const plan = planificarRecontacto(
      [lead("1", "Clara", MISMO_TEL), lead("2", "Clara Duplicada", MISMO_TEL), lead("3", "Otra")],
      estados([]),
      0,
      AHORA
    );

    expect(plan.duplicados).toHaveLength(1);
    expect(plan.duplicados[0]?.leads.map((l) => l.nombre)).toEqual(["Clara", "Clara Duplicada"]);
    const texto = formatearReporte(plan, true);
    expect(texto).toContain("FICHAS DUPLICADAS EN TOKKO");
    expect(texto).toContain("Clara Duplicada");
  });

  it("detectarDuplicados no reporta a los que tienen telefono propio", () => {
    expect(detectarDuplicados([lead("1"), lead("2"), lead("3")])).toEqual([]);
  });
});

describe("cuando se puede correr", () => {
  const enHorario = (h: number) => new Date(2026, 7, 25, h, 0, 0);

  // Nadie quiere un WhatsApp de la inmobiliaria a las 3 de la manana.
  it.each([0, 3, 6, 8, 20, 22, 23])("a las %i:00 NO corre", (hora) => {
    const r = puedeCorrer(enHorario(hora), undefined);

    expect(r.puede).toBe(false);
    if (!r.puede) expect(r.motivo).toBe("fuera_de_horario");
  });

  it.each([9, 12, 15, 19])("a las %i:00 si corre", (hora) => {
    expect(puedeCorrer(enHorario(hora), undefined).puede).toBe(true);
  });

  it("respeta el intervalo minimo entre corridas", () => {
    const ahora = enHorario(12);
    const haceRato = new Date(ahora.getTime() - 20 * 60_000).toISOString();

    const r = puedeCorrer(ahora, haceRato);

    expect(r.puede).toBe(false);
    if (!r.puede) {
      expect(r.motivo).toBe("muy_pronto_desde_la_ultima");
      expect(r.detalle).toContain("20 min");
    }
  });

  it("pasado el intervalo, corre", () => {
    const ahora = enHorario(12);
    const haceRato = new Date(ahora.getTime() - 46 * 60_000).toISOString();

    expect(puedeCorrer(ahora, haceRato).puede).toBe(true);
  });

  // El horario se evalua primero: aunque haya pasado el intervalo, a las 3 AM
  // no se manda.
  it("el horario manda sobre el intervalo", () => {
    const madrugada = enHorario(3);
    const haceMucho = new Date(madrugada.getTime() - 500 * 60_000).toISOString();

    const r = puedeCorrer(madrugada, haceMucho);

    expect(r.puede).toBe(false);
    if (!r.puede) expect(r.motivo).toBe("fuera_de_horario");
  });
});
