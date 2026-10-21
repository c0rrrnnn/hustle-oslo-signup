import type { PricedNight, StoredOrder } from "./types.ts";

const ADDRESS = "Sentralen, Øvre Slottsgate 3, 0157 Oslo";
const DETAILS = "What to bring: non-grippy shoes. No partner needed.\nQuestions? DM @hustleoslo on Instagram";

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Oslo",
  "X-LIC-LOCATION:Europe/Oslo",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

export function calendarBaseFor(order: StoredOrder, env: { WORKER_PUBLIC_URL?: string }): string {
  return String(order.workerOrigin || env.WORKER_PUBLIC_URL || "").replace(/\/$/, "");
}

/** Class or social window. The stored night start/end is the whole evening. */
export function ticketSpan(night: PricedNight): { start: string; end: string } {
  if (night.ticketId === "beginners") return { start: "18:00", end: "19:00" };
  if (night.ticketId === "intermediate") return { start: "19:00", end: "20:00" };
  if (night.ticketId === "bundle") return { start: "18:00", end: "20:00" };
  if (night.ticketId === "social" && night.eventType === "class") return { start: "20:00", end: "21:00" };
  return { start: night.eventStart || "18:00", end: night.eventEnd || "20:00" };
}

export function calendarSummary(night: PricedNight): string {
  const name = night.ticketName || (night.eventType === "social" ? "Social" : "Class");
  return `Hustle Oslo – ${name}`;
}

export function calendarLocation(night: PricedNight): string {
  const room = String(night.eventLocation || "").trim();
  return room ? `${ADDRESS}, ${room}` : ADDRESS;
}

export function calendarUid(orderId: string, eventId: string): string {
  return `${orderId}-${eventId}@hustleoslo.com`;
}

function osloParts(date: Date): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || "0");
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute"), ss: get("second") };
}

/** Wall-clock Europe/Oslo to a UTC instant. Handles CET and CEST. */
export function osloLocalToUtc(date: string, hm: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hm.split(":").map(Number);
  const desired = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = desired;
  for (let i = 0; i < 4; i++) {
    const wall = osloParts(new Date(utc));
    const actual = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm, wall.ss);
    if (actual === desired) break;
    utc -= actual - desired;
  }
  return new Date(utc);
}

export function utcBasic(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function googleCalendarUrl(night: PricedNight): string {
  const span = ticketSpan(night);
  const start = utcBasic(osloLocalToUtc(night.eventDate, span.start));
  const end = utcBasic(osloLocalToUtc(night.eventDate, span.end));
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: calendarSummary(night),
    location: calendarLocation(night),
    details: DETAILS,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}&dates=${start}/${end}`;
}

export function icsUrlFor(base: string, orderId: string, eventId?: string): string {
  const root = base.replace(/\/$/, "");
  const url = new URL(`${root}/ics`);
  url.searchParams.set("order", orderId);
  if (eventId) url.searchParams.set("eventId", eventId);
  return url.toString();
}

export interface CalendarNightLink {
  eventId: string;
  eventDate: string;
  summary: string;
  googleUrl: string;
  icsUrl: string;
}

export function calendarEmailLinks(
  order: StoredOrder,
  base: string,
): { icsUrl: string; nights: CalendarNightLink[] } | null {
  const root = String(base || "").replace(/\/$/, "");
  if (!root || !order.orderId || order.nights.length === 0) return null;
  return {
    icsUrl: icsUrlFor(root, order.orderId),
    nights: order.nights.map((night) => ({
      eventId: night.eventId,
      eventDate: night.eventDate,
      summary: calendarSummary(night),
      googleUrl: googleCalendarUrl(night),
      icsUrl: icsUrlFor(root, order.orderId, night.eventId),
    })),
  };
}

export function calendarFields(order: StoredOrder, base: string): Record<string, unknown> {
  const links = calendarEmailLinks(order, base);
  if (!links) return {};
  return {
    orderId: order.orderId,
    calendarIcs: links.icsUrl,
    calendarNights: links.nights,
  };
}

/** `night` is a 0-based index. `eventId` wins when both are present. */
export function nightsForCalendar(order: StoredOrder, params: URLSearchParams): PricedNight[] | null {
  const eventId = String(params.get("eventId") || "");
  if (eventId) {
    const found = order.nights.filter((night) => night.eventId === eventId);
    return found.length ? found : null;
  }
  const night = params.get("night");
  if (night != null && night !== "") {
    if (!/^\d+$/.test(night)) return null;
    const index = Number(night);
    if (!Number.isInteger(index) || index < 0 || index >= order.nights.length) return null;
    return [order.nights[index]];
  }
  return order.nights.slice();
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r\n|\n|\r/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const max = parts.length === 0 ? 75 : 74;
    if (current && currentBytes + size > max) {
      parts.push(current);
      current = char;
      currentBytes = size;
    } else {
      current += char;
      currentBytes += size;
    }
  }
  if (current) parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

function foldIcs(text: string): string {
  return text
    .split("\r\n")
    .map((line) => foldLine(line))
    .join("\r\n");
}

function localStamp(date: string, hm: string): string {
  const [hh, mm] = hm.split(":");
  return `${date.replace(/-/g, "")}T${hh}${mm}00`;
}

export function buildCalendar(orderId: string, nights: PricedNight[], stamp: Date): string {
  const dtStamp = utcBasic(stamp);
  const events = nights.map((night) => {
    const span = ticketSpan(night);
    return [
      "BEGIN:VEVENT",
      `UID:${icsEscape(calendarUid(orderId, night.eventId))}`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART;TZID=Europe/Oslo:${localStamp(night.eventDate, span.start)}`,
      `DTEND;TZID=Europe/Oslo:${localStamp(night.eventDate, span.end)}`,
      `SUMMARY:${icsEscape(calendarSummary(night))}`,
      `LOCATION:${icsEscape(calendarLocation(night))}`,
      `DESCRIPTION:${icsEscape(DETAILS)}`,
      "END:VEVENT",
    ].join("\r\n");
  });
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hustle Oslo//Signup//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", VTIMEZONE, ...events, "END:VCALENDAR", ""].join("\r\n");
  return foldIcs(body);
}
