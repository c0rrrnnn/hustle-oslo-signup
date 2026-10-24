import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function body(name: string, next: string): string {
  const start = app.indexOf(name);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf(next, start + name.length));
}

test("the cart and the details survive a return in a new tab (localStorage, 2 hour expiry)", () => {
  assert.match(app, /SAVED_CART_TTL_MS = 2 \* 60 \* 60 \* 1000/);
  const get = body("function storeGet(", "function storeSet(");
  assert.match(get, /localStorage\.getItem/);
  assert.match(get, /SAVED_CART_TTL_MS/);
  const set = body("function storeSet(", "function storeRemove(");
  assert.match(set, /localStorage\.setItem/);
  assert.match(set, /savedAt: Date\.now\(\)/);
  const remove = body("function storeRemove(", "function readSavedCart(");
  assert.match(remove, /localStorage\.removeItem/);
  assert.match(remove, /sessionStorage\.removeItem/);
});

test("the details draft never reads card fields", () => {
  const read = body("function readDetailsForm(", "function saveDetailsDraft(");
  assert.equal(/bk-card|cardNumber|cvc/i.test(read), false);
  const draftField = body("function isDraftField(", "function onSheetInput(");
  assert.equal(/card|cvc|expiry/i.test(draftField), false);
});

test("a successful payment clears both the cart and the details; start over clears the cart", () => {
  const done = body("function showConfirmation", "async function saveAndConfirm");
  assert.match(done, /clearSavedCart\(\)/);
  assert.match(done, /clearSavedDetails\(\)/);
  const over = body("function startOver(", "async function resumePayment(");
  assert.match(over, /clearSavedCart\(\)/);
});

test("the return page rebuilds the cart from the Worker when there is no local copy", () => {
  const resume = body("async function resumePayment(", "function maybeResumePayment(");
  assert.match(resume, /applyServerCart\(data\.cart\)/);
  const open = body("function openSheet(", "function closeSheet(");
  assert.match(open, /restoreDetailsDraft\(\)/);
});

test("express checkout shows Apple Pay and Google Pay only", () => {
  const wallet = body("function createWalletElement(", "function walletPaymentFailed(");
  assert.match(wallet, /applePay: "auto"/);
  assert.match(wallet, /googlePay: "auto"/);
  for (const key of ["link", "paypal", "amazonPay", "klarna"]) assert.match(wallet, new RegExp(key + ': "never"'));
});
