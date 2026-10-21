import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appsScriptBodies } from "../src/apps-script.ts";
import { osloLocalToUtc, utcBasic } from "../src/calendar.ts";
import { handleRequest } from "../src/handler.ts";
import { getOrder, markOrderPaid, putOrder } from "../src/orders.ts";
import { deliverPaidBooking } from "../src/sheet-sync.ts";
import type { StoredOrder } from "../src/types.ts";
import { checkoutBody, jsonResponse, memoryKv, ORDER_ID, recordFetch, testEnv, NOW } from "./helpers.ts";

const ORDER_2 = "22222222-2222-4222-8222-222222222222";
const BEGINNER = "2026-11-02-class-gymsalen";
const SOCIAL = "2026-11-09-social-kronesalen";

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
  assert.match(body, /SUMMARY:Hustle Oslo – Beginner class/);
  assert.match(body, /SUMMARY:Hustle Oslo – Social only/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261102T180000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261102T190000/);
  assert.match(body, /DTSTART;TZID=Europe\/Oslo:20261109T180000/);
  assert.match(body, /DTEND;TZID=Europe\/Oslo:20261109T200000/);
  assert.match(body, /LOCATION:Sentralen\\, Øvre Slottsgate 3\\, 0157 Oslo\\, Gymsalen/);
  assert.match(body, /LOCATION:Sentralen\\, Øvre Slottsgate 3\\, 0157 Oslo\\, Kronesalen/);
  assert.match(body, /non-grippy shoes/);
  assert.match(body, /DM @hustleoslo on Instagram/);
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
  assert.equal(one.includes("Social only"), false);

  const second = unfold(await (await handleRequest(new Request(`https://payments.test/ics?order=${ORDER_ID}&night=1`), env)).text());
  assert.match(second, /Social only/);
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

test("the confirmation post carries hosted calendar links and not the customer", async () => {
  const { kv, env, recorded } = await checkout([{ eventId: BEGINNER, ticketId: "beginners", priceTier: "standard" }]);
  await markPaid(kv);
  const order = (await getOrder(kv, ORDER_ID)) as StoredOrder;
  const posted = appsScriptBodies(order, "shared-secret-value", "https://payments.test");
  assert.equal(posted[0].calendarIcs, `https://payments.test/ics?order=${ORDER_ID}`);
  const nights = posted[0].calendarNights as { googleUrl: string; icsUrl: string; summary: string }[];
  assert.equal(nights.length, 1);
  assert.equal(nights[0].summary, "Hustle Oslo – Beginner class");
  assert.match(nights[0].googleUrl, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  assert.match(nights[0].googleUrl, /dates=20261102T170000Z\/20261102T180000Z/);
  assert.match(nights[0].googleUrl, /action=TEMPLATE/);
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
  assert.match(hosted, /Other calendar \(\.ics\)/);
  assert.match(hosted, /aria-label/);
  assert.equal(hosted.includes("createObjectURL"), false);
  assert.equal(hosted.includes(".download"), false);
  assert.equal(hosted.includes("fetch("), false);
  assert.equal(hosted.includes("await"), false);
  assert.match(hosted, /target="_blank" rel="noopener noreferrer"/);
  assert.match(js, /function calendarPlatform/);
});
