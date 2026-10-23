import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface Mail {
  to?: string;
  subject?: string;
  name?: string;
  replyTo?: string;
  body?: string;
}

function loadScript() {
  const props = new Map<string, string>();
  const emails: Mail[] = [];
  let lockHeld = false;
  let appendsWhileLocked = 0;
  let appendsWhileUnlocked = 0;
  const sheets = new Map<string, { rows: unknown[][] }>();

  function sheet(name: string) {
    let found = sheets.get(name);
    if (!found) {
      found = { rows: [] };
      sheets.set(name, found);
    }
    const current = found;
    return {
      getLastRow: () => current.rows.length,
      getLastColumn: () => current.rows.reduce((max, row) => Math.max(max, row.length), 0),
      appendRow(row: unknown[]) {
        if (lockHeld) appendsWhileLocked += 1;
        else appendsWhileUnlocked += 1;
        current.rows.push(row.slice());
      },
      setFrozenRows() {},
      getRange(row: number, column: number, numRows: number, numCols: number) {
        const range = {
          getValues() {
            const out: unknown[][] = [];
            for (let r = 0; r < numRows; r++) {
              const source = current.rows[row - 1 + r] || [];
              const line: unknown[] = [];
              for (let c = 0; c < numCols; c++) line.push(source[column - 1 + c] ?? "");
              out.push(line);
            }
            return out;
          },
          setValues(values: unknown[][]) {
            for (let r = 0; r < values.length; r++) {
              const index = row - 1 + r;
              if (!current.rows[index]) current.rows[index] = [];
              for (let c = 0; c < values[r].length; c++) current.rows[index][column - 1 + c] = values[r][c];
            }
            return range;
          },
          setFontWeight() {
            return range;
          },
          setWrap() {
            return range;
          },
        };
        return range;
      },
    };
  }

  const sandbox = {
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: (key: string) => (props.has(key) ? props.get(key) : null),
          setProperty: (key: string, value: string) => props.set(key, value),
        };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() {
            lockHeld = true;
          },
          releaseLock() {
            lockHeld = false;
          },
        };
      },
    },
    SpreadsheetApp: {
      openById() {
        return {
          getSheetByName: (name: string) => (sheets.has(name) ? sheet(name) : null),
          insertSheet: (name: string) => sheet(name),
        };
      },
    },
    MailApp: {
      sendEmail(message: Mail) {
        emails.push(message);
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(text: string) {
        return {
          setMimeType() {
            return this;
          },
          getContent: () => text,
        };
      },
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL("../../apps-script/Code.gs", import.meta.url), "utf8"), sandbox, {
    filename: "Code.gs",
  });
  const api = sandbox as unknown as { doPost: (event: { postData: { contents: string } }) => { getContent: () => string } };
  props.set("SHEET_ID", "sheet-id");
  props.set("APPS_SCRIPT_SHARED_SECRET", "shared-secret-value");
  return {
    props,
    emails,
    sheets,
    post(body: Record<string, unknown>) {
      const output = api.doPost({ postData: { contents: JSON.stringify(body) } });
      return JSON.parse(output.getContent()) as Record<string, unknown>;
    },
    counts: () => ({ appendsWhileLocked, appendsWhileUnlocked }),
    setLockFailure(message: string) {
      sandbox.LockService.getScriptLock = () => ({
        waitLock() {
          throw new Error(message);
        },
        releaseLock() {},
      });
    },
  };
}

const NIGHT = {
  eventId: "2026-11-02-class-gymsalen",
  eventDate: "2026-11-02",
  eventType: "class",
  eventLocation: "Gymsalen",
  eventLabel: "Beginner class",
  eventVenue: "Gymsalen",
  eventStart: "18:00",
  eventEnd: "19:00",
  ticketName: "Two class bundle",
  priceTier: "standard",
  amount: 220,
};

function pendingSignup(overrides: Record<string, unknown> = {}) {
  return {
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "46862806",
    transactionNumber: "payment-pending",
    ...NIGHT,
    ...overrides,
  };
}

test("unpaid signups stay open until REQUIRE_SHARED_SECRET, and paid writes always need the secret", () => {
  const script = loadScript();
  const open = script.post(pendingSignup());
  assert.equal(open.ok, true);
  assert.equal(script.emails.length, 1);
  assert.match(String(script.emails[0].subject), /Signup/);

  const paid = script.post(
    pendingSignup({
      transactionNumber: "pi_test_1",
      paymentStatus: "paid",
      paymentProvider: "stripe",
      paymentId: "pi_test_1",
      sendAttendeeConfirmation: true,
    }),
  );
  assert.equal(paid.ok, false);
  assert.equal(paid.error, "Unauthorized");
  assert.equal(script.emails.length, 1);

  const confirmation = script.post({
    confirmationOnly: true,
    sendAttendeeConfirmation: true,
    fullName: "Anyone",
    email: "victim@example.com",
    confirmationTransactionNumber: "payment-pending",
    confirmationNights: [NIGHT],
  });
  assert.equal(confirmation.ok, true);
  assert.equal(confirmation.confirmationSent, true);
  assert.equal(script.emails.filter((mail) => mail.to === "victim@example.com").length, 1);

  script.props.set("REQUIRE_SHARED_SECRET", "true");
  const before = script.emails.length;
  const locked = script.post(pendingSignup({ email: "second@example.com" }));
  assert.equal(locked.ok, false);
  assert.equal(locked.error, "Unauthorized");
  const lockedMail = script.post({
    confirmationOnly: true,
    sendAttendeeConfirmation: true,
    fullName: "Anyone",
    email: "other@example.com",
    confirmationTransactionNumber: "payment-pending",
    confirmationNights: [NIGHT],
  });
  assert.equal(lockedMail.ok, false);
  assert.equal(script.emails.length, before);
  assert.equal(script.counts().appendsWhileUnlocked, 0);
  assert.ok(script.counts().appendsWhileLocked >= 1);
});

test("one paid booking appends one row and sends one confirmation email", () => {
  const script = loadScript();
  const body = pendingSignup({
    transactionNumber: "pi_test_1",
    paymentStatus: "paid",
    paymentProvider: "stripe",
    paymentId: "pi_test_1",
    sendAttendeeConfirmation: true,
    SHARED_SECRET: "shared-secret-value",
    confirmationNights: [NIGHT],
  });
  const first = script.post(body);
  assert.equal(first.ok, true);
  assert.equal(first.confirmationSent, true);
  const attendee = script.emails.filter((mail) => mail.to === "ada@example.com");
  assert.equal(attendee.length, 1);
  assert.equal(attendee[0].name, "Hustle Oslo");
  assert.equal(attendee[0].replyTo, "hustleinoslo@gmail.com");
  assert.match(attendee[0].body || "", /Payment received/);

  const second = script.post(body);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.confirmationSent, true);
  assert.equal(script.emails.filter((mail) => mail.to === "ada@example.com").length, 1);
  const master = script.sheets.get("All signups");
  assert.equal(master?.rows.length, 2);

  const followUp = script.post({
    confirmationOnly: true,
    sendAttendeeConfirmation: true,
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    confirmationTransactionNumber: "pi_test_1",
    paymentStatus: "paid",
    paymentProvider: "stripe",
    paymentId: "pi_test_1",
    confirmationNights: [NIGHT],
    SHARED_SECRET: "shared-secret-value",
  });
  assert.equal(followUp.duplicate, true);
  assert.equal(script.emails.filter((mail) => mail.to === "ada@example.com").length, 1);
  assert.equal(script.counts().appendsWhileUnlocked, 0);
});

test("a paid confirmation email links to the hosted calendar and does not attach a file", () => {
  const script = loadScript();
  const ics = "https://payments.test/ics?order=11111111-1111-4111-8111-111111111111";
  const google = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Hustle%20Oslo&dates=20261102T170000Z/20261102T180000Z";
  const paid = script.post(
    pendingSignup({
      transactionNumber: "pi_test_1",
      paymentStatus: "paid",
      paymentProvider: "stripe",
      paymentId: "pi_test_1",
      sendAttendeeConfirmation: true,
      SHARED_SECRET: "shared-secret-value",
      confirmationNights: [NIGHT],
      calendarIcs: ics,
      calendarNights: [{ summary: "Hustle Oslo – Beginner class", eventDate: "2026-11-02", googleUrl: google, icsUrl: ics + "&eventId=2026-11-02-class-gymsalen" }],
    }),
  );
  assert.equal(paid.ok, true);
  const attendee = script.emails.filter((mail) => mail.to === "ada@example.com")[0];
  assert.match(attendee.body || "", /Add to calendar/);
  assert.match(attendee.body || "", new RegExp(ics.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(attendee.body || "", /calendar\.google\.com\/calendar\/render/);
  assert.equal((attendee.body || "").includes("BEGIN:VCALENDAR"), false);
  assert.equal((attendee as { attachments?: unknown }).attachments, undefined);
  const row = script.sheets.get("All signups")?.rows[1] || [];
  assert.equal(row.join("\n").includes("/ics"), false);

  const unpaid = loadScript();
  unpaid.post(pendingSignup({ sendAttendeeConfirmation: true }));
  const pendingMail = unpaid.emails.find((mail) => mail.to === "ada@example.com");
  assert.equal((pendingMail?.body || "").includes("Add to calendar"), false);
  assert.equal((pendingMail?.body || "").includes("calendar.google.com"), false);
});

test("a lock failure does not append a row", () => {
  const script = loadScript();
  script.setLockFailure("busy");
  const result = script.post(
    pendingSignup({
      transactionNumber: "pi_test_1",
      paymentStatus: "paid",
      paymentProvider: "stripe",
      paymentId: "pi_test_1",
      SHARED_SECRET: "shared-secret-value",
      sendAttendeeConfirmation: true,
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "Busy");
  assert.equal(script.emails.length, 0);
  assert.equal(script.sheets.get("All signups"), undefined);
});
