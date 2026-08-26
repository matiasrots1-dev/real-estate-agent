/**
 * Saca los identificadores de un texto, dejando el tono intacto.
 *
 * Para qué: los mensajes que el broker escribe se guardan para mostrárselos a
 * Claude como ejemplos de estilo. El objetivo es que aprenda **cómo** escribe,
 * no **a quién** le escribió — un ejemplo con el nombre de un cliente puede
 * terminar citado en el borrador para otro.
 *
 * El sesgo es deliberado y asimétrico: se redactan identificadores (nombres,
 * teléfonos, mails, direcciones, links) y **no se toca nada más**. Los precios,
 * las muletillas, los signos, los emojis y la forma de armar la frase son
 * justamente la señal que se quiere conservar — redactarlos de más deja un
 * ejemplo que no enseña nada.
 */

export interface OpcionesAnonimizado {
  /**
   * Nombres a redactar explícitamente (de contactos y de agentes). Es lo que
   * cubre los casos que ningún patrón agarra: "le dije a Marcela que sí".
   */
  nombres?: Iterable<string>;
  /** Direcciones conocidas (ej. las propiedades de la cartera). */
  direcciones?: Iterable<string>;
}

/** Saludos tras los cuales, en español, suele venir un nombre propio. */
const SALUDOS = [
  "hola",
  "buenas",
  "buen día",
  "buenos días",
  "buenas tardes",
  "buenas noches",
  "gracias",
  "chau",
  "saludos",
  "estimado",
  "estimada",
  "querido",
  "querida",
];

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Un token que parece nombre propio: empieza en mayúscula y tiene al menos 3
 * letras. Se usa **sólo** detrás de un saludo, no en cualquier lugar del
 * texto: redactar toda palabra capitalizada destruiría el tono (se llevaría
 * puesto "Palermo", "Lunes", y el arranque de cada oración).
 */
const PALABRA_CAPITALIZADA = "[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}";

export function anonimizar(texto: string, opciones: OpcionesAnonimizado = {}): string {
  let salida = String(texto ?? "");
  if (!salida.trim()) return salida;

  // 1. Mails y links primero: pueden contener nombres y números que los otros
  //    patrones romperían a la mitad.
  salida = salida.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[MAIL]");
  salida = salida.replace(/https?:\/\/\S+/gi, "[LINK]");

  // 2. Direcciones conocidas, antes que los números sueltos.
  for (const dir of opciones.direcciones ?? []) {
    const limpia = String(dir).trim();
    if (limpia.length < 4) continue;
    salida = salida.replace(new RegExp(escaparRegex(limpia), "gi"), "[DIRECCION]");
  }

  // 3. Calle + altura: "Olleros 3700", "Av. Santa Fe 3253", "Mariano Acha 1653".
  //    Las palabras de continuación admiten 1 sola minúscula ("Fe", "San") —
  //    con el mínimo de 2 se perdía "Av. Santa Fe 3253".
  const CONTINUACION = "[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+";
  salida = salida.replace(
    new RegExp(
      `\\b(?:[Aa]v\\.?|[Aa]venida|[Cc]alle)?\\s*${PALABRA_CAPITALIZADA}(?:\\s+${CONTINUACION}){0,2}\\s+\\d{2,5}\\b`,
      "g"
    ),
    "[DIRECCION]"
  );

  // 4. Teléfonos: 8 dígitos o más, con o sin separadores. El umbral alto
  //    evita comerse precios ("178", "425000" queda; un teléfono no).
  salida = salida.replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => {
    const digitos = m.replace(/\D/g, "");
    return digitos.length >= 8 ? "[TELEFONO]" : m;
  });

  // 5. Nombres conocidos, en cualquier parte del texto.
  for (const nombre of opciones.nombres ?? []) {
    for (const parte of String(nombre).split(/\s+/)) {
      const limpia = parte.trim();
      // Se ignoran los tokens cortos: "De", "La", "Del" romperían el texto.
      if (limpia.length < 3) continue;
      salida = salida.replace(new RegExp(`\\b${escaparRegex(limpia)}\\b`, "gi"), "[NOMBRE]");
    }
  }

  // 6. Vocativo detrás de un saludo: "Hola Juan", "Gracias Marcela".
  //    Es lo que cubre a los contactos que no están en ninguna lista.
  for (const saludo of SALUDOS) {
    // El saludo se busca sin distinguir mayúsculas, pero la capitalización de
    // lo que sigue se verifica DENTRO del reemplazo, no en el patrón: con el
    // flag `i` la clase `[A-Z]` también matchea minúsculas, y entonces
    // "Buenas tardes" se convertía en "Buenas [NOMBRE]".
    const patron = new RegExp(`(\\b${escaparRegex(saludo)}\\b[\\s,!]*)([\\p{L}]{3,})`, "giu");
    salida = salida.replace(patron, (m, pre: string, palabra: string) => {
      const empiezaEnMayuscula = palabra[0] === palabra[0]?.toUpperCase() && palabra[0] !== palabra[0]?.toLowerCase();
      if (!empiezaEnMayuscula) return m;
      // Tampoco se redacta si es una palabra común que simplemente arranca la
      // oración ("Gracias Igualmente", "Hola Buenas").
      if (COMUNES.has(sinAcentos(palabra).toLowerCase())) return m;
      return `${pre}[NOMBRE]`;
    });
  }

  return salida;
}

/**
 * Palabras que aparecen detrás de un saludo y NO son nombres propios. Sin
 * esta lista, "Gracias Igualmente" quedaría "Gracias [NOMBRE]".
 */
const COMUNES = new Set([
  "buenas",
  "buenos",
  "buen",
  "igualmente",
  "gracias",
  "como",
  "que",
  "por",
  "para",
  "muchas",
  "muchisimas",
  "mil",
  "perfecto",
  "dale",
  "listo",
  "barbaro",
  "genial",
  "disculpa",
  "disculpe",
  "perdon",
  "todo",
  "nos",
  "te",
  "le",
  "ahi",
  "aca",
  "hoy",
  "manana",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
]);
