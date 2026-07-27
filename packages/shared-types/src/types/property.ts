// Ficha de propiedad tal como la expone Tokko Broker (docs/SOW.md secc. 4.2).
// Campos marcados opcionales porque Tokko no garantiza que estén cargados —
// el agente nunca debe inventar un valor ausente (ver "response.style:
// generative_grounded" en docs/intent_catalog.yaml).

export type PropertyStatus = "disponible" | "reservada" | "alquilada" | "vendida";

export interface Property {
  id: string;
  tokkoId: string;
  direccion: string;
  direccionCorta: string;
  tipo: string; // ej. "departamento", "casa", "PH"
  estado: PropertyStatus;
  precio?: number;
  moneda?: string;
  expensas?: number;
  requisitos?: string;
  garantiasAceptadas?: string[];
  ambientes?: number;
  metrosCuadrados?: number;
  // Coordenadas para pedir clima de la visita (docs/intent_catalog.yaml:
  // consulta_clima_visita). Tokko no siempre las carga a nivel propiedad —
  // si faltan, el caller decide un fallback razonable, nunca se inventan.
  lat?: number;
  lng?: number;
  fotos?: string[];
  planos?: string[];
  videos?: string[];
  linkPortal?: string;
}
