import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(l1: number, l2: number) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test("the payment footer is measured and the error card keeps a red fill without a red border", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const banner = css.match(/\.bk-banner \{[^}]+\}/);
  assert.ok(banner, "missing .bk-banner rule");
  assert.match(banner[0], /background:\s*rgba\(255,\s*138,\s*138,\s*0\.08\)/);
  assert.match(banner[0], /border:\s*0;/);
  assert.equal(banner[0].includes("#ff8a8a"), false);
  assert.match(banner[0], /color:\s*#a1a1aa/);
  assert.match(css, /\.bk-sheet\.is-clear-foot \.bk-foot \{[^}]*background:\s*transparent;/);
  assert.match(css, /\.bk-sheet\.is-clear-foot \.bk-foot \{[^}]*margin-top:\s*0;/);
  assert.match(css, /\.bk-sheet\.is-clear-foot \{[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.bk-sheet\.is-clear-foot \.bk-body \{[^}]*overflow:\s*auto;/);
  assert.match(css, /\.bk-sheet\.is-clear-foot \.bk-body \{[^}]*padding-bottom:\s*calc\(var\(--bk-foot-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.equal(/margin-top:\s*calc\(-1\s*\*\s*var\(--bk-foot-h/.test(css), false);
  assert.match(js, /new ResizeObserver/);
  assert.match(js, /--bk-foot-h/);
  assert.equal(js.includes("PAYMENTS_ENABLED: false"), true);

  // rgba(255, 138, 138, 0.08) over the sheet #121214.
  const sheet = [18, 18, 20];
  const red = [255, 138, 138];
  const alpha = 0.08;
  const composite = red.map((c, i) => c * alpha + sheet[i] * (1 - alpha));
  const background = luminance(composite[0], composite[1], composite[2]);
  const before = contrast(luminance(0xfe, 0xca, 0xca), background);
  const after = contrast(luminance(0xa1, 0xa1, 0xaa), background);
  assert.ok(after >= 4.5, "secondary grey contrast " + after.toFixed(2));
  assert.ok(before > after);
});
