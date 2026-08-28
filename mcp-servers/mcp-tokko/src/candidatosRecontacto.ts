/**
 * Quiénes entran siquiera a considerarse para un recontacto proactivo.
 *
 * El criterio lo definió el dueño del repo mirando la distribución real de los
 * 4683 contactos de la cuenta:
 *
 *     sin filtro                                              4683
 *     agente = Matias Rots                                    1324
 *     estado != Cerrado                                        538
 *     teléfono usable para WhatsApp                           3655
 *     ---------------------------------------------------------
 *     los cuatro juntos + barrio de sus propiedades              29
 *
 * El cruce por barrio no es sólo cautela: son los únicos a los que el agente
 * les puede ofrecer algo concreto, porque son los que consultaron por zonas
 * donde el broker efectivamente tiene propiedades.
 *
 * `lead_status` es la señal más fuerte de todas: **4145 de 4683 están
 * "Cerrado"** (88.5%). Escribirle a alguien cuyo tema ya terminó es lo que más
 * riesgo tiene, así que se excluyen siempre.
 */

export interface CriterioCandidatos {
  /** Nombre exacto del agente asignado en Tokko. */
  agente?: string;
  /** Estados de `lead_status` que se EXCLUYEN. */
  estadosExcluidos: string[];
  /** Etiquetas de barrio que habilitan. Vacío = no se filtra por barrio. */
  barrios: string[];
}

export const CRITERIO_POR_DEFECTO: CriterioCandidatos = {
  agente: "Matias Rots",
  estadosExcluidos: ["Cerrado"],
  barrios: ["Colegiales", "Palermo Hollywood", "Palermo Chico", "Las Cañitas", "Belgrano", "Núñez"],
};

function nombreDe(valor: unknown): string {
  if (!valor) return "";
  if (typeof valor === "string") return valor;
  if (typeof valor === "object" && valor !== null && "name" in valor) {
    return String((valor as { name?: unknown }).name ?? "");
  }
  return "";
}

/** Comparación tolerante: sin acentos, sin mayúsculas, sin espacios de más. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Decide si un contacto crudo de Tokko entra al conjunto de candidatos.
 * **No decide si se le escribe** — eso lo resuelve la política de recontacto
 * (ventana de 60 días, máximo de intentos, topes).
 */
export function esCandidatoARecontacto(raw: any, criterio: CriterioCandidatos = CRITERIO_POR_DEFECTO): boolean {
  if (criterio.agente) {
    if (normalizar(nombreDe(raw?.agent)) !== normalizar(criterio.agente)) return false;
  }

  const estado = normalizar(nombreDe(raw?.lead_status));
  if (criterio.estadosExcluidos.some((e) => normalizar(e) === estado)) return false;

  if (criterio.barrios.length > 0) {
    const etiquetas = (raw?.tags ?? []).map((t: any) => normalizar(nombreDe(t) || String(t ?? "")));
    const hayBarrio = criterio.barrios.some((b) => etiquetas.includes(normalizar(b)));
    if (!hayBarrio) return false;
  }

  return true;
}
