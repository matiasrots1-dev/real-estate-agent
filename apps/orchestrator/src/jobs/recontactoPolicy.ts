import type { Lead } from "shared-types";

/**
 * Quién puede recibir un recontacto proactivo, y cuántos.
 *
 * Este es el único job que le escribe a gente que **no escribió primero**, así
 * que la decisión vive separada de la ejecución: el modo simulacro corre
 * exactamente este mismo cálculo y muestra el resultado sin mandar nada. Si
 * fueran dos caminos distintos, el simulacro podría dejar de reflejar lo que
 * pasa de verdad justo cuando más importa que lo refleje.
 */

export interface RecontactoConfig {
  /** Días mínimos entre dos mensajes a la misma persona. */
  diasEntreMensajes: number;
  /** Cuántas veces como máximo se le puede escribir a alguien, en toda su vida. */
  intentosMaximos: number;
  /** Tope por corrida del scheduler. */
  topePorCorrida: number;
  /** Tope por día calendario, persistido (no se reinicia con el proceso). */
  topePorDia: number;
}

export const CONFIG_POR_DEFECTO: RecontactoConfig = {
  diasEntreMensajes: 60,
  intentosMaximos: 2,
  topePorCorrida: 3,
  topePorDia: 10,
};

export type MotivoSupresion =
  | "sin_telefono_usable"
  | "contactado_hace_poco"
  | "agotó_intentos"
  | "tope_por_corrida"
  | "tope_por_dia";

export interface EstadoDeContacto {
  /** Última vez que se lo contactó, por el sistema **o a mano por el broker**. */
  ultimoContactoAt?: string;
  /** Cuántas veces le escribió el sistema. */
  intentos: number;
}

export interface Destinatario {
  leadId: string;
  /** Va en el reporte a propósito: un número suelto no permite detectar un error, un nombre sí. */
  nombre: string;
  telefono: string;
  intentoNumero: number;
}

export interface Suprimido {
  leadId: string;
  nombre: string;
  motivo: MotivoSupresion;
  /** Contexto legible del porqué, ej. "contactado hace 12 días". */
  detalle?: string;
}

export interface PlanDeRecontacto {
  aEnviar: Destinatario[];
  suprimidos: Suprimido[];
  /** `true` si quedó gente elegible afuera sólo por los topes. */
  topeAlcanzado: boolean;
  /** Cuántos entraron a evaluación. */
  evaluados: number;
}

function diasEntre(desde: string, hasta: Date): number {
  const t = new Date(desde).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((hasta.getTime() - t) / 86_400_000);
}

/**
 * Arma el plan. **No manda nada ni toca ningún store**: es una función pura,
 * así que el simulacro y la ejecución real comparten exactamente esta lógica.
 */
export function planificarRecontacto(
  candidatos: Lead[],
  estados: Map<string, EstadoDeContacto>,
  enviadosHoy: number,
  ahora: Date,
  config: RecontactoConfig = CONFIG_POR_DEFECTO
): PlanDeRecontacto {
  const aEnviar: Destinatario[] = [];
  const suprimidos: Suprimido[] = [];
  let topeAlcanzado = false;

  for (const lead of candidatos) {
    const estado = estados.get(lead.id) ?? { intentos: 0 };
    const nombre = lead.nombre || "(sin nombre)";

    // Un teléfono que no sirve para WhatsApp no es un destinatario. Se
    // reporta igual: si aparece seguido, hay contactos que corregir en el CRM
    // (ver `npm run tokko:telefonos`).
    if (!lead.telefonoWhatsapp) {
      suprimidos.push({ leadId: lead.id, nombre, motivo: "sin_telefono_usable" });
      continue;
    }

    if (estado.intentos >= config.intentosMaximos) {
      suprimidos.push({
        leadId: lead.id,
        nombre,
        motivo: "agotó_intentos",
        detalle: `ya se le escribió ${estado.intentos} ${estado.intentos === 1 ? "vez" : "veces"}`,
      });
      continue;
    }

    // Acá entra el eco de coexistencia: si el broker le escribió a mano desde
    // el celular, ese contacto cuenta igual que uno del sistema. Mandarle
    // "hace tiempo que no sabemos de vos" a alguien con quien hablo ayer es
    // peor que no escribirle nunca.
    if (estado.ultimoContactoAt) {
      const dias = diasEntre(estado.ultimoContactoAt, ahora);
      if (dias < config.diasEntreMensajes) {
        suprimidos.push({
          leadId: lead.id,
          nombre,
          motivo: "contactado_hace_poco",
          detalle: `contactado hace ${dias} ${dias === 1 ? "día" : "días"}`,
        });
        continue;
      }
    }

    // Los topes se evalúan al final: así alguien que igual no era elegible se
    // reporta por su motivo real y no consume cupo.
    if (enviadosHoy + aEnviar.length >= config.topePorDia) {
      suprimidos.push({ leadId: lead.id, nombre, motivo: "tope_por_dia" });
      topeAlcanzado = true;
      continue;
    }
    if (aEnviar.length >= config.topePorCorrida) {
      suprimidos.push({ leadId: lead.id, nombre, motivo: "tope_por_corrida" });
      topeAlcanzado = true;
      continue;
    }

    aEnviar.push({
      leadId: lead.id,
      nombre,
      telefono: lead.telefonoWhatsapp,
      intentoNumero: estado.intentos + 1,
    });
  }

  return { aEnviar, suprimidos, topeAlcanzado, evaluados: candidatos.length };
}

/**
 * El reporte que ve el broker. Muestra **nombre y teléfono de cada
 * destinatario**, no un conteo: la supresión automática puede fallar (el eco
 * de coexistencia es best-effort y Meta no lo reintenta), así que esta lista
 * es la defensa principal, no un extra. Un número suelto no permite detectar
 * que se coló alguien que no corresponde; un nombre sí.
 */
export function formatearReporte(plan: PlanDeRecontacto, simulacro: boolean): string {
  const lineas: string[] = [];
  lineas.push(simulacro ? "RECONTACTO — SIMULACRO (no se mandó nada)" : "RECONTACTO — ENVÍO REAL");
  lineas.push(`evaluados: ${plan.evaluados} | a enviar: ${plan.aEnviar.length} | suprimidos: ${plan.suprimidos.length}`);

  if (plan.aEnviar.length > 0) {
    lineas.push("");
    lineas.push(simulacro ? "Les escribiría a:" : "Se les escribió a:");
    for (const d of plan.aEnviar) {
      lineas.push(`  • ${d.nombre} — ${d.telefono} (intento ${d.intentoNumero})`);
    }
  }

  const porMotivo = new Map<string, Suprimido[]>();
  for (const s of plan.suprimidos) {
    const lista = porMotivo.get(s.motivo) ?? [];
    lista.push(s);
    porMotivo.set(s.motivo, lista);
  }
  if (porMotivo.size > 0) {
    lineas.push("");
    lineas.push("No se les escribe:");
    for (const [motivo, lista] of porMotivo) {
      lineas.push(`  ${motivo} (${lista.length}):`);
      for (const s of lista.slice(0, 10)) {
        lineas.push(`    - ${s.nombre}${s.detalle ? ` — ${s.detalle}` : ""}`);
      }
      if (lista.length > 10) lineas.push(`    … y ${lista.length - 10} más`);
    }
  }

  if (plan.topeAlcanzado) {
    lineas.push("");
    lineas.push("⚠️ Se alcanzó el tope: quedó gente elegible sin contactar. No se siguió enviando.");
  }

  return lineas.join("\n");
}
