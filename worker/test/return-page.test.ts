import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("the return page errors on an unknown order and can mount a live publishable key", () => {
  const document = {
    readyState: "loading",
    addEventListener() {},
  };
  const sandbox = {
    window: {} as Record<string, unknown>,
    document,
    console,
  };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../../app.js", import.meta.url), "utf8"), sandbox, { filename: "app.js" });
  const api = sandbox.window.HustleOslo as {
    resultFromOrder: (data: unknown) => { ok: boolean; message?: string; booking?: { pendingConfirmation?: boolean } };
    publishableKeyOk: (key: string) => boolean;
    config: { PAYMENTS_ENABLED: boolean };
  };
  assert.equal(api.config.PAYMENTS_ENABLED, false);
  const unknown = api.resultFromOrder({ ok: false, error: "not-found", status: "unknown" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message || "", /couldn’t find that payment/i);
  assert.equal(unknown.booking, undefined);
  const pending = api.resultFromOrder({ status: "pending", appsScriptPosted: false, confirmationSent: false });
  assert.equal(pending.ok, true);
  assert.equal(pending.booking?.pendingConfirmation, true);
  assert.equal(api.publishableKeyOk("pk_test_123"), true);
  assert.equal(api.publishableKeyOk("pk_live_123"), true);
  assert.equal(api.publishableKeyOk("pk_live_"), true);
  assert.equal(api.publishableKeyOk("sk_live_123"), false);
  assert.equal(api.publishableKeyOk(""), false);
});
