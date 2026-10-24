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
  assert.match(css, /\.bk-sheet\.is-clear-foot \.bk-body \{[^}]*scroll-padding-bottom:\s*calc\(var\(--bk-foot-h, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(js, /document\.addEventListener\("focusin"/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /height:\s*100svh/);
  const mobileFoot = css.match(/\.bk-foot \{[^}]+\}/);
  assert.ok(mobileFoot, "missing .bk-foot rule");
  assert.match(mobileFoot[0], /padding:\s*12px 16px calc\(16px \+ var\(--bk-safe-bottom, 0px\)\)/);
  const drawer = css.slice(css.indexOf("/* Desktop signup drawer"));
  assert.match(drawer, /\.bk-foot \{[^}]*padding:\s*12px 16px calc\(12px \+ max\(16px, env\(safe-area-inset-bottom, 0px\)\)\)/);
  const heading = css.match(/\.bk-banner b \{[^}]+\}/);
  assert.ok(heading, "missing banner heading rule");
  assert.match(heading[0], /color:\s*#ff8a8a/);
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="bk-dates-heading"[^>]*>Select dates</);
  assert.match(html, /id="bk-details-heading"[^>]*>Enter your details</);
  assert.match(js, /dates: "Select dates\."/);
  assert.match(js, /details: "Enter your details\."/);
  const failedFoot = html.slice(html.indexOf('id="bk-foot-failed"'), html.indexOf('id="bk-foot-waiting"'));
  const checkoutFoot = html.slice(html.indexOf('id="bk-foot-checkout"'), html.indexOf('id="bk-foot-failed"'));
  // The Terms of Sale / Refund Policy line sits directly above the Pay button.
  assert.ok(failedFoot.indexOf('id="bk-fail-tos"') < failedFoot.indexOf('id="bk-fail-retry"'));
  assert.ok(checkoutFoot.indexOf('id="bk-checkout-tos"') < checkoutFoot.indexOf('id="bk-pay"'));
  assert.equal(/\.bk-foot-note\s*\{[^}]*min-height/.test(css), false);
  assert.match(css, /\.bk-foot-note\s*\{[^}]*margin:\s*0 0 10px;/);
  assert.match(css, /\.bk-foot-panel\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(js, /visualViewport/);
  assert.equal(js.includes("--bk-foot-note"), false);
  assert.equal(js.includes("function syncFootNote("), false);
  for (const name of ["student", "dates", "confirm", "details", "waiting"]) {
    const start = html.indexOf('id="bk-foot-' + name + '"');
    const next = html.indexOf('id="bk-foot-', start + 12);
    const slice = html.slice(start, next === -1 ? html.indexOf("</footer>", start) : next);
    assert.equal(slice.includes('class="bk-foot-note"'), false, name + " reserves no empty space under its button");
  }
  assert.ok(checkoutFoot.indexOf("bk-foot-note") < checkoutFoot.indexOf('id="bk-checkout-tos"'));
  assert.ok(checkoutFoot.indexOf('id="bk-checkout-tos"') < checkoutFoot.indexOf('id="bk-pay"'));
  // The booked screen has no sticky bar: go() hides .bk-foot when a view has
  // no panel, and the Instagram line scrolls under the calendar buttons.
  assert.equal(html.includes('id="bk-foot-done"'), false);
  assert.match(js, /footer\.hidden = !document\.getElementById\("bk-foot-" \+ view\)/);
  const doneStep = html.slice(html.indexOf('id="bk-step-done"'), html.indexOf("</section>", html.indexOf('id="bk-step-done"')));
  assert.equal(doneStep.includes('data-action="done"'), false);
  assert.ok(doneStep.indexOf('id="bk-cal-actions"') < doneStep.indexOf('id="bk-done-help"'));
  assert.match(doneStep, /class="bk-mini bk-done-help"[^>]*>Questions\? DM <a href="https:\/\/instagram\.com\/hustleoslo" target="_blank" rel="noopener noreferrer">@hustleoslo<span class="visually-hidden"> \(opens in a new tab\)<\/span><\/a> on Instagram/);
  assert.match(css, /\.bk-done-help\s*\{[^}]*margin:\s*24px 0 0;/);
  assert.equal(html.slice(html.indexOf('<footer class="bk-foot">'), html.indexOf("</footer>", html.indexOf('<footer class="bk-foot">'))).includes("bk-mini"), false);
  assert.match(html, /id="bk-back"[^>]*aria-label="Back"/);
  assert.match(css, /#bk-back,\s*\n\s*#bk-close\s*\{[^}]*width:\s*40px/);
  assert.match(css, /#bk-back,\s*\n\s*#bk-close\s*\{[^}]*height:\s*40px/);
  assert.match(css, /#bk-back,\s*\n\s*#bk-close\s*\{[^}]*border-radius:\s*50%/);
  const footRule = css.match(/\.bk-foot \{[^}]+\}/);
  assert.ok(footRule, "missing .bk-foot rule");
  assert.equal(footRule[0].includes("border-top"), false);
  assert.equal(css.includes(".bk-foot:has(#bk-foot-student"), false);
  assert.equal(css.includes(".bk-foot:has(#bk-foot-confirm"), false);
  assert.match(css, /\.bk-sheet\.is-done #bk-back\s*\{[^}]*visibility:\s*hidden;/);
  assert.match(js, /classList\.toggle\("is-done", view === "done"\)/);
  assert.equal(html.includes("Secure payment by"), false);
  assert.equal(css.includes("bk-brand-visa"), false);
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
  const headingRed = contrast(luminance(0xff, 0x8a, 0x8a), background);
  assert.ok(after >= 4.5, "secondary grey contrast " + after.toFixed(2));
  assert.ok(headingRed >= 4.5, "banner heading contrast " + headingRed.toFixed(2));
  assert.ok(before > after);
});
