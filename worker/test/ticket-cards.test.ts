import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("desktop ticket cards are squares in two columns and the landing cards stay rectangles", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const desktop = css.slice(css.indexOf("@media (min-width: 601px)"));
  const mobile = css.slice(0, css.indexOf("@media (min-width: 601px)"));
  const ticket = desktop.slice(desktop.indexOf("#bk-options .bk-options"));
  assert.match(ticket, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(ticket, /#bk-options \.bk-opt \{[^}]*aspect-ratio:\s*1\s*\/\s*1;/);
  assert.equal(/\.bk-opt \{[^}]*aspect-ratio/.test(mobile), false);
  const upcoming = css.slice(css.indexOf(".upcoming-card {"), css.indexOf(".upcoming-date"));
  assert.equal(upcoming.includes("aspect-ratio"), false);
});
