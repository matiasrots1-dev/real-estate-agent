import { describe, expect, it, vi } from "vitest";
import type { CalendarClient, CalendarEvent, FreeBusySlot } from "../calendarClient.js";
import { createFreebusyHandler } from "./freebusy.js";
import { createCreateEventHandler } from "./createEvent.js";
import { createPatchEventHandler } from "./patchEvent.js";
import { createDeleteEventHandler } from "./deleteEvent.js";
import { createGetEventHandler } from "./getEvent.js";
import { createListEventsHandler } from "./listEvents.js";

const sampleEvent: CalendarEvent = {
  id: "evt1",
  summary: "Visita depto Palermo",
  start: "2026-07-27T15:00:00-03:00",
  end: "2026-07-27T15:30:00-03:00",
  status: "confirmed",
};

function stubClient(overrides: Partial<CalendarClient> = {}): CalendarClient {
  return {
    freebusy: vi.fn(async () => [] as FreeBusySlot[]),
    createEvent: vi.fn(async () => sampleEvent),
    patchEvent: vi.fn(async () => sampleEvent),
    deleteEvent: vi.fn(async () => {}),
    getEvent: vi.fn(async () => sampleEvent),
    listEvents: vi.fn(async () => [sampleEvent]),
    ...overrides,
  };
}

describe("tool handlers (client OK)", () => {
  it("freebusy devuelve los slots del client", async () => {
    const slots: FreeBusySlot[] = [{ start: "2026-07-27T10:00:00-03:00", end: "2026-07-27T11:00:00-03:00" }];
    const client = stubClient({ freebusy: vi.fn(async () => slots) });
    const result = await createFreebusyHandler(client)({
      timeMin: "2026-07-27T00:00:00-03:00",
      timeMax: "2026-07-28T00:00:00-03:00",
    });
    expect(JSON.parse(result.content[0].text as string)).toEqual(slots);
  });

  it("create_event delega en client.createEvent y devuelve el evento creado", async () => {
    const client = stubClient();
    const result = await createCreateEventHandler(client)({
      summary: "Visita depto Palermo",
      startDateTime: "2026-07-27T15:00:00-03:00",
      endDateTime: "2026-07-27T15:30:00-03:00",
    });
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text as string)).toEqual(sampleEvent);
  });

  it("patch_event separa eventId del resto del patch", async () => {
    const client = stubClient();
    await createPatchEventHandler(client)({
      eventId: "evt1",
      startDateTime: "2026-07-28T11:00:00-03:00",
    });
    expect(client.patchEvent).toHaveBeenCalledWith("evt1", { startDateTime: "2026-07-28T11:00:00-03:00" });
  });

  it("delete_event confirma el borrado sin inventar datos del evento", async () => {
    const client = stubClient();
    const result = await createDeleteEventHandler(client)({ eventId: "evt1" });
    expect(client.deleteEvent).toHaveBeenCalledWith("evt1");
    expect(JSON.parse(result.content[0].text as string)).toEqual({ deleted: true, eventId: "evt1" });
  });

  it("get_event y list_events devuelven lo que trae el client", async () => {
    const client = stubClient();
    const got = await createGetEventHandler(client)({ eventId: "evt1" });
    expect(JSON.parse(got.content[0].text as string)).toEqual(sampleEvent);

    const listed = await createListEventsHandler(client)({
      timeMin: "2026-07-27T00:00:00-03:00",
      timeMax: "2026-07-28T00:00:00-03:00",
    });
    expect(JSON.parse(listed.content[0].text as string)).toEqual([sampleEvent]);
  });
});

describe("tool handlers (client falla)", () => {
  it("nunca inventa un evento: si el client tira error, el handler devuelve isError", async () => {
    const client = stubClient({
      getEvent: vi.fn(async () => {
        throw new Error("evento no encontrado");
      }),
    });
    const result = await createGetEventHandler(client)({ eventId: "no-existe" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no encontrado/);
  });
});
