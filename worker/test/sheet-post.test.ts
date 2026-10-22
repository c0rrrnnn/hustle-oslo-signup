import assert from "node:assert/strict";
import test from "node:test";
import { getOrder, markOrderPaid, newOrder, orderKey } from "../src/orders.ts";
import { deliverPaidBooking, sheetBackoffMs } from "../src/sheet-sync.ts";
import type { OrderKv } from "../src/types.ts";
import { bundlePrice, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

const ECHO = "https://script.googleusercontent.com/macros/echo?user_content_key=abc";

async function paidEnv(kv: OrderKv = memoryKv()) {
  const priced = bundlePrice();
  const order = newOrder(
    {
      idempotencyKey: ORDER_ID,
      method: "card",
      customer: { fullName: "Claire Wu", email: "claire@example.com", phone: "" },
      nights: priced.nights,
      amountNok: priced.amountNok,
      amountMinor: priced.amountMinor,
      meta: {
        experience: "",
        experienceLabel: "",
        referral: "",
        referralLabel: "",
        referralOther: "",
        howFound: "",
        howFoundLabel: "",
        howFoundOther: "",
        isRepeat: true,
        termsAcceptedAt: NOW.toISOString(),
        termsVersion: "v1.0",
      },
      returnUrl: "https://hustleoslo.com/?order=" + ORDER_ID,
    },
    "immediate",
    NOW.toISOString(),
  );
  order.paymentId = "pi_test_1";
  const env = testEnv(kv);
  await markOrderPaid(
    kv,
    order,
    "pi_test_1",
    "succeeded",
    { webhookVerified: true, serverConfirmed: true },
    NOW.toISOString(),
  );
  return { kv, env };
}

test("Apps Script 302 is followed with GET and the success JSON marks the order posted", async () => {
  const { kv, env } = await paidEnv();
  const recorded = recordFetch((call) => {
    assert.equal(call.redirect, "manual");
    if (call.url === env.APPS_SCRIPT_URL) {
      assert.equal(call.method, "POST");
      assert.equal(call.headers["content-type"], "text/plain;charset=utf-8");
      assert.ok(call.body.length > 0);
      return new Response(null, { status: 302, headers: { Location: ECHO } });
    }
    assert.equal(call.url, ECHO);
    assert.equal(call.method, "GET");
    assert.equal(call.body, "");
    assert.equal(call.headers["content-type"], undefined);
    return jsonResponse({ ok: true, confirmationSent: true });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  assert.equal(recorded.calls.length, 2);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, true);
  assert.equal(order?.confirmationSent, true);
  assert.equal(order?.appsScriptLeaseToken, null);
  assert.equal(order?.appsScriptAttempts, 0);
  assert.equal((await kv.list({ prefix: "unposted:" })).keys.length, 0);
});

test("Apps Script 302 followed by error JSON does not mark the order posted", async () => {
  const { kv, env } = await paidEnv();
  const recorded = recordFetch((call) => {
    if (call.url === env.APPS_SCRIPT_URL) {
      assert.equal(call.method, "POST");
      return new Response(null, { status: 302, headers: { Location: ECHO } });
    }
    assert.equal(call.method, "GET");
    assert.equal(call.body, "");
    return jsonResponse({ ok: false, error: "sheet-rejected" });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "failed");
  assert.equal(recorded.calls.length, 2);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, false);
  assert.equal(order?.failureReason, "sheet-rejected");
  assert.equal(order?.appsScriptLeaseToken, null);
});

test("Apps Script 307 is posted again with the same body", async () => {
  const { kv, env } = await paidEnv();
  const recorded = recordFetch((call) => {
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "manual");
    assert.equal(call.headers["content-type"], "text/plain;charset=utf-8");
    if (call.url === env.APPS_SCRIPT_URL) {
      return new Response(null, { status: 307, headers: { Location: ECHO } });
    }
    assert.equal(call.url, ECHO);
    return jsonResponse({ ok: true, confirmationSent: true });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  assert.equal(recorded.calls.length, 2);
  assert.equal(recorded.calls[1].body, recorded.calls[0].body);
  assert.ok(recorded.calls[1].body.length > 0);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, true);
  assert.equal(order?.confirmationSent, true);
});

test("a transient 404 and 500 are retried in the same request", async () => {
  const { kv, env } = await paidEnv();
  const statuses = [404, 500, 200];
  let seen = 0;
  const recorded = recordFetch(() => {
    const status = statuses[seen++] ?? 200;
    if (status === 200) return jsonResponse({ ok: true, confirmationSent: true });
    return new Response(null, { status });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  assert.equal(seen, 3);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, true);
  assert.equal(order?.appsScriptAttempts, 0);
  assert.equal(order?.failureReason, null);
});

test("repeated 404s fail once after the quick retries and leave no lease", async () => {
  const { kv, env } = await paidEnv();
  let seen = 0;
  const recorded = recordFetch(() => {
    seen += 1;
    return new Response(null, { status: 404 });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "failed");
  assert.equal(seen, 4);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, false);
  assert.equal(order?.appsScriptAttempts, 1);
  assert.equal(order?.failureReason, "HTTP 404");
  assert.equal(order?.appsScriptLeaseToken, null);
  assert.equal(order?.appsScriptLeaseUntil, null);
  assert.equal(Date.parse(order?.appsScriptNextAttemptAt || ""), NOW.getTime() + sheetBackoffMs(1));
});

test("an ok false body is not retried", async () => {
  const { kv, env } = await paidEnv();
  let seen = 0;
  const recorded = recordFetch(() => {
    seen += 1;
    return jsonResponse({ ok: false, error: "nope" });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "failed");
  assert.equal(seen, 1);
  assert.equal((await getOrder(kv, ORDER_ID))?.failureReason, "nope");
});

test("a redirect away from Apps Script is not followed", async () => {
  const { kv, env } = await paidEnv();
  let seen = 0;
  const recorded = recordFetch((call) => {
    seen += 1;
    assert.equal(call.url, env.APPS_SCRIPT_URL);
    return new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "failed");
  assert.equal(seen, 1);
  assert.equal((await getOrder(kv, ORDER_ID))?.failureReason, "HTTP 302");
  assert.equal((await getOrder(kv, ORDER_ID))?.appsScriptPosted, false);
});

test("a hung Apps Script post records timeout instead of staying in progress", async () => {
  const { kv, env } = await paidEnv();
  let seen = 0;
  const fetcher: typeof fetch = (_input, init) => {
    seen += 1;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (!signal) return;
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  };
  const result = await deliverPaidBooking(env, { fetch: fetcher, now: () => NOW }, ORDER_ID, { timeoutMs: 40 });
  assert.equal(result, "failed");
  assert.equal(seen, 2);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, false);
  assert.equal(order?.failureReason, "timeout");
  assert.equal(order?.appsScriptAttempts, 1);
  assert.equal(order?.appsScriptLeaseToken, null);
  assert.equal(order?.appsScriptLeaseUntil, null);
});

test("a 2xx is saved when the order read after the post is stale", async () => {
  const inner = memoryKv();
  const { env } = await paidEnv(inner);
  const before = await inner.get(orderKey(ORDER_ID));
  assert.ok(before);
  let arm = false;
  const kv: OrderKv = {
    get: (key) => (arm && key === orderKey(ORDER_ID) ? Promise.resolve(before) : inner.get(key)),
    put: (key, value, options) => inner.put(key, value, options),
    delete: (key) => inner.delete(key),
    list: (options) => inner.list(options),
  };
  env.ORDERS = kv;
  const recorded = recordFetch(() => {
    arm = true;
    return jsonResponse({ ok: true, confirmationSent: true });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  const stored = JSON.parse((await inner.get(orderKey(ORDER_ID))) || "{}") as { appsScriptPosted?: boolean; appsScriptLeaseToken?: string | null };
  assert.equal(stored.appsScriptPosted, true);
  assert.equal(stored.appsScriptLeaseToken, null);
  assert.equal((await inner.list({ prefix: "unposted:" })).keys.length, 0);
});

test("the night is saved before the confirmation follow-up, and that 2xx marks it posted", async () => {
  const { kv, env } = await paidEnv();
  let nightsBeforeConfirmation = -1;
  let postedBeforeConfirmation = true;
  const recorded = recordFetch(async (call) => {
    const body = JSON.parse(call.body) as { confirmationOnly?: boolean };
    if (body.confirmationOnly === true) {
      const current = await getOrder(kv, ORDER_ID);
      nightsBeforeConfirmation = current?.appsScriptPostedNights ?? -1;
      postedBeforeConfirmation = current?.appsScriptPosted === true;
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    return jsonResponse({ ok: true, duplicate: true, confirmationSent: false });
  });
  const result = await deliverPaidBooking(env, { fetch: recorded.fetcher, now: () => NOW }, ORDER_ID);
  assert.equal(result, "posted");
  assert.equal(nightsBeforeConfirmation, 1);
  assert.equal(postedBeforeConfirmation, false);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, true);
  assert.equal(order?.confirmationSent, true);
  assert.equal(order?.appsScriptLeaseToken, null);
});
