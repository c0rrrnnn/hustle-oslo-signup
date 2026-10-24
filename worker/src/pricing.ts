import { eventById, ticketFor } from "./catalog.ts";
import type { PricedNight } from "./types.ts";

export interface NightRequest {
  eventId: string;
  ticketId: string;
  priceTier?: string;
}

export type PriceResult =
  | { ok: true; nights: PricedNight[]; amountNok: number; amountMinor: number }
  | { ok: false; error: string };

const MAX_NIGHTS = 8;

/** Oslo wall-clock key, sortable as text. */
export function osloKey(date: Date): string {
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
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** A night can be booked until 18:00 Europe/Oslo on that date. */
export function isNightOpen(eventDate: string, now: Date): boolean {
  return osloKey(now) < `${eventDate} 18:00:00`;
}

/**
 * Price a checkout from the catalogue. `clientAmount` is accepted only so
 * callers can prove it is ignored.
 */
export function priceOrder(nights: NightRequest[], now: Date, clientAmount?: unknown): PriceResult {
  void clientAmount;
  if (!Array.isArray(nights) || nights.length === 0) {
    return { ok: false, error: "Choose at least one night." };
  }
  if (nights.length > MAX_NIGHTS) {
    return { ok: false, error: "Too many nights in one checkout." };
  }
  const seen = new Set<string>();
  const priced: PricedNight[] = [];
  for (const night of nights) {
    const eventId = String(night?.eventId || "");
    const ticketId = String(night?.ticketId || "");
    if (!eventId || seen.has(eventId)) {
      return { ok: false, error: "Each night can be booked once." };
    }
    seen.add(eventId);
    const event = eventById(eventId);
    if (!event) return { ok: false, error: "Unknown night." };
    if (!isNightOpen(event.date, now)) return { ok: false, error: "That night is no longer open for booking." };
    const ticket = ticketFor(event.type, ticketId);
    if (!ticket) return { ok: false, error: "Unknown ticket." };
    const tier = ticket.prices.standard === ticket.prices.student
      ? "standard"
      : night.priceTier === "student"
        ? "student"
        : "standard";
    const amount = ticket.prices[tier];
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: "Ticket has no price." };
    const kind = event.type === "class" ? "Class" : "Social";
    priced.push({
      eventId: event.id,
      eventDate: event.date,
      eventType: event.type,
      eventLocation: event.location,
      eventLabel: event.label,
      eventVenue: event.venue,
      eventStart: event.start,
      eventEnd: event.end,
      sheetTabHint: `${event.date} ${kind} ${event.location}`,
      ticketId: ticket.id,
      ticketName: ticket.sheetName,
      priceTier: tier,
      amount,
    });
  }
  const amountNok = priced.reduce((sum, night) => sum + night.amount, 0);
  return { ok: true, nights: priced, amountNok, amountMinor: amountNok * 100 };
}
