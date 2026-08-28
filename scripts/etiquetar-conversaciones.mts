/**
 * Etiquetado manual de las conversaciones reales, para tener una verdad de
 * base independiente del clasificador.
 *
 * Por qué existe: medir el clasificador contra sus propias etiquetas es
 * circular. Con 74% de los mensajes cayendo en `fallback_low_confidence`, no
 * hay forma de saber si eso es un problema del catálogo o del umbral sin que
 * una persona diga qué era cada conversación en realidad.
 *
 * **No muestra qué clasificó el agente.** Verlo contaminaría el criterio y la
 * verdad de base dejaría de ser independiente. La comparación viene después.
 *
 *   npm run etiquetar             -> etiqueta las que faltan
 *   npm run etiquetar -- --resumen  -> compara etiquetas vs clasificador
 *   npm run etiquetar -- --reset    -> borra las etiquetas y empieza de cero
 *
 * Guarda después de CADA tecla: se puede cortar en cualquier momento y
 * retomar. El archivo va a `apps/orchestrator/data/` (gitignoreado) porque
 * lleva teléfonos.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = path.join(REPO, "apps/orchestrator/data/audit_log.jsonl");
const ETIQUETAS = path.join(REPO, "apps/orchestrator/data/etiquetas_conversaciones.json");

type Etiqueta = "L" | "N" | "D";

interface Entrada {
  conversationId: string;
  timestamp: string;
  incomingMessage?: string;
  matchedIntentId: string;
}

const entradas: Entrada[] = fs
  .readFileSync(AUDIT, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Entrada);

interface Conv {
  id: string;
  mensajes: Entrada[];
  intents: string[];
}

const porId = new Map<string, Conv>();
for (const e of entradas) {
  let c = porId.get(e.conversationId);
  if (!c) {
    c = { id: e.conversationId, mensajes: [], intents: [] };
    porId.set(e.conversationId, c);
  }
  c.mensajes.push(e);
  c.intents.push(e.matchedIntentId);
}
for (const c of porId.values()) c.mensajes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

// Más recientes primero: si se corta a la mitad, quedan etiquetadas las que
// más importan.
const conversaciones = [...porId.values()].sort((a, b) =>
  b.mensajes[b.mensajes.length - 1].timestamp.localeCompare(a.mensajes[a.mensajes.length - 1].timestamp)
);

function cargarEtiquetas(): Record<string, Etiqueta> {
  try {
    return JSON.parse(fs.readFileSync(ETIQUETAS, "utf8"));
  } catch {
    return {};
  }
}

function guardar(etiquetas: Record<string, Etiqueta>): void {
  fs.writeFileSync(ETIQUETAS, JSON.stringify(etiquetas, null, 2) + "\n", "utf8");
}

if (process.argv.includes("--reset")) {
  guardar({});
  console.log("Etiquetas borradas.\n");
  process.exit(0);
}

const etiquetas = cargarEtiquetas();

// ─────────────────────────── RESUMEN ───────────────────────────
if (process.argv.includes("--resumen")) {
  const etiquetadas = conversaciones.filter((c) => etiquetas[c.id]);
  if (etiquetadas.length === 0) {
    console.log("\nTodavía no hay etiquetas. Corré `npm run etiquetar` primero.\n");
    process.exit(0);
  }

  const CONCRETO = new Set(["agendar_visita", "negociacion_precio"]);
  const clasificoComoLead = (c: Conv) => c.intents.some((i) => CONCRETO.has(i));
  const clasificoTodoFallback = (c: Conv) => c.intents.every((i) => i === "fallback_low_confidence");

  const L = etiquetadas.filter((c) => etiquetas[c.id] === "L");
  const N = etiquetadas.filter((c) => etiquetas[c.id] === "N");
  const D = etiquetadas.filter((c) => etiquetas[c.id] === "D");

  console.log(`\n=== TUS ETIQUETAS (${etiquetadas.length} de ${conversaciones.length}) ===`);
  console.log(`  L (lead)   : ${L.length}`);
  console.log(`  N (no lead): ${N.length}`);
  console.log(`  D (dudosa) : ${D.length}`);

  console.log(`\n=== EL CLASIFICADOR CONTRA TUS ETIQUETAS ===`);
  console.log(`(sólo se miden las L y las N; las dudosas quedan afuera)`);
  const tp = L.filter(clasificoComoLead).length;
  const fn = L.filter((c) => !clasificoComoLead(c)).length;
  const fp = N.filter(clasificoComoLead).length;
  const tn = N.filter((c) => !clasificoComoLead(c)).length;
  console.log(`  leads que detectó como intención concreta : ${tp} de ${L.length}`);
  console.log(`  leads que NO detectó (los perdió)         : ${fn}`);
  console.log(`  no-leads que marcó como intención concreta: ${fp}`);
  console.log(`  no-leads correctamente ignorados          : ${tn}`);
  if (tp + fp > 0) console.log(`  precisión: ${((tp * 100) / (tp + fp)).toFixed(0)}%`);
  if (tp + fn > 0) console.log(`  recall   : ${((tp * 100) / (tp + fn)).toFixed(0)}%`);

  console.log(`\n=== CUÁNTOS LEADS REALES CAYERON ENTEROS EN FALLBACK ===`);
  const perdidos = L.filter(clasificoTodoFallback);
  console.log(`  ${perdidos.length} de ${L.length} leads no matchearon NINGÚN intent en ningún mensaje.`);
  for (const c of perdidos.slice(0, 12)) {
    const ultimo = c.mensajes[c.mensajes.length - 1].incomingMessage?.replace(/\s+/g, " ").slice(0, 80);
    console.log(`     •••${c.id.slice(-4)}  "${ultimo}"`);
  }

  console.log(`\n=== QUÉ INTENTS APARECEN EN LO QUE VOS LLAMASTE "NO LEAD" ===`);
  const cuenta: Record<string, number> = {};
  for (const c of N) for (const i of new Set(c.intents)) cuenta[i] = (cuenta[i] ?? 0) + 1;
  for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  console.log("");
  process.exit(0);
}

// ─────────────────────────── ETIQUETADO ───────────────────────────
const pendientes = conversaciones.filter((c) => !etiquetas[c.id]);

if (pendientes.length === 0) {
  console.log(`\nYa están las ${conversaciones.length} etiquetadas.`);
  console.log(`Para ver el resultado:  npm run etiquetar -- --resumen\n`);
  process.exit(0);
}

function haceCuanto(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} días`;
}

function mostrar(c: Conv, indice: number, total: number): void {
  const ultimos = c.mensajes.slice(-4);
  console.log("\n".repeat(2));
  console.log("═".repeat(72));
  console.log(`  ${indice}/${total}   ${c.id}   ·   ${c.mensajes.length} mensajes   ·   ${haceCuanto(c.mensajes[c.mensajes.length - 1].timestamp)}`);
  console.log("═".repeat(72));
  for (const m of ultimos) {
    const texto = (m.incomingMessage ?? "").replace(/\s+/g, " ").trim();
    const fecha = m.timestamp.slice(5, 16).replace("T", " ");
    const sangria = " ".repeat(fecha.length);
    // La fecha sólo en la primera línea; las continuaciones van alineadas.
    partir(texto, 66).forEach((linea, n) => {
      console.log(`   ${n === 0 ? fecha : sangria}  │ ${linea}`);
    });
  }
  console.log("─".repeat(72));
  console.log("   [L] lead    [N] no es lead    [D] dudosa    [Q] salir y guardar");
}

function partir(texto: string, ancho: number): string[] {
  if (!texto) return ["(sin texto)"];
  const palabras = texto.split(" ");
  const lineas: string[] = [];
  let actual = "";
  for (const p of palabras) {
    if ((actual + " " + p).trim().length > ancho) {
      lineas.push(actual.trim());
      actual = p;
    } else {
      actual += " " + p;
    }
  }
  if (actual.trim()) lineas.push(actual.trim());
  return lineas.slice(0, 4);
}

const total = conversaciones.length;
let i = 0;

function siguiente(): void {
  if (i >= pendientes.length) {
    terminar();
    return;
  }
  mostrar(pendientes[i], total - pendientes.length + i + 1, total);
}

function terminar(): void {
  guardar(etiquetas);
  const hechas = Object.keys(etiquetas).length;
  console.log(`\n\nGuardadas ${hechas} de ${total} etiquetas.`);
  console.log(
    hechas >= total
      ? `Listo. Para ver el resultado:  npm run etiquetar -- --resumen\n`
      : `Faltan ${total - hechas}. Corré  npm run etiquetar  para seguir donde quedaste.\n`
  );
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error("Este comando necesita una terminal interactiva (no funciona con la salida redirigida).");
  process.exit(1);
}

console.log(`\n${pendientes.length} conversaciones para etiquetar (de ${total}).`);
console.log(`Se guarda después de cada tecla: podés cortar cuando quieras y retomar.`);

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", (tecla: string) => {
  const k = tecla.toLowerCase();

  // Ctrl+C y Ctrl+D como escapes, no como caracteres literales: un editor
  // que "limpie" el archivo se los lleva y la terminal queda trabada en modo
  // raw sin forma de salir.
  if (tecla === "" || tecla === "" || k === "q") {
    terminar();
    return;
  }

  if (k !== "l" && k !== "n" && k !== "d") return;

  etiquetas[pendientes[i].id] = k.toUpperCase() as Etiqueta;
  guardar(etiquetas); // Después de CADA tecla: cortar no pierde nada.
  i += 1;
  siguiente();
});

siguiente();
