/**
 * Hustle Oslo — upcoming events
 * Edit this file to add/remove/change class and social nights.
 * Dates are ISO (YYYY-MM-DD). All events are 18:00–21:00 Europe/Oslo at Sentralen, Oslo.
 * Weekdays verified as Mondays in 2026.
 */
window.HUSTLE_EVENTS = [
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
    end: "21:00",
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
    end: "21:00",
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
    end: "21:00",
    label: "Social night",
  },
];

/**
 * Ticket catalogue.
 * Class nights: beginners / intermediate / 2 class bundle / social-only.
 * Social-only nights: social entry only.
 * No capacity caps. Student = honour system.
 */
window.HUSTLE_TICKETS = {
  class: [
    {
      id: "beginners",
      name: "Beginners class",
      note: "Includes social dancing after class",
      prices: { standard: 150, student: 100 },
    },
    {
      id: "intermediate",
      name: "Intermediate class",
      note: "Includes social dancing after class",
      prices: { standard: 150, student: 100 },
    },
    {
      id: "bundle",
      name: "2 class bundle",
      note: "Beginners + intermediate same evening only. Social included.",
      prices: { standard: 220, student: 150 },
    },
    {
      id: "social",
      name: "Social only",
      note: "Social dancing that night",
      prices: { standard: 50, student: 50 },
    },
  ],
  social: [
    {
      id: "social",
      name: "Social entry",
      note: "Social dancing that night",
      prices: { standard: 50, student: 50 },
    },
  ],
};
