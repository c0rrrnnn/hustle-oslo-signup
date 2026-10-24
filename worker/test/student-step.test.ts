import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("the student step has no separate Next button", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const step = html.slice(html.indexOf('id="bk-step-student"'), html.indexOf('id="bk-step-dates"'));
  const foot = html.slice(html.indexOf('id="bk-foot-student"'), html.indexOf('id="bk-foot-dates"'));
  assert.equal(html.includes("student-next"), false);
  assert.match(html, /viewport-fit=cover/);
  assert.match(step, /Are you a student\?/);
  assert.equal(step.includes("bk-student-yes"), false);
  assert.match(foot, /<button type="button"[^>]*id="bk-student-yes"/);
  assert.match(foot, /<button type="button"[^>]*id="bk-student-no"/);
  assert.match(html, /id="bk-dates-next"[^>]*>Next</);
  assert.match(html, /id="bk-dates-heading"[^>]*tabindex="-1"/);
  assert.match(html, /id="bk-student-heading"[^>]*tabindex="-1"/);
  const footRule = css.match(/\.bk-foot \{[^}]+\}/);
  assert.ok(footRule, "missing .bk-foot rule");
  assert.match(footRule[0], /padding:\s*12px 16px calc\(16px \+ var\(--bk-safe-bottom, 0px\)\)/);
  const drawer = css.slice(css.indexOf("/* Desktop signup drawer"));
  assert.match(drawer, /\.bk-foot \{[^}]*padding:\s*12px 16px calc\(12px \+ max\(16px, env\(safe-area-inset-bottom, 0px\)\)\)/);
  assert.match(css, /#bk-foot-student \.bk-choices \{[^}]*flex-direction:\s*column;/);
});

class ClassList {
  private names = new Set<string>();

  constructor(value: string) {
    value.split(/\s+/).filter(Boolean).forEach((name) => this.names.add(name));
  }

  add(name: string) {
    this.names.add(name);
  }

  remove(name: string) {
    this.names.delete(name);
  }

  contains(name: string) {
    return this.names.has(name);
  }

  toggle(name: string, force?: boolean) {
    const on = force === undefined ? !this.names.has(name) : force;
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class El {
  tag: string;
  attrs: Record<string, string>;
  children: El[] = [];
  parentElement: El | null = null;
  classList: ClassList;
  hidden: boolean;
  listeners: Record<string, Array<(event: EventLike) => void>> = {};
  text = "";
  style: Record<string, string> = {};
  disabled = false;
  inert = false;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    this.attrs = { ...attrs };
    this.classList = new ClassList(attrs.class || "");
    this.hidden = Object.prototype.hasOwnProperty.call(attrs, "hidden");
  }

  get id() {
    return this.attrs.id || "";
  }

  get dataset() {
    const out: Record<string, string> = {};
    Object.entries(this.attrs).forEach(([key, value]) => {
      if (!key.startsWith("data-")) return;
      const name = key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      out[name] = value;
    });
    return out;
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join("");
    return this.text;
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  set innerHTML(value: string) {
    this.text = value ? "" : this.text;
    this.text = "";
    this.children = [];
    void value;
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === "hidden") this.hidden = true;
  }

  getAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  matches(selector: string) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    if (selector === "[data-action]") return this.getAttribute("data-action") != null;
    return this.tag === selector;
  }

  closest(selector: string): El | null {
    let node: El | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): El[] {
    const parts = selector.trim().split(/\s+/);
    let matched = descendants(this).filter((el) => el.matches(parts[0]));
    for (let i = 1; i < parts.length; i += 1) {
      const next: El[] = [];
      matched.forEach((el) => {
        descendants(el)
          .filter((kid) => kid.matches(parts[i]))
          .forEach((kid) => next.push(kid));
      });
      matched = next;
    }
    return matched;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }

  addEventListener(type: string, fn: (event: EventLike) => void) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  appendChild(child: El) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  focus() {
    active = this;
  }

  scrollTo() {}

  click() {
    const event: EventLike = {
      target: this,
      key: "",
      preventDefault() {},
      stopPropagation() {
        event.stopped = true;
      },
      stopped: false,
    };
    let node: El | null = this;
    while (node) {
      (node.listeners.click || []).forEach((fn) => fn(event));
      if (event.stopped) break;
      node = node.parentElement;
    }
  }

  contains(node: El | null): boolean {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }
}

type EventLike = {
  target: El;
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopped?: boolean;
};

function descendants(root: El) {
  const out: El[] = [];
  const walk = (el: El) => {
    el.children.forEach((child) => {
      out.push(child);
      walk(child);
    });
  };
  walk(root);
  return out;
}

function el(tag: string, attrs: Record<string, string> = {}) {
  return new El(tag, attrs);
}

let active: El | null = null;

function mountSheet() {
  const body = el("body");
  const start = el("button", { id: "btn-start" });
  const sheet = el("div", { id: "book-sheet", hidden: "" });
  const back = el("button", { id: "bk-back", "data-action": "back" });
  const prog = el("div", { id: "bk-prog" });
  prog.appendChild(el("i"));
  prog.appendChild(el("i"));
  prog.appendChild(el("i"));
  prog.appendChild(el("i"));
  const status = el("p", { id: "bk-step-status" });
  const student = el("section", { id: "bk-step-student" });
  const studentHeading = el("h2", { id: "bk-student-heading", tabindex: "-1" });
  studentHeading.textContent = "Are you a student?";
  const yes = el("button", { id: "bk-student-yes", type: "button", "data-action": "student", "data-value": "student", "aria-pressed": "false" });
  const no = el("button", { id: "bk-student-no", type: "button", "data-action": "student", "data-value": "standard", "aria-pressed": "false" });
  const dates = el("section", { id: "bk-step-dates", hidden: "" });
  const datesHeading = el("h2", { id: "bk-dates-heading", tabindex: "-1" });
  datesHeading.textContent = "Select a date";
  const options = el("div", { id: "bk-options" });
  const footer = el("footer", { class: "bk-foot" });
  const studentFoot = el("div", { id: "bk-foot-student" });
  const datesFoot = el("div", { id: "bk-foot-dates", hidden: "" });
  datesFoot.appendChild(el("button", { id: "bk-dates-next", "data-action": "dates-next" }));
  student.appendChild(studentHeading);
  studentFoot.appendChild(yes);
  studentFoot.appendChild(no);
  dates.appendChild(datesHeading);
  dates.appendChild(options);
  footer.appendChild(studentFoot);
  footer.appendChild(datesFoot);
  sheet.appendChild(back);
  sheet.appendChild(prog);
  sheet.appendChild(status);
  sheet.appendChild(student);
  sheet.appendChild(dates);
  sheet.appendChild(footer);
  body.appendChild(start);
  body.appendChild(sheet);

  const listeners: Record<string, Array<(event: EventLike) => void>> = {};
  const document = {
    body,
    readyState: "complete",
    activeElement: null as El | null,
    addEventListener(type: string, fn: (event: EventLike) => void) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    getElementById(id: string) {
      return [body, ...descendants(body)].find((node) => node.id === id) || null;
    },
    querySelector(selector: string) {
      return body.querySelector(selector);
    },
    querySelectorAll(selector: string) {
      return body.querySelectorAll(selector);
    },
    contains(node: El | null) {
      return body.contains(node);
    },
    emit(type: string, event: EventLike) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
  };
  Object.defineProperty(document, "activeElement", {
    get() {
      return active;
    },
  });
  return { document, start, sheet, back, yes, no, student, dates, datesHeading, status, options, footer, studentFoot };
}

test("choosing Yes or No opens the date step and keeps that answer", async () => {
  const ui = mountSheet();
  const sandbox = {
    window: {
      HUSTLE_EVENTS: [] as unknown[],
      location: { search: "", pathname: "/", origin: "http://127.0.0.1" },
      matchMedia() {
        return { matches: false, addEventListener() {} };
      },
    } as Record<string, unknown>,
    document: ui.document,
    console,
  };
  sandbox.window.document = ui.document;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../../app.js", import.meta.url), "utf8"), sandbox, { filename: "app.js" });

  ui.start.click();
  assert.equal(ui.student.hidden, false);
  assert.equal(ui.footer.hidden, false);
  assert.equal(ui.studentFoot.hidden, false);

  ui.yes.focus();
  ui.document.emit("keydown", { target: ui.yes, key: "ArrowDown", preventDefault() {}, stopPropagation() {}, stopped: false });
  assert.equal(ui.document.activeElement, ui.no);
  assert.equal(ui.student.hidden, false);
  assert.equal(ui.dates.hidden, true);
  assert.equal(ui.yes.getAttribute("aria-pressed"), "false");
  assert.equal(ui.no.getAttribute("aria-pressed"), "false");

  ui.document.emit("keydown", { target: ui.no, key: " ", preventDefault() {}, stopPropagation() {}, stopped: false });
  assert.equal(ui.student.hidden, true);
  assert.equal(ui.dates.hidden, false);
  assert.equal(ui.document.activeElement, ui.datesHeading);
  assert.equal(ui.datesHeading.getAttribute("tabindex"), "-1");
  assert.match(ui.status.textContent, /Select dates/);
  assert.equal(ui.no.getAttribute("aria-pressed"), "true");
  assert.equal(ui.no.classList.contains("is-on"), true);
  assert.equal(ui.yes.getAttribute("aria-pressed"), "false");
  assert.equal(ui.footer.hidden, false);
  assert.equal(ui.studentFoot.hidden, true);

  ui.options.textContent = "untouched";
  const ghost = el("button", { "data-action": "focus-date", "data-date": "2026-11-02" });
  ui.sheet.appendChild(ghost);
  ghost.click();
  assert.equal(ui.options.textContent, "untouched");
  assert.equal(ui.dates.hidden, false);

  await new Promise((resolve) => setTimeout(resolve, 520));
  ui.back.click();
  assert.equal(ui.student.hidden, false);
  assert.equal(ui.dates.hidden, true);
  assert.equal(ui.no.getAttribute("aria-pressed"), "true");
  assert.equal(ui.footer.hidden, false);
  assert.equal(ui.studentFoot.hidden, false);

  ui.yes.click();
  assert.equal(ui.dates.hidden, false);
  assert.equal(ui.yes.getAttribute("aria-pressed"), "true");
  assert.equal(ui.no.getAttribute("aria-pressed"), "false");
  ui.yes.click();
  assert.equal(ui.dates.hidden, false);
  assert.equal(ui.student.hidden, true);
  assert.equal(ui.document.getElementById("bk-step-confirm"), null);
});
