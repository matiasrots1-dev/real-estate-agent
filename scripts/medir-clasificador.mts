/**
 * Mide el clasificador contra las etiquetas manuales del broker.
 *
 * **Es el criterio de aceptación del bloque del contexto**, por pedido
 * explícito del dueño del repo: si la precisión cae, el contexto no se
 * mergea, aunque el recall suba.
 *
 * Corre tres variantes sobre las mismas conversaciones etiquetadas, para
 * poder separar el efecto de cada cambio:
 *
 *   A) lo que ya está en el audit_log       (catálogo viejo, sin contexto)
 *   B) catálogo nuevo, sin contexto          (aísla el efecto de los 2 intents)
 *   C) catálogo nuevo, con contexto          (el bloque completo)
 *
 * Usa la API real: son ~2 llamadas por conversación etiquetada.
 *
 *   npm run medir:clasificador
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

// Sólo L y N: las dudosas quedan afuera del cálculo, igual que en --resumen.
const casos = [...porId.entries()].filter(([id]) => etiquetas[id] === "L" || etiquetas[id] === "N");

const catalogo = loadCatalog(path.join(REPO, "docs/intent_catalog.yaml"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const clasificador = new ClaudeIntentClassifier(anthropic);

/** "Lo detectó" = matcheó cualquier intent que no sea el catch-all. */
const detectado = (intentId: string) => intentId !== "fallback_low_confidence";

interface Resultado {
  nombre: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function medir(nombre: string, porCaso: Map<string, boolean>): Resultado {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const [id] of casos) {
    const esLead = etiquetas[id] === "L";
    const detecto = porCaso.get(id) ?? false;
    if (esLead && detecto) tp += 1;
    else if (esLead) fn += 1;
    else if (detecto) fp += 1;
    else tn += 1;
  }
  return { nombre, tp, fp, fn, tn };
}

function fila(r: Resultado): string {
  const p = r.tp + r.fp ? Math.round((r.tp * 100) / (r.tp + r.fp)) : 0;
  const rec = r.tp + r.fn ? Math.round((r.tp * 100) / (r.tp + r.fn)) : 0;
  return (
    `  ${r.nombre.padEnd(34)} TP=${String(r.tp).padStart(2)} FP=${String(r.fp).padStart(2)} ` +
    `FN=${String(r.fn).padStart(2)} TN=${String(r.tn).padStart(2)}   precisión=${String(p).padStart(3)}%  recall=${String(rec).padStart(3)}%`
  );
}

// ── A: lo que ya está en el audit log ──
//
// Se mide sobre el ÚLTIMO mensaje, igual que B y C. Un primer intento contaba
// "si CUALQUIER mensaje de la conversación matcheó", y eso hacía que A tuviera
// muchas más oportunidades de acertar que B y C: el recall parecía desplomarse
// de 69% a 38% por la métrica, no por el cambio. Las tres variantes tienen que
// responder exactamente la misma pregunta.
const A = new Map<string, boolean>();
for (const [id, ms] of casos) A.set(id, detectado(ms[ms.length - 1].matchedIntentId));

// Se conserva la vista "cualquier mensaje" sólo como referencia, claramente
// separada, porque es la que describe lo que el sistema hace en la práctica:
// clasifica cada mensaje a medida que llega, no sólo el último.
const AcualquierMensaje = new Map<string, boolean>();
for (const [id, ms] of casos) AcualquierMensaje.set(id, ms.some((m) => detectado(m.matchedIntentId)));

// ── B y C: se reclasifica el ÚLTIMO mensaje de cada conversación ──
const B = new Map<string, boolean>();
const C = new Map<string, boolean>();
const cambios: string[] = [];

let i = 0;
for (const [id, ms] of casos) {
  i += 1;
  const ultimo = ms[ms.length - 1];
  const texto = ultimo.incomingMessage ?? "";
  process.stderr.write(`\r  clasificando… ${i}/${casos.length}`);
  if (!texto.trim()) {
    B.set(id, false);
    C.set(id, false);
    continue;
  }

  const sinCtx = await clasificador.classify(texto, catalogo);
  B.set(id, detectado(sinCtx.intentId));

  const previos = ms.slice(0, -1).map((m) => m.incomingMessage ?? "").filter(Boolean);
  const contexto: ContextoConversacion = { mensajesPrevios: previos };
  const conCtx = await clasificador.classify(texto, catalogo, contexto);
  C.set(id, detectado(conCtx.intentId));

  if (sinCtx.intentId !== conCtx.intentId) {
    cambios.push(
      `  •••${id.slice(-4)} [${etiquetas[id]}] "${texto.replace(/\s+/g, " ").slice(0, 44)}"\n` +
        `        sin contexto: ${sinCtx.intentId} (${sinCtx.confidence})\n` +
        `        con contexto: ${conCtx.intentId} (${conCtx.confidence})`
    );
  }
}
process.stderr.write("\n");

const rA = medir("A) hoy, ultimo mensaje", A);
const rRef = medir("    (ref) hoy, cualquier mensaje", AcualquierMensaje);
const rB = medir("B) catálogo nuevo, sin contexto", B);
const rC = medir("C) catálogo nuevo + contexto", C);

console.log(`\nCasos medidos: ${casos.length} (L=${casos.filter(([id]) => etiquetas[id] === "L").length}, N=${casos.filter(([id]) => etiquetas[id] === "N").length})\n`);
console.log(fila(rA));
console.log(fila(rRef));
console.log(fila(rB));
console.log(fila(rC));

const precision = (r: Resultado) => (r.tp + r.fp ? (r.tp * 100) / (r.tp + r.fp) : 0);
console.log(`\n=== CRITERIO DE ACEPTACIÓN ===`);
console.log(`  precisión hoy (A): ${precision(rA).toFixed(0)}%`);
console.log(`  precisión con el bloque (C): ${precision(rC).toFixed(0)}%`);
console.log(
  precision(rC) >= precision(rA)
    ? `  ✅ La precisión NO cae. El bloque se puede mergear.`
    : `  ❌ La precisión CAE. El bloque NO se mergea, aunque el recall suba.`
);

if (cambios.length > 0) {
  console.log(`\n=== DÓNDE EL CONTEXTO CAMBIÓ LA CLASIFICACIÓN (${cambios.length}) ===`);
  for (const c of cambios) console.log(c);
}
console.log("");
