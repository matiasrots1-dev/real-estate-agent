#!/usr/bin/env node
// Reporte de contactos de Tokko cuyo teléfono NO sirve para WhatsApp.
//
// Existe porque el filtro de teléfonos deja gente afuera en silencio: un
// celular cargado sin el `9` parsea como línea fija y nunca va a recibir un
// mensaje. Sin este reporte, esos contactos simplemente no existen para el
// agente y nadie se entera.
//
// Uso:
//   npm run tokko:telefonos            -> resumen
//   npm run tokko:telefonos -- --lista -> además, quiénes son (para corregirlos en Tokko)
//   npm run tokko:telefonos -- --csv   -> CSV a stdout
//
// El detalle incluye nombre y teléfono a propósito: el objetivo es poder ir a
// arreglarlos. Por eso NO se escribe a un archivo del repo — sale por consola
// y se va con la terminal.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizarTelefono } from "shared-types";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs.readFileSync(path.join(REPO, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)])
);

const KEY = env.TOKKO_API_KEY;
const BASE = (env.TOKKO_API_BASE_URL || "https://www.tokkobroker.com/api/v1").replace(/\/$/, "");
if (!KEY) {
  console.error("Falta TOKKO_API_KEY en .env");
  process.exit(1);
}

const lista = process.argv.includes("--lista");
const csv = process.argv.includes("--csv");

let esperado = 0;

async function traerTodos() {
  const todos = [];
  // El offset avanza por lo que la API DEVOLVIO, no por lo que se pidio:
  // Tokko topea la pagina en 50 aunque se pida mas, y avanzar de a 200
  // saltearia 150 contactos por vuelta -- una muestra dispersa que parece
  // un barrido completo.
  let offset = 0;
  for (;;) {
    const url = `${BASE}/contact/?limit=200&offset=${offset}&key=${encodeURIComponent(KEY)}&format=json`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`Tokko respondió HTTP ${res.status}`);
    const json = JSON.parse(await res.text());
    const lote = json.objects || [];
    todos.push(...lote);
    process.stderr.write(`\r  leyendo… ${todos.length}/${json.meta.total_count}`);
    offset += lote.length;
    if (lote.length === 0 || todos.length >= json.meta.total_count) break;
    esperado = json.meta.total_count;
  }
  process.stderr.write("\n");
  return todos;
}

const MOTIVOS = {
  sin_telefono: "Sin teléfono cargado",
  no_parseable: "No se entiende como número",
  invalido: "Número incompleto o inválido",
  no_es_movil: "Es línea fija (o falta el 9 del celular)",
};

const contactos = await traerTodos();
const problemas = [];
let usables = 0;

for (const c of contactos) {
  const crudo = [c.cellphone, c.phone, c.other_phone].map((v) => String(v ?? "").trim()).find(Boolean) ?? "";
  const r = normalizarTelefono(crudo);
  if (r.usable) { usables += 1; continue; }
  problemas.push({ id: c.id, nombre: c.name || "(sin nombre)", crudo, motivo: r.motivo, tipo: r.tipo ?? "" });
}

if (csv) {
  console.log("id,nombre,telefono_cargado,motivo");
  for (const p of problemas) {
    console.log([p.id, `"${String(p.nombre).replace(/"/g, '""')}"`, `"${p.crudo}"`, p.motivo].join(","));
  }
  process.exit(0);
}

console.log(`\nContactos analizados: ${contactos.length}`);
console.log(`  Contactables por WhatsApp: ${usables} (${((usables * 100) / contactos.length).toFixed(1)}%)`);
console.log(`  NO contactables:           ${problemas.length} (${((problemas.length * 100) / contactos.length).toFixed(1)}%)\n`);

const porMotivo = {};
for (const p of problemas) porMotivo[p.motivo] = (porMotivo[p.motivo] || 0) + 1;
for (const [m, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${MOTIVOS[m] ?? m}`);
}

const recuperables = porMotivo.no_es_movil ?? 0;
if (recuperables > 0) {
  console.log(`\n  De esos, ${recuperables} son RECUPERABLES: casi siempre es un celular`);
  console.log(`  cargado sin el 9. Corrigiéndolo en Tokko pasan a ser contactables.`);
}

if (!lista) {
  console.log(`\n  Para ver cuáles son: npm run tokko:telefonos -- --lista`);
  console.log(`  Para exportarlos:     npm run tokko:telefonos -- --csv > telefonos.csv\n`);
} else {
  console.log("\n--- detalle ---");
  for (const p of problemas) {
    console.log(`  [${p.id}] ${p.nombre}  |  "${p.crudo}"  |  ${MOTIVOS[p.motivo] ?? p.motivo}`);
  }
  console.log("");
}
