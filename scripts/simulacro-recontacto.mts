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
import {
  CRITERIO_POR_DEFECTO,
  esCandidatoARecontacto,
} from "../mcp-servers/mcp-tokko/src/candidatosRecontacto.js";
import { mapearLead } from "../mcp-servers/mcp-tokko/src/tokkoMapper.js";
import {
  CONFIG_POR_DEFECTO,
  formatearReporte,
  planificarRecontacto,
  puedeCorrer,
  type EstadoDeContacto,
} from "../apps/orchestrator/src/jobs/recontactoPolicy.js";
import { FileUltimoContactoStore } from "../apps/orchestrator/src/agent/ultimoContactoStore.js";
import { FileTopeDiarioStore } from "../apps/orchestrator/src/jobs/topeDiarioStore.js";
import { NumerosInternos } from "../apps/orchestrator/src/jobs/numerosInternos.js";

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
    // order_by fijo: sin el, el paginado sobre un dataset vivo lee un
    // subconjunto distinto en cada corrida y la lista a revisar cambia sola.
    const url = `${BASE}/contact/?order_by=created_at&limit=200&offset=${offset}&key=${encodeURIComponent(KEY)}&format=json`;
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

// Se usa `mapearLead`, el MISMO mapeo que el cliente real de Tokko. Armar el
// Lead a mano acá haría que el simulacro trabajara con datos distintos a los
// del job — entre otras cosas, con un `diasSinRespuesta` inventado, que es
// justo el campo por el que se ordenan los candidatos.
const candidatos: Lead[] = [];
for (const c of crudos) {
  if (!esCandidatoARecontacto(c, CRITERIO_POR_DEFECTO)) continue;
  const mapeado = mapearLead(c);
  if (!mapeado || !mapeado.contactable) continue;
  candidatos.push(mapeado.lead);
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

// Números a los que el job NUNCA puede escribir. Tres fuentes, porque ninguna
// alcanza sola: el .env puede tener un número viejo (de hecho lo tenía), y los
// usuarios de Tokko no incluyen la línea de WhatsApp Business.
//  1. la línea de WhatsApp Business, preguntándosela a Meta (es la autoridad);
//  2. BROKER_WHATSAPP_NUMBER del .env;
//  3. los teléfonos de todos los usuarios de la cuenta de Tokko.
const internos = new NumerosInternos();
internos.agregar(env.BROKER_WHATSAPP_NUMBER);

if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } }
    );
    const j = (await r.json()) as { display_phone_number?: string };
    if (j.display_phone_number) internos.agregar(j.display_phone_number);
    else console.error("  AVISO: Meta no devolvió display_phone_number; la línea NO quedó excluida");
  } catch (e) {
    console.error("  AVISO: no se pudo consultar la línea a Meta:", e);
  }
} else {
  console.error("  AVISO: sin WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID, la línea NO queda excluida");
}

try {
  const r = await fetch(`${BASE}/user/?limit=100&key=${encodeURIComponent(KEY)}&format=json`);
  const usuarios = (JSON.parse(await r.text()).objects ?? []) as Array<Record<string, unknown>>;
  for (const u of usuarios) internos.agregar(String(u.phone ?? ""), String(u.cellphone ?? ""));
} catch (e) {
  console.error("  AVISO: no se pudieron leer los usuarios de Tokko:", e);
}

const topeDiario = new FileTopeDiarioStore(
  env.TOPE_DIARIO_STORE_PATH || path.join(REPO, "apps/orchestrator/data/tope_diario.json")
);
const ahora = new Date();
const enviadosHoy = await topeDiario.enviadosEn(ahora);

const plan = planificarRecontacto(candidatos, estados, enviadosHoy, ahora, CONFIG_POR_DEFECTO, internos);

console.log("");
console.log(`Candidatos que pasan el criterio y tienen teléfono usable: ${candidatos.length}`);
console.log(`Números internos registrados (nunca reciben): ${internos.size} formas`);
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
