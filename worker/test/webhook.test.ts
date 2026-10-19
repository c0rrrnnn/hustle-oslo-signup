import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { clearVippsTokenCache } from "../src/vipps.ts";
import { canMarkPaid, getOrder, markOrderPaid, newOrder } from "../src/orders.ts";
import { retryUnpostedBookings, sheetBackoffMs } from "../src/sheet-sync.ts";
import { verifyStripeSignature, decideStripe } from "../src/stripe.ts";
import { interpretVipps } from "../src/vipps.ts";
import { backgroundDeps, bundlePrice, checkoutBody, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

function sign(payload: string, secret: string, timestamp: string): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

const SECRET = "whsec_test_secret";

test("stripe signatures accept the matching v1 and reject tampering, the wrong secret, and a stale timestamp", async () => {
  const payload = "{\"id\":\"evt_test\"}";
  const header = sign(payload, SECRET, "1700000000");
  assert.equal(await verifyStripeSignature(payload, header, SECRET, 300, 1700000100), true);
  assert.equal(await verifyStripeSignature(payload + " ", header, SECRET, 300, 1700000100), false);
  assert.equal(await verifyStripeSignature(payload, header, "whsec_other", 300, 1700000100), false);
  assert.equal(await verifyStripeSignature(payload, header, SECRET, 300, 1700000000 + 301), false);
  const rotated = `${header},v1=deadbeef`;
  assert.equal(await verifyStripeSignature(payload, rotated, SECRET, 300, 1700000100), true);
  assert.equal(await verifyStripeSignature(payload, null, SECRET, 300, 1700000100), false);
});

test("a booking is paid only when the webhook is verified and the server check agrees", async () => {
  assert.equal(canMarkPaid({ webhookVerified: false, serverConfirmed: true }), false);
  assert.equal(canMarkPaid({ webhookVerified: true, serverConfirmed: false }), false);
  assert.equal(canMarkPaid({ webhookVerified: true, serverConfirmed: true }), true);

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
  const kv = memoryKv();
  const blocked = await markOrderPaid(
    kv,
    order,
    "pi_test_1",
    "succeeded",
    { webhookVerified: true, serverConfirmed: false },
    NOW.toISOString(),
  );
  assert.equal(blocked.status, "pending");
  assert.equal((await kv.list({ prefix: "unposted:" })).keys.length, 0);

  const paid = await markOrderPaid(
    kv,
    order,
    "pi_test_1",
    "succeeded",
    { webhookVerified: true, serverConfirmed: true },
    NOW.toISOString(),
  );
  assert.equal(paid.status, "paid");
  assert.equal(paid.appsScriptPosted, false);
  assert.equal((await kv.list({ prefix: "unposted:" })).keys[0]?.name, `unposted:${ORDER_ID}`);

  assert.deepEqual(
    decideStripe(
      { id: "pi_test_1", amount: 1, currency: "nok", status: "succeeded", metadata: { orderId: ORDER_ID } },
      order,
    ),
    { action: "failed", reason: "amount-mismatch" },
  );
  assert.equal(
    interpretVipps(
      {
        state: "AUTHORIZED",
        amount: { currency: "NOK", value: 1 },
        aggregate: { capturedAmount: { currency: "NOK", value: 0 } },
      },
      22000,
    ).kind,
    "mismatch",
  );
});

async function seedCardOrder() {
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
        metadata: { orderId: ORDER_ID },
      });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const response = await handleRequest(
    new Request("https://payments.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hustleoslo.com" },
      body: JSON.stringify(checkoutBody()),
    }),
    env,
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 200);
  return { kv, env };
}

function stripeEvent(amount = 1) {
  return JSON.stringify({
    id: "evt_1",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_test_1",
        object: "payment_intent",
        amount,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      },
    },
  });
}

test("stripe webhook does not mark paid on a bad signature or a mismatched server amount", async () => {
  const { kv, env } = await seedCardOrder();
  const payload = stripeEvent(1);
  const recorded = recordFetch(() => {
    throw new Error("provider should not be called");
  });
  const rejected = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, "whsec_wrong", "1760000000") },
      body: payload,
    }),
    env,
    { fetch: recorded.fetcher, now: () => new Date("2026-10-15T10:05:00.000Z") },
  );
  assert.equal(rejected.status, 400);
  assert.equal(recorded.calls.length, 0);
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "pending");

  const now = new Date("2026-10-15T10:05:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  let scriptPosts = 0;
  const server = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return jsonResponse({
        id: "pi_test_1",
        amount: 100,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptPosts += 1;
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const mismatch = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
      body: payload,
    }),
    env,
    { fetch: server.fetcher, now: () => now },
  );
  const body = await mismatch.json();
  assert.equal(mismatch.status, 200);
  assert.equal(body.reason, "amount-mismatch");
  assert.equal(scriptPosts, 0);
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "failed");
});

test("stripe webhook marks paid only after retrieve confirms the catalogue amount", async () => {
  const { kv, env } = await seedCardOrder();
  const payload = stripeEvent(1);
  const now = new Date("2026-10-15T10:05:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const scriptBodies: Record<string, unknown>[] = [];
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return jsonResponse({
        id: "pi_test_1",
        amount: 22000,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptBodies.push(JSON.parse(call.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => now });
  const first = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
      body: payload,
    }),
    env,
    deps,
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "paid");
  await deps.flush();
  assert.equal(scriptBodies.length, 1);
  assert.equal(scriptBodies[0].SHARED_SECRET, "shared-secret-value");
  assert.equal(scriptBodies[0].amount, 220);
  assert.equal(scriptBodies[0].paymentProvider, "stripe");
  assert.equal(scriptBodies[0].paymentId, "pi_test_1");
  assert.equal(scriptBodies[0].paymentStatus, "paid");
  assert.equal(scriptBodies[0].transactionNumber, "pi_test_1");
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.status, "paid");
  assert.equal(order?.appsScriptPosted, true);

  const before = recorded.calls.length;
  const second = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
      body: payload,
    }),
    env,
    deps,
  );
  assert.equal(second.status, 200);
  await deps.flush();
  assert.equal(scriptBodies.length, 1);
  assert.ok(recorded.calls.length > before);
});

async function firePaidStripeWebhook(
  env: ReturnType<typeof testEnv>,
  appsScript: (call: { url: string }) => Response | Promise<Response>,
) {
  const payload = stripeEvent(1);
  const now = new Date("2026-10-15T10:05:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return jsonResponse({
        id: "pi_test_1",
        amount: 22000,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) return appsScript(call);
    return jsonResponse({ ok: false }, 500);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => now });
  const response = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
      body: payload,
    }),
    env,
    deps,
  );
  return { response, calls: recorded.calls, deps, now };
}

async function assertSheetPostRetried(appsScript: (call: { url: string }) => Response | Promise<Response>, error: string) {
  const { kv, env } = await seedCardOrder();
  const { response, deps, now } = await firePaidStripeWebhook(env, appsScript);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "paid");
  await deps.flush();
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, false);
  assert.equal(order?.appsScriptPostedNights, 0);
  assert.equal(order?.status, "paid");
  assert.equal(order?.failureReason, error);
  assert.equal(order?.appsScriptAttempts, 1);
  assert.equal(Date.parse(order?.appsScriptNextAttemptAt || ""), now.getTime() + sheetBackoffMs(1));
  const listed = await kv.list({ prefix: "unposted:" });
  assert.equal(listed.keys.some((key) => key.name === `unposted:${ORDER_ID}`), true);
}

test("stripe webhook acks before a non-JSON Apps Script body and leaves the night unposted", async () => {
  await assertSheetPostRetried(
    () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }),
    "invalid-json",
  );
});

test("stripe webhook acks when Apps Script returns ok false and leaves the night unposted", async () => {
  await assertSheetPostRetried(() => jsonResponse({ ok: false, error: "nope" }), "nope");
});

test("stripe webhook acks when the Apps Script post times out and leaves the night unposted", async () => {
  await assertSheetPostRetried(() => {
    throw new Error("timeout");
  }, "timeout");
});

test("stripe webhook returns before Apps Script answers, then the background post confirms the row", async () => {
  const { kv, env } = await seedCardOrder();
  const payload = stripeEvent(1);
  const now = new Date("2026-10-15T10:05:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let scriptCalls = 0;
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return jsonResponse({
        id: "pi_test_1",
        amount: 22000,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptCalls += 1;
      return gate.then(() => jsonResponse({ ok: true, confirmationSent: true }));
    }
    return jsonResponse({ ok: false }, 500);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => now });
  const response = await Promise.race([
    handleRequest(
      new Request("https://payments.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
        body: payload,
      }),
      env,
      deps,
    ),
    new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(new Error("webhook waited on Apps Script")), 1000);
    }),
  ]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "paid");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pending = await getOrder(kv, ORDER_ID);
  assert.equal(pending?.status, "paid");
  assert.equal(pending?.appsScriptPosted, false);
  assert.equal(scriptCalls, 1);
  releaseGate();
  await deps.flush();
  const posted = await getOrder(kv, ORDER_ID);
  assert.equal(posted?.appsScriptPosted, true);
  assert.equal(posted?.confirmationSent, true);
  assert.equal(posted?.appsScriptPostedNights, 1);
  assert.equal((await kv.list({ prefix: "unposted:" })).keys.length, 0);
  assert.equal(scriptCalls, 1);
});

test("cron retries an unposted paid order after backoff and does not post it twice", async () => {
  const { kv, env } = await seedCardOrder();
  const now = new Date("2026-10-15T10:05:00.000Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  let scriptCalls = 0;
  let fail = true;
  const recorded = recordFetch((call) => {
    if (call.url.includes("/payment_intents/pi_test_1")) {
      return jsonResponse({
        id: "pi_test_1",
        amount: 22000,
        currency: "nok",
        status: "succeeded",
        metadata: { orderId: ORDER_ID },
      });
    }
    if (call.url === env.APPS_SCRIPT_URL) {
      scriptCalls += 1;
      if (fail) return jsonResponse({ ok: false, error: "later" });
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const deps = backgroundDeps({ fetch: recorded.fetcher, now: () => now });
  const payload = stripeEvent(1);
  const response = await handleRequest(
    new Request("https://payments.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": sign(payload, SECRET, timestamp) },
      body: payload,
    }),
    env,
    deps,
  );
  assert.equal(response.status, 200);
  await deps.flush();
  assert.equal(scriptCalls, 1);
  assert.equal((await getOrder(kv, ORDER_ID))?.appsScriptPosted, false);

  const early = await retryUnpostedBookings(env, {
    fetch: recorded.fetcher,
    now: () => new Date(now.getTime() + sheetBackoffMs(1) - 1),
  });
  assert.equal(early.skipped, 1);
  assert.equal(early.posted, 0);
  assert.equal(scriptCalls, 1);

  fail = false;
  const due = await retryUnpostedBookings(env, {
    fetch: recorded.fetcher,
    now: () => new Date(now.getTime() + sheetBackoffMs(1)),
  });
  assert.equal(due.posted, 1);
  assert.equal(scriptCalls, 2);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.appsScriptPosted, true);
  assert.equal(order?.appsScriptPostedNights, 1);
  assert.equal(order?.confirmationSent, true);
  assert.equal((await kv.list({ prefix: "unposted:" })).keys.length, 0);

  const again = await retryUnpostedBookings(env, {
    fetch: recorded.fetcher,
    now: () => new Date(now.getTime() + 6 * 60 * 60 * 1000),
  });
  assert.equal(again.checked, 0);
  assert.equal(scriptCalls, 2);
});

function vippsPayment(state: string, captured: number, amount = 22000) {
  return {
    reference: ORDER_ID,
    pspReference: "psp-1",
    state,
    amount: { currency: "NOK", value: amount },
    aggregate: {
      authorizedAmount: { currency: "NOK", value: state === "AUTHORIZED" || captured > 0 ? amount : 0 },
      capturedAmount: { currency: "NOK", value: captured },
    },
  };
}

function vippsRecorder() {
  let captured = false;
  const scriptBodies: Record<string, unknown>[] = [];
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) {
      assert.equal(call.headers.client_id, "vipps-client");
      assert.equal(call.headers["ocp-apim-subscription-key"], "vipps-subscription");
      return jsonResponse({ access_token: "vipps-token", expires_in: "3600" });
    }
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      const body = JSON.parse(call.body) as { amount: { value: number }; reference: string; returnUrl: string };
      assert.equal(body.amount.value, 22000);
      assert.equal(body.reference, ORDER_ID);
      assert.equal(body.returnUrl, `https://hustleoslo.com/?order=${ORDER_ID}`);
      assert.ok(call.url.startsWith("https://apitest.vipps.no/"));
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    if (call.method === "POST" && call.url.endsWith("/capture")) {
      const body = JSON.parse(call.body) as { modificationAmount: { value: number; currency: string } };
      assert.equal(body.modificationAmount.value, 22000);
      assert.equal(body.modificationAmount.currency, "NOK");
      assert.equal(call.headers.authorization, "Bearer vipps-token");
      captured = true;
      return jsonResponse({ pspReference: "psp-capture" });
    }
    if (call.method === "GET" && call.url.includes("/epayment/v1/payments/")) {
      return jsonResponse(vippsPayment("AUTHORIZED", captured ? 22000 : 0));
    }
    if (call.url === "https://apps-script.test/exec") {
      scriptBodies.push(JSON.parse(call.body) as Record<string, unknown>);
      return jsonResponse({ ok: true, confirmationSent: true });
    }
    return jsonResponse({ ok: false }, 500);
  });
  return { recorded, scriptBodies, isCaptured: () => captured };
}

async function seedVipps(envOverrides: Partial<import("../src/types.ts").Env> = {}) {
  clearVippsTokenCache();
  const kv = memoryKv();
  const env = testEnv(kv, envOverrides);
  const seeded = vippsRecorder();
  const response = await handleRequest(
    new Request("https://payments.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test" },
      body: JSON.stringify(checkoutBody({ method: "vipps", returnUrl: "https://evil.test/phish" })),
    }),
    env,
    { fetch: seeded.recorded.fetcher, now: () => NOW },
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.redirectUrl, "https://apitest.vipps.no/pay/abc");
  return { kv, env, seeded };
}

test("vipps webhook ignores the posted amount and captures from the server payment", async () => {
  const { kv, env, seeded } = await seedVipps();
  const webhook = {
    msn: "123456",
    reference: ORDER_ID,
    name: "CAPTURED",
    amount: { currency: "NOK", value: 1 },
    success: true,
  };
  const deps = backgroundDeps({ fetch: seeded.recorded.fetcher, now: () => NOW });
  const response = await handleRequest(
    new Request("https://payments.test/webhooks/vipps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhook),
    }),
    env,
    deps,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "paid");
  assert.equal(seeded.isCaptured(), true);
  await deps.flush();
  assert.equal(seeded.scriptBodies.length, 1);
  assert.equal(seeded.scriptBodies[0].paymentProvider, "vipps");
  assert.equal(seeded.scriptBodies[0].amount, 220);
  assert.equal(seeded.scriptBodies[0].SHARED_SECRET, "shared-secret-value");
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "paid");

  const posts = seeded.scriptBodies.length;
  const again = await handleRequest(
    new Request("https://payments.test/webhooks/vipps", {
      method: "POST",
      body: JSON.stringify(webhook),
    }),
    env,
    deps,
  );
  assert.equal(again.status, 200);
  await deps.flush();
  assert.equal(seeded.scriptBodies.length, posts);
});

test("vipps reserve mode does not capture or record until the admin capture call", async () => {
  const { kv, env, seeded } = await seedVipps({ CAPTURE_MODE: "reserve" });
  const deps = backgroundDeps({ fetch: seeded.recorded.fetcher, now: () => NOW });
  const webhook = { msn: "123456", reference: ORDER_ID, name: "AUTHORIZED", amount: { currency: "NOK", value: 1 } };
  const reserved = await handleRequest(
    new Request("https://payments.test/webhooks/vipps", { method: "POST", body: JSON.stringify(webhook) }),
    env,
    deps,
  );
  assert.equal((await reserved.json()).status, "reserved");
  assert.equal(seeded.isCaptured(), false);
  await deps.flush();
  assert.equal(seeded.scriptBodies.length, 0);
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "reserved");

  const denied = await handleRequest(
    new Request(`https://payments.test/order/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    }),
    env,
    deps,
  );
  assert.equal(denied.status, 401);
  assert.equal(seeded.isCaptured(), false);

  const captured = await handleRequest(
    new Request(`https://payments.test/order/${ORDER_ID}/capture`, {
      method: "POST",
      headers: { authorization: "Bearer admin-secret-value" },
    }),
    env,
    deps,
  );
  const body = await captured.json();
  assert.equal(captured.status, 200, JSON.stringify(body));
  assert.equal(body.status, "paid");
  assert.equal(seeded.isCaptured(), true);
  await deps.flush();
  assert.equal(seeded.scriptBodies.length, 1);
  assert.equal(seeded.scriptBodies[0].paymentStatus, "paid");
});

test("a vipps webhook that is not authorized yet does not capture", async () => {
  const { kv, env } = await seedVipps();
  clearVippsTokenCache();
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "60" });
    if (call.method === "GET") return jsonResponse(vippsPayment("CREATED", 0));
    if (call.url.endsWith("/capture")) throw new Error("should not capture");
    if (call.url.includes("apps-script")) throw new Error("should not record");
    return jsonResponse({ ok: false }, 500);
  });
  const response = await handleRequest(
    new Request("https://payments.test/webhooks/vipps", {
      method: "POST",
      body: JSON.stringify({ msn: "123456", reference: ORDER_ID, name: "CAPTURED", amount: { value: 22000 } }),
    }),
    env,
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal((await response.json()).status, "pending");
  assert.equal((await getOrder(kv, ORDER_ID))?.status, "pending");
});

test("order status omits the Stripe client secret", async () => {
  const { env } = await seedCardOrder();
  const response = await handleRequest(new Request(`https://payments.test/order/${ORDER_ID}`), env, { now: () => NOW });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "pending");
  assert.equal(body.amountNok, 220);
  assert.equal("clientSecret" in body, false);
  assert.equal(body.paymentId, null);
});
