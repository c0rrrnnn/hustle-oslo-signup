import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appsScriptBodies } from "../src/apps-script.ts";
import { buildCalendar, calendarSummary, googleCalendarUrl, osloLocalToUtc, utcBasic } from "../src/calendar.ts";
import type { PricedNight } from "../src/types.ts";
import { handleRequest } from "../src/handler.ts";
import { getOrder, markOrderPaid, putOrder } from "../src/orders.ts";
import { deliverPaidBooking } from "../src/sheet-sync.ts";
import type { StoredOrder } from "../src/types.ts";
import { checkoutBody, jsonResponse, memoryKv, ORDER_ID, recordFetch, testEnv, NOW } from "./helpers.ts";

const ORDER_2 = "22222222-2222-4222-8222-222222222222";
const BEGINNER = "2026-11-02-class-gymsalen";
const SOCIAL = "2026-11-09-class-kronesalen";

function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, "");
}

async function checkout(nights: { eventId: string; ticketId: string; priceTier: string }[], orderId = ORDER_ID) {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId },
      });
    }
    return jsonResponse({ ok: true, confirmationSent: true });
  });
  const response = await handleRequest(
    new Request("https://payments.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hustleoslo.com" },
      body: JSON.stringify(checkoutBody({ idempotencyKey: orderId, nights, customer: { fullName: "Claire Wu", email: "claire@example.com", phone: "46862806" } })),
    }),
    env,
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 200);
  return { kv, env, recorded };
}

async function markPaid(kv: ReturnType<typeof memoryKv>, orderId = ORDER_ID) {
  const order = await getOrder(kv, orderId);
  assert.ok(order);
  await markOrderPaid(kv, order, "pi_test_1", "succeeded", { webhookVerified: true, serverConfirmed: true }, NOW.toISOString());
}

test("Oslo wall time becomes UTC in winter and summer", () => {
  assert.equal(utcBasic(osloLocalToUtc("2026-11-02", "18:00")), "20261102T170000Z");
  assert.equal(utcBasic(osloLocalToUtc("2026-07-06", "18:00")), "20260706T160000Z");
});

test("GET /ics serves a paid booking and hides every other status", async () => {
  const { kv, env } = await checkout([
    { eventId: BEGINNER, ticketId: "beginners", priceTier: "standard" },
    { eventId: SOCIAL, ticketId: "social", priceTier: "standard" },
  ]);
  const stored = await getOrder(kv, ORDER_ID);
  assert.equal(stored?.workerOrigin, "https://payments.test");

  const pending = await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}`), env, { now: () => NOW });
  assert.equal(pending.status, 404);
  assert.equal(await pending.text(), "");

  await markPaid(kv);
  const response = await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}`), env, { now: () => NOW });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "inline; filename=hustle-oslo.ics");
  assert.equal(response.headers.get("cache-control"), "private, max-age=300");
  const body = unfold(await response.text());
  assert.equal(body.split("BEGIN:VEVENT").length - 1, 2);
  assert.match(body, /BEGIN:VTIMEZONE/);
  assert.match(body, /TZID:Europe\/Oslo/);
  assert.match(body, /SUMMARY:Hustle Oslo: Beginner class/);
  assert.match(body, /SUMMARY:Hustle Oslo: Social Only\r\n/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261102T180000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261102T190000/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261109T200000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261109T210000/);
  assert.match(body, /LOCATION:Sentralen\\, Øvre Slottsgate 3\\, 0157 Oslo/);
  assert.equal(/LOCATION:[^\r\n]*(Gymsalen|Kronesalen)/.test(body), false);
  assert.match(body, /DESCRIPTION:Room: Gymsalen/);
  assert.match(body, /DESCRIPTION:Room: Kronesalen/);
  assert.equal(body.includes("non-grippy shoes"), false);
  assert.equal(body.includes("DM @hustleoslo on Instagram"), false);
  assert.equal(body.match(/TRIGGER:-P1D/g)?.length, 2);
  assert.equal(body.match(/TRIGGER:-PT2H/g)?.length, 2);
  assert.equal(body.match(/ACTION:DISPLAY/g)?.length, 4);
  assert.equal(/\r\nURL:/.test(body), false);
  assert.match(body, new RegExp(`UID:${ORDER_ID}-${BEGINNER}@hustleoslo.com`));
  assert.equal(body.includes("Claire"), false);
  assert.equal(body.includes("claire@example.com"), false);
  assert.equal(body.includes("46862806"), false);
  assert.equal(body.includes("ATTENDEE"), false);
  assert.equal(body.includes("mailto:"), false);

  const again = unfold(await (await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}`), env, { now: () => NOW })).text());
  assert.match(again, new RegExp(`UID:${ORDER_ID}-${BEGINNER}@hustleoslo.com`));

  const one = unfold(await (await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}&eventId=${BEGINNER}`), env)).text());
  assert.equal(one.split("BEGIN:VEVENT").length - 1, 1);
  assert.match(one, /Beginner class/);
  assert.equal(one.includes("Hustle Oslo: Social"), false);

  const second = unfold(await (await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}&night=1`), env)).text());
  assert.match(second, /SUMMARY:Hustle Oslo: Social Only\r\n/);
  assert.equal(second.includes("Beginner class"), false);

  assert.equal((await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}&night=9`), env)).status, 404);
  assert.equal((await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}&eventId=missing`), env)).status, 404);
  assert.equal((await handleRequest(new Request("https://payments.test/ics"), env)).status, 404);
  assert.equal((await handleRequest(new Request("https://payments.test/ics?order=not-a-uuid"), env)).status, 404);

  const failed = await getOrder(kv, ORDER_ID);
  assert.ok(failed);
  failed.status = "failed";
  await putOrder(kv, failed);
  assert.equal((await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}`), env)).status, 404);

  const reserved = await checkout([{ eventId: BEGINNER, ticketId: "beginners", priceTier: "standard" }], ORDER_2);
  const reservedOrder = await getOrder(reserved.kv, ORDER_2);
  assert.ok(reservedOrder);
  reservedOrder.status = "reserved";
  await putOrder(reserved.kv, reservedOrder);
  const reservedFile = await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_2}`), reserved.env);
  assert.equal(reservedFile.status, 200);
  assert.match(unfold(await reservedFile.text()), /Beginner class/);
});

test("a social-only night stays Social from 18:00 to 20:00", async () => {
  const socialOnly = "33333333-3333-4333-8333-333333333333";
  const { kv, env } = await checkout(
    [{ eventId: "2026-12-14-social-gymsalen", ticketId: "social", priceTier: "standard" }],
    socialOnly,
  );
  await markPaid(kv, socialOnly);
  const response = await handleRequest(new Request(`https://payments.test/ics?order=${socialOnly}`), env, { now: () => NOW });
  assert.equal(response.status, 200);
  const body = unfold(await response.text());
  assert.match(body, /SUMMARY:Hustle Oslo: Social\r\n/);
  assert.equal(body.includes("Social Only"), false);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261214T180000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261214T200000/);
  assert.match(body, /DESCRIPTION:Room: Gymsalen/);
});

test("the confirmation post carries hosted calendar links and not the customer", async () => {
  const { kv, env, recorded } = await checkout([{ eventId: BEGINNER, ticketId: "beginners", priceTier: "standard" }]);
  await markPaid(kv);
  const order = (await getOrder(kv, ORDER_ID)) as StoredOrder;
  const posted = appsScriptBodies(order, "shared-secret-value", "https://payments.test");
  assert.equal(posted[0].calendarIcs, `https://payments.test/ics?order=${ORDER_ID}`);
  const nights = posted[0].calendarNights as { googleUrl: string; icsUrl: string; summary: string }[];
  assert.equal(nights.length, 1);
  assert.equal(nights[0].summary, "Hustle Oslo: Beginner class");
  assert.match(nights[0].googleUrl, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  assert.match(nights[0].googleUrl, /dates=20261102T170000Z\/20261102T180000Z/);
  assert.match(nights[0].googleUrl, /action=TEMPLATE/);
  assert.match(nights[0].googleUrl, /text=Hustle\+Oslo%3A\+Beginner\+class/);
  const google = new URL(nights[0].googleUrl);
  assert.equal(google.searchParams.get("location"), "Sentralen, Øvre Slottsgate 3, 0157 Oslo");
  assert.equal(google.searchParams.get("details"), "Room: Gymsalen");
  assert.equal(JSON.stringify(nights).includes("claire@example.com"), false);
  assert.equal(JSON.stringify(nights).includes("Claire"), false);
  assert.equal(JSON.stringify(nights).includes("46862806"), false);

  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  const scriptCall = recorded.calls.find((call) => call.url === "https://apps-script.test/exec");
  assert.ok(scriptCall);
  const body = JSON.parse(scriptCall.body) as { calendarIcs?: string; calendarNights?: { googleUrl: string }[] };
  assert.equal(body.calendarIcs, `https://payments.test/ics?order=${ORDER_ID}`);
  assert.match(body.calendarNights?.[0].googleUrl || "", /calendar\.google\.com/);
});

test("the confirmation screen uses hosted links and does not download a blob", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="bk-cal-actions"/);
  const hosted = js.slice(js.indexOf("function googleCalendarHref"), js.indexOf("function fallbackCalendarHtml"));
  assert.match(hosted, /calendar\.google\.com\/calendar\/render\?/);
  assert.match(hosted, /Apple \/ Outlook \(\.ics\)/);
  assert.match(hosted, /Google Calendar/);
  assert.match(hosted, /aria-controls="cf-gcal-list"/);
  assert.match(hosted, /aria-haspopup="dialog"/);
  assert.equal(hosted.includes("Other calendar (.ics)"), false);
  assert.equal(hosted.includes("bk-cal-list"), false);
  assert.equal(hosted.includes("bk-cal-other"), false);
  assert.match(hosted, /aria-label/);
  assert.equal(hosted.includes("createObjectURL"), false);
  assert.equal(hosted.includes(".download"), false);
  assert.equal(hosted.includes("fetch("), false);
  assert.equal(hosted.includes("await"), false);
  assert.match(hosted, /target="_blank" rel="noopener noreferrer"/);
  assert.match(js, /function calendarPlatform/);
  assert.match(js, /CLASS_LINE_LABELS/);
  assert.match(js, /TRIGGER:-P1D/);
  assert.match(js, /TRIGGER:-PT2H/);
  assert.equal(js.includes("CALENDAR_DETAILS"), false);
  assert.match(html, /class="cf-badge"/);
  assert.match(html, /id="bk-done-mark"[^>]*aria-label="Registration confirmed"/);
  assert.match(html, /id="bk-done-heading"[^>]*>You’re registered!</);
  assert.match(js, /done: "You’re registered\."/);
  assert.match(js, /step\.textContent = "You’re registered\."/);
  assert.match(js, /saved \? "You’re registered!"/);
  assert.match(js, /sub\.textContent = "Confirmation email has been sent to " \+ email/);
  assert.match(js, /sub\.hidden = true/);
  assert.equal(js.includes("See you on the dance floor"), false);
  assert.equal(js.includes('sub.innerHTML = "See you'), false);
  assert.match(readFileSync(new URL("../../styles.css", import.meta.url), "utf8"), /\.cf-hero \.bk-sub\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.equal(html.includes("You’re booked!"), false);
  assert.equal(js.includes("You’re booked"), false);
  assert.match(html, /id="bk-done-table"/);
  assert.equal(html.includes('data-action="done"'), false);
  assert.match(html, /id="bk-close"[^>]*aria-label="Close"/);
  assert.match(html, /Questions\? DM/);
});

function sampleNight(overrides: Partial<PricedNight>): PricedNight {
  return {
    eventId: "2026-11-02-class-gymsalen",
    eventDate: "2026-11-02",
    eventType: "class",
    eventLocation: "Gymsalen",
    eventLabel: "Class night",
    eventVenue: "Sentralen, Oslo",
    eventStart: "18:00",
    eventEnd: "21:00",
    sheetTabHint: "Class",
    ticketId: "beginners",
    ticketName: "Beginner class",
    priceTier: "standard",
    amount: 150,
    ...overrides,
  };
}

test("bundle and social-on-a-class-night use the calendar titles, literal ampersand, and 20:00 social", () => {
  const bundle = sampleNight({ ticketId: "bundle", ticketName: "2 class bundle", amount: 220 });
  const social = sampleNight({ ticketId: "social", ticketName: "Social only", amount: 50, eventId: "2026-11-02-class-gymsalen-social" });
  assert.equal(calendarSummary(bundle), "Hustle Oslo: Beginner & Intermediate Class");
  assert.equal(calendarSummary(social), "Hustle Oslo: Social Only");
  const body = unfold(buildCalendar("order-1", [bundle, social], NOW));
  assert.match(body, /SUMMARY:Hustle Oslo: Beginner & Intermediate Class/);
  assert.match(body, /SUMMARY:Hustle Oslo: Social Only/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261102T180000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261102T200000/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261102T200000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261102T210000/);
  assert.equal(body.match(/TRIGGER:-P1D/g)?.length, 2);
  assert.equal(body.match(/TRIGGER:-PT2H/g)?.length, 2);
  const google = googleCalendarUrl(bundle);
  assert.match(google, /text=Hustle\+Oslo%3A\+Beginner\+%26\+Intermediate\+Class/);
  const params = new URL(google).searchParams;
  assert.equal(params.get("text"), "Hustle Oslo: Beginner & Intermediate Class");
  assert.equal(params.get("location"), "Sentralen, Øvre Slottsgate 3, 0157 Oslo");
  assert.equal(params.get("details"), "Room: Gymsalen");
  assert.match(google, /dates=20261102T170000Z\/20261102T190000Z/);
});
