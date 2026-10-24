import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function body(name: string, next: string): string {
  const start = app.indexOf(name);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf(next, start + name.length));
}

function sorter() {
  const src = body("function ticketTime(", "function ticketNote(") + "\nthis.sortSelections = sortSelections;";
  const box: any = {};
  vm.runInNewContext(src, box);
  return box.sortSelections as (list: any[]) => any[];
}

const ev = (date: string, type = "class") => ({ id: `${date}-${type}`, date, type, start: "18:00", end: type === "class" ? "21:00" : "20:00" });
const pick = (date: string, ticket: string, type = "class") => ({ event: ev(date, type), ticket: { id: ticket } });

test("nights picked 16 Nov, then 2 Nov, then 9 Nov list as 2, 9, 16 Nov", () => {
  const sortSelections = sorter();
  const list = [pick("2026-11-16", "social"), pick("2026-11-02", "beginners"), pick("2026-11-09", "bundle")];
  sortSelections(list);
  assert.deepEqual(list.map((s) => s.event.date), ["2026-11-02", "2026-11-09", "2026-11-16"]);
});

test("on the same night Beginners comes before Intermediate before Social", () => {
  const sortSelections = sorter();
  const list = [pick("2026-12-07", "social"), pick("2026-12-07", "intermediate"), pick("2026-11-02", "social"), pick("2026-12-07", "beginners")];
  sortSelections(list);
  assert.deepEqual(list.map((s) => s.event.date + " " + s.ticket.id),
    ["2026-11-02 social", "2026-12-07 beginners", "2026-12-07 intermediate", "2026-12-07 social"]);
});

test("every list and payload reads the sorted selection", () => {
  assert.match(body("function setTicket(", "function clearTicket("), /cartChanged\(\)/);
  assert.match(body("function cartChanged(", "function detailsComplete("), /sortSelections\(state\.selections\)/);
  assert.match(body("function cartSelections(", "function storeGet("), /\.sort\(compareSelections\)/);
  assert.match(body("function renderConfirm(", "function "), /sortSelections\(state\.selections\)/);
  assert.match(body("function renderCheckout(", "function renderFailed("), /sortSelections\(state\.selections\)\.map\(orderLine\)/);
  assert.match(body("function renderFailed(", "function cardDigits("), /sortSelections\(state\.selections\)\.map\(orderLine\)/);
  assert.match(body("async function submitAllSignups(", "function "), /sortSelections\(state\.selections\)/);
  assert.equal((app.match(/nights: sortSelections\(state\.selections\)\.map/g) || []).length, 3);
  assert.equal(/nights: state\.selections\.map/.test(app), false);
});

test("removing or changing a class refreshes every total, drops the old payment and rewrites the saved cart", () => {
  const removeFn = body("function removeNight(", "function cartChanged(");
  assert.match(removeFn, /cartChanged\(\)/);
  assert.match(body("function clearTicket(", "function isTicketInput("), /cartChanged\(\)/);
  const changed = body("function cartChanged(", "function detailsComplete(");
  assert.match(changed, /resetPaymentAttempt\(\)/);
  assert.match(changed, /updatePayChrome\(\)/);
  assert.match(changed, /renderConfirm\(\)/);
  assert.match(changed, /savePaymentSession\("", true\)/);
  assert.match(changed, /clearSavedCart\(\)/);
});

test("Confirm selection goes straight back to checkout after an edit when details are valid, with a truthful label", () => {
  const next = body("function nextAfterConfirm(", "function syncConfirmNext(");
  assert.match(next, /if \(!state\.priceTier\) return "student"/);
  assert.match(next, /state\.reachedCheckout && detailsComplete\(\)\) return "checkout"/);
  assert.match(next, /return "details"/);
  const label = body("function syncConfirmNext(", "function ");
  assert.match(label, /=== "checkout" \? "Continue to Payment" : "Continue"/);
  assert.match(app, /if \(target === "checkout"\) state\.checkoutFrom = "confirm";/);
  assert.match(app, /return go\(state\.checkoutFrom === "confirm" \? "confirm" : "details"\)/);
});

test("experience copy: other styles without 'now'", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="other-styles">I dance other styles \(salsa, swing, etc\.\)<\/option>/);
  assert.match(app, /"other-styles": "I dance other styles \(salsa, swing, etc\.\)"/);
  assert.equal(/other styles now/.test(app + html), false);
});

test("removing or changing a class refreshes every total, drops the old payment and rewrites the saved cart", () => {
  assert.match(body("function removeNight(", "function cartChanged("), /cartChanged\(\)/);
  const changed = body("function cartChanged(", "function detailsComplete(");
  assert.match(changed, /resetPaymentAttempt\(\)/);
  assert.match(changed, /updatePayChrome\(\)/);
  assert.match(changed, /renderConfirm\(\)/);
  assert.match(changed, /savePaymentSession\("", true\)/);
  assert.match(changed, /clearSavedCart\(\)/);
});

test("Confirm selection goes straight back to checkout after an edit when details are valid, with a truthful label", () => {
  const next = body("function nextAfterConfirm(", "function syncConfirmNext(");
  assert.match(next, /if \(!state\.priceTier\) return "student"/);
  assert.match(next, /state\.reachedCheckout && detailsComplete\(\)\) return "checkout"/);
  assert.match(next, /return "details"/);
  assert.match(app, /"Continue to Payment" : "Continue"/);
  assert.match(app, /if \(target === "checkout"\) state\.checkoutFrom = "confirm";/);
  assert.match(app, /return go\(state\.checkoutFrom === "confirm" \? "confirm" : "details"\)/);
  // Coming back from Vipps/Stripe to the failed screen counts as having reached checkout.
  assert.match(app, /if \(view === "failed"\) \{\s*state\.reachedCheckout = true;/);
});

test("Google Pay is offered on any capable browser, not only with a card already saved", () => {
  const mode = body("function googlePayMode(", "function createWalletElement(");
  assert.match(mode, /\? "auto" : "always"/);
  assert.match(app, /googlePay: googlePayMode\(\)/);
  assert.match(app, /wallets: \{ applePay: "never", googlePay: "never", link: "never" \}/);
  assert.match(app, /klarna: "never"/);
  assert.match(app, /link: "never"/);
});

test("experience copy: other styles without 'now'", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /<option value="other-styles">I dance other styles \(salsa, swing, etc\.\)<\/option>/);
  assert.match(app, /"other-styles": "I dance other styles \(salsa, swing, etc\.\)"/);
  assert.equal(/other styles now/.test(app + html), false);
});
