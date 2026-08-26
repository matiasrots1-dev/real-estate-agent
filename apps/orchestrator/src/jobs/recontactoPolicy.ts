import type { Lead } from "shared-types";

/**
 * Quién puede recibir un recontacto proactivo, cuántos, y cuándo.
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
  /**
   * Minutos mínimos entre dos corridas que envían. Sin esto, con el scheduler
   * cada 5 minutos el tope diario se agota en 20 minutos y parece un bot.
   */
  intervaloEntreCorridasMinutos: number;
  /** Hora local (0-23) a partir de la cual se puede enviar. */
  horaInicio: number;
  /** Hora local (0-23) hasta la cual se puede enviar, exclusiva. */
  horaFin: number;
}

export const CONFIG_POR_DEFECTO: RecontactoConfig = {
  diasEntreMensajes: 60,
  intentosMaximos: 2,
  topePorCorrida: 3,
  topePorDia: 10,
  intervaloEntreCorridasMinutos: 45,
  horaInicio: 9,
  horaFin: 20,
};

export type MotivoSupresion =
  /** La linea del broker, su numero, o el telefono de un usuario de la cuenta. */
  | "numero_interno"
  | "sin_telefono_usable"
  | "contactado_hace_poco"
  | "agotó_intentos"
  | "duplicado_en_esta_corrida"
  | "tope_por_corrida"
  | "tope_por_dia";

export type MotivoNoCorre = "fuera_de_horario" | "muy_pronto_desde_la_ultima";

export interface EstadoDeContacto {
  /** Última vez que se lo contactó, por el sistema **o a mano por el broker**. */
  ultimoContactoAt?: string;
  /** Cuántas veces le escribió el sistema. */
  intentos: number;
}

/**
 * El estado se consulta por las dos claves. **Por teléfono además de por
 * leadId** porque Tokko tiene fichas duplicadas de la misma persona: sin esto,
 * dos fichas de "Clara" significan dos mensajes a Clara.
 */
export interface EstadosDeContacto {
  porLead: Map<string, EstadoDeContacto>;
  porTelefono: Map<string, EstadoDeContacto>;
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
  detalle?: string;
}

/** Dos o más fichas de Tokko que comparten teléfono: la misma persona, cargada dos veces. */
export interface Duplicado {
  telefono: string;
  leads: Array<{ id: string; nombre: string }>;
}

export interface PlanDeRecontacto {
  aEnviar: Destinatario[];
  suprimidos: Suprimido[];
  /** Fichas duplicadas detectadas, para unificarlas en el CRM. */
  duplicados: Duplicado[];
  topeAlcanzado: boolean;
  evaluados: number;
}

function diasEntre(desde: string, hasta: Date): number {
  const t = new Date(desde).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.floor((hasta.getTime() - t) / 86_400_000);
}

/**
 * ¿Se puede correr ahora? Separado del plan porque son dos preguntas
 * distintas: "¿es momento?" y "¿a quién?".
 */
export function puedeCorrer(
  ahora: Date,
  ultimaCorridaAt: string | undefined,
  config: RecontactoConfig = CONFIG_POR_DEFECTO
): { puede: true } | { puede: false; motivo: MotivoNoCorre; detalle: string } {
  const hora = ahora.getHours();
  if (hora < config.horaInicio || hora >= config.horaFin) {
    return {
      puede: false,
      motivo: "fuera_de_horario",
      detalle: `son las ${hora}:00 y la ventana es ${config.horaInicio}:00–${config.horaFin}:00`,
    };
  }

  if (ultimaCorridaAt) {
    const minutos = Math.floor((ahora.getTime() - new Date(ultimaCorridaAt).getTime()) / 60_000);
    if (minutos < config.intervaloEntreCorridasMinutos) {
      return {
        puede: false,
        motivo: "muy_pronto_desde_la_ultima",
        detalle: `pasaron ${minutos} min de los ${config.intervaloEntreCorridasMinutos} requeridos`,
      };
    }
  }

  return { puede: true };
}

/** Agrupa candidatos que comparten teléfono: son la misma persona duplicada en el CRM. */
export function detectarDuplicados(candidatos: Lead[]): Duplicado[] {
  const porTelefono = new Map<string, Array<{ id: string; nombre: string }>>();
  for (const lead of candidatos) {
    if (!lead.telefonoWhatsapp) continue;
    const lista = porTelefono.get(lead.telefonoWhatsapp) ?? [];
    lista.push({ id: lead.id, nombre: lead.nombre || "(sin nombre)" });
    porTelefono.set(lead.telefonoWhatsapp, lista);
  }
  return [...porTelefono.entries()]
    .filter(([, leads]) => leads.length > 1)
    .map(([telefono, leads]) => ({ telefono, leads }));
}

/**
 * Orden determinístico de los candidatos.
 *
 * Sin esto la selección no es estable: Tokko **no garantiza orden** en
 * `/contact/?offset=N` (no hay `order_by`), así que el orden depende de cómo
 * devuelva las páginas y de que el dataset se mueve mientras se lee. Dos
 * corridas seguidas mostraban tres personas distintas — y una lista que
 * cambia sola no se puede revisar antes de aprobarla.
 *
 * Criterio: primero los que llevan más tiempo sin respuesta (son los que más
 * sentido tiene recontactar), y el id como desempate para que el resultado
 * sea idéntico corrida a corrida.
 */
export function ordenarCandidatos(candidatos: Lead[]): Lead[] {
  return [...candidatos].sort((a, b) => {
    if (b.diasSinRespuesta !== a.diasSinRespuesta) return b.diasSinRespuesta - a.diasSinRespuesta;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Arma el plan. **No manda nada ni toca ningún store**: es una función pura,
 * así que el simulacro y la ejecución real comparten exactamente esta lógica.
 */
export function planificarRecontacto(
  candidatosSinOrdenar: Lead[],
  estados: EstadosDeContacto,
  enviadosHoy: number,
  ahora: Date,
  config: RecontactoConfig = CONFIG_POR_DEFECTO,
  internos?: { contiene(t: string): boolean }
): PlanDeRecontacto {
  // El orden se fija ACÁ y no en el llamador: si lo hiciera cada llamador, el
  // simulacro y el job podrían ordenar distinto y el simulacro dejaría de
  // mostrar lo que va a pasar.
  const candidatos = ordenarCandidatos(candidatosSinOrdenar);
  const aEnviar: Destinatario[] = [];
  const suprimidos: Suprimido[] = [];
  const duplicados = detectarDuplicados(candidatos);
  /** Teléfonos ya cubiertos en ESTA corrida: la segunda ficha no vuelve a escribir. */
  const telefonosYaPlanificados = new Set<string>();
  let topeAlcanzado = false;

  for (const lead of candidatos) {
    const nombre = lead.nombre || "(sin nombre)";

    if (!lead.telefonoWhatsapp) {
      suprimidos.push({ leadId: lead.id, nombre, motivo: "sin_telefono_usable" });
      continue;
    }

    // PRIMERO de todo: la linea de WhatsApp Business del broker esta cargada
    // como un contacto mas en el CRM y pasa el criterio. Escribirle es
    // escribirle a la misma linea que recibe a los clientes, y ese numero le
    // manda mensajes al sistema: puede armar un lazo.
    if (internos?.contiene(lead.telefonoWhatsapp)) {
      suprimidos.push({
        leadId: lead.id,
        nombre,
        motivo: "numero_interno",
        detalle: "es la linea del broker o de un usuario de la cuenta",
      });
      continue;
    }

    const porLead = estados.porLead.get(lead.id);
    const porTelefono = estados.porTelefono.get(lead.telefonoWhatsapp);
    // Se toma lo MÁS restrictivo de las dos vistas: el mayor número de
    // intentos y el contacto más reciente. Si una ficha duplicada ya recibió
    // mensajes, la otra hereda esa historia.
    const intentos = Math.max(porLead?.intentos ?? 0, porTelefono?.intentos ?? 0);
    const fechas = [porLead?.ultimoContactoAt, porTelefono?.ultimoContactoAt].filter(Boolean) as string[];
    const ultimoContactoAt = fechas.sort().at(-1);

    if (intentos >= config.intentosMaximos) {
      suprimidos.push({
        leadId: lead.id,
        nombre,
        motivo: "agotó_intentos",
        detalle: `ya se le escribió ${intentos} ${intentos === 1 ? "vez" : "veces"}`,
      });
      continue;
    }

    // Acá entra el eco de coexistencia: si el broker le escribió a mano desde
    // el celular, ese contacto cuenta igual que uno del sistema.
    if (ultimoContactoAt) {
      const dias = diasEntre(ultimoContactoAt, ahora);
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

    // Dos fichas de Tokko con el mismo teléfono son la misma persona. Sólo la
    // primera recibe el mensaje; la otra se reporta para poder unificarlas.
    if (telefonosYaPlanificados.has(lead.telefonoWhatsapp)) {
      suprimidos.push({
        leadId: lead.id,
        nombre,
        motivo: "duplicado_en_esta_corrida",
        detalle: "otra ficha con el mismo teléfono ya recibe el mensaje",
      });
      continue;
    }

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

    telefonosYaPlanificados.add(lead.telefonoWhatsapp);
    aEnviar.push({
      leadId: lead.id,
      nombre,
      telefono: lead.telefonoWhatsapp,
      intentoNumero: intentos + 1,
    });
  }

  return { aEnviar, suprimidos, duplicados, topeAlcanzado, evaluados: candidatos.length };
}

/**
 * El reporte que ve el broker. Muestra **nombre y teléfono de cada
 * destinatario**, no un conteo: la supresión automática puede fallar (el eco
 * de coexistencia es best-effort y Meta no lo reintenta), así que esta lista
 * es la defensa principal, no un extra.
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

  // Se listan aparte de los suprimidos: no es un motivo de exclusión, es una
  // tarea pendiente en el CRM.
  if (plan.duplicados.length > 0) {
    lineas.push("");
    lineas.push(`⚠️ FICHAS DUPLICADAS EN TOKKO (${plan.duplicados.length}) — conviene unificarlas:`);
    for (const d of plan.duplicados) {
      lineas.push(`    ${d.telefono} → ${d.leads.map((l) => `${l.nombre} [${l.id}]`).join("  +  ")}`);
    }
  }

  if (plan.topeAlcanzado) {
    lineas.push("");
    lineas.push("⚠️ Se alcanzó el tope: quedó gente elegible sin contactar. No se siguió enviando.");
  }

  return lineas.join("\n");
}
