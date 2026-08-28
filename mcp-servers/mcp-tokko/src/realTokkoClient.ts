import type { Lead, Property } from "shared-types";
import type {
  LeadSearchFilters,
  LogActivityInput,
  LogActivityResult,
  PropertySearchFilters,
  TokkoClient,
} from "./tokkoClient.js";
import { mapearLead, mapearPropiedad } from "./tokkoMapper.js";

/**
 * Cliente real de Tokko Broker.
 *
 * Tres cosas verificadas contra la cuenta real que condicionan el diseño:
 *
 * 1. **La key va como query param.** Probado también con
 *    `Authorization: Token`: devuelve 200 pero con **7605** propiedades en vez
 *    de 76 — un listado que no es el de esta cuenta. Usar el header haría que
 *    el agente cite propiedades de otras inmobiliarias.
 * 2. **Los filtros del servidor no funcionan y fallan en silencio.**
 *    `/property/?branch_id=X` devuelve 200 y **todas** las propiedades igual;
 *    un parámetro inventado en `/contact/` también se ignora sin error. Por
 *    eso el filtro de sucursal se aplica de este lado.
 * 3. **La página tope es de 50** aunque se pida más, así que el offset avanza
 *    por lo que la API devolvió, nunca por lo que se pidió.
 */

export interface RealTokkoClientOptions {
  apiKey: string;
  baseUrl?: string;
  /**
   * Sólo se exponen las propiedades de esta sucursal. Sin esto, el agente ve
   * las 76 de la cuenta y no las que le corresponden al broker.
   */
  branchId?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onDescarte?: (que: string, motivo: string) => void;
}

const BASE_POR_DEFECTO = "https://www.tokkobroker.com/api/v1";
const TIMEOUT_POR_DEFECTO = 25_000;
/** Tokko topea la página acá aunque se pida más (verificado en `/contact/`). */
const PAGINA = 50;

/**
 * Qué `order_by` acepta cada endpoint. **No es uniforme**: `/contact/` acepta
 * `created_at`, pero el mismo valor en `/property/` devuelve HTTP 400, igual
 * que en `/branch/` y `/user/`. Medido, no leído — ver `docs/tokko-api.md`.
 *
 * Un endpoint sin entrada acá se pide sin `order_by`.
 */
const ORDEN_POR_ENDPOINT: Record<string, string | undefined> = {
  "/contact/": "created_at",
};

function avisarDescarte(que: string, motivo: string): void {
  // Se loguea a propósito: un registro que desaparece del catálogo en silencio
  // hace que el agente conteste "no la encontré" sobre algo que sí existe.
  console.warn(`[tokko] descartado ${que}: ${motivo}`);
}

export class RealTokkoClient implements TokkoClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onDescarte: (que: string, motivo: string) => void;

  constructor(private readonly options: RealTokkoClientOptions) {
    this.base = (options.baseUrl ?? BASE_POR_DEFECTO).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_POR_DEFECTO;
    this.onDescarte = options.onDescarte ?? avisarDescarte;
  }

  private async pedir(ruta: string, params: Record<string, string | number> = {}): Promise<any> {
    const url = new URL(`${this.base}${ruta}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("key", this.options.apiKey);
    url.searchParams.set("format", "json");

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Tokko respondió HTTP ${res.status} en ${ruta}`);
      return JSON.parse(await res.text());
    } finally {
      clearTimeout(t);
    }
  }

  /** Trae todas las páginas. El offset avanza por lo devuelto, no por lo pedido. */
  private async pedirTodo(ruta: string, params: Record<string, string | number> = {}): Promise<any[]> {
    const todos: any[] = [];
    let offset = 0;
    for (;;) {
      // El `order_by` estabiliza el paginado sobre un dataset VIVO: sin él, un
      // registro nuevo corre todos los offsets y cada corrida lee un
      // subconjunto distinto. Pero sólo se manda donde el endpoint lo acepta —
      // en `/property/` el mismo parámetro devuelve 400.
      const orden = ORDEN_POR_ENDPOINT[ruta];
      const json = await this.pedir(ruta, {
        ...params,
        ...(orden ? { order_by: orden } : {}),
        limit: PAGINA,
        offset,
      });
      const lote: any[] = json?.objects ?? [];
      todos.push(...lote);
      offset += lote.length;
      const total = json?.meta?.total_count ?? todos.length;
      if (lote.length === 0 || todos.length >= total) break;
    }
    return todos;
  }

  /**
   * **Único lugar donde se aplica el filtro de sucursal.** Todas las lecturas
   * de propiedades pasan por acá, así que ningún método puede olvidárselo.
   */
  private async propiedadesDeLaSucursal(): Promise<Property[]> {
    const crudas = await this.pedirTodo("/property/");
    const salida: Property[] = [];

    for (const raw of crudas) {
      if (this.options.branchId !== undefined && raw?.branch?.id !== this.options.branchId) continue;
      const mapeada = mapearPropiedad(raw);
      if (!mapeada) {
        this.onDescarte(`propiedad ${raw?.id ?? "(sin id)"}`, "le falta id o dirección");
        continue;
      }
      salida.push(mapeada.property);
    }
    return salida;
  }

  /**
   * Confirma que estamos autenticados **de verdad**, no sólo que la API
   * responde 200.
   *
   * Medido (docs/tokko-api.md): sin key, o con la key en el header
   * `Authorization` o en `?api_key=`, la API devuelve **200 con el catálogo
   * público** — 7613 propiedades que no son de esta cuenta. Sólo una key
   * *inválida* produce un 401. O sea que un cliente mal configurado no falla:
   * le cita a los clientes propiedades de otras inmobiliarias.
   *
   * La verificación es **diferencial** y no por umbral: se pide el total con
   * key y sin key. Si dan lo mismo, la key no se está aplicando. Un umbral
   * ("más de N propiedades es sospechoso") sería una adivinanza que rompería
   * para una inmobiliaria grande; esto compara contra la respuesta anónima
   * real, que es la evidencia directa.
   */
  async verificarAutenticacion(): Promise<{ ok: boolean; conKey: number; sinKey: number; motivo?: string }> {
    if (!this.options.apiKey?.trim()) {
      return { ok: false, conKey: 0, sinKey: 0, motivo: "no hay TOKKO_API_KEY configurada" };
    }

    const conKey = (await this.pedir("/property/", { limit: 1 }))?.meta?.total_count ?? -1;

    const url = new URL(`${this.base}/property/`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("format", "json");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let sinKey = -1;
    try {
      const res = await this.fetchImpl(url.toString(), { signal: ctrl.signal });
      if (res.ok) sinKey = JSON.parse(await res.text())?.meta?.total_count ?? -1;
    } catch {
      // Que la llamada anónima falle no prueba nada malo de la nuestra: se
      // deja pasar y sólo se compara si se pudo obtener.
      sinKey = -1;
    } finally {
      clearTimeout(t);
    }

    if (sinKey >= 0 && conKey === sinKey) {
      return {
        ok: false,
        conKey,
        sinKey,
        motivo: `con key y sin key devuelven lo mismo (${conKey}): la key NO se está aplicando`,
      };
    }

    return { ok: true, conKey, sinKey };
  }

  async searchProperties(filters: PropertySearchFilters): Promise<Property[]> {
    const todas = await this.propiedadesDeLaSucursal();
    const coincide = (p: Property) => {
      const texto = `${p.direccion} ${p.direccionCorta} ${p.tipo}`.toLowerCase();
      if (filters.barrio && !texto.includes(filters.barrio.toLowerCase())) return false;
      if (filters.direccion && !texto.includes(filters.direccion.toLowerCase())) return false;
      if (filters.tipo && p.tipo.toLowerCase() !== filters.tipo.toLowerCase()) return false;
      if (filters.codigo && p.tokkoId !== filters.codigo && p.id !== filters.codigo) return false;
      return true;
    };
    return todas.filter(coincide);
  }

  async getProperty(propertyId: string): Promise<Property | null> {
    // Pasa por el mismo filtro: pedir una propiedad por id no puede ser la
    // puerta de atrás para leer una de otra sucursal.
    const todas = await this.propiedadesDeLaSucursal();
    return todas.find((p) => p.id === propertyId || p.tokkoId === propertyId) ?? null;
  }

  async searchLeads(filters: LeadSearchFilters): Promise<Lead[]> {
    const crudos = await this.pedirTodo("/contact/");
    const salida: Lead[] = [];

    for (const raw of crudos) {
      const mapeado = mapearLead(raw);
      if (!mapeado) continue;
      // Un lead sin teléfono usable no puede recibir un WhatsApp. Se excluye
      // de las búsquedas para que ningún job lo dé por contactado.
      // `npm run tokko:telefonos` lista cuáles son y por qué.
      if (!mapeado.contactable) continue;
      const { lead } = mapeado;
      if (filters.temperatura && lead.temperatura !== filters.temperatura) continue;
      if (filters.diasSinRespuestaMin !== undefined && lead.diasSinRespuesta < filters.diasSinRespuestaMin) continue;
      salida.push(lead);
    }
    return salida;
  }

  async getLead(leadId: string): Promise<Lead | null> {
    const json = await this.pedir(`/contact/${encodeURIComponent(leadId)}/`);
    const mapeado = mapearLead(json);
    return mapeado?.lead ?? null;
  }

  async logActivity(_input: LogActivityInput): Promise<LogActivityResult> {
    // Es la única operación de ESCRITURA y todavía no se confirmó con el
    // soporte de Tokko si el plan la permite ni si hay un sandbox. Escribir a
    // ciegas sobre fichas de clientes reales no es aceptable, así que falla
    // ruidosamente en vez de simular que anduvo.
    throw new Error(
      "logActivity no está implementado todavía: falta confirmar con Tokko el permiso de escritura y si hay ambiente de prueba (docs/TASKS.md)."
    );
  }
}
