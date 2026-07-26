import type { Property, Lead } from "shared-types";
import type {
  TokkoClient,
  PropertySearchFilters,
  LeadSearchFilters,
  LogActivityInput,
  LogActivityResult,
} from "./tokkoClient.js";

// Datos de ejemplo para desarrollo/tests. NO representan propiedades o
// leads reales — cuando se conecte la API real de Tokko, este archivo deja
// de usarse en producción (server.ts solo lo usa como default sin
// TOKKO_API_KEY configurada).
const MOCK_PROPERTIES: Property[] = [
  {
    id: "prop-1",
    tokkoId: "tokko-1001",
    direccion: "Av. Santa Fe 3253, Palermo, CABA",
    direccionCorta: "Depto Palermo",
    tipo: "departamento",
    estado: "disponible",
    precio: 350000,
    moneda: "ARS",
    expensas: 45000,
    requisitos: "Garantía propietaria o seguro de caución",
    garantiasAceptadas: ["propietaria", "seguro_caucion"],
    ambientes: 2,
    metrosCuadrados: 55,
    fotos: ["https://example.com/prop-1/foto1.jpg"],
  },
  {
    id: "prop-2",
    tokkoId: "tokko-1002",
    direccion: "Av. Cabildo 2100, Belgrano, CABA",
    direccionCorta: "2 amb. Av. Cabildo",
    tipo: "departamento",
    estado: "reservada",
    precio: 280000,
    moneda: "ARS",
    expensas: 30000,
    ambientes: 2,
    metrosCuadrados: 48,
  },
];

const MOCK_LEADS: Lead[] = [
  {
    id: "lead-1",
    tokkoId: "tokko-lead-1",
    nombre: "Juan Pérez",
    telefonoWhatsapp: "+5491100000001",
    temperatura: "tibio",
    propiedadesDeInteres: ["prop-1"],
    diasSinRespuesta: 2,
  },
  {
    id: "lead-2",
    tokkoId: "tokko-lead-2",
    nombre: "María Gómez",
    telefonoWhatsapp: "+5491100000002",
    temperatura: "frio",
    propiedadesDeInteres: ["prop-2"],
    diasSinRespuesta: 12,
  },
];

// Rango Unicode de marcas diacríticas combinantes (U+0300-U+036F), para
// poder comparar "Perez" con "Pérez" ignorando acentos.
const DIACRITICS_REGEX = /[̀-ͯ]/g;

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(DIACRITICS_REGEX, "");
}

// El classifier del orchestrator extrae `search_query` de lenguaje libre
// (ej. "depto Palermo", no solo "Palermo") — exigir que ese string completo
// aparezca como substring literal en la dirección es demasiado frágil.
// Matcheamos si ALGUNA palabra significativa de la query aparece en la
// dirección (descartamos palabras muy cortas tipo "el"/"de" para no matchear
// cualquier cosa).
const MIN_SIGNIFICANT_WORD_LENGTH = 3;

function matchesAnyWord(haystack: string, query: string): boolean {
  const normalizedHaystack = normalize(haystack);
  const words = normalize(query)
    .split(/\s+/)
    .filter((word) => word.length >= MIN_SIGNIFICANT_WORD_LENGTH);
  if (words.length === 0) return normalizedHaystack.includes(normalize(query));
  return words.some((word) => normalizedHaystack.includes(word));
}

export class MockTokkoClient implements TokkoClient {
  constructor(
    private readonly properties: Property[] = MOCK_PROPERTIES,
    private readonly leads: Lead[] = MOCK_LEADS
  ) {}

  async searchProperties(filters: PropertySearchFilters): Promise<Property[]> {
    return this.properties.filter((property) => {
      if (filters.barrio && !matchesAnyWord(property.direccion, filters.barrio)) {
        return false;
      }
      if (filters.direccion && !matchesAnyWord(property.direccion, filters.direccion)) {
        return false;
      }
      if (filters.tipo && normalize(property.tipo) !== normalize(filters.tipo)) {
        return false;
      }
      if (filters.codigo && property.tokkoId !== filters.codigo) {
        return false;
      }
      return true;
    });
  }

  async getProperty(propertyId: string): Promise<Property | null> {
    return this.properties.find((p) => p.id === propertyId || p.tokkoId === propertyId) ?? null;
  }

  async searchLeads(filters: LeadSearchFilters): Promise<Lead[]> {
    return this.leads.filter((lead) => {
      if (filters.temperatura && lead.temperatura !== filters.temperatura) {
        return false;
      }
      if (filters.diasSinRespuestaMin !== undefined && lead.diasSinRespuesta < filters.diasSinRespuestaMin) {
        return false;
      }
      return true;
    });
  }

  async getLead(leadId: string): Promise<Lead | null> {
    return this.leads.find((l) => l.id === leadId || l.tokkoId === leadId) ?? null;
  }

  async logActivity(input: LogActivityInput): Promise<LogActivityResult> {
    void input; // el mock no persiste; el orchestrator real loguea en audit_log/Postgres
    return { logged: true, activityId: `mock-activity-${Date.now()}` };
  }
}
