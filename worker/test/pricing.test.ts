import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { EVENTS, TICKETS } from "../src/catalog.ts";
import { isNightOpen, priceOrder } from "../src/pricing.ts";
import { NOW } from "./helpers.ts";

test("catalogue prices and nights match events.js", () => {
  const source = fs.readFileSync(new URL("../../events.js", import.meta.url), "utf8");
  const context: { window: { HUSTLE_EVENTS?: typeof EVENTS; HUSTLE_TICKETS?: Record<string, { id: string; prices: { standard: number; student: number } }[]> } } = {
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const events = context.window.HUSTLE_EVENTS || [];
  const tickets = context.window.HUSTLE_TICKETS || {};
  assert.equal(events.length, EVENTS.length);
  for (const event of events) {
    const ours = EVENTS.find((item) => item.id === event.id);
    assert.ok(ours, event.id);
    assert.equal(ours.date, event.date);
    assert.equal(ours.type, event.type);
    assert.equal(ours.location, event.location);
    assert.equal(ours.venue, event.venue);
    assert.equal(ours.start, event.start);
    assert.equal(ours.end, event.end);
    assert.equal(ours.label, event.label);
  }
  for (const type of ["class", "social"] as const) {
    assert.equal(TICKETS[type].length, tickets[type].length);
    for (const ticket of tickets[type]) {
      const ours = TICKETS[type].find((item) => item.id === ticket.id);
      assert.ok(ours, ticket.id);
      assert.equal(ours.prices.standard, ticket.prices.standard);
      assert.equal(ours.prices.student, ticket.prices.student);
    }
  }
});

test("prices a class bundle and a social night from the catalogue", () => {
  const bundle = priceOrder(
    [{ eventId: "2026-11-02-class-gymsalen", ticketId: "bundle", priceTier: "standard" }],
    NOW,
    1,
  );
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  assert.equal(bundle.amountNok, 220);
  assert.equal(bundle.amountMinor, 22000);
  assert.equal(bundle.nights[0].amount, 220);
  assert.equal(bundle.nights[0].ticketName, "2 class bundle");

  const student = priceOrder(
    [{ eventId: "2026-11-02-class-gymsalen", ticketId: "bundle", priceTier: "student" }],
    NOW,
  );
  assert.equal(student.ok, true);
  if (student.ok) assert.equal(student.amountNok, 150);

  const beginners = priceOrder(
    [{ eventId: "2026-12-07-class-gymsalen", ticketId: "beginners", priceTier: "student" }],
    NOW,
  );
  assert.equal(beginners.ok, true);
  if (beginners.ok) assert.equal(beginners.amountNok, 100);

  const social = priceOrder(
    [{ eventId: "2026-11-09-social-kronesalen", ticketId: "social", priceTier: "student" }],
    NOW,
  );
  assert.equal(social.ok, true);
  if (social.ok) {
    assert.equal(social.amountNok, 50);
    assert.equal(social.nights[0].priceTier, "standard");
  }
});

test("sums nights and ignores a client amount", () => {
  const priced = priceOrder(
    [
      { eventId: "2026-11-02-class-gymsalen", ticketId: "beginners", priceTier: "standard" },
      { eventId: "2026-11-09-social-kronesalen", ticketId: "social", priceTier: "standard" },
    ],
    NOW,
    1,
  );
  assert.equal(priced.ok, true);
  if (!priced.ok) return;
  assert.equal(priced.amountNok, 200);
  assert.equal(priced.nights[0].amount + priced.nights[1].amount, 200);
});

test("rejects unknown nights, wrong tickets, duplicates, and closed nights", () => {
  assert.equal(priceOrder([{ eventId: "nope", ticketId: "social" }], NOW).ok, false);
  assert.equal(
    priceOrder([{ eventId: "2026-11-09-social-kronesalen", ticketId: "beginners" }], NOW).ok,
    false,
  );
  assert.equal(
    priceOrder(
      [
        { eventId: "2026-11-02-class-gymsalen", ticketId: "social" },
        { eventId: "2026-11-02-class-gymsalen", ticketId: "social" },
      ],
      NOW,
    ).ok,
    false,
  );
  assert.equal(priceOrder([{ eventId: "2026-09-28-class-kronesalen", ticketId: "social" }], NOW).ok, false);
  const closes = new Date("2026-10-19T16:00:00.000Z");
  const stillOpen = new Date("2026-10-19T15:59:00.000Z");
  assert.equal(isNightOpen("2026-10-19", closes), false);
  assert.equal(isNightOpen("2026-10-19", stillOpen), true);
  assert.equal(priceOrder([{ eventId: "2026-10-19-social-gymsalen", ticketId: "social" }], closes).ok, false);
  assert.equal(priceOrder([{ eventId: "2026-10-19-social-gymsalen", ticketId: "social" }], stillOpen).ok, true);
});
