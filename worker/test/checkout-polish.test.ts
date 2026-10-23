import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a decline clears submitting before the failed screen prepares the card form", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const failed = js.slice(js.indexOf("function showPaymentFailed"), js.indexOf("function buildPersonFields"));
  const submitting = failed.indexOf("state.submitting = false");
  const reset = failed.indexOf("resetPaymentAttempt()");
  const go = failed.indexOf('go("failed")');
  assert.ok(submitting >= 0 && reset > submitting && go > reset);
  assert.match(js, /if \(state\.submitting\) return;/);
});

test("step headings take programmatic focus without a visible ring", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.match(css, /:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none;/);
  assert.match(css, /\.bk-h:focus,\s*\.bk-h:focus-visible\s*\{[^}]*box-shadow:\s*none;/);
  assert.match(js, /heading\.focus\(\{\s*preventScroll:\s*true,\s*focusVisible:\s*false\s*\}\)/);
  for (const id of [
    "bk-student-heading",
    "bk-dates-heading",
    "bk-confirm-heading",
    "bk-details-heading",
    "bk-checkout-heading",
    "bk-failed-heading",
    "bk-waiting-heading",
    "bk-done-heading",
  ]) {
    assert.match(html, new RegExp('id="' + id + '" tabindex="-1"'));
  }
});

test("checkout stays in the 480px drawer and the selected card closes its box", () => {
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.equal(js.includes("wideCheckout"), false);
  assert.equal(js.includes("paySeg"), false);
  assert.equal(css.includes("is-wide"), false);
  assert.equal(css.includes("bk-pay-seg"), false);
  assert.match(js, /if \(state\.view === "checkout"\) return go\("details"\)/);
  assert.match(js, /return go\("details"\)/);
  assert.equal(js.includes("brandMarks"), false);
  assert.equal(css.includes("1100px"), false);
  assert.match(css, /#bk-card-slot\.is-open,\s*#bk-fail-card-slot\.is-open\s*\{[^}]*border:\s*1px solid #fff;/);
  assert.match(css, /\.bk-pay-list:has\(\+ \.is-open\) \.bk-mrow\.is-on\[data-method="card"\]/);
  assert.equal(html.includes("Secure checkout"), false);
  assert.equal(html.includes("bk-brands"), false);
  assert.equal(html.includes("bk-pay-seg"), false);
  assert.equal(html.includes("bk-deskbar"), false);
  assert.match(html, /id="bk-pay-heading">Payment methods</);
  assert.match(html, /id="bk-fail-pay-heading">Payment methods</);
  assert.match(html, /id="bk-pay-list"[^>]*role="radiogroup"/);
});

test("checkout has no provider trust line and field errors keep the normal border", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const js = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.equal(html.includes("Secure payment by"), false);
  assert.equal(html.includes("bk-trust"), false);
  assert.equal(js.includes("VISA"), false);
  const invalid = css.match(/\.bk-input\[aria-invalid="true"\],\s*\.bk-select\[aria-invalid="true"\]\s*\{[^}]+\}/);
  assert.ok(invalid, "missing invalid field rule");
  assert.match(invalid[0], /border-color:\s*#2a2a2e/);
  assert.match(invalid[0], /background:\s*#1c1c1f/);
  assert.equal(invalid[0].includes("#2e2528"), false);
  assert.equal(invalid[0].includes("#ff8a8a"), false);
  assert.match(css, /\.bk-err\s*\{[^}]*color:\s*#ffb4b4/);
  assert.match(html, /id="btn-start"[^>]*aria-label="Register"/);
  const landingIds = ["hero-video", "intro-heading", "landing-upcoming", "btn-start", "landing-about", "landing-details", "landing-schedule", "landing-prices", "landing-location"];
  landingIds.reduce((prev, id) => {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > prev, id + " follows the landing order");
    return at;
  }, -1);
  assert.equal(html.slice(html.indexOf('id="landing-about"'), html.indexOf('id="landing-details"')).includes("btn-start"), false);
  assert.equal(html.split('id="btn-start"').length - 1, 1);
  assert.equal(/\border\s*:/.test(css), false);
  assert.equal(/\.landing-actions\s*\{[^}]*position:\s*fixed/.test(css), false);
  assert.equal(css.includes("--sticky-pad"), false);
  assert.match(css, /--landing-section-gap:\s*1\.75rem/);
  assert.match(css, /--landing-section-gap:\s*2\.4rem/);
  assert.equal(html.includes("Register for class"), false);
  assert.equal(html.includes("Book a class"), false);
  assert.match(html, /class="bk-bar-title">Register</);
  assert.match(css, /\.bk-sheet button:focus-visible[\s\S]*outline:\s*2px solid #fff;/);
  assert.equal(js.includes('colorPrimary: "#df8026"'), false);
  const err = [255, 180, 180];
  const sheet = [18, 18, 20];
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb: number[]) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const contrast = (lum(err) + 0.05) / (lum(sheet) + 0.05);
  assert.ok(contrast >= 4.5, "error text contrast " + contrast.toFixed(2));
});

test("desktop landing is two columns and signup opens in a right-side drawer", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.match(html, /landing-col-main/);
  assert.match(html, /landing-col-side/);
  assert.match(html, /class="bk-scrim"/);
  const desktop = css.slice(css.indexOf("@media (min-width: 960px)"));
  assert.match(desktop, /\.landing-cols\s*\{[^}]*grid-template-columns:/);
  assert.match(desktop, /\.bk-frame\s*\{[^}]*right:\s*0;/);
  assert.match(desktop, /\.bk-frame\s*\{[^}]*width:\s*min\(480px,\s*100%\)/);
});
