/**
 * Re-anonimiza el corpus de estilo con la lista de nombres actualizada.
 *
 * Por qué hace falta: el texto se guarda ya anonimizado, así que **un
 * identificador que no se conocía al escribir queda ahí para siempre**. Un
 * cliente que escribió antes de estar cargado en Tokko, un apodo, un nombre
 * que no venía detrás de un saludo. Como el corpus se conserva sin plazo, ese
 * error no se vence solo: hay que ir a buscarlo.
 *
 * Volver a pasar el anonimizador es idempotente — sobre un texto ya limpio no
 * cambia nada — así que correrlo de más no hace daño. Conviene después de
 * cargar contactos nuevos en Tokko.
 *
 *   npm run estilo:reanonimizar            -> simulacro: dice qué cambiaría
 *   npm run estilo:reanonimizar -- --aplicar  -> reescribe el corpus
 *
 * **Nunca imprime el texto de los ejemplos**, ni los viejos ni los nuevos:
 * sería exactamente el dato que se está tratando de proteger. Sólo cuenta.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anonimizar } from "shared-types";
import { FileEstiloBrokerStore } from "../apps/orchestrator/src/agent/estiloBrokerStore.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)])
);

const aplicar = process.argv.includes("--aplicar");

const store = new FileEstiloBrokerStore(
  env.ESTILO_BROKER_STORE_PATH || path.join(REPO, "apps/orchestrator/data/estilo_broker.jsonl")
);

const ejemplos = await store.all();
if (ejemplos.length === 0) {
  console.log("\nEl corpus está vacío: no hay nada que re-anonimizar.\n");
  process.exit(0);
}

// Nombres y direcciones actuales, de Tokko. Si falla, se sigue igual con los
// patrones — una re-anonimización parcial es mejor que ninguna.
const nombres = new Set<string>();
const direcciones = new Set<string>();

if (env.TOKKO_API_KEY) {
  const BASE = (env.TOKKO_API_BASE_URL || "https://www.tokkobroker.com/api/v1").replace(/\/$/, "");
  const key = encodeURIComponent(env.TOKKO_API_KEY);
  try {
    let offset = 0;
    for (;;) {
      const res = await fetch(`${BASE}/contact/?order_by=created_at&limit=200&offset=${offset}&key=${key}&format=json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: any = JSON.parse(await res.text());
      const lote: any[] = json.objects ?? [];
      for (const c of lote) {
        const n = String(c.name ?? "").trim();
        if (n.length >= 3) nombres.add(n);
      }
      offset += lote.length;
      process.stderr.write(`\r  leyendo contactos… ${offset}/${json.meta.total_count}`);
      if (lote.length === 0 || offset >= json.meta.total_count) break;
    }
    process.stderr.write("\n");

    const resProp = await fetch(`${BASE}/property/?limit=200&key=${key}&format=json`);
    for (const p of (JSON.parse(await resProp.text()).objects ?? []) as any[]) {
      for (const d of [p.address, p.real_address, p.fake_address]) {
        const limpia = String(d ?? "").trim();
        if (limpia.length >= 4) direcciones.add(limpia);
      }
    }
  } catch (e) {
    process.stderr.write("\n");
    console.error(`  AVISO: no se pudo leer Tokko (${e}). Se re-anonimiza sólo por patrones.\n`);
  }
}

const actualizados = ejemplos.map((e) => ({ ...e, texto: anonimizar(e.texto, { nombres, direcciones }) }));
const cambiados = actualizados.filter((e, i) => e.texto !== ejemplos[i]?.texto).length;

console.log("");
console.log(`Ejemplos en el corpus:        ${ejemplos.length}`);
console.log(`Nombres conocidos aplicados:  ${nombres.size}`);
console.log(`Direcciones aplicadas:        ${direcciones.size}`);
console.log(`Ejemplos que CAMBIARÍAN:      ${cambiados}`);
console.log("");

if (cambiados === 0) {
  console.log("Nada que limpiar: el corpus ya está anonimizado con los datos actuales.\n");
  process.exit(0);
}

if (!aplicar) {
  console.log("Fue un simulacro, no se tocó nada.");
  console.log("Para aplicarlo:  npm run estilo:reanonimizar -- --aplicar\n");
  process.exit(0);
}

await store.reescribir(actualizados);
console.log(`Listo: ${cambiados} ejemplos re-anonimizados.\n`);
