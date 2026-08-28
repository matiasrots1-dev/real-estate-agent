/**
 * Simula producción: clasifica CADA mensaje de las conversaciones etiquetadas,
 * con el contexto que habría tenido en ese momento.
 *
 * Es la medición comparable con la fila de referencia de
 * `medir-clasificador.mts` (42% / 69%), que describe lo que el sistema hace de
 * verdad: clasificar mensaje por mensaje a medida que llegan, no sólo el
 * último de la conversación.
 *
 * Además arma el recorrido de cada lead: qué le habría pasado a esa persona
 * con el modo silencioso APAGADO — si el agente le hubiera contestado solo, si
 * habría escalado al broker, o si habría caído en la plantilla de espera.
 *
 *   npm run medir:produccion
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { loadCatalog } from "../apps/orchestrator/src/agent/intentCatalog.js";
import { ClaudeIntentClassifier, type ContextoConversacion } from "../apps/orchestrator/src/agent/classifier.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotenv({ path: path.join(REPO, ".env") });

interface Entrada {
  conversationId: string;
  timestamp: string;
  incomingMessage?: string;
  matchedIntentId: string;
}

const entradas: Entrada[] = fs
  .readFileSync(path.join(REPO, "apps/orchestrator/data/audit_log.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const etiquetas: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(REPO, "apps/orchestrator/data/etiquetas_conversaciones.json"), "utf8")
);

const porId = new Map<string, Entrada[]>();
for (const e of entradas) {
  const a = porId.get(e.conversationId) ?? [];
  a.push(e);
  porId.set(e.conversationId, a);
}
for (const a of porId.values()) a.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
const casos = [...porId.entries()].filter(([id]) => etiquetas[id] === "L" || etiquetas[id] === "N");

/** Misma ventana que producción: un contacto de hace tres meses no ayuda. */
const VENTANA_CONTACTO_MS = 7 * 24 * 3600 * 1000;
const ultimoContacto: Record<string, { contactadoAt: string }> = JSON.parse(
  fs.readFileSync(path.join(REPO, "apps/orchestrator/data/ultimo_contacto.json"), "utf8")
);

const catalogo = loadCatalog(path.join(REPO, "docs/intent_catalog.yaml"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const clasificador = new ClaudeIntentClassifier(anthropic);

/** Qué hace el sistema con cada intent, según el catálogo. */
const porIntent = new Map(catalogo.intents.map((i) => [i.id, i]));
function queHace(intentId: string): "escala" | "responde_solo" | "espera" {
  if (intentId === "fallback_low_confidence") return "espera";
  const intent = porIntent.get(intentId);
  if (!intent) return "espera";
  return intent.requires_broker ? "escala" : "responde_solo";
}

const detectado = (id: string) => id !== "fallback_low_confidence";

interface Resultado {
  id: string;
  etiqueta: string;
  clasificaciones: Array<{ texto: string; intent: string; confianza: number }>;
}

const resultados: Resultado[] = [];
let n = 0;
const totalMensajes = casos.reduce((s, [, ms]) => s + ms.length, 0);

for (const [id, ms] of casos) {
  const clasificaciones: Resultado["clasificaciones"] = [];
  for (let k = 0; k < ms.length; k++) {
    n += 1;
    process.stderr.write(`\r  clasificando… ${n}/${totalMensajes}`);
    const texto = ms[k].incomingMessage ?? "";
    if (!texto.trim()) continue;
    // El contexto que habría tenido EN ESE MOMENTO: sólo los mensajes
    // anteriores, nunca los posteriores. Usar la conversación entera sería
    // darle información del futuro y el número saldría mejor de lo real.
    const previos = ms.slice(0, k).map((m) => m.incomingMessage ?? "").filter(Boolean);

    // La segunda mitad del contexto: hace cuántas horas el broker le escribió.
    // Se calcula contra el timestamp DEL MENSAJE, no contra `Date.now()`, y sólo
    // si el contacto es anterior a él. Con `Date.now()` un contacto del 26/8
    // teñiría mensajes de julio, y con contactos posteriores el clasificador
    // estaría leyendo el futuro — el mismo error que evita el `slice(0, k)`.
    // En este dataset la señal cubre 5 mensajes de ~230: el registro de
    // contactos empieza recién cuando se enganchó el eco de coexistencia.
    let horasDesdeContactoDelBroker: number | undefined;
    const contacto = ultimoContacto[id];
    if (contacto) {
      const delta = new Date(ms[k].timestamp).getTime() - new Date(contacto.contactadoAt).getTime();
      if (delta >= 0 && delta <= VENTANA_CONTACTO_MS) horasDesdeContactoDelBroker = delta / 3_600_000;
    }

    const contexto: ContextoConversacion | undefined =
      previos.length > 0 || horasDesdeContactoDelBroker !== undefined
        ? { mensajesPrevios: previos, horasDesdeContactoDelBroker }
        : undefined;
    const r = await clasificador.classify(texto, catalogo, contexto);
    clasificaciones.push({ texto, intent: r.intentId, confianza: r.confidence });
  }
  resultados.push({ id, etiqueta: etiquetas[id], clasificaciones });
}
process.stderr.write("\n");

// ── Agregado, comparable con la fila de referencia ──
let tp = 0, fp = 0, fn = 0, tn = 0;
for (const r of resultados) {
  const detecto = r.clasificaciones.some((c) => detectado(c.intent));
  if (r.etiqueta === "L" && detecto) tp += 1;
  else if (r.etiqueta === "L") fn += 1;
  else if (detecto) fp += 1;
  else tn += 1;
}
const prec = tp + fp ? Math.round((tp * 100) / (tp + fp)) : 0;
const rec = tp + fn ? Math.round((tp * 100) / (tp + fn)) : 0;

console.log(`\n=== PRODUCCIÓN: cada mensaje clasificado, con su contexto de ese momento ===`);
console.log(`  mensajes clasificados: ${totalMensajes}`);
console.log(`  TP=${tp} FP=${fp} FN=${fn} TN=${tn}   precisión=${prec}%  recall=${rec}%`);
console.log(`  (comparar con la referencia de hoy: precisión 42% / recall 69%)`);

// ── El recorrido de cada lead ──
console.log(`\n\n=== QUÉ LE HABRÍA PASADO A CADA LEAD (modo silencioso APAGADO) ===`);
const leads = resultados.filter((r) => r.etiqueta === "L");
let bien = 0, aceptable = 0, mal = 0;

for (const r of leads) {
  const acciones = r.clasificaciones.map((c) => queHace(c.intent));
  const respondeSolo = r.clasificaciones.filter((c) => queHace(c.intent) === "responde_solo");
  const escala = acciones.filter((a) => a === "escala").length;
  const espera = acciones.filter((a) => a === "espera").length;

  let veredicto: string;
  if (escala > 0 || respondeSolo.length > 0) {
    veredicto = respondeSolo.length > 0 ? "ATENDIDO" : "ESCALADO";
    bien += 1;
  } else {
    veredicto = "SOLO PLANTILLA";
    aceptable += 1;
  }
  void mal;

  const intents = [...new Set(r.clasificaciones.map((c) => c.intent))].join(", ");
  console.log(`\n  •••${r.id.slice(-4)}  ${veredicto}`);
  console.log(`     ${r.clasificaciones.length} mensajes · responde solo: ${respondeSolo.length} · escala: ${escala} · plantilla: ${espera}`);
  console.log(`     intents: ${intents}`);
  const ultimo = r.clasificaciones[r.clasificaciones.length - 1];
  if (ultimo) console.log(`     último: "${ultimo.texto.replace(/\s+/g, " ").slice(0, 56)}" → ${ultimo.intent}`);
}

console.log(`\n\n  De ${leads.length} leads:`);
console.log(`    ${bien} recibirían al menos una respuesta con contenido (agente o escalado al broker)`);
console.log(`    ${aceptable} recibirían SÓLO la plantilla de espera en toda la conversación`);
console.log("");
