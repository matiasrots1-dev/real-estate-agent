import { describe, expect, it } from "vitest";
import { MockGoogleCalendarClient } from "./mockCalendarClient.js";

describe("MockGoogleCalendarClient", () => {
  it("crea un evento y lo puede leer por id", async () => {
    const client = new MockGoogleCalendarClient();
    const created = await client.createEvent({
      summary: "Visita depto Palermo",
      startDateTime: "2026-08-01T15:00:00-03:00",
      endDateTime: "2026-08-01T15:30:00-03:00",
      attendeeEmail: "juan@example.com",
    });

    expect(created.id).toBeTruthy();
    const fetched = await client.getEvent(created.id);
    expect(fetched).toEqual(created);
  });

  it("getEvent tira si el id no existe (no devuelve null, como el CalendarClient real)", async () => {
    const client = new MockGoogleCalendarClient();
    await expect(client.getEvent("no-existe")).rejects.toThrow(/no encontrado/);
  });

  it("freebusy devuelve los eventos que se superponen al rango pedido", async () => {
    const client = new MockGoogleCalendarClient();
    await client.createEvent({
      summary: "Visita 1",
      startDateTime: "2026-08-01T15:00:00-03:00",
      endDateTime: "2026-08-01T15:30:00-03:00",
    });
    await client.createEvent({
      summary: "Visita 2 (otro día, no debería aparecer)",
      startDateTime: "2026-08-05T10:00:00-03:00",
      endDateTime: "2026-08-05T10:30:00-03:00",
    });

    const busy = await client.freebusy("2026-08-01T00:00:00-03:00", "2026-08-02T00:00:00-03:00");
    expect(busy).toHaveLength(1);
    expect(busy[0].start).toBe("2026-08-01T15:00:00-03:00");
  });

  it("patchEvent actualiza solo los campos provistos", async () => {
    const client = new MockGoogleCalendarClient();
    const created = await client.createEvent({
      summary: "Visita",
      startDateTime: "2026-08-01T15:00:00-03:00",
      endDateTime: "2026-08-01T15:30:00-03:00",
    });

    const patched = await client.patchEvent(created.id, { startDateTime: "2026-08-01T18:00:00-03:00" });
    expect(patched.start).toBe("2026-08-01T18:00:00-03:00");
    expect(patched.end).toBe("2026-08-01T15:30:00-03:00");
    expect(patched.summary).toBe("Visita");
  });

  it("deleteEvent marca el evento como cancelado y freebusy deja de contarlo", async () => {
    const client = new MockGoogleCalendarClient();
    const created = await client.createEvent({
      summary: "Visita",
      startDateTime: "2026-08-01T15:00:00-03:00",
      endDateTime: "2026-08-01T15:30:00-03:00",
    });

    await client.deleteEvent(created.id);
    const fetched = await client.getEvent(created.id);
    expect(fetched.status).toBe("cancelled");

    const busy = await client.freebusy("2026-08-01T00:00:00-03:00", "2026-08-02T00:00:00-03:00");
    expect(busy).toEqual([]);
  });

  it("listEvents filtra por rango y ordena por inicio", async () => {
    const client = new MockGoogleCalendarClient();
    await client.createEvent({
      summary: "Later",
      startDateTime: "2026-08-01T18:00:00-03:00",
      endDateTime: "2026-08-01T18:30:00-03:00",
    });
    await client.createEvent({
      summary: "Earlier",
      startDateTime: "2026-08-01T10:00:00-03:00",
      endDateTime: "2026-08-01T10:30:00-03:00",
    });
    await client.createEvent({
      summary: "Fuera de rango",
      startDateTime: "2026-09-01T10:00:00-03:00",
      endDateTime: "2026-09-01T10:30:00-03:00",
    });

    const events = await client.listEvents("2026-08-01T00:00:00-03:00", "2026-08-02T00:00:00-03:00");
    expect(events.map((e) => e.summary)).toEqual(["Earlier", "Later"]);
  });
});
