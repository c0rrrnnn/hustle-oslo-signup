import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../src/handler.ts";
import { paymentsModeError } from "../src/stripe.ts";
import { memoryKv, testEnv } from "./helpers.ts";

test("a restricted live key is accepted with a live publishable key when live mode is on", () => {
  assert.equal(paymentsModeError(true, "rk_live_123", "pk_live_123"), null);
});

test("a restricted test key is accepted with a test publishable key", () => {
  assert.equal(paymentsModeError(false, "rk_test_123", "pk_test_123"), null);
  assert.equal(paymentsModeError(true, "rk_test_123", "pk_test_123"), null);
});

test("a restricted live key is rejected with a test publishable key", () => {
  const error = paymentsModeError(true, "rk_live_123", "pk_test_123");
  assert.equal(error, "Stripe secret and publishable keys must both be live or both be test.");
});

test("a restricted live key is rejected when live mode is off", () => {
  const error = paymentsModeError(false, "rk_live_123", "pk_live_123");
  assert.match(error || "", /must be a test key \(sk_test_ or rk_test_\)/);
});

test("health treats a restricted live key as live only when live mode is on", async () => {
  const off = await handleRequest(
    new Request("https://payments.test/health"),
    testEnv(memoryKv(), { STRIPE_SECRET_KEY: "rk_live_123", STRIPE_PUBLISHABLE_KEY: "pk_live_123" }),
  );
  assert.equal((await off.json()).mode, "test");

  const on = await handleRequest(
    new Request("https://payments.test/health"),
    testEnv(memoryKv(), {
      ALLOW_LIVE_PAYMENTS: "true",
      STRIPE_SECRET_KEY: "rk_live_123",
      STRIPE_PUBLISHABLE_KEY: "pk_live_123",
    }),
  );
  assert.equal((await on.json()).mode, "live");
});
