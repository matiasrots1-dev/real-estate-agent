/**
 * Conversaciones sin responder, ordenadas por urgencia.
 *
 * Sale de `audit_log.jsonl` (lo que el agente recibió y clasificó) cruzado con
 * los contactos de Tokko para poner nombres. **No escribe ningún archivo**:
 * sale por consola y se va con la terminal, porque lleva teléfonos y el texto
 * de los mensajes.
 *
 *   npm run pendientes              -> lista completa
 *   npm run pendientes -- --masked  -> teléfonos enmascarados
 *   npm run pendientes -- --todos   -> incluye las ya respondidas
 *   npm run pendientes -- --sin-tokko -> no consulta Tokko (más rápido)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizarTelefono } from "shared-types";
import { contactoDelBroker, FileUltimoContactoStore } from "../apps/orchestrator/src/agent/ultimoContactoStore.js";
import {
  colapsarPorMensaje,
  fueRespondida,
  INTENT_PROCESAMIENTO_FALLIDO,
  INTENT_SIN_CLASIFICAR,
} from "../apps/orchestrator/src/agent/auditPorMensaje.js";
import { leerAuditLogExistente } from "../apps/orchestrator/src/agent/auditLog.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)])
);

const masked = process.argv.includes("--masked");
const todos = process.argv.includes("--todos");
const sinTokko = process.argv.includes("--sin-tokko");

/**
 * Prioridad de negocio. Cuanto más bajo, más arriba en la lista.
 * `agendar_visita` y `negociacion_precio` primero por pedido explícito: es
 * gente con intención concreta que quedó esperando.
 */
const PRIORIDAD: Record<string, number> = {
  // Un mensaje que fallo, o que llego y nunca se resolvio, no tuvo respuesta
  // de nadie: va primero (docs/TASKS.md Bloque 34).
  [INTENT_PROCESAMIENTO_FALLIDO]: 0,
  [INTENT_SIN_CLASIFICAR]: 0,
  agendar_visita: 0,
  negociacion_precio: 0,
  reclamo_queja: 1,
  reprogramar_cancelar_visita: 1,
  consulta_precio_condiciones: 2,
  pedido_ficha_multimedia: 2,
  consulta_disponibilidad: 2,
  consulta_clima_visita: 3,
  fallback_low_confidence: 4,
};
const prioridadDe = (intent: string) => PRIORIDAD[intent] ?? 3;

interface Entrada {
  conversationId: string;
  timestamp: string;
  incomingMessage?: string;
  matchedIntentId: string;
  escalatedToBroker?: boolean;
  responseSent?: string;
  avisoAlBroker?: string;
  envio?: string;
  envioMotivo?: string;
  messageId?: string;
  etapa?: string;
}

// Una entrada por mensaje (docs/TASKS.md Bloque 34): cada mensaje deja una
// recibido y la que lo resuelve, y sin colapsar se contaria dos veces.
// Se lee con el store y no con JSON.parse linea por linea: una linea rota no
// puede dejar al broker sin lista (docs/TASKS.md Bloque 37).
const entradas: Entrada[] = colapsarPorMensaje(
  await leerAuditLogExistente(path.join(REPO, "apps/orchestrator/data/audit_log.jsonl"))
);

// Una conversación puede tener varios mensajes con intents distintos: alguien
// escribe "quiero ver el depto" y después "hola?". Se guarda el ÚLTIMO mensaje
// (que es al que hay que contestar) pero la MEJOR prioridad de toda la
// conversación — si en algún momento quiso agendar, eso manda.
interface Conversacion {
  id: string;
  mensajes: number;
  ultimo: Entrada;
  mejorIntent: string;
  respondida: boolean;
}

const porConversacion = new Map<string, Conversacion>();
for (const e of entradas) {
  const previo = porConversacion.get(e.conversationId);
  if (!previo) {
    porConversacion.set(e.conversationId, {
      id: e.conversationId,
      mensajes: 1,
      ultimo: e,
      mejorIntent: e.matchedIntentId,
      respondida: fueRespondida(e),
    });
    continue;
  }
  previo.mensajes += 1;
  // "Respondida" es del ÚLTIMO mensaje, no de toda la conversación: si el
  // agente contestó la semana pasada y el mensaje de hoy falló, la
  // conversación está pendiente. Con un "alguna vez se respondió" el
  // `fallido` de hoy desaparecería de la lista (docs/TASKS.md Bloque 34).
  if (e.timestamp > previo.ultimo.timestamp) {
    previo.ultimo = e;
    previo.respondida = fueRespondida(e);
  }
  if (prioridadDe(e.matchedIntentId) < prioridadDe(previo.mejorIntent)) previo.mejorIntent = e.matchedIntentId;
}

/** Claves múltiples por teléfono, para maximizar el match contra Tokko. */
function clavesDe(telefono: string): string[] {
  const claves = new Set<string>();
  const digitos = String(telefono).replace(/\D/g, "");
  if (digitos) claves.add(digitos);
  const n = normalizarTelefono(telefono);
  if (n.paraEnviar) claves.add(n.paraEnviar);
  if (n.nacional) claves.add(n.nacional.replace(/^9/, ""));
  return [...claves];
}

const nombres = new Map<string, string>();
if (!sinTokko && env.TOKKO_API_KEY) {
  const BASE = (env.TOKKO_API_BASE_URL || "https://www.tokkobroker.com/api/v1").replace(/\/$/, "");
  try {
    let offset = 0;
    for (;;) {
      const url = `${BASE}/contact/?order_by=created_at&limit=200&offset=${offset}&key=${encodeURIComponent(env.TOKKO_API_KEY)}&format=json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = JSON.parse(await res.text());
      const lote: any[] = json.objects ?? [];
      for (const c of lote) {
        const nombre = String(c.name ?? "").trim();
        if (!nombre) continue;
        for (const t of [c.cellphone, c.phone, c.other_phone]) {
          for (const k of clavesDe(String(t ?? ""))) if (!nombres.has(k)) nombres.set(k, nombre);
        }
      }
      offset += lote.length;
      process.stderr.write(`\r  buscando nombres en Tokko… ${offset}/${json.meta.total_count}`);
      if (lote.length === 0 || offset >= json.meta.total_count) break;
    }
    process.stderr.write("\n");
  } catch (e) {
    // Tokko tiene rate limiting via Cloudflare: un barrido completo repetido
    // devuelve un desafío HTML en vez de JSON. Que falle no puede dejar sin
    // lista al broker — se sigue sin nombres.
    process.stderr.write("\n");
    console.error(`  AVISO: no se pudieron traer los nombres de Tokko (${e}). Sigo sin nombres.\n`);
  }
}

function nombreDe(telefono: string): string | null {
  for (const k of clavesDe(telefono)) {
    const n = nombres.get(k);
    if (n) return n;
  }
  return null;
}

// Lo que el broker contesto A MANO desde el celular, registrado via el eco de
// coexistencia. Sin esto, alguien a quien ya respondio sigue apareciendo como
// pendiente: el audit log solo sabe lo que mando el sistema.
const respondidoAMano = new Map<string, string>();
try {
  const store = new FileUltimoContactoStore(
    env.ULTIMO_CONTACTO_STORE_PATH || path.join(REPO, "apps/orchestrator/data/ultimo_contacto.json")
  );
  for (const r of await store.all()) {
    // `contactoDelBroker` y no `origen === "manual"`: desde el Bloque 38f la
    // marca del broker vive en su propio campo, justamente porque un contacto
    // del sistema posterior le pisaba el origen. Mirando `origen`, el dia que
    // el recontacto le escriba a alguien que vos ya habias contestado a mano,
    // esa conversacion vuelve a aparecer como pendiente.
    const cuando = contactoDelBroker(r);
    if (cuando !== null) respondidoAMano.set(r.leadId, new Date(cuando).toISOString());
  }
} catch {
  // Si el archivo todavia no existe, no hay nada que cruzar.
}

const ahora = Date.now();
function haceCuanto(iso: string): string {
  const min = Math.floor((ahora - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 48) return `hace ${horas} h`;
  return `hace ${Math.floor(horas / 24)} días`;
}

/**
 * El bot decidió que no era una conversación del negocio y se calló a
 * propósito (docs/TASKS.md Bloque 42). No van mezcladas con las que quedaron
 * sin responder —serían ruido— pero se listan aparte: es la única forma de
 * revisar a quién se calló, porque en esos casos no sale ningún aviso.
 */
const SILENCIO = "conversacion_ajena_al_negocio";
const silenciadas = [...porConversacion.values()].filter(
  (c) => c.ultimo.matchedIntentId === SILENCIO
);

/**
 * Sale de la lista de pendientes sólo si **nada** en la conversación fue una
 * consulta concreta. Si el cliente preguntó el precio y después mandó un
 * "jaja", el último mensaje es silencio pero la pregunta sigue sin responder:
 * sacarla de la lista por el "jaja" perdería el lead, que es exactamente lo
 * que `pendientes` existe para evitar (revisión del PR #53).
 */
const soloCharla = (c: Conversacion) => c.ultimo.matchedIntentId === SILENCIO && prioridadDe(c.mejorIntent) >= 3;

const lista = [...porConversacion.values()]
  .filter((c) => !soloCharla(c))
  .filter((c) => todos || (!c.respondida && !respondioElBroker(c)))
  .sort((a, b) => {
    const p = prioridadDe(a.mejorIntent) - prioridadDe(b.mejorIntent);
    if (p !== 0) return p;
    // Dentro de la misma prioridad, primero el más reciente: sigue caliente.
    return b.ultimo.timestamp.localeCompare(a.ultimo.timestamp);
  });

/** El broker le contesto a mano DESPUES del ultimo mensaje del cliente. */
function respondioElBroker(c: Conversacion): boolean {
  for (const k of clavesDe(c.id)) {
    const cuando = respondidoAMano.get(k);
    if (cuando && cuando > c.ultimo.timestamp) return true;
  }
  return false;
}

const mostrarTel = (t: string) => (masked ? "•••" + t.slice(-4) : t);
const ETIQUETA: Record<number, string> = {
  0: "🔴 URGENTE",
  1: "🟠 IMPORTANTE",
  2: "🟡 CONSULTA",
  3: "⚪ MENOR",
  4: "⚪ SIN CLASIFICAR",
};

console.log("");
console.log(`CONVERSACIONES ${todos ? "(todas)" : "SIN RESPONDER"}: ${lista.length}`);
console.log("");

let prioridadActual = -1;
for (const c of lista) {
  const p = prioridadDe(c.mejorIntent);
  if (p !== prioridadActual) {
    prioridadActual = p;
    console.log(`── ${ETIQUETA[p] ?? "OTROS"} ─────────────────────────────────────────`);
  }
  const nombre = nombreDe(c.id);
  const texto = String(c.ultimo.incomingMessage ?? "").replace(/\s+/g, " ").slice(0, 110);
  console.log(`  ${mostrarTel(c.id)}${nombre ? `  —  ${nombre}` : "  —  (no está en Tokko)"}`);
  console.log(`    "${texto}"`);
  console.log(
    `    ${haceCuanto(c.ultimo.timestamp)} · ${c.mejorIntent} · ${c.mensajes} ${c.mensajes === 1 ? "mensaje" : "mensajes"}` +
      `${c.respondida ? " · respondida por el agente" : ""}${respondioElBroker(c) ? " · YA LE CONTESTASTE VOS" : ""}` +
      `${c.ultimo.avisoAlBroker === "fallo" ? " · EL AVISO NO TE LLEGÓ" : ""}` +
      `${c.ultimo.envio === "fallo" ? " · NO SE PUDO MANDAR LA RESPUESTA" : ""}` +
      `${c.ultimo.envio === "parcial" ? " · LE FALTAN LAS FOTOS" : ""}`
  );
  console.log("");
}

const urgentes = lista.filter((c) => prioridadDe(c.mejorIntent) === 0).length;
if (urgentes > 0) console.log(`${urgentes} con intención concreta (agendar visita o negociar precio).`);

if (silenciadas.length > 0) {
  console.log("");
  console.log(`EL BOT SE CALLÓ (no eran del negocio): ${silenciadas.length}`);
  console.log("  Si alguna de estas SÍ era un cliente, avisá: el umbral se puede subir.");
  console.log("");
  for (const c of silenciadas) {
    const texto = (c.ultimo.incomingMessage ?? "").replace(/s+/g, " ").slice(0, 70);
    console.log(`  ${mostrarTel(c.id)}  —  "${texto}"  (${haceCuanto(c.ultimo.timestamp)})`);
  }
}
console.log("");
