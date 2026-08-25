import type { Lead, Property, PropertyStatus } from "shared-types";
import { normalizarTelefono } from "shared-types";
import { resolverEstadoPropiedad } from "./estadoPropiedad.js";

/**
 * Mapeo de las respuestas crudas de Tokko a los tipos del proyecto.
 *
 * Todo lo de acá es puro y testeable sin red. La forma de los campos salió de
 * sondear la cuenta real, no de la documentación: `type` es un objeto en
 * inglés, el precio vive en `operations[].prices[]`, `expenses` viene como
 * string, y la disponibilidad no existe como dato estructurado.
 */

export interface OperacionPrecio {
  /** `venta`, `alquiler` o `alquiler_temporario`. */
  operacion: string;
  moneda: string;
  precio: number;
}

/** Tokko devuelve los tipos en inglés; el agente habla español. */
const TIPOS: Record<string, string> = {
  Apartment: "departamento",
  House: "casa",
  Condo: "PH",
  Office: "oficina",
  Warehouse: "galpón",
  Land: "terreno",
};

const OPERACIONES: Record<string, string> = {
  Sale: "venta",
  Rent: "alquiler",
  "Temporary rent": "alquiler_temporario",
};

function aNumero(valor: unknown): number | undefined {
  if (valor === null || valor === undefined || valor === "") return undefined;
  const n = Number(String(valor).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function extraerOperaciones(raw: any): OperacionPrecio[] {
  const salida: OperacionPrecio[] = [];
  for (const op of raw?.operations ?? []) {
    const operacion = OPERACIONES[op?.operation_type] ?? String(op?.operation_type ?? "").toLowerCase();
    for (const p of op?.prices ?? []) {
      const precio = aNumero(p?.price);
      if (precio === undefined || precio <= 0) continue;
      salida.push({ operacion, moneda: String(p?.currency ?? ""), precio });
    }
  }
  return salida;
}

/**
 * Una propiedad puede estar publicada en venta **y** en alquiler. Por decisión
 * del dueño del repo **no se prioriza ninguna**: si hay más de una operación,
 * `precio`/`moneda` quedan sin definir y las dos viajan en `operaciones`, para
 * que el agente mencione ambas o pregunte cuál le interesa al cliente.
 *
 * Inventar cuál quiere el cliente es peor que preguntar, y un `precio` único
 * elegido por nosotros es exactamente esa invención.
 */
function precioSinAmbiguedad(ops: OperacionPrecio[]): { precio?: number; moneda?: string } {
  const operacionesDistintas = new Set(ops.map((o) => o.operacion));
  if (ops.length === 1 || operacionesDistintas.size === 1) {
    return { precio: ops[0]?.precio, moneda: ops[0]?.moneda };
  }
  return {};
}

export interface PropiedadMapeada {
  property: Property;
  /** De dónde salió el estado, para poder auditarlo. */
  fuenteEstado: string;
}

/**
 * Devuelve `null` si al registro le falta algo sin lo cual no se puede
 * trabajar. El llamador tiene que **loguear** esos descartes: una propiedad
 * que desaparece del catálogo en silencio hace que el agente conteste "no la
 * encontré" sobre algo que sí existe.
 */
export function mapearPropiedad(raw: any): PropiedadMapeada | null {
  const id = raw?.id !== undefined && raw?.id !== null ? String(raw.id) : "";
  if (!id) return null;

  const direccion = String(raw?.real_address || raw?.address || raw?.fake_address || "").trim();
  if (!direccion) return null;

  const etiquetas = [...(raw?.tags ?? []), ...(raw?.custom_tags ?? [])]
    .map((t: any) => String(t?.name ?? t ?? ""))
    .filter(Boolean);

  const estadoResuelto = resolverEstadoPropiedad({
    etiquetas,
    titulo: String(raw?.publication_title ?? ""),
  });

  const operaciones = extraerOperaciones(raw);
  const { precio, moneda } = precioSinAmbiguedad(operaciones);

  const fotos: string[] = [];
  const planos: string[] = [];
  for (const f of raw?.photos ?? []) {
    const url = String(f?.image ?? "");
    if (!url) continue;
    (f?.is_blueprint ? planos : fotos).push(url);
  }

  const property: Property & { operaciones?: OperacionPrecio[] } = {
    id,
    tokkoId: id,
    direccion,
    direccionCorta: String(raw?.address || direccion).trim(),
    tipo: TIPOS[raw?.type?.name] ?? String(raw?.type?.name ?? "").toLowerCase() ?? "",
    estado: estadoResuelto.estado as PropertyStatus,
    precio,
    moneda,
    expensas: aNumero(raw?.expenses),
    ambientes: aNumero(raw?.room_amount),
    metrosCuadrados: aNumero(raw?.total_surface),
    lat: aNumero(raw?.geo_lat),
    lng: aNumero(raw?.geo_long),
    fotos: fotos.length ? fotos : undefined,
    planos: planos.length ? planos : undefined,
    videos: (raw?.videos ?? []).map((v: any) => String(v?.url ?? v ?? "")).filter(Boolean) || undefined,
    linkPortal: raw?.public_url ? String(raw.public_url) : undefined,
    operaciones: operaciones.length ? operaciones : undefined,
  };

  return { property, fuenteEstado: estadoResuelto.fuente };
}

/**
 * Temperatura del lead. Tokko no tiene el concepto: se deriva de cuántos días
 * pasaron desde que se creó/interactuó. Los cortes salen de
 * `docs/intent_catalog.yaml` (recontacto_lead_frio).
 */
function temperaturaPorDias(dias: number): Lead["temperatura"] {
  if (dias <= 7) return "nuevo";
  if (dias <= 30) return "tibio";
  return "frio";
}

export interface LeadMapeado {
  lead: Lead;
  /** `false` si el teléfono no sirve para WhatsApp: no se le puede escribir. */
  contactable: boolean;
  motivoNoContactable?: string;
}

export function mapearLead(raw: any, ahora: Date = new Date()): LeadMapeado | null {
  const id = raw?.id !== undefined && raw?.id !== null ? String(raw.id) : "";
  if (!id) return null;

  const crudo = [raw?.cellphone, raw?.phone, raw?.other_phone]
    .map((v: unknown) => String(v ?? "").trim())
    .find(Boolean) ?? "";
  const tel = normalizarTelefono(crudo);

  const desde = raw?.created_at ? new Date(String(raw.created_at)) : undefined;
  const dias =
    desde && !Number.isNaN(desde.getTime())
      ? Math.max(0, Math.floor((ahora.getTime() - desde.getTime()) / 86_400_000))
      : 0;

  return {
    lead: {
      id,
      tokkoId: id,
      nombre: String(raw?.name ?? "").trim() || "(sin nombre)",
      // Vacío cuando no es usable: nunca un número a medias que alguien pueda
      // llegar a mandar por accidente.
      telefonoWhatsapp: tel.paraEnviar ?? "",
      email: raw?.email ? String(raw.email) : undefined,
      temperatura: temperaturaPorDias(dias),
      propiedadesDeInteres: [],
      ultimaInteraccion: desde && !Number.isNaN(desde.getTime()) ? desde.toISOString() : undefined,
      diasSinRespuesta: dias,
    },
    contactable: tel.usable,
    motivoNoContactable: tel.usable ? undefined : tel.motivo,
  };
}
