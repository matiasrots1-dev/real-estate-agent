import type { GcalQueries } from "../mcp/gcalMcpClient.js";

const ARGENTINA_TZ = "America/Argentina/Buenos_Aires"; // sin horario de verano desde 2009, offset fijo
const VISIT_DURATION_MINUTES = 30;
const BUSINESS_HOUR_START = 9;
const BUSINESS_HOUR_END = 20;
const WINDOW_HOURS = 72;
const MAX_PROPOSALS = 3;

export interface ProposedSlot {
  startDateTime: string; // ISO UTC
  endDateTime: string; // ISO UTC
}

export interface SlotProposalResult {
  slots: ProposedSlot[];
  toolsCalled: string[];
}

function argentinaHourAndWeekday(date: Date): { hour: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ARGENTINA_TZ,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  return { hour, weekday };
}

function isWithinBusinessHours(date: Date): boolean {
  const { hour, weekday } = argentinaHourAndWeekday(date);
  return weekday !== "Sun" && hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END;
}

/**
 * Propone hasta 3 horarios libres dentro de las próximas 72hs, en horario
 * habitual (9-20hs, sin domingos, hora de Argentina — docs/intent_catalog.yaml:
 * agendar_visita/reprogramar_cancelar_visita). Si devuelve `slots: []`, el
 * caller debe escalar (docs/escalation_policy.md regla 2: sin disponibilidad
 * compatible en 72hs).
 */
export async function proposeAvailableSlots(
  gcal: GcalQueries,
  fromIso: string
): Promise<SlotProposalResult> {
  const windowStart = new Date(fromIso);
  const windowEnd = new Date(windowStart.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

  const busy = await gcal.freebusy(windowStart.toISOString(), windowEnd.toISOString());
  const busyRanges = busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));

  const slots: ProposedSlot[] = [];
  const cursor = new Date(windowStart);
  cursor.setUTCMinutes(0, 0, 0);
  cursor.setUTCHours(cursor.getUTCHours() + 1); // arrancar en la próxima hora en punto

  while (cursor.getTime() < windowEnd.getTime() && slots.length < MAX_PROPOSALS) {
    if (isWithinBusinessHours(cursor)) {
      const start = new Date(cursor);
      const end = new Date(start.getTime() + VISIT_DURATION_MINUTES * 60 * 1000);
      const overlaps = busyRanges.some((b) => b.start < end && b.end > start);
      if (!overlaps && start.getTime() > windowStart.getTime()) {
        slots.push({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
      }
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  return { slots, toolsCalled: ["gcal.freebusy"] };
}

/** Texto legible en español para proponer/confirmar un horario (hora de Argentina). */
export function formatSlotForHuman(isoDateTime: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: ARGENTINA_TZ,
    weekday: "long",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(isoDateTime));
}
