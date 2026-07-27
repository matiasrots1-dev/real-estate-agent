import { describe, expect, it, vi } from "vitest";
import type { GcalQueries } from "../mcp/gcalMcpClient.js";
import { formatSlotForHuman, proposeAvailableSlots } from "./slotProposal.js";

function gcalWithBusy(busy: Array<{ start: string; end: string }>): GcalQueries {
  return {
    freebusy: vi.fn(async () => busy),
    createEvent: vi.fn(),
    patchEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
    listEvents: vi.fn(),
  };
}

function argentinaHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "numeric",
      hour12: false,
    }).format(new Date(iso))
  );
}

function argentinaWeekday(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
  }).format(new Date(iso));
}

describe("proposeAvailableSlots", () => {
  it("propone hasta 3 horarios en horario habitual (9-20hs Argentina, sin domingos)", async () => {
    // 2026-08-05T00:00:00Z es lunes 21hs ART -> arranca a buscar desde ahí.
    const gcal = gcalWithBusy([]);
    const result = await proposeAvailableSlots(gcal, "2026-08-05T00:00:00Z");

    expect(gcal.freebusy).toHaveBeenCalledTimes(1);
    expect(result.toolsCalled).toEqual(["gcal.freebusy"]);
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.length).toBeLessThanOrEqual(3);

    for (const slot of result.slots) {
      const hour = argentinaHour(slot.startDateTime);
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(20);
      expect(argentinaWeekday(slot.startDateTime)).not.toBe("Sun");
    }

    // ordenados cronológicamente
    const times = result.slots.map((s) => new Date(s.startDateTime).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("no propone un horario que se superpone con un evento existente", async () => {
    const gcal = gcalWithBusy([]);
    const free = await proposeAvailableSlots(gcal, "2026-08-05T00:00:00Z");
    const firstSlot = free.slots[0];

    const gcalBusy = gcalWithBusy([{ start: firstSlot.startDateTime, end: firstSlot.endDateTime }]);
    const withBusy = await proposeAvailableSlots(gcalBusy, "2026-08-05T00:00:00Z");

    expect(withBusy.slots.some((s) => s.startDateTime === firstSlot.startDateTime)).toBe(false);
  });

  it("devuelve [] si no hay ningún hueco libre en las próximas 72hs (agenda llena)", async () => {
    const gcal = gcalWithBusy([
      { start: "2026-08-04T00:00:00Z", end: "2026-08-08T00:00:00Z" },
    ]);
    const result = await proposeAvailableSlots(gcal, "2026-08-05T00:00:00Z");
    expect(result.slots).toEqual([]);
  });
});

describe("formatSlotForHuman", () => {
  it("formatea en español, hora de Argentina", () => {
    const text = formatSlotForHuman("2026-08-05T12:00:00.000Z");
    expect(text).toMatch(/09:00/);
    expect(text.toLowerCase()).toMatch(/miércoles/);
  });
});
