/**
 * Hustle Oslo — Google Apps Script backend for class/social signups
 *
 * Setup (Claire):
 * 1. Create a Google Sheet (e.g. "Hustle Oslo Signups").
 * 2. Extensions → Apps Script → paste this file.
 * 3. Project Settings → Script properties → add:
 *      SHEET_ID = <your spreadsheet ID from the URL>
 *      NOTIFY_EMAIL = hustleinoslo@gmail.com   (optional; defaults below)
 *      APPS_SCRIPT_SHARED_SECRET = <same value as the worker secret>
 *      REQUIRE_SHARED_SECRET = true   (ONLY after payments launch — see below)
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 5. Copy the Web App URL into app.js → CONFIG.APPS_SCRIPT_URL
 *
 * Behaviour:
 * - Ensures an "All signups" master tab
 * - Ensures one tab per event (from sheetTabHint / eventDate+type+location)
 * - Appends the signup row to both
 * - Emails hustleinoslo@gmail.com on each signup (organizer notify; one per night)
 * - Emails the attendee once per booking when sendAttendeeConfirmation === true
 * - Optional GET ?action=lookup&email= for future repeat-attender prefill
 *
 * Payload includes optional experience / howFound, optional phone,
 * and transactionNumber. While online card/Vipps checkout is not live,
 * the site sends transactionNumber "payment-pending" and asks the
 * attendee to Vipps the amount to #48782. That path does not send
 * SHARED_SECRET. It stays accepted only while script property
 * REQUIRE_SHARED_SECRET is not "true". A request that claims a completed
 * online payment (paymentStatus "paid", or any paymentProvider / paymentId)
 * is always rejected unless SHARED_SECRET matches. Once payments are the
 * path, set REQUIRE_SHARED_SECRET to true so every write and every
 * confirmationOnly also needs the secret. Do that only after the live
 * site stops posting straight from the browser (PAYMENTS_ENABLED true),
 * or unpaid signups on hustleoslo.com will be rejected. The worker sends
 * the secret only after payment is confirmed. Paid rows record payment
 * provider, payment id, and status paid. The sheet append and the paid
 * dedupe run inside a script lock. A paid confirmation email is sent at
 * most once per payment id.
 * Extra fields (referral, paymentMethod, terms acceptance) are appended
 * after the original columns.
 * Multi-night bookings: the website POSTs one signup object per night
 * (same person + same transactionNumber; per-night amount). The organizer
 * notify stays one email per night. The attendee confirmation is one email
 * per booking: the site sets sendAttendeeConfirmation only on the last
 * night in the batch and attaches confirmationNights for nights saved so
 * far plus that night. If that POST fails, or the row saves but MailApp
 * does not send, the site follows up with confirmationOnly (no sheet row)
 * listing only the nights that succeeded. A failed night is left off.
 * The follow-up omits top-level transactionNumber so an older deployed
 * script rejects it before appending a blank row; this script reads
 * confirmationTransactionNumber.
 *
 * Sender is the account the web app runs as (hustleinoslo@gmail.com,
 * Execute as Me). MailApp uses display name "Hustle Oslo" and replyTo
 * hustleinoslo@gmail.com.
 *
 * After editing this file, deploy a new Web App version (Deploy → Manage
 * deployments → Edit → New version). The existing /exec URL does not pick
 * up attendee confirmation until that version is deployed.
 *
 */
var MASTER_TAB = "All signups";
var DEFAULT_NOTIFY = "hustleinoslo@gmail.com";

var HEADERS = [
  "Timestamp",
  "Full name",
  "Email",
  "Phone",
  "Event date",
  "Event type",
  "Location",
  "Ticket",
  "Price tier",
  "Amount (NOK)",
  "Transaction #",
  "Repeat attender",
  "Experience",
  "How found",
  "How found (other)",
  "Event ID",
  "Vipps #",
  "Referral",
  "Referral (other)",
  "Payment method",
  "Terms accepted",
  "Terms accepted at",
  "Terms version",
  "Payment provider",
  "Payment id",
  "Payment status",
];

function doGet(e) {
  e = e || {};
  var params = e.parameter || {};
  if (params.action === "lookup") {
    return json_({
      ok: true,
      found: false,
      note: "Lookup stub — wire to All signups search when ready.",
      email: params.email || "",
    });
  }
  return json_({
    ok: true,
    service: "Hustle Oslo signup",
    message: "POST JSON signup payloads to this URL.",
  });
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || "{}";
    var data = JSON.parse(raw);
    if (!writeAuthorized_(data)) {
      return json_({ ok: false, error: "Unauthorized" });
    }
    if (!claimsPaid_(data)) {
      data.paymentProvider = "";
      data.paymentId = "";
      data.paymentStatus = isPendingSignup_(data) ? "pending" : "";
    }
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(30000);
    } catch (lockErr) {
      return json_({ ok: false, error: "Busy" });
    }
    try {
      if (data.confirmationOnly === true) {
        return sendAttendeeConfirmationOnly_(data);
      }
      return appendSignup_(data);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function appendSignup_(data) {
  if (!data.email || !data.fullName) {
    return json_({ ok: false, error: "Missing required fields" });
  }
  if (!data.transactionNumber) {
    return json_({ ok: false, error: "Missing Vipps transaction number" });
  }

  var ss = openSpreadsheet_();
  var master = getOrCreateSheet_(ss, MASTER_TAB);
  ensureHeaders_(master);

  var tabName = data.sheetTabHint || buildTabName_(data);
  var eventSheet = getOrCreateSheet_(ss, tabName);
  ensureHeaders_(eventSheet);

  if (claimsPaid_(data) && alreadyRecorded_(master, data.paymentId, data.eventId)) {
    return json_({
      ok: true,
      duplicate: true,
      transactionNumber: data.transactionNumber,
      tab: tabName,
      confirmationSent: ensurePaidConfirmation_(data),
    });
  }

  var row = buildRow_(data);
  master.appendRow(row);
  eventSheet.appendRow(row);

  sendNotifyEmail_(data);

  var response = {
    ok: true,
    transactionNumber: data.transactionNumber,
    tab: tabName,
  };
  if (data.sendAttendeeConfirmation === true) {
    try {
      response.confirmationSent = sendConfirmationEmail_(data) === true;
      if (response.confirmationSent) rememberPaidConfirmation_(data);
    } catch (mailErr) {
      response.confirmationSent = false;
      response.confirmationError = String(mailErr);
    }
  }

  return json_(response);
}

/** Paid claims always need the secret. Every write needs it once REQUIRE_SHARED_SECRET=true. */
function writeAuthorized_(data) {
  if (paymentsPathLocked_() || claimsPaid_(data)) return secretOk_(data.SHARED_SECRET);
  return true;
}

function paymentsPathLocked_() {
  var flag = PropertiesService.getScriptProperties().getProperty("REQUIRE_SHARED_SECRET") || "";
  return String(flag).toLowerCase() === "true";
}

function confirmationMarkerKey_(paymentId) {
  return "confirm:" + String(paymentId || "").slice(0, 120);
}

function paidConfirmationSent_(data) {
  if (!claimsPaid_(data) || !data.paymentId) return false;
  return PropertiesService.getScriptProperties().getProperty(confirmationMarkerKey_(data.paymentId)) === "1";
}

function rememberPaidConfirmation_(data) {
  if (!claimsPaid_(data) || !data.paymentId) return;
  PropertiesService.getScriptProperties().setProperty(confirmationMarkerKey_(data.paymentId), "1");
}

function ensurePaidConfirmation_(data) {
  if (paidConfirmationSent_(data)) return true;
  if (data.sendAttendeeConfirmation !== true) return false;
  try {
    if (sendConfirmationEmail_(data) === true) {
      rememberPaidConfirmation_(data);
      return true;
    }
  } catch (mailErr) {
    return false;
  }
  return false;
}

function openSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SHEET_ID");
  if (!id) {
    throw new Error(
      "Script property SHEET_ID is not set. Add it in Project Settings → Script properties."
    );
  }
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet_(ss, name) {
  // Sheet tab names max 100 chars; sanitize forbidden characters
  var safe = String(name || "Untitled")
    .replace(/[\\/?*\[\]]/g, "-")
    .substring(0, 100);
  var sheet = ss.getSheetByName(safe);
  if (!sheet) {
    sheet = ss.insertSheet(safe);
  }
  return sheet;
}

function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    var header = sheet.getRange(1, 1, 1, HEADERS.length);
    header.setFontWeight("bold");
    header.setWrap(true);
  } else {
    var width = Math.max(sheet.getLastColumn(), 1);
    var current = sheet.getRange(1, 1, 1, width).getValues()[0];
    var match = true;
    var limit = Math.min(current.length, HEADERS.length);
    for (var i = 0; i < limit; i++) {
      if (String(current[i] || "") !== String(HEADERS[i])) {
        match = false;
        break;
      }
    }
    if (match && current.length < HEADERS.length) {
      var extra = HEADERS.slice(current.length);
      sheet.getRange(1, current.length + 1, 1, extra.length).setValues([extra]).setFontWeight("bold");
    }
  }
  // Keep existing + future cells readable on narrow columns
  var lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(1, 1, lastRow, lastCol).setWrap(true);
}

function buildTabName_(data) {
  var kind = data.eventType === "class" ? "Class" : "Social";
  return (
    (data.eventDate || "undated") +
    " " +
    kind +
    " " +
    (data.eventLocation || "")
  ).trim();
}

function buildRow_(data) {
  return [
    data.timestamp || new Date().toISOString(),
    data.fullName || "",
    data.email || "",
    data.phone || "",
    data.eventDate || "",
    data.eventType || "",
    data.eventLocation || "",
    data.ticketName || data.ticketId || "",
    data.priceTier || "",
    data.amount != null ? data.amount : "",
    data.transactionNumber || "",
    data.isRepeat ? "yes" : "no",
    data.experienceLabel || data.experience || "",
    data.howFoundLabel || data.howFound || "",
    data.howFoundOther || "",
    data.eventId || "",
    data.vippsNumber || "48782",
    data.referralLabel || data.referral || "",
    data.referralOther || "",
    data.paymentMethod || "",
    data.termsAccepted ? "yes" : "no",
    data.termsAcceptedAt || "",
    data.termsVersion || "",
    data.paymentProvider || "",
    data.paymentId || "",
    data.paymentStatus || "",
  ];
}

function claimsPaid_(data) {
  var status = String(data.paymentStatus || "").toLowerCase();
  if (status === "paid") return true;
  if (String(data.paymentProvider || "") !== "") return true;
  if (String(data.paymentId || "") !== "") return true;
  return false;
}

function isPendingSignup_(data) {
  var txn = String(data.transactionNumber || data.confirmationTransactionNumber || "");
  return txn === "payment-pending";
}

function secretOk_(provided) {
  var expected =
    PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_SHARED_SECRET") || "";
  var got = String(provided || "");
  if (!expected || !got) return false;
  var length = Math.max(expected.length, got.length);
  var diff = expected.length === got.length ? 0 : 1;
  for (var i = 0; i < length; i++) {
    var left = i < expected.length ? expected.charCodeAt(i) : 0;
    var right = i < got.length ? got.charCodeAt(i) : 0;
    diff |= left ^ right;
  }
  return diff === 0;
}

function alreadyRecorded_(sheet, paymentId, eventId) {
  if (!paymentId || !eventId) return false;
  var last = sheet.getLastRow();
  if (last < 2) return false;
  var width = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
  var payCol = headers.indexOf("Payment id");
  var eventCol = headers.indexOf("Event ID");
  if (payCol < 0 || eventCol < 0) return false;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][payCol] || "") === String(paymentId) && String(values[i][eventCol] || "") === String(eventId)) {
      return true;
    }
  }
  return false;
}

function pendingPayment_(data) {
  if (String(data.paymentStatus || "").toLowerCase() === "paid") return false;
  return isPendingSignup_(data) || String(data.paymentStatus || "") === "pending";
}

function paidPayment_(data) {
  return String(data.paymentStatus || "").toLowerCase() === "paid";
}

function sendNotifyEmail_(data) {
  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty("NOTIFY_EMAIL") || DEFAULT_NOTIFY;
  var subject =
    "[Hustle Oslo] Signup - " +
    (data.eventDate || "") +
    " " +
    (data.ticketName || "") +
    " - txn " +
    (data.transactionNumber || "");
  var body = [
    "New Hustle Oslo signup",
    "",
    "Name: " + (data.fullName || ""),
    "Email: " + (data.email || ""),
    "Phone: " + (data.phone || "—"),
    "Night: " +
      (data.eventDate || "") +
      " · " +
      (data.eventType || "") +
      " · " +
      (data.eventLocation || ""),
    "Ticket: " +
      (data.ticketName || "") +
      " (" +
      (data.priceTier || "") +
      ")",
    "Amount: " + (data.amount != null ? data.amount + " NOK" : ""),
    paidPayment_(data)
      ? "Payment: paid via " + (data.paymentProvider || "—") + " · " + (data.paymentId || "—")
      : pendingPayment_(data)
        ? "Payment: pending — attendee was asked to Vipps Hustle Oslo #48782"
        : "Vipps transaction #: " + (data.transactionNumber || "—"),
    "Payment provider: " + (data.paymentProvider || "—"),
    "Payment id: " + (data.paymentId || "—"),
    "Payment status: " + (data.paymentStatus || (pendingPayment_(data) ? "pending" : "—")),
    "Payment method: " + (data.paymentMethod || "—"),
    "Terms: " +
      (data.termsAccepted ? "accepted " + (data.termsVersion || "") : "no") +
      (data.termsAcceptedAt ? " at " + data.termsAcceptedAt : ""),
    "Repeat attender: " + (data.isRepeat ? "yes" : "no"),
    "Experience: " + (data.experienceLabel || data.experience || "—"),
    "How found: " +
      (data.howFoundLabel || data.howFound || "—") +
      (data.howFoundOther ? " — " + data.howFoundOther : ""),
    "Vipps #: " + (data.vippsNumber || "48782"),
  ].join("\n");

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: body,
  });
}

/**
 * Attendee confirmation. Called only when sendAttendeeConfirmation === true
 * (once per booking). confirmationNights lists every night that saved; if
 * that array is missing, the single signup on this POST is used.
 * Does not write the sheet and does not replace sendNotifyEmail_.
 */
function sendAttendeeConfirmationOnly_(data) {
  if (!data.email || !data.fullName) {
    return json_({ ok: false, error: "Missing required fields" });
  }
  var txn = data.transactionNumber || data.confirmationTransactionNumber || "";
  if (!txn) {
    return json_({ ok: false, error: "Missing Vipps transaction number" });
  }
  if (data.sendAttendeeConfirmation !== true) {
    return json_({ ok: false, error: "Confirmation not requested" });
  }
  data.transactionNumber = txn;
  if (!data.vippsNumber) data.vippsNumber = "48782";
  if (paidConfirmationSent_(data)) {
    return json_({ ok: true, confirmationOnly: true, confirmationSent: true, duplicate: true });
  }
  if (sendConfirmationEmail_(data) !== true) {
    return json_({ ok: false, error: "Nothing to confirm" });
  }
  rememberPaidConfirmation_(data);
  return json_({ ok: true, confirmationOnly: true, confirmationSent: true });
}

function sendConfirmationEmail_(data) {
  if (!data || data.sendAttendeeConfirmation !== true) return false;
  var to = plain_(data.email);
  if (!to) return false;
  var nights = nightsForConfirmation_(data);
  if (!nights.length) return false;

  MailApp.sendEmail({
    to: to,
    subject: confirmationSubject_(),
    body: confirmationBody_(data, nights),
    name: "Hustle Oslo",
    replyTo: DEFAULT_NOTIFY,
  });
  return true;
}

function confirmationSubject_() {
  // MailApp does not RFC-2047-encode subjects. A non-ASCII dash is shown in Gmail as Latin-1 mojibake.
  return "Hustle Oslo - signup received";
}

function confirmationBody_(data, nights) {
  var name = plain_(data.fullName);
  var lines = [];
  lines.push(name ? "Hi " + name + "," : "Hi,");
  lines.push("");
  lines.push(
    nights.length === 1
      ? "Your Hustle Oslo signup is received for the night below."
      : "Your Hustle Oslo signup is received for the nights below."
  );
  lines.push("");

  for (var i = 0; i < nights.length; i++) {
    if (i > 0) lines.push("");
    lines.push(formatConfirmationNight_(nights[i], i, nights.length));
  }

  if (nights.length > 1) {
    var total = sumNightAmounts_(nights);
    if (total != null) {
      lines.push("");
      lines.push("Total: " + total + " NOK");
    }
  }

  lines.push("");
  if (paidPayment_(data)) {
    lines.push("Payment received via " + (plain_(data.paymentProvider) || "card") + ".");
    lines.push("Payment id: " + (plain_(data.paymentId) || plain_(data.transactionNumber) || "—"));
  } else if (pendingPayment_(data)) {
    lines.push(
      "Payment is still pending. Please Vipps the total to Hustle Oslo #" +
        (plain_(data.vippsNumber) || "48782") +
        "."
    );
  } else {
    lines.push("Vipps transaction #: " + (plain_(data.transactionNumber) || "—"));
    lines.push("Vipps number: " + (plain_(data.vippsNumber) || "48782"));
  }
  lines.push("");
  lines.push(
    "Questions? Reply to this email or contact " + DEFAULT_NOTIFY + "."
  );
  lines.push("");
  lines.push("Hustle Oslo");
  return lines.join("\n");
}

function nightsForConfirmation_(data) {
  var list = data.confirmationNights;
  if (Array.isArray(list) && list.length) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i] === "object") out.push(list[i]);
    }
    if (out.length) return out;
  }
  if (data.confirmationOnly === true) return [];
  return [singleNightFromSignup_(data)];
}

function singleNightFromSignup_(data) {
  return {
    eventDate: data.eventDate,
    eventType: data.eventType,
    eventLocation: data.eventLocation,
    eventVenue: data.eventVenue,
    eventLabel: data.eventLabel,
    eventStart: data.eventStart,
    eventEnd: data.eventEnd,
    ticketName: data.ticketName || data.ticketId,
    priceTier: data.priceTier,
    amount: data.amount,
  };
}

function formatConfirmationNight_(night, index, totalCount) {
  var lines = [];
  lines.push(totalCount > 1 ? "Night " + (index + 1) : "Night");
  var date = plain_(night.eventDate);
  if (date) lines.push("Date: " + date);
  var typeLine = confirmationTypeLine_(night);
  if (typeLine) lines.push("Type: " + typeLine);
  var venue = confirmationVenueLine_(night);
  if (venue) lines.push("Venue: " + venue);
  var time = confirmationTimeLine_(night);
  if (time) lines.push("Time: " + time);
  var ticket = plain_(night.ticketName || night.ticketId);
  if (ticket) lines.push("Ticket: " + ticket);
  var tier = plain_(night.priceTier);
  if (tier) lines.push("Price tier: " + tier);
  if (night.amount != null && night.amount !== "") {
    lines.push("Amount: " + night.amount + " NOK");
  }
  return lines.join("\n");
}

function confirmationTypeLine_(night) {
  var label = plain_(night.eventLabel);
  var type = plain_(night.eventType);
  if (label && type) return label + " (" + type + ")";
  return label || type;
}

function confirmationVenueLine_(night) {
  var parts = [];
  var location = plain_(night.eventLocation);
  var venue = plain_(night.eventVenue);
  if (location) parts.push(location);
  if (venue) parts.push(venue);
  return parts.join(", ");
}

function confirmationTimeLine_(night) {
  var start = plain_(night.eventStart);
  var end = plain_(night.eventEnd);
  if (start && end) return start + "–" + end;
  return start || end;
}

function sumNightAmounts_(nights) {
  var total = 0;
  var any = false;
  for (var i = 0; i < nights.length; i++) {
    var n = Number(nights[i].amount);
    if (!isNaN(n)) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

function plain_(value) {
  if (value == null) return "";
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
