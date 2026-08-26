/**
 * Simulacro de recontacto: muestra a quiénes les escribiría el job, con nombre
 * y teléfono, sin mandar absolutamente nada.
 *
 * Corre el MISMO cálculo que el envío real (`planificarRecontacto`), no una
 * aproximación: si fueran dos caminos distintos, esto podría dejar de reflejar
 * la realidad justo cuando más importa que la refleje.
 *
 *   npm run recontacto:simulacro              -> lista completa
 *   npm run recontacto:simulacro -- --masked  -> teléfonos enmascarados
 *
 * No escribe ningún archivo: sale por consola y se va con la terminal.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Lead } from "shared-types";
import { normalizarTelefono } from "shared-types";
import {
  CRITERIO_POR_DEFECTO,
  esCandidatoARecontacto,
} from "../mcp-servers/mcp-tokko/src/candidatosRecontacto.js";
import {
  CONFIG_POR_DEFECTO,
  formatearReporte,
  planificarRecontacto,
  puedeCorrer,
  type EstadoDeContacto,
} from "../apps/orchestrator/src/jobs/recontactoPolicy.js";
import { FileUltimoContactoStore } from "../apps/orchestrator/src/agent/ultimoContactoStore.js";
import { FileTopeDiarioStore } from "../apps/orchestrator/src/jobs/topeDiarioStore.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(REPO, ".env"), "utf8")
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

const masked = process.argv.includes("--masked");

async function traerContactos(): Promise<any[]> {
  // Deduplicado por id: paginar por offset sobre un dataset vivo repite
  // registros cuando alguien carga un contacto mientras leemos.
  const porId = new Map<string, any>();
  let offset = 0;
  for (;;) {
    const url = `${BASE}/contact/?limit=200&offset=${offset}&key=${encodeURIComponent(KEY)}&format=json`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(`Tokko respondió HTTP ${res.status}`);
    const json: any = JSON.parse(await res.text());
    const lote: any[] = json.objects ?? [];
    for (const item of lote) if (item?.id != null) porId.set(String(item.id), item);
    offset += lote.length;
    process.stderr.write(`\r  leyendo… ${porId.size} únicos / ${json.meta.total_count}`);
    // El corte va por OFFSET recorrido, no por cantidad de únicos: si se
    // repiten registros, contar únicos haría que el loop nunca termine.
    if (lote.length === 0 || offset >= json.meta.total_count) break;
  }
  process.stderr.write("\n");
  return [...porId.values()];
}

const crudos = await traerContactos();

const candidatos: Lead[] = [];
for (const c of crudos) {
  if (!esCandidatoARecontacto(c, CRITERIO_POR_DEFECTO)) continue;
  const crudo = [c.cellphone, c.phone, c.other_phone].map((v: unknown) => String(v ?? "").trim()).find(Boolean) ?? "";
  const tel = normalizarTelefono(crudo);
  if (!tel.usable) continue;
  candidatos.push({
    id: String(c.id),
    tokkoId: String(c.id),
    nombre: String(c.name ?? "").trim() || "(sin nombre)",
    telefonoWhatsapp: tel.paraEnviar!,
    temperatura: "frio",
    propiedadesDeInteres: [],
    diasSinRespuesta: 999,
  });
}

// Estado real: lo que el sistema ya sabe de contactos previos, del sistema o
// del broker a mano (vía el eco de coexistencia).
const ultimoContacto = new FileUltimoContactoStore(
  env.ULTIMO_CONTACTO_STORE_PATH || path.join(REPO, "apps/orchestrator/data/ultimo_contacto.json")
);
const porLead = new Map<string, EstadoDeContacto>();
const porTelefono = new Map<string, EstadoDeContacto>();
for (const registro of await ultimoContacto.all()) {
  porLead.set(registro.leadId, { intentos: 0, ultimoContactoAt: registro.contactadoAt });
}
// La vista por telefono es la que ataja las fichas duplicadas de Tokko.
for (const c of candidatos) {
  const previo = porLead.get(c.id);
  if (previo) porTelefono.set(c.telefonoWhatsapp, previo);
}
const estados = { porLead, porTelefono };

const topeDiario = new FileTopeDiarioStore(
  env.TOPE_DIARIO_STORE_PATH || path.join(REPO, "apps/orchestrator/data/tope_diario.json")
);
const ahora = new Date();
const enviadosHoy = await topeDiario.enviadosEn(ahora);

const plan = planificarRecontacto(candidatos, estados, enviadosHoy, ahora, CONFIG_POR_DEFECTO);

console.log("");
console.log(`Candidatos que pasan el criterio y tienen teléfono usable: ${candidatos.length}`);
console.log(`Ya enviados hoy: ${enviadosHoy} (tope diario: ${CONFIG_POR_DEFECTO.topePorDia})`);
const ventana = puedeCorrer(ahora, undefined, CONFIG_POR_DEFECTO);
console.log(
  ventana.puede
    ? `Horario: OK (ventana ${CONFIG_POR_DEFECTO.horaInicio}:00-${CONFIG_POR_DEFECTO.horaFin}:00)`
    : `Horario: el job NO correria ahora — ${ventana.detalle}`
);
console.log("");

let reporte = formatearReporte(plan, true);
if (masked) reporte = reporte.replace(/\b(\d{6,})(\d{4})\b/g, (_m, _a, b) => "•••" + b);
console.log(reporte);
console.log("");
