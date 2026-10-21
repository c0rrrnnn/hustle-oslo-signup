/**
 * Hustle Oslo — signup
 * Intro (landing) → student → dates → confirm → details → checkout → confirmation.
 * Payments go through startPayment() only when CONFIG.PAYMENTS_ENABLED is true.
 * The flag stays false on main: Pay saves the booking to Apps Script with
 * transactionNumber "payment-pending". Card inputs stay visual placeholders
 * and are never submitted. When the flag is on, startPayment talks to the
 * test-mode worker in worker/ (Stripe Payment Element or Vipps). No API keys here.
 */
(function () {
  "use strict";

  const CONFIG = {
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbx4hG1wNzoJaZglMuyZE_dPsyTt5ohRCbp5tukFhWPiQc5binIOaVcskl2GIUz4Fzf7/exec",
    // Leave false on main. Flip locally only after worker/SETUP.md. Do not commit true.
    PAYMENTS_ENABLED: false,
    // Deployed test worker origin, no trailing path. Empty while payments are off.
    PAYMENTS_WORKER_URL: "",
    VIPPS_NUMBER: "48782",
    VIPPS_NAME: "Hustle Oslo",
    TIMEZONE: "Europe/Oslo",
    CLASS_START_HOUR: 18,
    CLASS_START_MINUTE: 0,
    INSTAGRAM: "https://www.instagram.com/hustleoslo/",
    LOCAL_QUEUE_KEY: "hustleOsloSignups",
    TERMS_VERSION: "v1.0",
  };

  const EXPERIENCE_LABELS = {
    new: "New to dancing",
    some: "Some dance experience (solo or partner)",
    "other-styles": "I dance other styles now (salsa, swing, etc.)",
    hustle: "I’ve danced hustle before",
    teach: "I teach dance",
  };
  const REFERRAL_LABELS = {
    event: "At an event",
    poster: "Poster around town",
    friend: "A friend told me",
    instagram: "Instagram",
    "event-apps": "Event apps (Bruce, Meetup, Facebook)",
    google: "Google search",
    tiktok: "TikTok",
    other: "Other",
  };
  const TICKET_LABELS = {
    beginners: "Beginner class",
    intermediate: "Intermediate class",
    bundle: "2 class bundle",
    social: "Social only",
  };
  const METHOD_LABEL = {
    apple: "Apple Pay",
    google: "Google Pay",
    vipps: "Vipps",
    card: "Card",
  };
  const MOBILE_METHODS = ["apple", "google", "vipps", "card"];

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const WEEKDAYS_NARROW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

  const VIEWS = ["student", "dates", "confirm", "details", "checkout", "failed", "done"];
  const PROGRESS = { student: 1, dates: 2, confirm: 2, details: 3, checkout: 4, failed: 4, done: 4 };
  const HEADINGS = {
    student: "bk-student-heading",
    dates: "bk-dates-heading",
    confirm: "bk-confirm-heading",
    details: "bk-details-heading",
    checkout: "bk-checkout-heading",
    failed: "bk-failed-heading",
    done: "bk-done-heading",
  };

  const PAY_FAIL = "Payment didn’t go through. You haven’t been charged. Try again or pick another method.";
  const PAYMENT_SESSION_KEY = "hustleOsloPayment";
  const paymentUi = {
    idempotencyKey: "",
    fingerprint: "",
    prepToken: 0,
    stripe: null,
    elements: null,
    element: null,
    wallets: null,
    walletsReady: false,
    keys: {},
    nightsKey: "",
    orderId: "",
    surface: "",
    complete: false,
    announcedBusy: false,
    js: null,
    timer: null,
    mountChain: null,
  };

  const state = {
    view: "student",
    sheetOpen: false,
    priceTier: null,
    selectedEvents: [],
    selections: [],
    calendarFocusDate: null,
    calendarYear: null,
    calendarMonth: null,
    paymentMethod: "apple",
    paymentPending: true,
    transactionNumber: "",
    termsAcceptedAt: "",
    submitting: false,
    submitted: false,
    submitResult: null,
    opener: null,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const ICON_APPLE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16.7 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-.1 2.9-2.2c.7-1 1.2-2.1 1.5-3.2-4-1.5-3.9-5.6-1.8-7.2zM14.8 6.1c.6-.8 1.1-1.9.9-3-1 .1-2.2.7-2.9 1.5-.6.7-1.2 1.8-1 2.9 1.1.1 2.2-.5 3-1.4z"/></svg>';
  const ICON_GOOGLE = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.4 38.3 44 33 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>';
  const ICON_CARD = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M2 10h20" fill="none" stroke="currentColor" stroke-width="2"></path></svg>';

  function osloNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: CONFIG.TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return {
      y: +get("year"),
      m: +get("month"),
      d: +get("day"),
      h: +get("hour") === 24 ? 0 : +get("hour"),
      min: +get("minute"),
    };
  }

  function isEventPast(ev) {
    const now = osloNow();
    const [ey, em, ed] = ev.date.split("-").map(Number);
    if (now.y !== ey) return now.y > ey;
    if (now.m !== em) return now.m > em;
    if (now.d !== ed) return now.d > ed;
    const startMin = CONFIG.CLASS_START_HOUR * 60 + CONFIG.CLASS_START_MINUTE;
    return now.h * 60 + now.min >= startMin;
  }

  function upcomingEvents() {
    return (window.HUSTLE_EVENTS || []).filter((e) => !isEventPast(e));
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function toDateKey(y, m, d) {
    return y + "-" + pad2(m) + "-" + pad2(d);
  }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function mondayIndex(y, m, d) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return (dow + 6) % 7;
  }

  function eventsByDate(dateKey) {
    return upcomingEvents().filter((e) => e.date === dateKey);
  }

  function eventsOnMonth(y, m) {
    const prefix = y + "-" + pad2(m) + "-";
    return upcomingEvents().filter((e) => e.date.startsWith(prefix));
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function icsEscape(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  }

  function ticketLabel(ticket) {
    if (!ticket) return "";
    return TICKET_LABELS[ticket.id] || ticket.name || "";
  }

  function ticketTime(ev, ticketId) {
    if (!ev) return "";
    if (ev.type === "social") return ev.start + "–" + ev.end;
    if (ticketId === "beginners") return "18:00–19:00";
    if (ticketId === "intermediate") return "19:00–20:00";
    if (ticketId === "bundle") return "18:00–20:00";
    return "20:00–21:00";
  }

  function ticketNote(ticket) {
    if (!ticket || ticket.id === "social") return "";
    if (ticket.id === "bundle") return "Includes beginner, intermediate class and social";
    return "Includes social after class";
  }

  function venueShort(ev) {
    return String((ev && ev.venue) || "Sentralen").split(",")[0].trim();
  }

  function venueParen(ev) {
    return ev.location + " (" + venueShort(ev) + ")";
  }

  function venueDot(ev) {
    return ev.location + " • " + venueShort(ev);
  }

  function formatMonthDay(ev) {
    const parts = ev.date.split("-").map(Number);
    return MONTHS_SHORT[parts[1] - 1] + " " + parts[2];
  }

  function formatCheckoutDate(ev) {
    const parts = ev.date.split("-").map(Number);
    const wd = ev.weekday || WEEKDAYS_SHORT[mondayIndex(parts[0], parts[1], parts[2])];
    return wd + " " + parts[2] + " " + MONTHS_SHORT[parts[1] - 1];
  }

  function activePriceTier() {
    return state.priceTier === "student" ? "student" : "standard";
  }

  function tierForTicket(ticket) {
    if (ticket && ticket.prices && ticket.prices.standard === ticket.prices.student) return "standard";
    return activePriceTier();
  }

  function displayedTicketPrice(ticket) {
    const prices = (ticket && ticket.prices) || {};
    if (activePriceTier() === "student" && typeof prices.student === "number") return prices.student;
    return prices.standard;
  }

  function amountForSelection(sel) {
    if (!sel || !sel.ticket) return 0;
    const prices = sel.ticket.prices || {};
    const tier = sel.priceTier || "standard";
    if (tier === "student" && typeof prices.student === "number") return prices.student;
    return prices.standard;
  }

  function currentAmount() {
    return state.selections.reduce((sum, s) => sum + amountForSelection(s), 0);
  }

  function applyPriceTierToSelections() {
    state.selections.forEach((sel) => {
      sel.priceTier = tierForTicket(sel.ticket);
    });
  }

  function selectionForEvent(eventId) {
    return state.selections.find((s) => s.event.id === eventId) || null;
  }

  function sheetTabName(ev) {
    const kind = ev.type === "class" ? "Class" : "Social";
    return ev.date + " " + kind + " " + ev.location;
  }

  function isDesktop() {
    return window.matchMedia("(min-width: 601px)").matches;
  }

  function wideCheckout() {
    return state.view === "checkout" && isDesktop();
  }

  function orderLine(sel) {
    return (
      '<div class="bk-li"><span>' + escapeHtml(ticketLabel(sel.ticket)) +
      "<small>" + escapeHtml(formatCheckoutDate(sel.event)) + "</small></span><span>" +
      amountForSelection(sel) + " kr</span></div>"
    );
  }

  function placeDetailsForm() {
    const form = $("#bk-details-form");
    const mount = $("#bk-details-mount");
    const step = $("#bk-step-details");
    const block = $("#bk-desk-details");
    if (!form || !mount || !step) return;
    if (wideCheckout()) {
      if (form.parentElement !== mount) mount.appendChild(form);
      if (block) block.hidden = false;
    } else {
      if (form.parentElement !== step) step.appendChild(form);
      if (block) block.hidden = true;
    }
  }

  function placePayActions() {
    const pay = $("#bk-pay");
    const tos = $("#bk-checkout-tos");
    const inline = $("#bk-inline-pay");
    const foot = $("#bk-foot-checkout");
    if (!pay || !tos || !inline || !foot) return;
    if (wideCheckout()) {
      inline.hidden = false;
      if (tos.parentElement !== inline) inline.appendChild(tos);
      if (pay.parentElement !== inline) inline.appendChild(pay);
    } else {
      inline.hidden = true;
      if (pay.parentElement !== foot) foot.appendChild(pay);
      if (tos.parentElement !== foot) foot.appendChild(tos);
    }
  }

  function setErr(key, on) {
    const err = document.getElementById("bk-err-" + key);
    if (err) err.hidden = !on;
    const input = document.getElementById(fieldId(key));
    if (input) input.setAttribute("aria-invalid", on ? "true" : "false");
  }

  function fieldId(key) {
    const map = {
      name: "bk-name",
      email: "bk-email",
      phone: "bk-phone",
      "referral-other": "bk-referral-other",
      "card-number": "bk-card-number",
      "card-expiry": "bk-card-expiry",
      "card-cvc": "bk-card-cvc",
      "card-name": "bk-card-name",
    };
    return map[key] || "";
  }

  function announce(message) {
    const live = $("#bk-alert");
    if (!live) return;
    live.textContent = "";
    if (message) {
      window.setTimeout(() => {
        live.textContent = message;
      }, 30);
    }
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  }

  function isValidPhone(v) {
    const s = String(v).trim();
    if (!s) return true;
    if (!/^[+\d][\d\s()./-]*$/.test(s)) return false;
    const digits = s.replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15;
  }

  function queueLocally(payload) {
    try {
      const raw = sessionStorage.getItem(CONFIG.LOCAL_QUEUE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      list.push(payload);
      sessionStorage.setItem(CONFIG.LOCAL_QUEUE_KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      console.warn("[Hustle Oslo] sessionStorage queue failed", err);
      return false;
    }
  }

  function upcomingDateLabel(ev) {
    const parts = String(ev.date || "").split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
    const month = months[Number(parts[1]) - 1] || "";
    const day = Number(parts[2]);
    return (month + " " + day).trim();
  }

  function upcomingKind(ev) {
    if (ev.type === "class") return "Class + social";
    if (ev.type === "social") return "Social only";
    return ev.label || "Event";
  }

  function renderUpcomingEvents() {
    const host = $("#upcoming-events");
    if (!host) return;
    const empty = $("#upcoming-empty");
    const events = upcomingEvents();
    if (!events.length) {
      host.innerHTML = "";
      host.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    host.hidden = false;
    host.innerHTML = events
      .map((ev) => {
        return (
          '<article class="upcoming-card" role="listitem">' +
          '<p class="upcoming-date">' + escapeHtml(upcomingDateLabel(ev)) + "</p>" +
          '<p class="upcoming-kind">' + escapeHtml(upcomingKind(ev)) + "</p>" +
          "</article>"
        );
      })
      .join("");
  }

  function copyText(text) {
    const fallback = () =>
      new Promise((resolve, reject) => {
        const previous = document.activeElement;
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "0";
        area.style.left = "0";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        try {
          const ok = document.execCommand("copy");
          document.body.removeChild(area);
          if (previous && typeof previous.focus === "function") previous.focus();
          if (ok) resolve();
          else reject(new Error("copy failed"));
        } catch (err) {
          document.body.removeChild(area);
          if (previous && typeof previous.focus === "function") previous.focus();
          reject(err);
        }
      });
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => fallback());
    }
    return fallback();
  }

  function initCopyAddress() {
    const btn = $("#copy-address");
    const status = $("#copy-status");
    if (!btn) return;
    let timer = null;
    btn.addEventListener("click", () => {
      const text =
        btn.getAttribute("data-address") ||
        ($("#venue-address") && $("#venue-address").textContent.trim()) ||
        "";
      copyText(text)
        .then(() => {
          btn.classList.add("is-copied");
          btn.setAttribute("aria-label", "Address copied");
          if (status) status.textContent = "Address copied.";
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            btn.classList.remove("is-copied");
            btn.setAttribute("aria-label", "Copy address");
            if (status) status.textContent = "";
          }, 2000);
        })
        .catch(() => {
          btn.classList.remove("is-copied");
          btn.setAttribute("aria-label", "Copy address");
          if (status) status.textContent = "Could not copy the address. Select it and copy manually.";
        });
    });
  }

  function setInert(on) {
    ["#main", ".site-footer", ".skip-link"].forEach((sel) => {
      const el = $(sel);
      if (el) el.inert = on;
    });
  }

  function stepStatus(view) {
    const n = PROGRESS[view] || 1;
    const names = {
      student: "Are you a student?",
      dates: "Select a date.",
      confirm: "Confirm selection.",
      details: "Your details.",
      checkout: "Checkout.",
      failed: "Checkout.",
      done: "You’re booked.",
    };
    if (view === "failed" || view === "done") return names[view];
    return "Step " + n + " of 4. " + (names[view] || "");
  }

  function go(view, opts) {
    opts = opts || {};
    state.view = view;
    const sheet = $("#book-sheet");
    if (!sheet) return;
    sheet.classList.toggle("is-wide", wideCheckout());
    const headingId = HEADINGS[view];
    if (headingId) sheet.setAttribute("aria-labelledby", headingId);
    VIEWS.forEach((name) => {
      const step = document.getElementById("bk-step-" + name);
      const foot = document.getElementById("bk-foot-" + name);
      if (step) step.hidden = name !== view;
      if (foot) foot.hidden = name !== view;
    });
    const footer = $(".bk-foot", sheet);
    if (footer) footer.hidden = !document.getElementById("bk-foot-" + view);
    const prog = PROGRESS[view] || 1;
    $$("#bk-prog i").forEach((bar, i) => bar.classList.toggle("on", i < prog));
    const status = $("#bk-step-status");
    if (status) status.textContent = stepStatus(view);
    if (view === "dates") {
      if (state.calendarYear == null) initCalendarMonth();
      renderCalendar();
      renderOptions();
    }
    if (view === "confirm") renderConfirm();
    if (view === "checkout") {
      renderCheckout();
      renderPayMethods();
    }
    if (view === "failed") {
      renderFailed();
      renderPayMethods();
    }
    if (view === "done") renderDone();
    updatePayChrome();
    schedulePrepare();
    sheet.scrollTo({ top: 0, behavior: prefersReducedMotion() || opts.instant ? "auto" : "smooth" });
    if (!opts.skipFocus) {
      const heading = document.getElementById(headingId);
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function openSheet() {
    const sheet = $("#book-sheet");
    if (!sheet || state.sheetOpen) return;
    state.sheetOpen = true;
    state.opener = document.activeElement;
    sheet.hidden = false;
    document.body.classList.add("bk-open");
    setInert(true);
    go(state.submitted ? "student" : state.view || "student", { instant: true });
  }

  function closeSheet() {
    if (state.submitting) return;
    const sheet = $("#book-sheet");
    const submitted = state.submitted;
    if (sheet) sheet.hidden = true;
    document.body.classList.remove("bk-open");
    state.sheetOpen = false;
    setInert(false);
    if (submitted) resetBooking();
    const backTo = state.opener && document.contains(state.opener) ? state.opener : $("#btn-start");
    if (backTo && typeof backTo.focus === "function") backTo.focus();
  }

  function resetBooking() {
    state.view = "student";
    state.priceTier = null;
    state.selections = [];
    state.calendarFocusDate = null;
    state.calendarYear = null;
    state.calendarMonth = null;
    state.paymentMethod = "apple";
    state.paymentPending = true;
    state.transactionNumber = "";
    state.termsAcceptedAt = "";
    state.submitting = false;
    state.submitted = false;
    state.submitResult = null;
    const form = $("#bk-details-form");
    if (form) form.reset();
    ["bk-student-yes", "bk-student-no"].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.classList.remove("is-on");
      btn.setAttribute("aria-pressed", "false");
    });
    const repeat = $("#bk-repeat");
    if (repeat) repeat.checked = false;
    syncFirstTimer();
    ["student", "name", "email", "phone", "referral-other", "pay", "card-number", "card-expiry", "card-cvc", "card-name"].forEach((key) => setErr(key, false));
    announce("");
    clearCardFields();
    resetPaymentAttempt();
    const help = $("#bk-phone-help");
    const helpBtn = $("#bk-phone-help-btn");
    if (help) help.hidden = true;
    if (helpBtn) helpBtn.setAttribute("aria-expanded", "false");
    ["bk-experience", "bk-referral"].forEach((id) => {
      const sel = document.getElementById(id);
      if (sel) sel.classList.add("is-empty");
    });
    initCalendarMonth();
  }

  function onBack() {
    if (state.view === "student" || state.view === "done") {
      if (state.view === "done") state.submitted = true;
      closeSheet();
      return;
    }
    if (state.view === "dates") return go("student");
    if (state.view === "confirm") return go("dates");
    if (state.view === "details") return go("confirm");
    if (state.view === "checkout") return go(isDesktop() ? "confirm" : "details");
    if (state.view === "failed") return go("checkout");
  }

  function setTier(tier) {
    state.priceTier = tier === "student" ? "student" : "standard";
    const yes = $("#bk-student-yes");
    const no = $("#bk-student-no");
    if (yes) {
      yes.classList.toggle("is-on", state.priceTier === "student");
      yes.setAttribute("aria-pressed", state.priceTier === "student" ? "true" : "false");
    }
    if (no) {
      no.classList.toggle("is-on", state.priceTier === "standard");
      no.setAttribute("aria-pressed", state.priceTier === "standard" ? "true" : "false");
    }
    setErr("student", false);
    applyPriceTierToSelections();
  }

  // A second tap in this window is the same press landing on the next step.
  let studentAdvancedAt = 0;

  function studentAdvanceLocked() {
    return studentAdvancedAt !== 0 && Date.now() - studentAdvancedAt < 500;
  }

  function chooseStudent(tier) {
    if (studentAdvanceLocked()) return;
    setTier(tier);
    if (state.view !== "student") return;
    studentAdvancedAt = Date.now();
    go("dates");
  }

  function swallowStudentFollowup(e) {
    if (!studentAdvanceLocked() || state.view === "student") return false;
    e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
    return true;
  }

  function onStudentChoiceKey(e) {
    if (state.view !== "student") return false;
    const yes = $("#bk-student-yes");
    const no = $("#bk-student-no");
    const active = document.activeElement;
    if (!yes || !no || (active !== yes && active !== no)) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      (active === yes ? no : yes).focus();
      return true;
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      chooseStudent(active.getAttribute("data-value"));
      return true;
    }
    return false;
  }

  function initCalendarMonth() {
    const events = upcomingEvents();
    const now = osloNow();
    if (events.length) {
      const parts = events[0].date.split("-").map(Number);
      state.calendarYear = parts[0];
      state.calendarMonth = parts[1];
    } else {
      state.calendarYear = now.y;
      state.calendarMonth = now.m;
    }
  }

  function monthBounds() {
    const events = upcomingEvents();
    if (!events.length) {
      const now = osloNow();
      return { minY: now.y, minM: now.m, maxY: now.y, maxM: now.m };
    }
    const first = events[0].date.split("-").map(Number);
    const last = events[events.length - 1].date.split("-").map(Number);
    return { minY: first[0], minM: first[1], maxY: last[0], maxM: last[1] };
  }

  function canPrevMonth() {
    const b = monthBounds();
    return state.calendarYear * 12 + state.calendarMonth > b.minY * 12 + b.minM;
  }

  function canNextMonth() {
    const b = monthBounds();
    return state.calendarYear * 12 + state.calendarMonth < b.maxY * 12 + b.maxM;
  }

  function shiftMonth(delta) {
    let y = state.calendarYear;
    let m = state.calendarMonth + delta;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    while (m > 12) {
      m -= 12;
      y += 1;
    }
    state.calendarYear = y;
    state.calendarMonth = m;
    renderCalendar();
  }

  function updateDatesNext() {
    const btn = $("#bk-dates-next");
    if (btn) btn.disabled = state.selections.length < 1;
  }

  function renderCalendar() {
    const mount = $("#bk-calendar");
    const empty = $("#bk-no-events");
    if (!mount) return;
    const events = upcomingEvents();
    if (!events.length) {
      mount.innerHTML = "";
      if (empty) empty.hidden = false;
      updateDatesNext();
      return;
    }
    if (empty) empty.hidden = true;
    if (state.calendarYear == null) initCalendarMonth();
    const y = state.calendarYear;
    const m = state.calendarMonth;
    const dim = daysInMonth(y, m);
    const startPad = mondayIndex(y, m, 1);
    const byDate = {};
    eventsOnMonth(y, m).forEach((ev) => {
      if (!byDate[ev.date]) byDate[ev.date] = [];
      byDate[ev.date].push(ev);
    });
    let cells = "";
    for (let i = 0; i < startPad; i++) cells += '<span class="bk-day bk-day-empty"></span>';
    for (let d = 1; d <= dim; d++) {
      const key = toDateKey(y, m, d);
      const dayEvents = byDate[key] || [];
      if (!dayEvents.length) {
        cells += '<span class="bk-day bk-day-muted">' + d + "</span>";
        continue;
      }
      const selected = state.selections.some((s) => s.event.date === key);
      const focused = state.calendarFocusDate === key;
      const type = dayEvents.some((ev) => ev.type === "class") ? "class" : "social";
      const kind = type === "class" ? "Class and social" : "Social only";
      const label = d + " " + MONTH_NAMES[m - 1] + " " + y + ", " + kind + (selected ? ", selected" : "");
      cells +=
        '<button type="button" class="bk-day is-event' +
        (selected || focused ? " is-selected" : "") +
        '" data-action="focus-date" data-date="' + key + '" aria-pressed="' + (selected ? "true" : "false") +
        '" aria-label="' + escapeHtml(label) + '"><span class="bk-day-num">' + d +
        '</span><span class="bk-day-dot bk-dot-' + type + '" aria-hidden="true"></span></button>';
    }
    mount.innerHTML =
      '<div class="bk-cal">' +
      '<div class="bk-cal-h">' +
      '<button type="button" class="bk-cal-nav" data-action="cal-prev" aria-label="Previous month"' + (canPrevMonth() ? "" : " disabled") + ">&#8249;</button>" +
      '<h3 class="bk-cal-title" id="bk-month-label">' + MONTH_NAMES[m - 1] + " " + y + "</h3>" +
      '<button type="button" class="bk-cal-nav" data-action="cal-next" aria-label="Next month"' + (canNextMonth() ? "" : " disabled") + ">&#8250;</button>" +
      "</div>" +
      '<div class="bk-cal-grid" role="group" aria-labelledby="bk-month-label">' +
      WEEKDAYS_NARROW.map((w) => '<div class="bk-wd" aria-hidden="true">' + w + "</div>").join("") +
      cells +
      "</div>" +
      '<p class="bk-legend"><span><i class="bk-dot-class" aria-hidden="true"></i> Class &amp; social</span>' +
      '<span><i class="bk-dot-social" aria-hidden="true"></i> Social only</span></p>' +
      "</div>";
    updateDatesNext();
  }

  function renderOptions() {
    const host = $("#bk-options");
    if (!host) return;
    const key = state.calendarFocusDate;
    if (!key) {
      host.innerHTML = "";
      updateDatesNext();
      return;
    }
    const dayEvents = eventsByDate(key);
    if (!dayEvents.length) {
      host.innerHTML = "";
      updateDatesNext();
      return;
    }
    const blocks = dayEvents
      .map((ev) => {
        const tickets = (window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[ev.type]) || [];
        const sel = selectionForEvent(ev.id);
        const options = tickets
          .map((t) => {
            const on = sel && sel.ticket && sel.ticket.id === t.id;
            const id = "ticket-" + ev.id + "-" + t.id;
            const note = ticketNote(t);
            const badge = t.id === "bundle" ? '<span class="bk-badge">Save 15%</span>' : "";
            const detail =
              escapeHtml(ticketTime(ev, t.id) + " • " + venueParen(ev)) +
              (note ? "<br>" + escapeHtml(note) : "");
            return (
              '<label class="bk-opt' + (on ? " is-on" : "") + '">' +
              '<input type="radio" name="ticket-' + escapeHtml(ev.id) + '" id="' + escapeHtml(id) +
              '" data-event-id="' + escapeHtml(ev.id) + '" value="' + escapeHtml(t.id) + '"' + (on ? " checked" : "") + ">" +
              '<span class="bk-rd" aria-hidden="true"></span>' +
              '<span class="bk-opt-main"><span class="bk-opt-name">' + escapeHtml(ticketLabel(t)) + badge + "</span>" +
              "<small>" + detail + "</small></span>" +
              '<span class="bk-opt-price">' + displayedTicketPrice(t) + " kr</span></label>"
            );
          })
          .join("");
        const legend = dayEvents.length > 1
          ? '<p class="bk-dl">' + escapeHtml(formatCheckoutDate(ev)) + "</p>"
          : '<h3 class="visually-hidden">Tickets for ' + escapeHtml(formatCheckoutDate(ev)) + "</h3>";
        return legend + options;
      })
      .join("");
    const n = state.selections.length;
    host.innerHTML =
      '<div class="bk-options">' + blocks +
      (n ? '<p class="bk-count visually-hidden" aria-live="polite">' + n + (n === 1 ? " class selected" : " classes selected") + "</p>" : "") +
      "</div>";
    updateDatesNext();
  }

  function focusDate(dateKey) {
    state.calendarFocusDate = dateKey;
    renderCalendar();
    renderOptions();
    const btn = $('#bk-calendar [data-date="' + dateKey + '"]');
    if (btn) btn.focus();
  }

  function setTicket(eventId, ticketId) {
    const ev = upcomingEvents().find((e) => e.id === eventId);
    const tickets = (ev && window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[ev.type]) || [];
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ev || !ticket) return;
    let sel = selectionForEvent(eventId);
    if (!sel) {
      sel = { event: ev, ticket: ticket, priceTier: tierForTicket(ticket) };
      state.selections.push(sel);
    } else {
      sel.event = ev;
      sel.ticket = ticket;
      sel.priceTier = tierForTicket(ticket);
    }
    state.selections.sort((a, b) => a.event.date.localeCompare(b.event.date) || a.event.id.localeCompare(b.event.id));
    const activeId = document.activeElement && document.activeElement.id;
    renderCalendar();
    renderOptions();
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) el.focus();
    }
  }

  function removeNight(eventId) {
    state.selections = state.selections.filter((s) => s.event.id !== eventId);
    renderConfirm();
  }

  function renderConfirm() {
    const host = $("#bk-confirm-list");
    if (!host) return;
    if (!state.selections.length) {
      host.innerHTML = '<p class="bk-sub">No classes selected.</p>';
    } else {
      host.innerHTML = state.selections
        .map((s) => {
          const when = formatCheckoutDate(s.event);
          const name = ticketLabel(s.ticket);
          return (
            '<article class="bk-item">' +
            '<button type="button" class="bk-item-x" data-action="remove-night" data-event-id="' + escapeHtml(s.event.id) +
            '" aria-label="Remove ' + escapeHtml(name) + " on " + escapeHtml(when) + '">&#10005;</button>' +
            '<p class="bk-item-name">' + escapeHtml(name) + "</p>" +
            '<p class="bk-item-meta">' + escapeHtml(when) + "<br>" + escapeHtml(ticketTime(s.event, s.ticket.id)) +
            "<br>" + escapeHtml(venueDot(s.event)) + "</p>" +
            '<p class="bk-item-price">' + amountForSelection(s) + " kr</p></article>"
          );
        })
        .join("");
    }
    const sub = $("#bk-subtotal");
    if (sub) sub.textContent = currentAmount() + " kr";
    const next = $("#bk-confirm-next");
    if (next) next.disabled = state.selections.length < 1;
  }

  function syncSelectPlaceholder(sel) {
    if (sel) sel.classList.toggle("is-empty", !sel.value);
  }

  function syncOther() {
    const wrap = $("#bk-referral-other-wrap");
    if (!wrap) return;
    const show = !$("#bk-repeat").checked && $("#bk-referral").value === "other";
    wrap.hidden = !show;
    if (!show) setErr("referral-other", false);
  }

  function syncFirstTimer() {
    const repeat = $("#bk-repeat") && $("#bk-repeat").checked;
    const wrap = $("#bk-first-timer");
    if (wrap) {
      wrap.hidden = !!repeat;
      wrap.setAttribute("aria-hidden", repeat ? "true" : "false");
    }
    if (repeat) {
      const other = $("#bk-referral-other-wrap");
      if (other) other.hidden = true;
      setErr("referral-other", false);
    } else {
      syncOther();
    }
  }

  function validateDetails(showErrors) {
    const name = $("#bk-name").value.trim();
    const email = $("#bk-email").value.trim();
    const phone = $("#bk-phone").value.trim();
    const repeat = $("#bk-repeat").checked;
    const referral = repeat ? "" : $("#bk-referral").value;
    const other = $("#bk-referral-other").value.trim();
    const nameOk = name.length >= 2;
    const emailOk = isValidEmail(email);
    const phoneOk = isValidPhone(phone);
    const otherOk = repeat || referral !== "other" || other.length >= 2;
    const ok = nameOk && emailOk && phoneOk && otherOk;
    if (showErrors) {
      setErr("name", !nameOk);
      setErr("email", !emailOk);
      setErr("phone", !phoneOk);
      setErr("referral-other", !otherOk);
      if (!ok) announce("Please fix the highlighted fields before continuing.");
      else announce("");
    } else {
      if (nameOk) setErr("name", false);
      if (emailOk) setErr("email", false);
      if (phoneOk) setErr("phone", false);
      if (otherOk) setErr("referral-other", false);
      if (ok) announce("");
    }
    return ok;
  }

  function methodIcon(id) {
    if (id === "apple") return '<span class="bk-it bk-it-ap" aria-hidden="true">' + ICON_APPLE + "</span>";
    if (id === "google") return '<span class="bk-it bk-it-gp" aria-hidden="true">' + ICON_GOOGLE + "</span>";
    if (id === "vipps") return '<span class="bk-it bk-it-vp" aria-hidden="true">V</span>';
    return '<span class="bk-it bk-it-cd" aria-hidden="true">' + ICON_CARD + "</span>";
  }

  function brandMarks() {
    return '<span class="bk-brands" aria-hidden="true"><span class="bk-brand bk-brand-visa">VISA</span><span class="bk-brand bk-brand-mc"><i></i><i></i></span></span><span class="visually-hidden">Visa and Mastercard</span>';
  }

  function methodChoices() {
    // Wallets are Stripe's own buttons when payments are on. A custom radio
    // cannot open the native sheet, because Pay would have to await the
    // PaymentIntent first and the browser would drop the tap.
    if (paymentsLive()) return ["vipps", "card"];
    return MOBILE_METHODS.slice();
  }

  function normalizeLiveMethod() {
    if (!paymentsLive()) return;
    if (state.paymentMethod === "apple" || state.paymentMethod === "google") state.paymentMethod = "card";
  }

  function renderPayMethods() {
    normalizeLiveMethod();
    const methods = methodChoices();
    const list = $("#bk-pay-list");
    const seg = $("#bk-pay-seg");
    const fail = $("#bk-fail-pay");
    if (list) {
      list.innerHTML = methods.map((id) => payRow(id, "pay-mobile")).join("");
    }
    if (seg) {
      seg.innerHTML = methods.map((id) => paySeg(id, "pay-desktop")).join("");
    }
    if (fail) {
      fail.innerHTML = methods.map((id) => payRow(id, "pay-failed")).join("");
    }
    syncPayPressed();
  }

  function payRow(id, name) {
    const on = state.paymentMethod === id;
    return (
      '<label class="bk-mrow' + (on ? " is-on" : "") + '" data-method="' + id + '">' +
      '<input type="radio" name="' + name + '" value="' + id + '" data-pay="1"' + (on ? " checked" : "") + ">" +
      '<span class="bk-radio" aria-hidden="true"></span>' +
      methodIcon(id) +
      '<span class="bk-pay-name">' + METHOD_LABEL[id] + "</span>" +
      (id === "card" ? brandMarks() : "") +
      "</label>"
    );
  }

  function paySeg(id, name) {
    const on = state.paymentMethod === id;
    return (
      '<label class="bk-seg-btn' + (on ? " is-on" : "") + '" data-method="' + id + '">' +
      '<input type="radio" name="' + name + '" value="' + id + '" data-pay="1"' + (on ? " checked" : "") + ">" +
      methodIcon(id) +
      "<span>" + METHOD_LABEL[id] + "</span></label>"
    );
  }

  function syncPayPressed() {
    $$("[data-method]").forEach((el) => {
      el.classList.toggle("is-on", el.dataset.method === state.paymentMethod);
    });
    $$("input[data-pay]").forEach((input) => {
      input.checked = input.value === state.paymentMethod;
    });
  }

  function setPaymentMethod(method) {
    if (!METHOD_LABEL[method]) return;
    state.paymentMethod = method;
    syncPayPressed();
    setErr("pay", false);
    updatePayChrome();
    schedulePrepare();
  }

  function placeCardFields() {
    const fields = $("#bk-card-fields");
    const slot = state.view === "failed" ? $("#bk-fail-card-slot") : $("#bk-card-slot");
    if (fields && slot && fields.parentElement !== slot) slot.appendChild(fields);
    const show = !paymentsLive() && state.paymentMethod === "card" && (state.view === "checkout" || state.view === "failed");
    if (!fields) return;
    fields.hidden = !show;
    fields.classList.toggle("is-attached", show && !wideCheckout());
  }

  function paymentsLive() {
    return CONFIG.PAYMENTS_ENABLED === true && !!CONFIG.PAYMENTS_WORKER_URL;
  }

  function isStripeMethod(method) {
    return method === "card" || method === "apple" || method === "google";
  }

  function placeWalletHost() {
    const host = $("#bk-wallet-host");
    if (!host) return;
    const onStep = paymentsLive() && (state.view === "checkout" || state.view === "failed");
    const slot = state.view === "failed" ? $("#bk-fail-wallet-slot") : $("#bk-wallet-slot");
    if (onStep && slot && host.parentElement !== slot) {
      const mounted = !!paymentUi.wallets;
      slot.appendChild(host);
      if (mounted) {
        try {
          paymentUi.wallets.unmount();
          paymentUi.wallets.mount("#bk-express-checkout");
        } catch (err) {
          paymentUi.wallets = null;
          paymentUi.walletsReady = false;
        }
      }
    }
    const nightsMatch = paymentUi.nightsKey === nightsKey();
    host.hidden = !(onStep && paymentUi.walletsReady && nightsMatch);
  }

  function placePaymentHost() {
    const host = $("#bk-payment-host");
    if (!host) return;
    const show = paymentsLive() && isStripeMethod(state.paymentMethod) && (state.view === "checkout" || state.view === "failed");
    if (!show) {
      host.hidden = true;
      return;
    }
    const slot = state.view === "failed" ? $("#bk-fail-card-slot") : $("#bk-card-slot");
    if (slot && host.parentElement !== slot) {
      slot.appendChild(host);
      if (paymentUi.element) {
        try {
          paymentUi.element.unmount();
          paymentUi.element.mount("#bk-payment-element");
        } catch (err) {
          paymentUi.element = null;
        }
      }
    }
    host.hidden = false;
  }

  function setPaymentNote(text, isError) {
    const note = $("#bk-payment-note");
    if (!note) return;
    note.textContent = text || "";
    note.hidden = !text;
    note.classList.toggle("is-error", !!isError && !!text);
  }

  function updatePayChrome() {
    normalizeLiveMethod();
    const amt = currentAmount();
    const method = state.paymentMethod || "apple";
    const who = method === "vipps" ? "Vipps" : "Stripe";
    const payText = $("#bk-pay-text");
    if (payText && !state.submitting) payText.textContent = "Pay " + amt + " kr";
    ["bk-order-total", "bk-order-sub", "bk-fail-total", "bk-subtotal"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = amt + " kr";
    });
    const payBtn = $("#bk-pay");
    if (payBtn) {
      const orange = wideCheckout() && method === "vipps";
      payBtn.classList.toggle("bk-btn-vipps", orange);
      payBtn.classList.toggle("bk-btn-primary", !orange);
    }
    const retry = $("#bk-fail-retry-text");
    if (retry && !state.submitting) retry.textContent = "Pay " + amt + " kr";
    const retryBtn = $("#bk-fail-retry");
    if (retryBtn) {
      retryBtn.classList.toggle("bk-btn-vipps", method === "vipps");
      retryBtn.classList.toggle("bk-btn-primary", method !== "vipps");
    }
    const wallet = paymentsLive() && (method === "apple" || method === "google");
    if (payBtn) payBtn.hidden = wallet && !state.submitting;
    if (retryBtn) retryBtn.hidden = wallet && !state.submitting;
    syncPayBusy();
    $$(".bk-trust-by").forEach((el) => {
      el.textContent = who;
    });
    const sheet = $("#book-sheet");
    if (sheet) sheet.classList.toggle("is-wide", wideCheckout());
    placeDetailsForm();
    placePayActions();
    placeCardFields();
    placeWalletHost();
    placePaymentHost();
    syncFootPad();
  }

  // The terms line wraps, so the sticky footer's height is measured rather
  // than hard-coded. --bk-foot-h is the border box, which already includes
  // the footer's own safe-area padding. The content pad adds that inset once
  // more so the last payment row can clear the home indicator.
  function syncFootPad() {
    const sheet = $("#book-sheet");
    const foot = sheet && $(".bk-foot", sheet);
    if (!sheet || !foot) return;
    let height = 0;
    if (typeof foot.getBoundingClientRect === "function") {
      const rect = foot.getBoundingClientRect();
      if (rect && Number.isFinite(rect.height)) height = Math.ceil(rect.height);
    }
    if (sheet.style && typeof sheet.style.setProperty === "function") {
      sheet.style.setProperty("--bk-foot-h", height + "px");
    }
    const payBar = (state.view === "checkout" || state.view === "failed") && !wideCheckout() && !foot.hidden;
    sheet.classList.toggle("is-clear-foot", payBar);
  }

  function watchFootPad() {
    syncFootPad();
    const foot = $(".bk-foot");
    if (foot && typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(function () {
        syncFootPad();
      });
      observer.observe(foot);
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", syncFootPad);
    }
  }

  function syncPayBusy() {
    const on = state.submitting === true;
    $$(".bk-btn-pay").forEach((btn) => {
      btn.setAttribute("aria-busy", on ? "true" : "false");
      const spin = btn.querySelector(".bk-pay-spinner");
      const lock = btn.querySelector(".bk-lock");
      if (spin) spin.hidden = !on;
      if (lock) lock.hidden = on;
      if (on) btn.hidden = false;
    });
    if (on) {
      const payText = $("#bk-pay-text");
      const retryText = $("#bk-fail-retry-text");
      if (payText) payText.textContent = "Paying…";
      if (retryText) retryText.textContent = "Paying…";
    }
    if (on && !paymentUi.announcedBusy) {
      paymentUi.announcedBusy = true;
      const status = $("#bk-step-status");
      if (status) status.textContent = "Paying…";
      announce("Paying…");
    }
    if (!on) paymentUi.announcedBusy = false;
  }

  function logTiming(step, started, extra) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    console.info(JSON.stringify(Object.assign({ msg: "timing", step: step, ms: Math.round(now - started) }, extra || {})));
  }

  function renderCheckout() {
    const lines = $("#bk-order-lines");
    if (lines) {
      lines.innerHTML = state.selections.map(orderLine).join("");
    }
    const who = $("#bk-who");
    if (who) {
      const name = $("#bk-name").value.trim();
      const email = $("#bk-email").value.trim();
      who.innerHTML = escapeHtml(name) + "<small>" + escapeHtml(email) + "</small>";
    }
  }

  function renderFailed() {
    const lines = $("#bk-fail-lines");
    if (lines) {
      lines.innerHTML = state.selections.map(orderLine).join("");
    }
  }

  function cardDigits() {
    return $("#bk-card-number").value.replace(/\D/g, "");
  }

  function cardTouched() {
    return ["bk-card-number", "bk-card-expiry", "bk-card-cvc", "bk-card-name"].some((id) => {
      const el = document.getElementById(id);
      return el && el.value.trim();
    });
  }

  function validExpiry(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length !== 4) return false;
    const month = +digits.slice(0, 2);
    const year = 2000 + +digits.slice(2);
    if (month < 1 || month > 12) return false;
    return new Date(year, month, 1) > new Date();
  }

  function validateCard(showErrors) {
    const numberOk = cardDigits().length >= 13 && cardDigits().length <= 19;
    const expOk = validExpiry($("#bk-card-expiry").value);
    const cvc = $("#bk-card-cvc").value.replace(/\D/g, "");
    const cvcOk = cvc.length >= 3 && cvc.length <= 4;
    const nameOk = $("#bk-card-name").value.trim().length >= 2;
    const ok = numberOk && expOk && cvcOk && nameOk;
    if (showErrors) {
      setErr("card-number", !numberOk);
      setErr("card-expiry", !expOk);
      setErr("card-cvc", !cvcOk);
      setErr("card-name", !nameOk);
      if (!ok) announce("Check the card fields and try again.");
    }
    return ok;
  }

  function clearCardFields() {
    ["bk-card-number", "bk-card-expiry", "bk-card-cvc", "bk-card-name"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    ["card-number", "card-expiry", "card-cvc", "card-name"].forEach((key) => setErr(key, false));
  }

  function formatCardNumber(input) {
    const digits = input.value.replace(/\D/g, "").slice(0, 19);
    const parts = digits.match(/.{1,4}/g) || [];
    input.value = parts.join(" ");
  }

  function formatExpiry(input) {
    const digits = input.value.replace(/\D/g, "").slice(0, 4);
    input.value = digits.length <= 2 ? digits : digits.slice(0, 2) + " / " + digits.slice(2);
  }

  function workerUrl(path) {
    return String(CONFIG.PAYMENTS_WORKER_URL || "").replace(/\/$/, "") + path;
  }

  function resetPaymentAttempt() {
    paymentUi.prepToken += 1;
    paymentUi.idempotencyKey = "";
    paymentUi.fingerprint = "";
    if (paymentUi.timer) {
      window.clearTimeout(paymentUi.timer);
      paymentUi.timer = null;
    }
    unmountStripeElements();
    paymentUi.orderId = "";
    paymentUi.surface = "";
    paymentUi.complete = false;
    paymentUi.keys = {};
    paymentUi.nightsKey = "";
    paymentUi.idempotencyKey = "";
    paymentUi.fingerprint = "";
    setPaymentNote("");
    try {
      sessionStorage.removeItem(PAYMENT_SESSION_KEY);
    } catch (err) {
      /* private mode */
    }
  }

  function unmountStripeElements() {
    [paymentUi.wallets, paymentUi.element].forEach((element) => {
      if (!element) return;
      try {
        element.unmount();
      } catch (err) {
        /* already unmounted */
      }
    });
    paymentUi.wallets = null;
    paymentUi.walletsReady = false;
    paymentUi.element = null;
    paymentUi.elements = null;
    paymentUi.stripe = null;
  }

  function nightsKey() {
    return state.selections
      .map((sel) => sel.event.id + "|" + sel.ticket.id + "|" + (sel.priceTier || "standard"))
      .sort()
      .join(",");
  }

  function idempotencyKeyFor(method) {
    const provider = method === "vipps" ? "vipps" : "stripe";
    const nights = nightsKey();
    if (!paymentUi.keys) paymentUi.keys = {};
    if (paymentUi.nightsKey !== nights) {
      paymentUi.nightsKey = nights;
      paymentUi.keys = {};
      unmountStripeElements();
      paymentUi.orderId = "";
      paymentUi.surface = "";
      paymentUi.complete = false;
    }
    if (!paymentUi.keys[provider]) paymentUi.keys[provider] = crypto.randomUUID();
    paymentUi.fingerprint = provider + "|" + nights;
    paymentUi.idempotencyKey = paymentUi.keys[provider];
    return paymentUi.keys[provider];
  }

  function cancelPrepare() {
    paymentUi.prepToken += 1;
    if (paymentUi.timer) {
      window.clearTimeout(paymentUi.timer);
      paymentUi.timer = null;
    }
  }

  function schedulePrepare() {
    if (!paymentsLive()) return;
    if (state.submitting) return;
    if (state.view !== "checkout" && state.view !== "failed") return;
    if (paymentUi.timer) window.clearTimeout(paymentUi.timer);
    paymentUi.timer = window.setTimeout(function () {
      paymentUi.timer = null;
      prepareStripeElement();
    }, 250);
  }

  async function prepareStripeElement() {
    if (state.submitting) return;
    if (!paymentsLive()) return;
    if (state.view !== "checkout" && state.view !== "failed") return;
    if (!validateDetails(false)) return;
    const token = ++paymentUi.prepToken;
    setPaymentNote("Preparing secure payment…");
    // One Stripe PaymentIntent covers Card, Apple Pay, and Google Pay.
    // It has to exist before a wallet button can be tapped.
    const created = await postCheckout("card");
    if (token !== paymentUi.prepToken) return;
    if (!created.ok || created.status === "paid" || created.status === "reserved") {
      setPaymentNote("");
      return;
    }
    const mounted = await mountStripe(created);
    if (token !== paymentUi.prepToken) return;
    setPaymentNote(mounted.ok ? "" : PAY_FAIL, !mounted.ok);
  }

  async function postCheckout(method) {
    const person = buildPersonFields();
    const body = {
      idempotencyKey: idempotencyKeyFor(method),
      method: method,
      customer: {
        fullName: person.fullName,
        email: person.email,
        phone: person.phone,
      },
      nights: state.selections.map((sel) => ({
        eventId: sel.event.id,
        ticketId: sel.ticket.id,
        priceTier: sel.priceTier,
      })),
      experience: person.experience,
      experienceLabel: person.experienceLabel,
      referral: person.referral,
      referralLabel: person.referralLabel,
      referralOther: person.referralOther,
      howFound: person.howFound,
      howFoundLabel: person.howFoundLabel,
      howFoundOther: person.howFoundOther,
      isRepeat: person.isRepeat,
      termsAccepted: true,
      termsAcceptedAt: state.termsAcceptedAt || new Date().toISOString(),
      termsVersion: CONFIG.TERMS_VERSION,
      returnUrl: window.location.origin + window.location.pathname,
    };
    try {
      const started = typeof performance !== "undefined" ? performance.now() : Date.now();
      const res = await fetch(workerUrl("/checkout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      logTiming("create-intent", started, { ok: res.ok && data.ok !== false, replay: data.replay === true });
      if (!res.ok || data.ok === false) {
        return { ok: false, message: data.message || PAY_FAIL };
      }
      return data;
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
  }

  function loadStripeJs() {
    if (window.Stripe) return Promise.resolve();
    if (paymentUi.js) return paymentUi.js;
    paymentUi.js = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("stripe-js"));
      document.head.appendChild(script);
    });
    return paymentUi.js;
  }

  function publishableKeyOk(key) {
    const value = String(key || "");
    return value.indexOf("pk_test_") === 0 || value.indexOf("pk_live_") === 0;
  }

  function mountStripe(created) {
    const run = () => mountStripeNow(created);
    paymentUi.mountChain = (paymentUi.mountChain || Promise.resolve()).then(run, run);
    return paymentUi.mountChain;
  }

  function sameStripeOrder(created) {
    return paymentUi.orderId === created.orderId && paymentUi.elements && paymentUi.element && paymentUi.wallets;
  }

  async function mountStripeNow(created) {
    if (!created || !created.clientSecret || !publishableKeyOk(created.publishableKey)) {
      return { ok: false, message: PAY_FAIL };
    }
    const generation = paymentUi.prepToken;
    if (sameStripeOrder(created)) {
      placeWalletHost();
      placePaymentHost();
      return { ok: true };
    }
    try {
      await loadStripeJs();
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    if (generation !== paymentUi.prepToken) return { ok: true };
    if (sameStripeOrder(created)) {
      placeWalletHost();
      placePaymentHost();
      return { ok: true };
    }
    placeWalletHost();
    placePaymentHost();
    const cardHost = $("#bk-payment-element");
    const walletHost = $("#bk-express-checkout");
    if (!cardHost || !walletHost || !window.Stripe) return { ok: false, message: PAY_FAIL };
    unmountStripeElements();
    const stripe = window.Stripe(created.publishableKey);
    const elements = stripe.elements({
      clientSecret: created.clientSecret,
      appearance: {
        theme: "night",
        variables: {
          colorPrimary: "#df8026",
          colorBackground: "#1c1c1f",
          colorText: "#f4f4f5",
          borderRadius: "12px",
          fontFamily: "DM Sans, sans-serif",
        },
      },
    });
    const wallets = createWalletElement(elements);
    const element = createCardElement(elements);
    paymentUi.stripe = stripe;
    paymentUi.elements = elements;
    paymentUi.wallets = wallets;
    paymentUi.element = element;
    paymentUi.orderId = created.orderId;
    paymentUi.surface = "stripe";
    wallets.mount("#bk-express-checkout");
    element.mount("#bk-payment-element");
    if (generation !== paymentUi.prepToken) {
      if (paymentUi.wallets === wallets) unmountStripeElements();
      return { ok: true };
    }
    return { ok: true };
  }

  function createCardElement(elements) {
    return elements.create("payment", {
      layout: { type: "tabs", defaultCollapsed: false },
      wallets: { applePay: "never", googlePay: "never", link: "never" },
      defaultValues: {
        billingDetails: {
          name: $("#bk-name").value.trim(),
          email: $("#bk-email").value.trim(),
        },
      },
    });
  }

  function createWalletElement(elements) {
    const element = elements.create("expressCheckout", {
      paymentMethods: {
        applePay: "auto",
        googlePay: "auto",
        link: "never",
        paypal: "never",
        amazonPay: "never",
      },
      buttonHeight: 48,
      buttonTheme: { applePay: "white", googlePay: "white" },
      layout: { maxColumns: 1, maxRows: 2, overflow: "never" },
    });
    element.on("ready", (event) => {
      if (paymentUi.wallets !== element) return;
      const methods = (event && event.availablePaymentMethods) || {};
      paymentUi.walletsReady = !!(methods.applePay || methods.googlePay);
      placeWalletHost();
    });
    element.on("click", (event) => {
      // Synchronous. The PaymentIntent was created before this button existed.
      if (event && typeof event.resolve === "function") event.resolve();
    });
    element.on("confirm", (event) => {
      if (paymentUi.wallets !== element) return undefined;
      return confirmWalletPayment(event);
    });
    return element;
  }

  function walletPaymentFailed(walletEvent, message) {
    if (!walletEvent || typeof walletEvent.paymentFailed !== "function") return;
    walletEvent.paymentFailed({ reason: "fail", message: message || PAY_FAIL });
  }

  async function confirmWalletPayment(walletEvent) {
    if (state.submitting || !paymentUi.stripe || !paymentUi.elements) {
      walletPaymentFailed(walletEvent, PAY_FAIL);
      return;
    }
    state.submitting = true;
    const pay = $("#bk-pay");
    const retry = $("#bk-fail-retry");
    if (pay) pay.disabled = true;
    if (retry) retry.disabled = true;
    $("#book-sheet").setAttribute("aria-busy", "true");
    updatePayChrome();
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const confirmed = await paymentUi.stripe.confirmPayment({
        elements: paymentUi.elements,
        confirmParams: {
          return_url: window.location.origin + window.location.pathname + "?order=" + encodeURIComponent(paymentUi.orderId),
        },
        redirect: "if_required",
      });
      logTiming("stripe-confirm", started, { surface: paymentUi.surface });
      const result = await resolveConfirmed(paymentUi.orderId, confirmed, started);
      if (result && result.redirecting) return;
      if (!result || result.ok !== true) {
        walletPaymentFailed(walletEvent, result && result.message);
        showPaymentFailed(result && result.message);
        return;
      }
      state.transactionNumber = result.transactionNumber || "";
      state.paymentPending = false;
      showConfirmation(result.booking || { ok: true, confirmationSent: false, paidByWorker: true });
    } catch (err) {
      console.error(err);
      walletPaymentFailed(walletEvent, PAY_FAIL);
      showPaymentFailed(PAY_FAIL);
    } finally {
      state.submitting = false;
      if (pay) pay.disabled = false;
      if (retry) retry.disabled = false;
      $("#book-sheet").setAttribute("aria-busy", "false");
      updatePayChrome();
    }
  }

  function resultFromOrder(data, confirmOutcome) {
    const result = window.HustlePaymentStatus.checkoutResult(data, confirmOutcome || null);
    if (result.ok) return result;
    if (result.reason === "missing") {
      return {
        ok: false,
        message: "We couldn’t find that payment. If money left your account, don’t pay again. Email hustleinoslo@gmail.com.",
      };
    }
    return { ok: false, message: PAY_FAIL };
  }

  async function pollOrder(orderId, options) {
    const stripeSucceeded = !!(options && options.stripeSucceeded);
    const deadline = Date.now() + window.HustlePaymentStatus.confirmWaitMs(stripeSucceeded);
    let last = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(workerUrl("/order/" + encodeURIComponent(orderId)));
        last = await res.json().catch(() => ({}));
        if (res.status === 404 || (last && last.error === "not-found")) {
          return { status: "unknown", error: "not-found" };
        }
      } catch (err) {
        last = last || { status: "pending" };
      }
      if (window.HustlePaymentStatus.pollSettled(last)) return last;
      const wait = window.HustlePaymentStatus.pollDelayMs(attempt);
      attempt += 1;
      if (Date.now() + wait >= deadline) break;
      await new Promise((resolve) => window.setTimeout(resolve, wait));
    }
    return last;
  }

  async function resolveConfirmed(orderId, confirmed, started) {
    const decision = window.HustlePaymentStatus.stripeConfirmOutcome(confirmed);
    if (decision.kind === "failed") {
      return { ok: false, message: decision.message || PAY_FAIL };
    }
    const pollStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    const polled = await pollOrder(orderId, { stripeSucceeded: decision.succeeded === true });
    logTiming("order-poll", pollStarted, {
      orderId: orderId,
      status: polled && polled.status,
      stripeSucceeded: decision.succeeded === true,
    });
    const result = resultFromOrder(polled, decision);
    logTiming("success-resolve", started, { orderId: orderId, ok: !!(result && result.ok) });
    return result;
  }

  function savePaymentSession(orderId) {
    const snapshot = {
      orderId: orderId,
      priceTier: state.priceTier,
      paymentMethod: state.paymentMethod,
      termsAcceptedAt: state.termsAcceptedAt,
      customer: {
        fullName: $("#bk-name") ? $("#bk-name").value.trim() : "",
        email: $("#bk-email") ? $("#bk-email").value.trim() : "",
        phone: $("#bk-phone") ? $("#bk-phone").value.trim() : "",
      },
      nights: state.selections.map((sel) => ({
        eventId: sel.event.id,
        ticketId: sel.ticket.id,
        priceTier: sel.priceTier,
      })),
    };
    try {
      sessionStorage.setItem(PAYMENT_SESSION_KEY, JSON.stringify(snapshot));
    } catch (err) {
      /* private mode */
    }
  }

  function selectionFromIds(eventId, ticketId, priceTier) {
    const ev = (window.HUSTLE_EVENTS || []).find((item) => item.id === eventId);
    if (!ev) return null;
    const tickets = (window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[ev.type]) || [];
    const ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket) return null;
    return { event: ev, ticket: ticket, priceTier: priceTier || "standard" };
  }

  function restorePaymentSession(orderId) {
    let snapshot = null;
    try {
      snapshot = JSON.parse(sessionStorage.getItem(PAYMENT_SESSION_KEY) || "null");
    } catch (err) {
      snapshot = null;
    }
    if (!snapshot || snapshot.orderId !== orderId) {
      state.view = "checkout";
      return;
    }
    state.priceTier = snapshot.priceTier === "student" ? "student" : "standard";
    state.paymentMethod = METHOD_LABEL[snapshot.paymentMethod] ? snapshot.paymentMethod : "card";
    state.termsAcceptedAt = snapshot.termsAcceptedAt || "";
    state.selections = (snapshot.nights || [])
      .map((night) => selectionFromIds(night.eventId, night.ticketId, night.priceTier))
      .filter(Boolean);
    const name = $("#bk-name");
    const email = $("#bk-email");
    const phone = $("#bk-phone");
    if (name) name.value = (snapshot.customer && snapshot.customer.fullName) || "";
    if (email) email.value = (snapshot.customer && snapshot.customer.email) || "";
    if (phone) phone.value = (snapshot.customer && snapshot.customer.phone) || "";
    state.view = state.selections.length ? "checkout" : "student";
  }

  function stripPaymentQuery() {
    const url = new URL(window.location.href);
    ["order", "payment_intent", "payment_intent_client_secret", "redirect_status"].forEach((key) => {
      url.searchParams.delete(key);
    });
    const next = url.pathname + (url.search ? url.search : "") + url.hash;
    window.history.replaceState({}, "", next);
  }

  async function resumePayment(orderId) {
    state.submitting = true;
    const polled = await pollOrder(orderId);
    state.submitting = false;
    stripPaymentQuery();
    const result = resultFromOrder(polled);
    if (result.ok) {
      state.transactionNumber = result.transactionNumber || "";
      state.paymentPending = false;
      showConfirmation(result.booking);
      return;
    }
    showPaymentFailed(result.message);
  }

  function maybeResumePayment() {
    if (!paymentsLive()) return;
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order");
    if (!orderId) return;
    restorePaymentSession(orderId);
    openSheet();
    if (params.get("redirect_status") === "failed") {
      stripPaymentQuery();
      showPaymentFailed(PAY_FAIL);
      return;
    }
    resumePayment(orderId);
  }

  /**
   * The only function that charges a card or starts Vipps.
   * Called only when CONFIG.PAYMENTS_ENABLED is true.
   * Card data stays in the Stripe Payment Element. This file has no API keys.
   * Resolve with { ok: true, transactionNumber, booking } or { ok: false, message }.
   */
  async function startPayment(method, order) {
    if (!CONFIG.PAYMENTS_ENABLED) {
      return { ok: false, reason: "payments-disabled" };
    }
    if (!CONFIG.PAYMENTS_WORKER_URL) {
      return { ok: false, reason: "not-configured", message: PAY_FAIL };
    }
    void order;
    if (method === "apple" || method === "google") {
      return {
        ok: false,
        reason: "needs-details",
        message: method === "apple" ? "Use the Apple Pay button." : "Use the Google Pay button.",
      };
    }
    cancelPrepare();
    const created = await postCheckout(method);
    if (!created.ok) return { ok: false, message: created.message || PAY_FAIL };
    if (created.status === "failed" || created.status === "cancelled") return { ok: false, message: PAY_FAIL };
    if (created.status === "paid" || created.status === "reserved") return resultFromOrder(created);
    if (method === "vipps") {
      if (!created.redirectUrl) return { ok: false, message: PAY_FAIL };
      savePaymentSession(created.orderId);
      window.location.assign(created.redirectUrl);
      return { ok: true, redirecting: true };
    }
    const mounted = await mountStripe(created);
    if (!mounted.ok) return { ok: false, message: mounted.message || PAY_FAIL };
    if (!paymentUi.stripe || !paymentUi.elements) return { ok: false, message: PAY_FAIL };
    let submitted;
    const submitStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      submitted = await paymentUi.elements.submit();
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    logTiming("elements-submit", submitStarted, { orderId: created.orderId });
    if (submitted && submitted.error) {
      const message = submitted.error.message || "Enter your payment details, then press Pay again.";
      setPaymentNote(message, true);
      return { ok: false, reason: "needs-details", message: message };
    }
    setPaymentNote("");
    savePaymentSession(created.orderId);
    let confirmed;
    const confirmStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      confirmed = await paymentUi.stripe.confirmPayment({
        elements: paymentUi.elements,
        confirmParams: {
          return_url: window.location.origin + window.location.pathname + "?order=" + encodeURIComponent(created.orderId),
        },
        redirect: "if_required",
      });
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    logTiming("stripe-confirm", confirmStarted, { surface: "card" });
    return resolveConfirmed(created.orderId, confirmed, confirmStarted);
  }

  function buildOrder() {
    return {
      currency: "NOK",
      amount: currentAmount(),
      method: state.paymentMethod,
      customer: {
        fullName: $("#bk-name").value.trim(),
        email: $("#bk-email").value.trim().toLowerCase(),
        phone: $("#bk-phone").value.trim(),
      },
      nights: state.selections.map((s) => ({
        eventId: s.event.id,
        eventDate: s.event.date,
        eventType: s.event.type,
        ticketId: s.ticket.id,
        ticketName: ticketLabel(s.ticket),
        priceTier: s.priceTier,
        amount: amountForSelection(s),
      })),
    };
  }

  function showPaymentFailed(message) {
    resetPaymentAttempt();
    const el = $("#bk-fail-message");
    if (el) {
      el.textContent = message || "Your card was declined. You haven’t been charged. Try again or pick another method.";
    }
    go("failed");
  }

  function buildPersonFields() {
    const repeat = $("#bk-repeat").checked;
    const referral = repeat ? "" : $("#bk-referral").value;
    const experience = repeat ? "" : $("#bk-experience").value;
    const referralOther = referral === "other" ? $("#bk-referral-other").value.trim() : "";
    return {
      timestamp: new Date().toISOString(),
      fullName: $("#bk-name").value.trim(),
      email: $("#bk-email").value.trim().toLowerCase(),
      phone: $("#bk-phone").value.trim(),
      transactionNumber: state.transactionNumber || "payment-pending",
      experience: experience,
      experienceLabel: EXPERIENCE_LABELS[experience] || "",
      howFound: referral,
      howFoundLabel: REFERRAL_LABELS[referral] || "",
      howFoundOther: referralOther,
      referral: referral,
      referralLabel: REFERRAL_LABELS[referral] || "",
      referralOther: referralOther,
      isRepeat: repeat,
      vippsNumber: CONFIG.VIPPS_NUMBER,
      currency: "NOK",
      paymentMethod: state.paymentMethod || "",
      termsAccepted: true,
      termsAcceptedAt: state.termsAcceptedAt || new Date().toISOString(),
      termsVersion: CONFIG.TERMS_VERSION,
    };
  }

  function buildPayloadForSelection(sel, person) {
    return Object.assign({}, person, {
      eventId: sel.event.id,
      eventDate: sel.event.date,
      eventType: sel.event.type,
      eventLocation: sel.event.location,
      eventLabel: sel.event.label,
      eventVenue: sel.event.venue,
      eventStart: sel.event.start,
      eventEnd: sel.event.end,
      sheetTabHint: sheetTabName(sel.event),
      ticketId: sel.ticket.id,
      ticketName: ticketLabel(sel.ticket),
      priceTier: sel.priceTier,
      amount: amountForSelection(sel),
    });
  }

  function confirmationNightFromPayload(payload) {
    return {
      eventId: payload.eventId,
      eventDate: payload.eventDate,
      eventType: payload.eventType,
      eventLocation: payload.eventLocation,
      eventLabel: payload.eventLabel,
      eventVenue: payload.eventVenue,
      eventStart: payload.eventStart,
      eventEnd: payload.eventEnd,
      ticketId: payload.ticketId,
      ticketName: payload.ticketName,
      priceTier: payload.priceTier,
      amount: payload.amount,
    };
  }

  function signupPayloadForQueue(payload) {
    const copy = Object.assign({}, payload);
    delete copy.sendAttendeeConfirmation;
    delete copy.confirmationNights;
    delete copy.confirmationOnly;
    delete copy.confirmationTransactionNumber;
    return copy;
  }

  async function submitSignup(payload) {
    if (!CONFIG.APPS_SCRIPT_URL) {
      const queued = queueLocally(payload);
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, mocked: true, queued: queued };
    }
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function sendSucceededConfirmation(person, nights) {
    if (!nights.length || !CONFIG.APPS_SCRIPT_URL) return;
    const payload = {
      timestamp: person.timestamp,
      fullName: person.fullName,
      email: person.email,
      phone: person.phone,
      sendAttendeeConfirmation: true,
      confirmationOnly: true,
      confirmationNights: nights,
      confirmationTransactionNumber: person.transactionNumber,
      vippsNumber: person.vippsNumber,
    };
    try {
      await submitSignup(payload);
    } catch (err) {
      console.warn("[Hustle Oslo] attendee confirmation email failed", err);
    }
  }

  async function submitAllSignups() {
    const person = buildPersonFields();
    const selections = state.selections.slice();
    const results = [];
    let mocked = false;
    const succeededNights = [];
    for (let i = 0; i < selections.length; i++) {
      const sel = selections[i];
      const isLast = i === selections.length - 1;
      const payload = buildPayloadForSelection(sel, person);
      const night = confirmationNightFromPayload(payload);
      if (isLast) {
        payload.sendAttendeeConfirmation = true;
        payload.confirmationNights = succeededNights.concat([night]);
      }
      try {
        const result = await submitSignup(payload);
        if (result && result.mocked) mocked = true;
        results.push({ ok: true, payload: payload, result: result });
        succeededNights.push(night);
        const confirmationMissed =
          isLast &&
          payload.sendAttendeeConfirmation === true &&
          result &&
          result.confirmationSent === false &&
          !result.mocked;
        if (confirmationMissed) await sendSucceededConfirmation(person, payload.confirmationNights);
      } catch (err) {
        queueLocally(signupPayloadForQueue(payload));
        results.push({ ok: false, payload: payload, error: String(err) });
        if (isLast && succeededNights.length > 0) await sendSucceededConfirmation(person, succeededNights.slice());
      }
    }
    const allOk = results.every((r) => r.ok);
    const anyOk = results.some((r) => r.ok);
    const last = results[results.length - 1];
    const confirmationSent = !!(last && last.result && last.result.confirmationSent === true);
    return {
      ok: allOk,
      partial: anyOk && !allOk,
      mocked: mocked,
      confirmationSent: confirmationSent,
      results: results,
    };
  }

  function timeParts(sel) {
    const range = ticketTime(sel.event, sel.ticket.id).split("–");
    return { start: range[0], end: range[1] || range[0] };
  }

  function buildIcs(selections) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const events = selections
      .map((sel) => {
        const times = timeParts(sel);
        const start = sel.event.date.replace(/-/g, "") + "T" + times.start.replace(":", "") + "00";
        const end = sel.event.date.replace(/-/g, "") + "T" + times.end.replace(":", "") + "00";
        return [
          "BEGIN:VEVENT",
          "UID:" + sel.event.id + "-" + sel.ticket.id + "@hustleoslo.com",
          "DTSTAMP:" + stamp,
          "DTSTART;TZID=Europe/Oslo:" + start,
          "DTEND;TZID=Europe/Oslo:" + end,
          "SUMMARY:" + icsEscape("Hustle Oslo — " + ticketLabel(sel.ticket)),
          "LOCATION:" + icsEscape("Sentralen, Øvre Slottsgate 3, 0157 Oslo"),
          "END:VEVENT",
        ].join("\r\n");
      })
      .join("\r\n");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Hustle Oslo//Signup//EN", "CALSCALE:GREGORIAN", events, "END:VCALENDAR", ""].join("\r\n");
  }

  function downloadIcs(selections, filename) {
    if (!selections.length) return;
    const blob = new Blob([buildIcs(selections)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function renderDone() {
    const result = state.submitResult;
    const amt = currentAmount();
    const email = $("#bk-email").value.trim();
    const heading = $("#bk-done-heading");
    const sub = $("#bk-done-sub");
    const banner = $("#bk-save-banner");
    const mark = $("#bk-done-mark");
    const ok = !!(result && result.ok);
    const mocked = !!(result && result.mocked);
    const partial = !!(result && result.partial);
    const saved = ok || mocked || partial;
    const emailed = !!(result && result.confirmationSent);
    const pendingConfirmation = !!(result && result.pendingConfirmation);
    const step = $("#bk-step-status");
    if (step) {
      if (pendingConfirmation) step.textContent = "We’re confirming your payment.";
      else if (saved) step.textContent = "You’re booked.";
      else step.textContent = "We couldn’t save your booking.";
    }
    if (heading) {
      if (pendingConfirmation) heading.textContent = "We’re confirming your payment";
      else heading.textContent = saved ? "You’re booked!" : "We couldn’t save your booking";
    }
    if (mark) mark.hidden = !saved;
    if (sub) {
      if (emailed) sub.textContent = "Confirmation sent to " + email;
      else if (pendingConfirmation) sub.textContent = "We’re confirming your payment.";
      else if (!state.paymentPending) sub.textContent = "Paid " + amt + " kr";
      else sub.textContent = "";
    }
    if (banner) {
      if (partial) {
        banner.hidden = false;
        banner.innerHTML = "<b>Some nights may not have saved.</b> Screenshot this page and email hustleinoslo@gmail.com so we can confirm you.";
      } else if (!saved) {
        banner.hidden = false;
        if (!state.paymentPending && pendingConfirmation) {
          banner.innerHTML = "<b>Your payment is still confirming.</b> If money left your account, don’t pay again. Email hustleinoslo@gmail.com and include a screenshot of this page.";
        } else if (!state.paymentPending) {
          banner.innerHTML = "<b>Your payment went through, but we couldn’t save the signup.</b> Screenshot this page and email hustleinoslo@gmail.com so we can confirm you.";
        } else {
          banner.innerHTML = "<b>We couldn’t save your signup online.</b> Screenshot this page and email hustleinoslo@gmail.com so we can confirm you.";
        }
      } else if (mocked) {
        banner.hidden = false;
        banner.innerHTML = "<b>Saved in this browser only.</b> The signup sheet isn’t connected yet.";
      } else {
        banner.hidden = true;
        banner.innerHTML = "";
      }
    }
    const list = $("#bk-done-list");
    if (list) {
      list.innerHTML = state.selections
        .map((s) => {
          return (
            '<article class="bk-calcard"><div><p class="bk-calcard-date">' + escapeHtml(ticketLabel(s.ticket)) +
            '</p><p class="bk-calcard-meta">' + escapeHtml(formatCheckoutDate(s.event)) +
            "<br>" + escapeHtml(ticketTime(s.event, s.ticket.id) + " · " + venueDot(s.event).replace(" • ", ", ")) + "</p></div>" +
            '<button type="button" class="bk-textlink" data-action="ics-one" data-event-id="' + escapeHtml(s.event.id) +
            '">+ Calendar</button></article>'
          );
        })
        .join("");
    }
  }

  function showConfirmation(result) {
    state.submitResult = result;
    state.submitted = true;
    clearCardFields();
    go("done");
  }

  async function saveAndConfirm() {
    state.submitting = true;
    const pay = $("#bk-pay");
    const retry = $("#bk-fail-retry");
    if (pay) pay.disabled = true;
    if (retry) retry.disabled = true;
    const payText = $("#bk-pay-text");
    if (payText) payText.textContent = "Saving…";
    $("#book-sheet").setAttribute("aria-busy", "true");
    try {
      const result = await submitAllSignups();
      showConfirmation(result);
    } catch (err) {
      console.error(err);
      const person = buildPersonFields();
      state.selections.forEach((sel) => queueLocally(buildPayloadForSelection(sel, person)));
      showConfirmation({ ok: false, error: String(err) });
    } finally {
      state.submitting = false;
      if (pay) pay.disabled = false;
      if (retry) retry.disabled = false;
      $("#book-sheet").setAttribute("aria-busy", "false");
      updatePayChrome();
    }
  }

  async function onPay() {
    if (state.submitting) return;
    if (!state.selections.length) return;
    if (wideCheckout() && !validateDetails(true)) {
      const first = $("#bk-details-form [aria-invalid='true']");
      if (first) first.focus();
      return;
    }
    if (!state.paymentMethod) {
      setErr("pay", true);
      announce("Choose how you’d like to pay.");
      return;
    }
    setErr("pay", false);
    if (!paymentsLive() && state.paymentMethod === "card" && (CONFIG.PAYMENTS_ENABLED || cardTouched())) {
      if (!validateCard(true)) {
        const first = $("#bk-card-fields [aria-invalid='true']");
        if (first) first.focus();
        return;
      }
    }
    state.termsAcceptedAt = new Date().toISOString();
    const order = buildOrder();
    if (CONFIG.PAYMENTS_ENABLED) {
      state.submitting = true;
      const pay = $("#bk-pay");
      const retry = $("#bk-fail-retry");
      if (pay) pay.disabled = true;
      if (retry) retry.disabled = true;
      $("#book-sheet").setAttribute("aria-busy", "true");
      updatePayChrome();
      const payStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        const result = await startPayment(state.paymentMethod, order);
        if (result && result.redirecting) return;
        if (result && result.reason === "needs-details") {
          announce(result.message || "Enter your payment details, then press Pay again.");
          return;
        }
        if (!result || result.ok !== true) {
          showPaymentFailed(result && result.message);
          return;
        }
        state.transactionNumber = result.transactionNumber || "";
        state.paymentPending = false;
        showConfirmation(result.booking || { ok: true, confirmationSent: false, paidByWorker: true });
        logTiming("success-page", payStarted, { ok: true });
      } catch (err) {
        console.error(err);
        showPaymentFailed(PAY_FAIL);
      } finally {
        state.submitting = false;
        if (pay) pay.disabled = false;
        if (retry) retry.disabled = false;
        $("#book-sheet").setAttribute("aria-busy", "false");
        updatePayChrome();
      }
      return;
    } else {
      state.transactionNumber = "payment-pending";
      state.paymentPending = true;
    }
    await saveAndConfirm();
  }

  function onDetailsSubmit(e) {
    e.preventDefault();
    if (!validateDetails(true)) {
      const first = $("#bk-details-form [aria-invalid='true']");
      if (first) first.focus();
      return;
    }
    if (state.view !== "checkout") go("checkout");
  }

  function visibleFocusable() {
    const sheet = $("#book-sheet");
    if (!sheet) return [];
    return $$("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])", sheet).filter((el) => {
      if (el.closest("[hidden]")) return false;
      return el.getClientRects().length > 0;
    });
  }

  function onKeydown(e) {
    const sheet = $("#book-sheet");
    if (!sheet || sheet.hidden) return;
    if (onStudentChoiceKey(e)) return;
    if (e.key === "Escape") {
      const help = $("#bk-phone-help");
      const helpBtn = $("#bk-phone-help-btn");
      if (help && !help.hidden) {
        help.hidden = true;
        if (helpBtn) {
          helpBtn.setAttribute("aria-expanded", "false");
          helpBtn.focus();
        }
        e.preventDefault();
        return;
      }
      closeSheet();
      e.preventDefault();
      return;
    }
    if (e.key !== "Tab") return;
    const items = visibleFocusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!items.includes(active)) {
      (e.shiftKey ? last : first).focus();
      e.preventDefault();
      return;
    }
    if (e.shiftKey && active === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && active === last) {
      first.focus();
      e.preventDefault();
    }
  }

  function onSheetClick(e) {
    if (swallowStudentFollowup(e)) return;
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl || !$("#book-sheet").contains(actionEl)) return;
    const action = actionEl.dataset.action;
    if (action === "phone-help") {
      e.preventDefault();
      const btn = $("#bk-phone-help-btn");
      const panel = $("#bk-phone-help");
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      panel.hidden = open;
      return;
    }
    if (action === "close") return closeSheet();
    if (action === "back") return onBack();
    if (action === "student") return chooseStudent(actionEl.dataset.value);
    if (action === "cal-prev") {
      if (canPrevMonth()) shiftMonth(-1);
      return;
    }
    if (action === "cal-next") {
      if (canNextMonth()) shiftMonth(1);
      return;
    }
    if (action === "focus-date") return focusDate(actionEl.dataset.date);
    if (action === "dates-next") {
      if (!state.selections.length) return;
      return go("confirm");
    }
    if (action === "remove-night") return removeNight(actionEl.dataset.eventId);
    if (action === "confirm-next") {
      if (!state.selections.length) return;
      return go(isDesktop() ? "checkout" : "details");
    }
    if (action === "edit-order") return go("confirm");
    if (action === "edit-details") return go("details");
    if (action === "pay") return onPay();
    if (action === "fail-back") return go("checkout");
    if (action === "done") return closeSheet();
    if (action === "ics-one") {
      const sel = state.selections.find((s) => s.event.id === actionEl.dataset.eventId);
      if (sel) downloadIcs([sel], "hustle-oslo-" + sel.event.date + ".ics");
      return;
    }
    if (action === "ics-all") return downloadIcs(state.selections, "hustle-oslo.ics");
  }

  function onSheetChange(e) {
    const t = e.target;
    if (t.matches && t.matches("input[data-pay]")) setPaymentMethod(t.value);
    if (t.name && String(t.name).indexOf("ticket-") === 0) setTicket(t.dataset.eventId, t.value);
    if (t.id === "bk-repeat") syncFirstTimer();
    if (t.id === "bk-referral") {
      syncSelectPlaceholder(t);
      syncOther();
    }
    if (t.id === "bk-experience") syncSelectPlaceholder(t);
  }

  function onSheetInput(e) {
    const t = e.target;
    if (t.id === "bk-name" || t.id === "bk-email" || t.id === "bk-phone" || t.id === "bk-referral-other") {
      validateDetails(false);
      schedulePrepare();
    }
    if (t.id === "bk-card-number") formatCardNumber(t);
    if (t.id === "bk-card-expiry") formatExpiry(t);
  }

  async function lookupByEmail(email) {
    if (!CONFIG.APPS_SCRIPT_URL) return { ok: false, reason: "no-url" };
    try {
      const url = CONFIG.APPS_SCRIPT_URL + "?action=lookup&email=" + encodeURIComponent(email);
      const res = await fetch(url, { method: "GET", redirect: "follow" });
      return await res.json();
    } catch (err) {
      return { ok: false, reason: "network", error: String(err) };
    }
  }

  function init() {
    renderUpcomingEvents();
    initCopyAddress();
    initCalendarMonth();
    syncFirstTimer();
    placeCardFields();
    maybeResumePayment();
    const start = $("#btn-start");
    if (start) start.addEventListener("click", openSheet);
    const sheet = $("#book-sheet");
    if (sheet) {
      sheet.addEventListener("pointerdown", swallowStudentFollowup);
      sheet.addEventListener("click", onSheetClick);
      sheet.addEventListener("change", onSheetChange);
      sheet.addEventListener("input", onSheetInput);
    }
    const form = $("#bk-details-form");
    if (form) form.addEventListener("submit", onDetailsSubmit);
    document.addEventListener("keydown", onKeydown);
    watchFootPad();
    const wide = window.matchMedia("(min-width: 601px)");
    if (typeof wide.addEventListener === "function") {
      wide.addEventListener("change", () => {
        if (!state.sheetOpen) return;
        if (isDesktop() && state.view === "details") go("checkout");
        else updatePayChrome();
      });
    }
  }

  window.HustleOsloLookup = lookupByEmail;
  window.HustleOslo = {
    startPayment: startPayment,
    showPaymentFailed: showPaymentFailed,
    buildOrder: buildOrder,
    resultFromOrder: resultFromOrder,
    publishableKeyOk: publishableKeyOk,
    config: CONFIG,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
