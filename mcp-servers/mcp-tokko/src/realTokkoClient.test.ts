import { describe, expect, it } from "vitest";
import { RealTokkoClient } from "./realTokkoClient.js";
import { mapearPropiedad, extraerOperaciones } from "./tokkoMapper.js";

const MIA = 94185;
const OTRA = 80242;

function prop(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    address: "Mariano Acha al 1600",
    real_address: "Mariano Acha 1653 PB 2",
    publication_title: "Departamento en Venta",
    branch: { id: MIA, name: "moderna matias" },
    type: { name: "Apartment" },
    expenses: "290000",
    geo_lat: "-34.577",
    geo_long: "-58.472",
    room_amount: "4",
    total_surface: "170.00",
    operations: [{ operation_type: "Sale", prices: [{ currency: "USD", price: 425000 }] }],
    photos: [
      { image: "https://x/a.jpg", is_blueprint: false },
      { image: "https://x/p.jpg", is_blueprint: true },
    ],
    ...over,
  };
}

/** Simula la API: pagina de a 50, como hace Tokko de verdad. */
function apiFalsa(propiedades: unknown[], contactos: unknown[] = []) {
  const impl = (async (url: string) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const fuente = u.pathname.includes("/contact") ? contactos : propiedades;
    const lote = fuente.slice(offset, offset + 50);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ meta: { total_count: fuente.length }, objects: lote }),
    } as Response;
  }) as unknown as typeof fetch;
  return impl;
}

function cliente(propiedades: unknown[], contactos: unknown[] = []) {
  return new RealTokkoClient({
    apiKey: "k",
    branchId: MIA,
    fetchImpl: apiFalsa(propiedades, contactos),
    onDescarte: () => {},
  });
}

describe("filtro de sucursal", () => {
  // Modo de fallo 1 del pre-mortem. El filtro del servidor NO funciona
  // (verificado: ?branch_id=X devuelve 200 y todas las propiedades igual), asi
  // que si este se cae, el agente cita propiedades de la otra sucursal sin que
  // salte ningun error.
  it("searchProperties solo devuelve las de la sucursal configurada", async () => {
    const c = cliente([prop({ id: 1 }), prop({ id: 2, branch: { id: OTRA } }), prop({ id: 3 })]);

    const r = await c.searchProperties({});

    expect(r.map((p) => p.id)).toEqual(["1", "3"]);
  });

  it("getProperty tampoco puede leer una de otra sucursal", async () => {
    const c = cliente([prop({ id: 2, branch: { id: OTRA } })]);

    expect(await c.getProperty("2")).toBeNull();
  });

  it("sin branchId configurado devuelve todas", async () => {
    const c = new RealTokkoClient({
      apiKey: "k",
      fetchImpl: apiFalsa([prop({ id: 1 }), prop({ id: 2, branch: { id: OTRA } })]),
      onDescarte: () => {},
    });

    expect((await c.searchProperties({})).length).toBe(2);
  });
});

describe("paginacion", () => {
  // Tokko topea la pagina en 50 aunque se pida mas. Avanzar el offset por lo
  // pedido saltearia registros y devolveria una muestra dispersa que parece un
  // barrido completo.
  it("lee todas las paginas y no saltea registros", async () => {
    const muchas = Array.from({ length: 137 }, (_, i) => prop({ id: i + 1 }));
    const c = cliente(muchas);

    const r = await c.searchProperties({});

    expect(r.length).toBe(137);
    expect(new Set(r.map((p) => p.id)).size).toBe(137);
  });
});

describe("mapeo de precio", () => {
  it("una sola operacion deja el precio disponible", () => {
    const m = mapearPropiedad(prop())!;

    expect(m.property.precio).toBe(425000);
    expect(m.property.moneda).toBe("USD");
  });

  // Decision del dueno del repo: no priorizar. Si hay venta Y alquiler, el
  // precio unico queda sin definir para que el agente pregunte, en vez de
  // cotizarle alquiler a alguien que quiere comprar.
  it("con venta y alquiler NO elige uno: deja el precio vacio", () => {
    const m = mapearPropiedad(
      prop({
        operations: [
          { operation_type: "Sale", prices: [{ currency: "USD", price: 425000 }] },
          { operation_type: "Rent", prices: [{ currency: "ARS", price: 900000 }] },
        ],
      })
    )!;

    expect(m.property.precio).toBeUndefined();
    expect(m.property.moneda).toBeUndefined();
    // Pero las dos viajan, para poder mencionarlas.
    expect((m.property as unknown as { operaciones: unknown[] }).operaciones).toHaveLength(2);
  });

  it("traduce los tipos de operacion al espanol", () => {
    const ops = extraerOperaciones(
      prop({
        operations: [
          { operation_type: "Sale", prices: [{ currency: "USD", price: 1 }] },
          { operation_type: "Temporary rent", prices: [{ currency: "ARS", price: 2 }] },
        ],
      })
    );

    expect(ops.map((o) => o.operacion)).toEqual(["venta", "alquiler_temporario"]);
  });

  it("ignora precios en cero en vez de mostrarlos", () => {
    const ops = extraerOperaciones(prop({ operations: [{ operation_type: "Sale", prices: [{ price: 0 }] }] }));

    expect(ops).toEqual([]);
  });
});

describe("mapeo de la propiedad", () => {
  it("traduce el tipo y separa fotos de planos", () => {
    const m = mapearPropiedad(prop())!;

    expect(m.property.tipo).toBe("departamento");
    expect(m.property.fotos).toEqual(["https://x/a.jpg"]);
    expect(m.property.planos).toEqual(["https://x/p.jpg"]);
  });

  it("convierte a numero los campos que Tokko manda como string", () => {
    const m = mapearPropiedad(prop())!;

    expect(m.property.expensas).toBe(290000);
    expect(m.property.ambientes).toBe(4);
    expect(m.property.lat).toBeCloseTo(-34.577);
  });

  it("resuelve el estado desde el titulo", () => {
    const m = mapearPropiedad(prop({ publication_title: "RESERVADO / Depto con jardin" }))!;

    expect(m.property.estado).toBe("reservada");
    expect(m.fuenteEstado).toBe("titulo");
  });

  it("la etiqueta le gana al titulo", () => {
    const m = mapearPropiedad(prop({ tags: [{ name: "Vendida" }], publication_title: "RESERVADO / Depto" }))!;

    expect(m.property.estado).toBe("vendida");
    expect(m.fuenteEstado).toBe("etiqueta");
  });

  // Modo de fallo 3 del pre-mortem: un descarte silencioso hace que el agente
  // conteste "no la encontre" sobre algo que si existe.
  it("descarta lo que no puede mapear, pero avisando", async () => {
    const avisos: string[] = [];
    const c = new RealTokkoClient({
      apiKey: "k",
      branchId: MIA,
      fetchImpl: apiFalsa([prop({ id: 1 }), prop({ id: null, address: "", real_address: "" })]),
      onDescarte: (q, m) => avisos.push(q + "|" + m),
    });

    expect((await c.searchProperties({})).length).toBe(1);
    expect(avisos).toHaveLength(1);
  });
});

describe("leads", () => {
  const contacto = (over: Record<string, unknown> = {}) => ({
    id: 100,
    name: "Cliente Test",
    cellphone: "91155551234",
    created_at: "2026-01-01T00:00:00",
    ...over,
  });

  it("excluye los que no tienen un telefono usable", async () => {
    const c = cliente(
      [],
      [
        contacto({ id: 1, cellphone: "91155551234" }),
        contacto({ id: 2, cellphone: "1155551234" }), // fijo: no tiene WhatsApp
        contacto({ id: 3, cellphone: "" }),
      ]
    );

    const r = await c.searchLeads({});

    expect(r.map((l) => l.id)).toEqual(["1"]);
  });

  it("normaliza el telefono a E.164 sin +", async () => {
    const c = cliente([], [contacto({ cellphone: "011 15 5555 1234" })]);

    const [lead] = await c.searchLeads({});

    expect(lead.telefonoWhatsapp).toBe("5491155551234");
  });
});

describe("logActivity", () => {
  // Es la unica escritura y no esta confirmado el permiso ni si hay sandbox.
  // Falla ruidosamente en vez de simular que anduvo.
  it("falla explicitamente en vez de fingir que escribio", async () => {
    const c = cliente([]);

    await expect(c.logActivity({ tipo: "visita_agendada" })).rejects.toThrow(/no esta implementado|no está implementado/);
  });
});
