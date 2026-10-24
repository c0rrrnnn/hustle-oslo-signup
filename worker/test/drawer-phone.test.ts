import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("a tapped calendar date keeps the circle and not a white box", () => {
  assert.match(css, /\.bk-day\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent;/);
  assert.match(css, /\.bk-day\s*\{[^}]*appearance:\s*none;/);
  assert.match(css, /\.bk-day\s*\{[^}]*justify-self:\s*center;/);
  assert.match(css, /\.bk-day\.is-selected,\s*\.bk-day\.is-selected:focus,\s*\.bk-day\.is-selected:active\s*\{[^}]*background-color:\s*#3a3a40;/);
  assert.match(css, /\.bk-day\.is-selected,\s*\.bk-day\.is-selected:focus,\s*\.bk-day\.is-selected:active\s*\{[^}]*box-shadow:\s*0 0 0 2px #fff;/);
  assert.match(css, /\.bk-sheet button\.bk-day:focus-visible\s*\{[^}]*outline:\s*2px solid #fff;/);
  assert.match(css, /\.bk-sheet\.bk-touch button\.bk-day:focus,\s*\.bk-sheet\.bk-touch button\.bk-day:focus-visible\s*\{[^}]*outline:\s*none;/);
  assert.match(app, /sheet\.classList\.add\("bk-touch"\)/);
  assert.match(app, /focusVisible:\s*false/);
  assert.equal(html.includes("user-scalable"), false);
  assert.equal(html.includes("maximum-scale"), false);
});

test("the drawer ignores zoom and keeps Next at the layout bottom", () => {
  assert.match(html, /interactive-widget=resizes-visual/);
  assert.match(css, /@media \(max-width: 959px\)\s*\{[^}]*\.bk-input,\s*\.bk-select,\s*\.bk-sheet textarea\s*\{[^}]*font-size:\s*16px;/);
  assert.match(css, /\.bk-sheet\s*\{[^}]*overscroll-behavior:\s*contain;/);
  assert.match(css, /\.bk-body\s*\{[^}]*overscroll-behavior:\s*contain;/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /height:\s*100svh/);
  const capture = app.slice(app.indexOf("function captureSheetBox"), app.indexOf("function releaseSheetBox"));
  assert.match(capture, /Math\.abs\(viewportScale\(\) - 1\) > 0\.01\) return/);
  assert.equal(capture.includes('setProperty("top"'), false);
  assert.equal(app.includes('addEventListener("scroll"'), false);
  assert.match(app, /body\.style\.position = "fixed"/);
  assert.match(app, /body\.dataset\.bkScrollY/);
  assert.match(app, /window\.scrollTo\(0, y\)/);
  const foot = css.match(/\.bk-foot \{[^}]+\}/);
  assert.ok(foot);
  assert.match(foot[0], /padding:\s*12px 16px calc\(16px \+ var\(--bk-safe-bottom, 0px\)\)/);
});

test("Return moves to the next required field, then continues", () => {
  const document = { readyState: "loading", addEventListener() {} };
  const sandbox = { window: {} as Record<string, unknown>, document, console };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: "app.js" });
  const api = sandbox.window.HustleOslo as {
    formFieldNeedsAttention: (field: { required: boolean; empty: boolean; valid: boolean }) => boolean;
    nextFormFieldIndex: (fields: { required: boolean; empty: boolean; valid: boolean }[], from: number) => number;
    enterKeyHintFor: (fields: { required: boolean; empty: boolean; valid: boolean }[], index: number, step: string) => string;
  };
  const empty = { required: true, empty: true, valid: false };
  const filled = { required: true, empty: false, valid: true };
  const phone = { required: false, empty: true, valid: true };
  const badPhone = { required: false, empty: false, valid: false };
  const optional = { required: false, empty: true, valid: true };
  assert.equal(api.formFieldNeedsAttention(phone), false);
  assert.equal(api.formFieldNeedsAttention(badPhone), true);
  assert.equal(api.formFieldNeedsAttention(optional), false);
  assert.equal(api.nextFormFieldIndex([empty, empty, phone, optional], 0), 1);
  assert.equal(api.nextFormFieldIndex([filled, empty, phone], 0), 1);
  assert.equal(api.nextFormFieldIndex([filled, filled, phone, optional], 0), -1);
  assert.equal(api.nextFormFieldIndex([filled, badPhone, empty], 0), 1);
  assert.equal(api.nextFormFieldIndex([empty, filled], 0), 0);
  assert.equal(api.enterKeyHintFor([empty, empty], 0, "details"), "next");
  assert.equal(api.enterKeyHintFor([filled, filled], 1, "details"), "go");
  assert.equal(api.enterKeyHintFor([filled], 0, "checkout"), "done");
  assert.equal(api.enterKeyHintFor([filled], 0, "failed"), "done");
  assert.match(app, /function onFormReturn/);
  assert.match(html, /id="bk-name"[^>]*enterkeyhint="next"/);
  assert.match(html, /id="bk-card-name"[^>]*enterkeyhint="done"/);
});

test("a cancelled payment keeps the cart and the next pay is a new order", () => {
  const document = { readyState: "loading", addEventListener() {} };
  const sandbox = { window: {} as Record<string, unknown>, document, console };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: "app.js" });
  const api = sandbox.window.HustleOslo as {
    cartSelections: (
      snapshot: { nights: { eventId: string; ticketId: string; priceTier: string; event?: { id: string; type: string; date: string }; ticket?: { id: string; name: string; prices: { standard: number } } }[] },
      events: { id: string; type: string; date: string }[],
      tickets: Record<string, { id: string; name: string; prices: { standard: number; student?: number } }[]>,
    ) => { event: { id: string; date: string }; ticket: { id: string }; priceTier: string }[];
    cartMatchesOrder: (snapshot: { pendingPayment?: boolean; orderId?: string; nights?: unknown[] } | null, orderId: string) => boolean;
  };
  const events = [{ id: "2026-10-19-social-gymsalen", type: "social", date: "2026-10-19" }];
  const tickets = { social: [{ id: "social", name: "Social entry", prices: { standard: 50, student: 50 } }] };
  const snapshot = {
    pendingPayment: true,
    orderId: "order-1",
    nights: [{ eventId: events[0].id, ticketId: "social", priceTier: "student" }],
  };
  const restored = api.cartSelections(snapshot, events, tickets);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].event.date, "2026-10-19");
  assert.equal(restored[0].ticket.id, "social");
  assert.equal(restored[0].priceTier, "student");
  const embedded = api.cartSelections({
    nights: [{
      eventId: "2026-10-14-social",
      ticketId: "social",
      priceTier: "standard",
      event: { id: "2026-10-14-social", type: "social", date: "2026-10-14" },
      ticket: { id: "social", name: "Social entry", prices: { standard: 50 } },
    }],
  }, [], {});
  assert.equal(embedded.length, 1);
  assert.equal(embedded[0].event.date, "2026-10-14");
  assert.equal(api.cartMatchesOrder(snapshot, "order-1"), true);
  assert.equal(api.cartMatchesOrder(snapshot, "other-order"), false);
  assert.equal(api.cartMatchesOrder({ pendingPayment: false, orderId: "order-1", nights: snapshot.nights }, "order-1"), false);
  const reset = app.slice(app.indexOf("function resetPaymentAttempt"), app.indexOf("function unmountStripeElements"));
  assert.equal(reset.includes("sessionStorage.removeItem"), false);
  assert.match(reset, /paymentUi\.keys = \{\}/);
  const failed = app.slice(app.indexOf("function showPaymentFailed"), app.indexOf("function buildPersonFields"));
  const saveAt = failed.indexOf("savePaymentSession(orderId)");
  const restoreAt = failed.indexOf("restorePendingCart(orderId)");
  const resetAt = failed.indexOf("resetPaymentAttempt()");
  assert.ok(saveAt >= 0 && restoreAt > saveAt && resetAt > restoreAt);
  assert.match(app, /pendingPayment: true/);
  const done = app.slice(app.indexOf("function showConfirmation"), app.indexOf("async function saveAndConfirm"));
  assert.match(done, /clearSavedCart\(\)/);
});

test("pagehide saves the Vipps order even after a card form was prepared", () => {
  const start = app.indexOf("async function startPayment(");
  const vipps = app.indexOf('if (method === "vipps")', start);
  const pin = app.indexOf("paymentUi.redirectOrderId = created.orderId;", vipps);
  const assign = app.indexOf("window.location.assign(created.redirectUrl)", vipps);
  assert.ok(vipps > start && pin > vipps && pin < assign, "the Vipps order is pinned before the redirect");
  const hide = app.indexOf('addEventListener("pagehide"');
  assert.ok(hide > 0);
  assert.match(app.slice(hide, hide + 500), /savePaymentSession\(paymentUi\.redirectOrderId \|\| paymentUi\.orderId \|\| ""\)/);
  const reset = app.indexOf("function resetPaymentAttempt(");
  assert.match(app.slice(reset, reset + 900), /paymentUi\.redirectOrderId = "";/);
});
