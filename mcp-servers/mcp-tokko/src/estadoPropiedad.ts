import type { PropertyStatus } from "shared-types";

/**
 * Resuelve el estado de una propiedad a partir de lo que Tokko realmente
 * expone.
 *
 * El problema de fondo: **Tokko no tiene disponibilidad como dato
 * estructurado**. Verificado contra la cuenta real — `status` vale `2` en las
 * 76 propiedades, `situation` es ocupación ("In use"/"Empty"), y las
 * reservadas están marcadas escribiendo `RESERVADO` en `publication_title`.
 *
 * Orden de decisión, definido por el dueño del repo:
 *  1. **Etiqueta** (`tags` / `custom_tags`), si existe una que indique estado.
 *  2. **Título del aviso**, como respaldo.
 *  3. Si la señal es **ambigua o no clasificable con confianza** →
 *     `indeterminado`, para que el agente escale en vez de afirmar que está
 *     disponible.
 *
 * El sesgo es deliberado y asimétrico: un falso positivo (decir "reservada"
 * de una disponible) cuesta una consulta; un falso negativo (ofrecer una
 * reservada) le hace quedar mal con un cliente y no se deshace.
 */

/** Patrones que se reconocen con confianza, ya normalizados. */
const PATRONES: ReadonlyArray<{ marca: string; estado: PropertyStatus }> = [
  { marca: "reservado", estado: "reservada" },
  { marca: "reservada", estado: "reservada" },
  { marca: "vendido", estado: "vendida" },
  { marca: "vendida", estado: "vendida" },
  { marca: "alquilado", estado: "alquilada" },
  { marca: "alquilada", estado: "alquilada" },
];

/**
 * Señales que *parecen* indicar un estado pero no lo dicen. Se listan aparte
 * para que caigan en `indeterminado` en vez de pasar como disponibles: son
 * justamente los casos donde asumir es peligroso.
 */
const AMBIGUAS = ["reserva", "reservar", "en reserva", "a reservar", "pre reserva", "prereserva", "senado", "seniado"];

/** Minúsculas y sin acentos, para que "Reservada" y "RESERVÁDO" matcheen igual. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Busca la marca como **palabra completa**, no como subcadena. Sin esto,
 * "invendido" o un nombre de calle que contenga la marca darían un falso
 * positivo — inofensivo para el cliente, pero te esconde una propiedad que sí
 * estaba disponible.
 */
function contienePalabra(textoNormalizado: string, palabra: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${palabra}([^a-z0-9]|$)`).test(textoNormalizado);
}

export interface SenalesDeEstado {
  /** Nombres de `tags` y `custom_tags` de Tokko. */
  etiquetas?: string[];
  /** `publication_title` del aviso. */
  titulo?: string;
}

export interface EstadoResuelto {
  estado: PropertyStatus;
  /** De dónde salió, para poder auditarlo y explicarlo. */
  fuente: "etiqueta" | "titulo" | "sin_marca" | "ambiguo";
  /** Qué texto disparó la decisión. Vacío cuando no hubo marca. */
  senal?: string;
}

function clasificarTexto(texto: string): { estado: PropertyStatus; ambiguo: boolean } | null {
  const n = normalizar(texto);

  for (const { marca, estado } of PATRONES) {
    if (contienePalabra(n, marca)) return { estado, ambiguo: false };
  }
  // Se evalúa DESPUÉS de los patrones exactos: "reservado" gana sobre
  // "reserva", que es su prefijo.
  for (const dudosa of AMBIGUAS) {
    if (contienePalabra(n, dudosa)) return { estado: "indeterminado", ambiguo: true };
  }
  return null;
}

export function resolverEstadoPropiedad(senales: SenalesDeEstado): EstadoResuelto {
  // 1. Etiquetas primero: es la señal que el broker controla explícitamente.
  for (const etiqueta of senales.etiquetas ?? []) {
    const r = clasificarTexto(etiqueta);
    if (r) {
      return {
        estado: r.estado,
        fuente: r.ambiguo ? "ambiguo" : "etiqueta",
        senal: etiqueta,
      };
    }
  }

  // 2. Título como respaldo.
  if (senales.titulo) {
    const r = clasificarTexto(senales.titulo);
    if (r) {
      return {
        estado: r.estado,
        fuente: r.ambiguo ? "ambiguo" : "titulo",
        senal: senales.titulo,
      };
    }
  }

  // 3. Sin ninguna marca. Acá SÍ se asume disponible, y es una decisión
  //    consciente: 62 de las 76 propiedades no tienen marca porque están
  //    efectivamente disponibles. La convención es "se marca lo que NO está
  //    disponible". El riesgo residual —que el broker se olvide de marcar una
  //    reservada— está anotado como riesgo abierto en docs/TASKS.md y no lo
  //    resuelve el código.
  return { estado: "disponible", fuente: "sin_marca" };
}
