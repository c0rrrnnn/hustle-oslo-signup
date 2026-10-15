/**
 * Server-side copy of events.js and the checkout labels in app.js.
 * worker/test/pricing.test.ts fails if prices or event ids drift.
 * Amounts are whole kroner. The client never supplies the price.
 */
export interface CatalogEvent {
  id: string;
  date: string;
  weekday: string;
  type: "class" | "social";
  location: string;
  venue: string;
  start: string;
  end: string;
  label: string;
}

export interface CatalogTicket {
  id: string;
  /** Name written to the signup sheet. Matches app.js TICKET_LABELS. */
  sheetName: string;
  prices: { standard: number; student: number };
}

export const EVENTS: CatalogEvent[] = [
  {
    id: "2026-09-28-class-kronesalen",
    date: "2026-09-28",
    weekday: "Mon",
    type: "class",
    location: "Kronesalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "21:00",
    label: "Class night",
  },
  {
    id: "2026-10-12-class-kronesalen",
    date: "2026-10-12",
    weekday: "Mon",
    type: "class",
    location: "Kronesalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "21:00",
    label: "Class night",
  },
  {
    id: "2026-10-19-social-gymsalen",
    date: "2026-10-19",
    weekday: "Mon",
    type: "social",
    location: "Gymsalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "20:00",
    label: "Social night",
  },
  {
    id: "2026-11-02-class-gymsalen",
    date: "2026-11-02",
    weekday: "Mon",
    type: "class",
    location: "Gymsalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "21:00",
    label: "Class night",
  },
  {
    id: "2026-11-09-social-kronesalen",
    date: "2026-11-09",
    weekday: "Mon",
    type: "social",
    location: "Kronesalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "20:00",
    label: "Social night",
  },
  {
    id: "2026-12-07-class-gymsalen",
    date: "2026-12-07",
    weekday: "Mon",
    type: "class",
    location: "Gymsalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "21:00",
    label: "Class night",
  },
  {
    id: "2026-12-14-social-gymsalen",
    date: "2026-12-14",
    weekday: "Mon",
    type: "social",
    location: "Gymsalen",
    venue: "Sentralen, Oslo",
    start: "18:00",
    end: "20:00",
    label: "Social night",
  },
];

export const TICKETS: Record<"class" | "social", CatalogTicket[]> = {
  class: [
    { id: "beginners", sheetName: "Beginner class", prices: { standard: 150, student: 100 } },
    { id: "intermediate", sheetName: "Intermediate class", prices: { standard: 150, student: 100 } },
    { id: "bundle", sheetName: "2 class bundle", prices: { standard: 220, student: 150 } },
    { id: "social", sheetName: "Social only", prices: { standard: 50, student: 50 } },
  ],
  social: [{ id: "social", sheetName: "Social only", prices: { standard: 50, student: 50 } }],
};

export function eventById(id: string): CatalogEvent | undefined {
  return EVENTS.find((event) => event.id === id);
}

export function ticketFor(type: "class" | "social", ticketId: string): CatalogTicket | undefined {
  return TICKETS[type].find((ticket) => ticket.id === ticketId);
}
