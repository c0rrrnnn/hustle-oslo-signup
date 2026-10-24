import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("ticket cards use the mobile row at every width and landing cards stay rectangles", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const opt = css.slice(css.indexOf(".bk-opt {"), css.indexOf(".bk-opt.is-on"));
  assert.match(opt, /display:\s*flex/);
  assert.equal(/aspect-ratio/.test(opt), false);
  assert.equal(/#bk-options[\s\S]*aspect-ratio/.test(css), false);
  assert.equal(/#bk-options[\s\S]*min\(100%,\s*280px\)/.test(css), false);
  assert.equal(/#bk-options[\s\S]*justify-items:\s*center/.test(css), false);
  assert.equal(css.includes("@media (min-width: 601px)"), false);
  const upcoming = css.slice(css.indexOf(".upcoming-card {"), css.indexOf(".upcoming-date"));
  assert.equal(upcoming.includes("aspect-ratio"), false);
});
