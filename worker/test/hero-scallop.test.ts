import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const src = readFileSync(new URL("../../hero-scallop.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

type Geo = { n: number; m: number; d: number; H: number; dd: number; R: number; rho: number; svg: string };
function load(supports: boolean) {
  const sandbox: Record<string, unknown> = { CSS: { supports: () => supports } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "hero-scallop.js" });
  return sandbox.HustleHeroScallop as { geometry: (w: number, h: number) => Geo; attach: (el: unknown) => boolean; ACROSS: number; DEPTH: number };
}

test("hero scallop: 5 across, height snapped to whole bumps, dips 0.25 of a bump, round corners", () => {
  const s = load(true);
  assert.equal(s.ACROSS, 5);
  assert.equal(s.DEPTH, 0.25);
  for (const [w, ratio] of [[320, 16 / 9], [390, 16 / 9], [430, 16 / 9], [728, 16 / 9], [440, 16 / 10]]) {
    const g = s.geometry(w, w / ratio);
    assert.equal(g.n, 5);
    assert.equal(g.d, w / 5);
    assert.ok(Math.abs(g.H - g.m * g.d) < 1e-9, "height is a whole number of bumps");
    assert.ok(Math.abs(g.H - w / ratio) <= g.d / 2 + 1e-9, "snap trims at most half a bump");
    assert.equal(g.dd, 0.25 * g.d);
    // edge arc spans exactly one bump with sagitta dd -> neighbours meet in a point at depth dd
    assert.ok(Math.abs(Math.sqrt(g.R * g.R - (g.R - g.dd) ** 2) - g.d / 2) < 1e-9);
    // corner circle reaches the first dip point (d, dd) exactly
    assert.ok(Math.abs(Math.hypot(g.d - g.rho, g.dd - g.rho) - g.rho) < 1e-9);
    assert.ok(g.rho > g.dd && g.rho < g.d);
    const circles = g.svg.match(/<circle /g) || [];
    assert.equal(circles.length, 4 + 2 * (g.n - 2) + 2 * (g.m - 2));
  }
});

test("hero scallop: falls back to the rounded tile when masks are unsupported", () => {
  const s = load(false);
  let touched = false;
  assert.equal(s.attach({ classList: { add() { touched = true; } } }), false);
  assert.equal(touched, false);
});

test("hero scallop: loaded in <head>, attached before the video, overrides only under .is-scalloped", () => {
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<script src="hero-scallop\.js"><\/script>/);
  assert.match(html, /HustleHeroScallop\.attach\(video\.parentNode\)/);
  const rule = css.match(/\.hero-visual\.is-scalloped,\s*body\.is-landing \.hero-visual\.is-scalloped \{[^}]+\}/);
  assert.ok(rule);
  assert.match(rule[0], /border:\s*0;/);
  assert.match(rule[0], /border-radius:\s*0;/);
  assert.match(rule[0], /-webkit-mask-size:\s*100% 100%;/);
  assert.match(css, /body\.is-landing \.hero-visual\.is-scalloped \.hero-video \{[^}]*position:\s*absolute;[^}]*object-fit:\s*cover;/);
  assert.match(css, /\.hero-visual \{[^}]*border-radius:\s*18px;/, "fallback keeps the rounded corners");
});
