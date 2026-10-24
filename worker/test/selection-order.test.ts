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
  assert.match(body("function setTicket(", "function clearTicket("), /sortSelections\(state\.selections\)/);
  assert.match(body("function cartSelections(", "function storeGet("), /\.sort\(compareSelections\)/);
  assert.match(body("function renderConfirm(", "function "), /sortSelections\(state\.selections\)/);
  assert.match(body("function renderCheckout(", "function renderFailed("), /sortSelections\(state\.selections\)\.map\(orderLine\)/);
  assert.match(body("function renderFailed(", "function cardDigits("), /sortSelections\(state\.selections\)\.map\(orderLine\)/);
  assert.match(body("async function submitAllSignups(", "function "), /sortSelections\(state\.selections\)/);
  assert.equal((app.match(/nights: sortSelections\(state\.selections\)\.map/g) || []).length, 3);
  assert.equal(/nights: state\.selections\.map/.test(app), false);
});
