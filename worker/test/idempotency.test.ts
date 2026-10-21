import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { clearVippsTokenCache } from "../src/vipps.ts";
import { getOrder, putOrder } from "../src/orders.ts";
import { checkoutBody, jsonResponse, memoryKv, NOW, ORDER_ID, recordFetch, testEnv } from "./helpers.ts";

function stripeFetch() {
  return recordFetch((call) => {
    if (call.url.includes("script.google.com") || call.url.startsWith("https://api.vipps.no/")) {
      throw new Error("unexpected live call");
    }
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      const params = new URLSearchParams(call.body);
      assert.equal(params.get("amount"), "22000");
      assert.equal(params.get("currency"), "nok");
      assert.equal(params.get("automatic_payment_methods[enabled]"), "true");
      assert.equal(params.get("payment_method_types[0]"), null);
      assert.equal(params.get("metadata[orderId]"), ORDER_ID);
      assert.equal(call.headers["idempotency-key"], ORDER_ID);
      assert.equal(call.headers.authorization, "Bearer sk_test_123");
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId: ORDER_ID },
      });
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
}

function checkoutRequest(body: unknown) {
  return new Request("https://payments.test/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://hustleoslo.com" },
    body: JSON.stringify(body),
  });
}

test("the deployed allow-list is the public site and live mode stays off", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const origins = toml.split("\n").find((line) => line.startsWith("ALLOWED_ORIGINS"));
  assert.equal(
    origins,
    'ALLOWED_ORIGINS = "https://hustleoslo.com,https://www.hustleoslo.com"',
  );
  assert.match(toml, /ALLOW_LIVE_PAYMENTS = "false"/);
});

test("checkout prices on the server and replays the same order id", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const first = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  const created = await first.json();
  assert.equal(first.status, 200);
  assert.equal(created.ok, true);
  assert.equal(created.orderId, ORDER_ID);
  assert.equal(created.amountNok, 220);
  assert.equal(created.clientSecret, "pi_test_1_secret_abc");
  assert.equal(created.publishableKey, "pk_test_123");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);

  const second = await handleRequest(checkoutRequest(checkoutBody({ amount: 999999 })), env, deps);
  const replay = await second.json();
  assert.equal(second.status, 200);
  assert.equal(replay.replay, true);
  assert.equal(replay.orderId, ORDER_ID);
  assert.equal(replay.amountNok, 220);
  assert.equal(replay.clientSecret, "pi_test_1_secret_abc");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);

  const stored = await getOrder(kv, ORDER_ID);
  assert.equal(stored?.amountMinor, 22000);
  assert.equal(stored?.nights[0].amount, 220);
});

test("checkout create-intent does not call Apps Script", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const stripeDelayMs = 80;
  const recorded = recordFetch(async (call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      await new Promise((resolve) => setTimeout(resolve, stripeDelayMs));
      return jsonResponse({
        id: "pi_test_1",
        client_secret: "pi_test_1_secret_abc",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId: ORDER_ID },
      });
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
  const started = Date.now();
  const response = await handleRequest(checkoutRequest(checkoutBody()), env, { fetch: recorded.fetcher, now: () => NOW });
  const ms = Date.now() - started;
  assert.equal(response.status, 200);
  assert.ok(ms >= stripeDelayMs - 20 && ms < 250, "checkout took " + ms + "ms");
  assert.equal(recorded.calls.some((call) => call.url === env.APPS_SCRIPT_URL), false);
  console.info(JSON.stringify({ msg: "timing-measured", step: "create-intent", ms, stripeDelayMs }));
});

test("the same idempotency key with a different booking conflicts", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const first = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  assert.equal(first.status, 200);
  const second = await handleRequest(
    checkoutRequest(
      checkoutBody({
        nights: [{ eventId: "2026-12-07-class-gymsalen", ticketId: "beginners", priceTier: "standard" }],
      }),
    ),
    env,
    deps,
  );
  const body = await second.json();
  assert.equal(second.status, 409);
  assert.equal(body.error, "idempotency-conflict");
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);
  const stored = await getOrder(kv, ORDER_ID);
  assert.equal(stored?.amountNok, 220);
});

test("checkout is rate limited per hashed address and a replay does not count", async () => {
  const kv = memoryKv();
  const puts: { key: string; options?: { expirationTtl?: number } }[] = [];
  const wrapped = {
    get: (key: string) => kv.get(key),
    delete: (key: string) => kv.delete(key),
    list: (options: { prefix?: string; cursor?: string }) => kv.list(options),
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      puts.push({ key, options });
      await kv.put(key, value, options);
    },
  };
  const env = testEnv(wrapped);
  const ip = "203.0.113.10";
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      const params = new URLSearchParams(call.body);
      const orderId = params.get("metadata[orderId]") || "";
      return jsonResponse({
        id: "pi_" + orderId.slice(0, 8),
        client_secret: "secret_" + orderId.slice(0, 8),
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
        metadata: { orderId },
      });
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const requestFor = (n: number) =>
    new Request("https://payments.test/checkout", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://hustleoslo.com", "cf-connecting-ip": ip },
      body: JSON.stringify(
        checkoutBody({ idempotencyKey: `11111111-1111-4111-8111-${n.toString(16).padStart(12, "0")}` }),
      ),
    });
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await handleRequest(requestFor(attempt + 1), env, deps);
    assert.equal(response.status, 200, String(attempt));
  }
  const blocked = await handleRequest(requestFor(31), env, deps);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "rate-limit");
  const replay = await handleRequest(requestFor(1), env, deps);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replay, true);
  const ratePuts = puts.filter((put) => put.key.startsWith("rl:"));
  assert.ok(ratePuts.length >= 1);
  assert.equal(ratePuts.some((put) => put.key.includes(ip)), false);
  assert.ok(ratePuts.every((put) => (put.options?.expirationTtl || 0) >= 60));
});

test("a simultaneous second checkout receives the same payment session", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  let started = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      started += 1;
      return gate.then(() =>
        jsonResponse({
          id: "pi_test_1",
          client_secret: "pi_test_1_secret_abc",
          amount: 22000,
          currency: "nok",
          status: "requires_payment_method",
          metadata: { orderId: ORDER_ID },
        }),
      );
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const firstPromise = handleRequest(checkoutRequest(checkoutBody()), env, deps);
  for (let i = 0; i < 40 && started < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const secondPromise = handleRequest(checkoutRequest(checkoutBody()), env, deps);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const created = await first.json();
  const replay = await second.json();
  assert.equal(first.status, 200, JSON.stringify(created));
  assert.equal(second.status, 200, JSON.stringify(replay));
  assert.equal(created.clientSecret, "pi_test_1_secret_abc");
  assert.equal(replay.clientSecret, "pi_test_1_secret_abc");
  assert.equal(replay.replay, true);
  assert.equal(started, 1);
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.status, "pending");
  assert.equal(order?.failureReason, null);
  assert.equal(order?.clientSecret, "pi_test_1_secret_abc");
});

test("a racing provider error does not overwrite a checkout that succeeded", async () => {
  const kv = memoryKv();
  let leaseReads = 0;
  const racing = {
    get: async (key: string) => {
      const value = await kv.get(key);
      if (key.startsWith("order:") && value && value.includes('"checkoutLeaseToken":"') && !value.includes("pi_test_1_secret_abc")) {
        leaseReads += 1;
        // The winner's claim is visible. The next two reads are the loser
        // looking the order up, and must miss it so both reach Stripe.
        if (leaseReads === 2 || leaseReads === 3) return null;
      }
      return value;
    },
    put: (key: string, value: string, options?: { expirationTtl?: number }) => kv.put(key, value, options),
    delete: (key: string) => kv.delete(key),
    list: (options: { prefix?: string; cursor?: string }) => kv.list(options),
  };
  const env = testEnv(racing);
  let started = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorded = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      started += 1;
      if (started === 1) {
        return gate.then(() =>
          jsonResponse({
            id: "pi_test_1",
            client_secret: "pi_test_1_secret_abc",
            amount: 22000,
            currency: "nok",
            status: "requires_payment_method",
            metadata: { orderId: ORDER_ID },
          }),
        );
      }
      return jsonResponse({ error: { message: "stripe down" } }, 500);
    }
    return jsonResponse({ error: { message: "unexpected " + call.url } }, 500);
  });
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  const firstPromise = handleRequest(checkoutRequest(checkoutBody()), env, deps);
  for (let i = 0; i < 40 && started < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const secondPromise = handleRequest(checkoutRequest(checkoutBody()), env, deps);
  for (let i = 0; i < 40 && started < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(started, 2);
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const created = await first.json();
  const other = await second.json();
  assert.equal(first.status, 200, JSON.stringify(created));
  assert.equal(second.status, 200, JSON.stringify(other));
  assert.equal(created.clientSecret, "pi_test_1_secret_abc");
  assert.equal(other.clientSecret, "pi_test_1_secret_abc");
  const order = await getOrder(kv, ORDER_ID);
  assert.equal(order?.status, "pending");
  assert.equal(order?.failureReason, null);
  assert.equal(order?.clientSecret, "pi_test_1_secret_abc");
});

test("live stripe keys are accepted only when live mode is explicitly on", async () => {
  const refused = recordFetch(() => {
    throw new Error("provider should not be called");
  });
  const blocked = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_test_123" }),
    { fetch: refused.fetcher, now: () => NOW },
  );
  assert.equal(blocked.status, 403);
  assert.equal(refused.calls.length, 0);

  const allowed = recordFetch((call) => {
    if (call.method === "POST" && call.url.endsWith("/payment_intents")) {
      assert.equal(call.headers.authorization, "Bearer sk_live_123");
      return jsonResponse({
        id: "pi_live_1",
        client_secret: "live_secret",
        amount: 22000,
        currency: "nok",
        status: "requires_payment_method",
      });
    }
    return jsonResponse({ error: { message: "unexpected" } }, 500);
  });
  const response = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_live_123" }),
    { fetch: allowed.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 200);
  assert.equal(allowed.calls.length, 1);
});

test("vipps stays on apitest until live mode points at the production host", async () => {
  clearVippsTokenCache();
  const recorded = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "60" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://apitest.vipps.no/pay/abc", reference: ORDER_ID });
    }
    return jsonResponse({ ok: false }, 500);
  });
  const testMode = await handleRequest(
    checkoutRequest(checkoutBody({ method: "vipps" })),
    testEnv(memoryKv(), { VIPPS_API_BASE: "https://api.vipps.no" }),
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(testMode.status, 200);
  assert.ok(recorded.calls.some((call) => call.url.startsWith("https://apitest.vipps.no/")));
  assert.equal(recorded.calls.some((call) => call.url.startsWith("https://api.vipps.no/")), false);

  clearVippsTokenCache();
  const live = recordFetch((call) => {
    if (call.url.endsWith("/accesstoken/get")) return jsonResponse({ access_token: "vipps-token", expires_in: "60" });
    if (call.method === "POST" && call.url.endsWith("/epayment/v1/payments")) {
      return jsonResponse({ redirectUrl: "https://api.vipps.no/pay/abc", reference: ORDER_ID });
    }
    return jsonResponse({ ok: false }, 500);
  }, { allowLiveVipps: true });
  const liveResponse = await handleRequest(
    checkoutRequest(checkoutBody({ method: "vipps" })),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", VIPPS_API_BASE: "https://api.vipps.no" }),
    { fetch: live.fetcher, now: () => NOW },
  );
  assert.equal(liveResponse.status, 200);
  assert.ok(live.calls.some((call) => call.url.startsWith("https://api.vipps.no/epayment/")));
});

test("a live Stripe key is refused before any provider call", async () => {
  const recorded = stripeFetch();
  const response = await handleRequest(
    checkoutRequest(checkoutBody()),
    testEnv(memoryKv(), { STRIPE_SECRET_KEY: "sk_live_nope" }),
    { fetch: recorded.fetcher, now: () => NOW },
  );
  assert.equal(response.status, 403);
  assert.equal(recorded.calls.length, 0);
});

test("a paid order is not charged again", async () => {
  const kv = memoryKv();
  const env = testEnv(kv);
  const recorded = stripeFetch();
  const deps = { fetch: recorded.fetcher, now: () => NOW };
  assert.equal((await handleRequest(checkoutRequest(checkoutBody()), env, deps)).status, 200);
  const stored = await getOrder(kv, ORDER_ID);
  assert.ok(stored);
  stored.status = "paid";
  stored.paymentId = "pi_test_1";
  stored.appsScriptPosted = true;
  await putOrder(kv, stored);
  const again = await handleRequest(checkoutRequest(checkoutBody()), env, deps);
  const body = await again.json();
  assert.equal(body.status, "paid");
  assert.equal(body.clientSecret, null);
  assert.equal(recorded.calls.filter((call) => call.url.endsWith("/payment_intents")).length, 1);
});
