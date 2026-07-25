// Lead/contacto tal como lo maneja Tokko Broker. "temperatura" alimenta las
// reglas de recontacto proactivo (docs/intent_catalog.yaml: recontacto_lead_frio).

export type LeadTemperature = "nuevo" | "tibio" | "frio";

export interface Lead {
  id: string;
  tokkoId: string;
  nombre: string;
  telefonoWhatsapp: string;
  email?: string;
  temperatura: LeadTemperature;
  propiedadesDeInteres: string[]; // Property.id
  ultimaInteraccion?: string; // ISO date
  diasSinRespuesta: number;
}
