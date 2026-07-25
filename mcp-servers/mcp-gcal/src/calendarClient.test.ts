import { describe, expect, it } from "vitest";
import { toCalendarEvent, toCreateEventRequestBody, toPatchEventRequestBody } from "./calendarClient.js";

describe("toCalendarEvent", () => {
  it("mapea un evento con dateTime y attendees", () => {
    const event = toCalendarEvent({
      id: "abc123",
      summary: "Visita depto Palermo",
      description: "Con Juan Pérez",
      start: { dateTime: "2026-07-27T15:00:00-03:00" },
      end: { dateTime: "2026-07-27T15:30:00-03:00" },
      attendees: [{ email: "juan@example.com" }],
      status: "confirmed",
    });

    expect(event).toEqual({
      id: "abc123",
      summary: "Visita depto Palermo",
      description: "Con Juan Pérez",
      start: "2026-07-27T15:00:00-03:00",
      end: "2026-07-27T15:30:00-03:00",
      attendees: ["juan@example.com"],
      status: "confirmed",
    });
  });

  it("usa 'date' (evento de todo el día) si no hay dateTime, y no rompe sin attendees", () => {
    const event = toCalendarEvent({
      id: "allday1",
      start: { date: "2026-07-27" },
      end: { date: "2026-07-28" },
    });

    expect(event.start).toBe("2026-07-27");
    expect(event.end).toBe("2026-07-28");
    expect(event.attendees).toBeUndefined();
    expect(event.status).toBe("confirmed");
  });
});

describe("toCreateEventRequestBody", () => {
  it("arma el body con attendee opcional", () => {
    const body = toCreateEventRequestBody({
      summary: "Visita",
      startDateTime: "2026-07-27T15:00:00-03:00",
      endDateTime: "2026-07-27T15:30:00-03:00",
      attendeeEmail: "juan@example.com",
    });

    expect(body.attendees).toEqual([{ email: "juan@example.com" }]);
    expect(body.start).toEqual({ dateTime: "2026-07-27T15:00:00-03:00" });
  });

  it("omite attendees si no se pasa attendeeEmail", () => {
    const body = toCreateEventRequestBody({
      summary: "Visita",
      startDateTime: "2026-07-27T15:00:00-03:00",
      endDateTime: "2026-07-27T15:30:00-03:00",
    });

    expect(body.attendees).toBeUndefined();
  });
});

describe("toPatchEventRequestBody", () => {
  it("solo incluye los campos provistos", () => {
    const body = toPatchEventRequestBody({ startDateTime: "2026-07-28T11:00:00-03:00" });

    expect(body.start).toEqual({ dateTime: "2026-07-28T11:00:00-03:00" });
    expect(body.end).toBeUndefined();
    expect(body.summary).toBeUndefined();
  });
});
