import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function api() {
  const document = { readyState: "loading", addEventListener() {} };
  const sandbox = { window: {} as Record<string, unknown>, document, console };
  sandbox.window = sandbox as unknown as Record<string, unknown>;
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: "app.js" });
  return sandbox.window.HustleOslo as {
    safeBottomExtra: (inset: number, v: { standalone: boolean; innerHeight: number; innerWidth: number; screenHeight: number; screenWidth: number }) => number;
  };
}

test("the bottom buttons end 16px above the visible viewport, no empty note under them", () => {
  const foot = css.match(/\.bk-foot \{[^}]+\}/);
  assert.ok(foot);
  assert.match(foot[0], /padding:\s*12px 16px calc\(16px \+ var\(--bk-safe-bottom, 0px\)\);/);
  assert.equal(foot[0].includes("env(safe-area-inset-bottom"), false);
  assert.match(css, /\.bk-safe-probe\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom, 0px\);/);
  assert.equal(html.includes('<div class="bk-foot-note" aria-hidden="true"></div>'), false);
  assert.equal(foot[0].includes("border-top"), false);
});

test("the home-indicator inset is added only when no browser toolbar covers it", () => {
  const { safeBottomExtra } = api();
  const phone = { standalone: false, innerWidth: 390, screenWidth: 390, screenHeight: 844 };
  assert.equal(safeBottomExtra(34, { ...phone, innerHeight: 664 }), 0, "Safari / Chrome with the bottom toolbar showing");
  assert.equal(safeBottomExtra(34, { ...phone, innerHeight: 750 }), 34, "collapsed toolbar");
  assert.equal(safeBottomExtra(34, { ...phone, innerHeight: 844, standalone: true }), 34, "home-screen app");
  assert.equal(safeBottomExtra(0, { ...phone, innerHeight: 750 }), 0, "no inset (Android, older phones)");
});

test("the sheet follows toolbar height changes but not the keyboard or zoom", () => {
  const fn = app.slice(app.indexOf("function onSheetViewport"), app.indexOf("function lockBackgroundScroll"));
  assert.match(fn, /Math\.abs\(viewportScale\(\) - 1\) > 0\.01\) return/);
  assert.match(fn, /const keyboardOpen = /);
  assert.match(fn, /!keyboardOpen && !typing\) captureSheetBox\(\)/);
  assert.match(html, /interactive-widget=resizes-visual/);
});

test("Terms of Sale and Refund Policy sit above Pay in title case and stay links", () => {
  for (const [foot, tos, pay] of [["bk-foot-checkout", "bk-checkout-tos", "bk-pay"], ["bk-foot-failed", "bk-fail-tos", "bk-fail-retry"]]) {
    const start = html.indexOf('id="' + foot + '"');
    const slice = html.slice(start, html.indexOf('id="bk-foot-', start + 12));
    assert.ok(slice.indexOf('id="' + tos + '"') < slice.indexOf('id="' + pay + '"'), foot);
    assert.match(slice, /<a href="\/termsofsale"[^>]*>Terms of Sale</);
    assert.match(slice, /<a href="\/termsofsale"[^>]*>Refund Policy</);
  }
  assert.equal(html.includes(">refund policy<"), false);
  assert.match(css, /\.bk-sheet \.bk-tos a \{[^}]*text-decoration:\s*underline;/);
});
