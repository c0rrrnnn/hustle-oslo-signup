/**
 * Hustle Oslo — Google Apps Script backend for class/social signups
 *
 * Setup (Claire):
 * 1. Create a Google Sheet (e.g. "Hustle Oslo Signups").
 * 2. Extensions → Apps Script → paste this file.
 * 3. Project Settings → Script properties → add:
 *      SHEET_ID = <your spreadsheet ID from the URL>
 *      NOTIFY_EMAIL = hustleinoslo@gmail.com   (optional; defaults below)
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 5. Copy the Web App URL into app.js → CONFIG.APPS_SCRIPT_URL
 *
 * Behaviour:
 * - Ensures an "All signups" master tab
 * - Ensures one tab per event (from sheetTabHint / eventDate+type+location)
 * - Appends the signup row to both
 * - Emails hustleinoslo@gmail.com on each signup
 * - Optional GET ?action=lookup&email= for future repeat-attender prefill
 *
 * Payload includes optional experience / howFound, optional phone,
 * and required transactionNumber (Vipps payment proof).
 * Multi-night bookings: the website POSTs one signup object per night
 * (same person + same transactionNumber; per-night amount). No Apps Script
 * redeploy required for multi-select. Optional future: accept { signups: [...] }.
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

    var row = buildRow_(data);
    master.appendRow(row);
    eventSheet.appendRow(row);

    sendNotifyEmail_(data);

    return json_({ ok: true, transactionNumber: data.transactionNumber, tab: tabName });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
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
  ];
}

function sendNotifyEmail_(data) {
  var props = PropertiesService.getScriptProperties();
  var to = props.getProperty("NOTIFY_EMAIL") || DEFAULT_NOTIFY;
  var subject =
    "[Hustle Oslo] Signup — " +
    (data.eventDate || "") +
    " " +
    (data.ticketName || "") +
    " · txn " +
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
    "Vipps transaction #: " + (data.transactionNumber || "—"),
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
