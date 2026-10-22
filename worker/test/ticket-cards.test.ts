import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop ticket cards are centred squares in one column and the landing cards stay rectangles", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const desktop = css.slice(css.indexOf("@media (min-width: 601px)"));
  const mobile = css.slice(0, css.indexOf("@media (min-width: 601px)"));
  const ticket = desktop.slice(desktop.indexOf("#bk-options .bk-options"));
  assert.match(ticket, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(ticket, /justify-items:\s*center/);
  assert.equal(/repeat\(2/.test(ticket), false);
  assert.match(ticket, /#bk-options \.bk-opt \{[^}]*aspect-ratio:\s*1\s*\/\s*1;/);
  assert.match(ticket, /#bk-options \.bk-opt \{[^}]*width:\s*min\(100%,\s*280px\)/);
  assert.equal(/\.bk-opt \{[^}]*aspect-ratio/.test(mobile), false);
  const upcoming = css.slice(css.indexOf(".upcoming-card {"), css.indexOf(".upcoming-date"));
  assert.equal(upcoming.includes("aspect-ratio"), false);
});
