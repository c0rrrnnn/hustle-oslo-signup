import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { memoryKv, testEnv } from "./helpers.ts";

test("GET /config returns only the publishable key and the deferred-intent options", async () => {
  const res = await handleRequest(new Request("https://payments.test/config"), testEnv(memoryKv()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["currency", "ok", "paymentMethodTypes", "publishableKey"]);
  assert.match(body.publishableKey, /^pk_test_/);
  assert.equal(body.currency, "nok");
  assert.deepEqual(body.paymentMethodTypes, ["card"]);
  assert.doesNotMatch(JSON.stringify(body), /sk_|rk_|whsec_/);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("GET /config is refused when the Stripe keys don't match the mode", async () => {
  const res = await handleRequest(
    new Request("https://payments.test/config"),
    testEnv(memoryKv(), { STRIPE_SECRET_KEY: "rk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_live_123" }),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).publishableKey, undefined);
});

test("GET /config works in live mode with live keys", async () => {
  const res = await handleRequest(
    new Request("https://payments.test/config"),
    testEnv(memoryKv(), { ALLOW_LIVE_PAYMENTS: "true", STRIPE_SECRET_KEY: "rk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_live_123" }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).publishableKey, "pk_live_123");
});
