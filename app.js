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
    // LIVE: online payments on. Revert this commit to fall back to Vipps #48782 + transaction number.
    PAYMENTS_ENABLED: true,
    // Live worker origin (wrangler.toml [env.production]), no trailing path.
    PAYMENTS_WORKER_URL: "https://hustle-oslo-payments-live.hustleinoslo-564.workers.dev",
    VIPPS_NUMBER: "48782",
    VIPPS_NAME: "Hustle Oslo",
    TIMEZONE: "Europe/Oslo",
    CLASS_START_HOUR: 18,
    CLASS_START_MINUTE: 0,
    INSTAGRAM: "https://www.instagram.com/hustleoslo/",
    LOCAL_QUEUE_KEY: "hustleOsloSignups",
    TERMS_VERSION: "v1.1",
  };

  const EXPERIENCE_LABELS = {
    new: "New to dancing",
    some: "Some dance experience (solo or partner)",
    "other-styles": "I dance other styles (salsa, swing, etc.)",
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
    bundle: "Two class bundle",
    social: "Social only",
  };
  // Booked-screen class lines. Swap these when Claire renames a ticket
  // (for example "Two class bundle", "Social night"). Calendar titles are separate.
  const CLASS_LINE_LABELS = {
    beginners: "Beginner class",
    intermediate: "Intermediate class",
    bundle: "Two class bundle",
    social: "Social only",
    socialNight: "Social night",
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

  const VIEWS = ["student", "dates", "confirm", "details", "checkout", "failed", "waiting", "done"];
  const PROGRESS = { student: 1, dates: 2, confirm: 2, details: 3, checkout: 4, failed: 4, waiting: 4, done: 4 };
  const HEADINGS = {
    student: "bk-student-heading",
    dates: "bk-dates-heading",
    confirm: "bk-confirm-heading",
    details: "bk-details-heading",
    checkout: "bk-checkout-heading",
    failed: "bk-failed-heading",
    waiting: "bk-waiting-heading",
    done: "bk-done-heading",
  };

  const PAY_FAIL = "Payment didn’t go through. You haven’t been charged. Try again or pick another method.";
  const SERVER_FAIL = "Something went wrong on our side. You haven’t been charged. Try again in a moment.";
  const PAYMENT_SESSION_KEY = "hustleOsloPayment";
  // Details typed into the form, kept so a return from Vipps/Stripe (often a new tab) or a
  // trip back to the calendar never empties them. Never holds card data.
  const DETAILS_DRAFT_KEY = "hustleOsloDetails";
  // Saved carts and details live in localStorage (shared by every tab) for this long.
  const SAVED_CART_TTL_MS = 2 * 60 * 60 * 1000;
  const sheetBox = { width: 0, height: 0 };

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
    resumeGen: 0,
    timer: null,
    mountChain: null,
    // Deferred-intent Elements: mounted from GET /config before any order exists.
    config: null,
    cfg: null,
    stripeShared: null,
    stripeKey: "",
    walletElements: null,
    deferred: false,
    mountedKey: "",
    walletsSettled: false,
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
    paymentMethod: "card",
    paidMethodLabel: "",
    paymentPending: true,
    transactionNumber: "",
    termsAcceptedAt: "",
    submitting: false,
    // Set once the buyer has seen checkout in this booking; while it is set and the
    // details are still valid, Confirm selection goes straight back to checkout.
    reachedCheckout: false,
    checkoutFrom: "details",
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

  function classLineName(sel) {
    const ticket = sel && sel.ticket;
    const ev = sel && sel.event;
    if (!ticket) return "";
    if (ev && ev.type === "social") return CLASS_LINE_LABELS.socialNight;
    return CLASS_LINE_LABELS[ticket.id] || ticketLabel(ticket);
  }

  function ticketTime(ev, ticketId) {
    if (!ev) return "";
    if (ev.type === "social") return ev.start + "–" + ev.end;
    if (ticketId === "beginners") return "18:00–19:00";
    if (ticketId === "intermediate") return "19:00–20:00";
    if (ticketId === "bundle") return "18:00–20:00";
    return "20:00–21:00";
  }

  // Chosen nights are always listed soonest first: date, then start time, then
  // Beginners > Intermediate > Bundle > Social on the same night. Every list, the
  // checkout payload and the saved cart read state.selections, so sort it in place.
  const TICKET_ORDER = { beginners: 0, intermediate: 1, bundle: 2, social: 3 };

  function compareSelections(a, b) {
    const ae = (a && a.event) || {}, be = (b && b.event) || {};
    const at = (a && a.ticket && a.ticket.id) || "", bt = (b && b.ticket && b.ticket.id) || "";
    return String(ae.date || "").localeCompare(String(be.date || "")) ||
      ticketTime(ae, at).localeCompare(ticketTime(be, bt)) ||
      String(ae.start || "").localeCompare(String(be.start || "")) ||
      (at in TICKET_ORDER ? TICKET_ORDER[at] : 9) - (bt in TICKET_ORDER ? TICKET_ORDER[bt] : 9) ||
      String(ae.id || "").localeCompare(String(be.id || ""));
  }

  function sortSelections(list) {
    if (Array.isArray(list)) list.sort(compareSelections);
    return list;
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

  function drawerMode() {
    return window.matchMedia("(min-width: 960px)").matches;
  }

  function bookingScroller(sheet) {
    if (drawerMode()) {
      const frame = sheet.querySelector(".bk-frame");
      if (frame) return frame;
    }
    return sheet;
  }

  function orderLine(sel) {
    return (
      '<div class="bk-li"><span>' + escapeHtml(ticketLabel(sel.ticket)) +
      "<small>" + escapeHtml(formatCheckoutDate(sel.event)) + "</small></span><span>" +
      amountForSelection(sel) + " kr</span></div>"
    );
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

  function osloTodayKey() {
    const now = osloNow();
    return now.y + "-" + pad2(now.m) + "-" + pad2(now.d);
  }

  // Landing cards use the Oslo calendar date at page load. A night today stays
  // listed. Signup keeps isEventPast, which closes booking at 18:00 that day.
  function landingUpcomingEvents() {
    const today = osloTodayKey();
    return (window.HUSTLE_EVENTS || []).filter((ev) => {
      const date = String((ev && ev.date) || "");
      return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today;
    });
  }

  function upcomingKind(ev) {
    if (ev.type === "class") return "Class & social";
    if (ev.type === "social") return "Social only";
    return ev.label || "Event";
  }

  function renderUpcomingEvents() {
    const host = $("#upcoming-events");
    if (!host) return;
    const empty = $("#upcoming-empty");
    const events = landingUpcomingEvents();
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
    ["#main", ".landing-nav", ".site-footer", ".skip-link"].forEach((sel) => {
      const el = $(sel);
      if (el) el.inert = on;
    });
  }

  function stepStatus(view) {
    const n = PROGRESS[view] || 1;
    const names = {
      student: "Are you a student?",
      dates: "Select dates.",
      confirm: "Confirm selection.",
      details: "Enter your details.",
      checkout: "Checkout.",
      failed: "Checkout.",
      waiting: "Waiting for payment.",
      done: "You’re registered.",
    };
    if (view === "failed" || view === "done") return names[view];
    return "Step " + n + " of 4. " + (names[view] || "");
  }

  function go(view, opts) {
    opts = opts || {};
    state.view = view;
    const sheet = $("#book-sheet");
    if (!sheet) return;
    sheet.classList.toggle("is-done", view === "done");
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
      state.reachedCheckout = true;
      renderCheckout();
      renderPayMethods();
    }
    if (view === "failed") {
      state.reachedCheckout = true;
      renderFailed();
      renderPayMethods();
    }
    closeGcalList(false);
    if (view === "done") renderDone();
    updatePayChrome();
    schedulePrepare();
    const body = $(".bk-body", sheet);
    if (body) body.scrollTop = 0;
    bookingScroller(sheet).scrollTo({ top: 0, behavior: prefersReducedMotion() || opts.instant ? "auto" : "smooth" });
    revealPayRows();
    syncEnterKeyHints();
    if (!opts.skipFocus) {
      const heading = document.getElementById(headingId);
      if (heading) heading.focus({ preventScroll: true, focusVisible: false });
    }
  }

  function openSheet() {
    const sheet = $("#book-sheet");
    if (!sheet || state.sheetOpen) return;
    if (!state.submitted && !state.selections.length) {
      let orderId = "";
      try {
        orderId = new URLSearchParams(window.location.search).get("order") || "";
      } catch (err) {
        orderId = "";
      }
      restorePendingCart(orderId);
    }
    if (!state.submitted) restoreDetailsDraft();
    state.sheetOpen = true;
    state.opener = document.activeElement;
    lockBackgroundScroll();
    sheet.hidden = false;
    document.body.classList.add("bk-open");
    setInert(true);
    captureSheetBox();
    warmPayments();
    go(state.submitted ? "student" : state.view || "student", { instant: true });
  }

  function closeSheet() {
    clearStudentFeedback();
    closeGcalList(false);
    paymentUi.resumeGen += 1;
    if (state.submitting) return;
    const sheet = $("#book-sheet");
    const submitted = state.submitted;
    if (sheet) sheet.hidden = true;
    document.body.classList.remove("bk-open");
    state.sheetOpen = false;
    releaseSheetBox();
    unlockBackgroundScroll();
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
    state.paymentMethod = "card";
    state.paidMethodLabel = "";
    state.paymentPending = true;
    state.transactionNumber = "";
    state.termsAcceptedAt = "";
    state.submitting = false;
    state.submitted = false;
    state.submitResult = null;
    state.reachedCheckout = false;
    state.checkoutFrom = "details";
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
    clearSavedCart();
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
    if (state.view === "confirm") return go(state.priceTier ? "dates" : "student");
    if (state.view === "details") return go("confirm");
    if (state.view === "checkout") return go(state.checkoutFrom === "confirm" ? "confirm" : "details");
    if (state.view === "failed") return go("checkout");
    if (state.view === "waiting") {
      paymentUi.resumeGen += 1;
      return go(state.selections.length ? "checkout" : "student");
    }
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

  // The tapped answer shows white for this long before the date step opens, so the tap is seen.
  const STUDENT_FEEDBACK_MS = 250;
  let studentFeedbackTimer = 0;

  function clearStudentFeedback() {
    if (studentFeedbackTimer) clearTimeout(studentFeedbackTimer);
    studentFeedbackTimer = 0;
    ["bk-student-yes", "bk-student-no"].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.remove("is-tapped");
    });
  }

  function chooseStudent(tier) {
    // One answer per visit: taps (or Enter/Space) during the white moment or right after the advance are ignored.
    if (studentFeedbackTimer || studentAdvanceLocked()) return;
    setTier(tier);
    if (state.view !== "student") return;
    const btn = document.getElementById(state.priceTier === "student" ? "bk-student-yes" : "bk-student-no");
    if (btn) btn.classList.add("is-tapped");
    studentFeedbackTimer = setTimeout(() => {
      studentFeedbackTimer = 0;
      clearStudentFeedback();
      if (state.view !== "student" || !state.sheetOpen) return;
      studentAdvancedAt = Date.now();
      go("dates");
    }, STUDENT_FEEDBACK_MS);
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
      // The ring marks only the date being viewed. A date with a pick that is
      // not being viewed keeps just the grey fill, so earlier dates do not stay circled.
      cells +=
        '<button type="button" class="bk-day is-event' +
        (focused ? " is-selected" : selected ? " has-pick" : "") +
        '" data-action="focus-date" data-date="' + key + '" aria-pressed="' + (selected ? "true" : "false") + '"' +
        (focused ? ' aria-current="date"' : "") +
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
    if (!btn || typeof btn.focus !== "function") return;
    const sheet = $("#book-sheet");
    const fromTouch = sheet && sheet.classList.contains("bk-touch");
    if (fromTouch) btn.focus({ preventScroll: true, focusVisible: false });
    else btn.focus({ preventScroll: true });
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
    cartChanged();
    const activeId = document.activeElement && document.activeElement.id;
    renderCalendar();
    renderOptions();
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) el.focus();
    }
  }

  // Tapping the offer that is already chosen unselects it. Radios never fire
  // "change" when clicked again, so this runs from the click on the input.
  function clearTicket(eventId) {
    const before = state.selections.length;
    state.selections = state.selections.filter((s) => s.event.id !== eventId);
    if (state.selections.length === before) return;
    cartChanged();
    const activeId = document.activeElement && document.activeElement.id;
    renderCalendar();
    renderOptions();
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function isTicketInput(el) {
    return !!(el && el.matches && el.matches('input[type="radio"][name^="ticket-"]'));
  }

  function onTicketClick(e) {
    const input = e.target;
    if (!isTicketInput(input)) return false;
    const sel = selectionForEvent(input.dataset.eventId);
    if (!sel || !sel.ticket || sel.ticket.id !== input.value) return false;
    e.preventDefault();
    clearTicket(input.dataset.eventId);
    return true;
  }

  function removeNight(eventId) {
    state.selections = state.selections.filter((s) => s.event.id !== eventId);
    cartChanged();
  }

  // One place that runs after any add, change or remove: every total and label is
  // re-read from state.selections, a prepared Stripe/Vipps order for the old cart is
  // dropped (the next checkout gets a new idempotency key and the Worker prices it
  // from the items), and a saved cart is rewritten so a reload can't bring an item back.
  function cartChanged() {
    sortSelections(state.selections);
    resetPaymentAttempt();
    if (state.view === "confirm") renderConfirm();
    if (state.view === "checkout") renderCheckout();
    if (state.view === "failed") renderFailed();
    updatePayChrome();
    if (readSavedCart()) {
      if (state.selections.length) savePaymentSession("", true);
      else clearSavedCart();
    }
  }

  function detailsComplete() {
    const name = $("#bk-name");
    return !!name && validateDetails(false);
  }

  // Where Confirm selection's button leads. Only stops at a step that is still needed.
  function nextAfterConfirm() {
    if (!state.priceTier) return "student";
    if (state.reachedCheckout && detailsComplete()) return "checkout";
    return "details";
  }

  function syncConfirmNext() {
    const next = $("#bk-confirm-next");
    if (!next) return;
    next.disabled = state.selections.length < 1;
    next.textContent = nextAfterConfirm() === "checkout" ? "Continue to Payment" : "Continue";
  }

  function renderConfirm() {
    const host = $("#bk-confirm-list");
    if (!host) return;
    sortSelections(state.selections);
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
    syncConfirmNext();
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

  // Required fields block Next. An optional field that is still empty is skipped.
  // An optional field with a bad value (a partial phone number) still needs attention.
  function formFieldNeedsAttention(field) {
    if (!field) return false;
    if (!field.required && field.empty) return false;
    return field.valid !== true;
  }

  function nextFormFieldIndex(fields, fromIndex) {
    const list = Array.isArray(fields) ? fields : [];
    const start = typeof fromIndex === "number" ? fromIndex : -1;
    for (let step = 1; step < list.length; step += 1) {
      const i = (start + step + list.length) % list.length;
      if (formFieldNeedsAttention(list[i])) return i;
    }
    if (start >= 0 && start < list.length && formFieldNeedsAttention(list[start])) return start;
    return -1;
  }

  function enterKeyHintFor(fields, index, step) {
    const list = Array.isArray(fields) ? fields : [];
    const others = list.some(function (field, i) { return i !== index && formFieldNeedsAttention(field); });
    if (others) return "next";
    return step === "checkout" || step === "failed" ? "done" : "go";
  }

  function describeEntry(el) {
    const id = el && el.id;
    const value = String((el && el.value) || "").trim();
    const empty = value.length === 0;
    if (id === "bk-name") return { required: true, empty: empty, valid: value.length >= 2 };
    if (id === "bk-email") return { required: true, empty: empty, valid: isValidEmail(value) };
    if (id === "bk-phone") return { required: false, empty: empty, valid: isValidPhone(value) };
    if (id === "bk-referral-other") return { required: true, empty: empty, valid: value.length >= 2 };
    if (id === "bk-card-number") {
      const digits = value.replace(/\D/g, "");
      return { required: true, empty: digits.length === 0, valid: digits.length >= 13 && digits.length <= 19 };
    }
    if (id === "bk-card-expiry") return { required: true, empty: empty, valid: validExpiry(value) };
    if (id === "bk-card-cvc") {
      const digits = value.replace(/\D/g, "");
      return { required: true, empty: digits.length === 0, valid: digits.length >= 3 && digits.length <= 4 };
    }
    if (id === "bk-card-name") return { required: true, empty: empty, valid: value.length >= 2 };
    return { required: false, empty: empty, valid: true };
  }

  function entryFields() {
    let root = null;
    if (state.view === "details") root = $("#bk-details-form");
    else if (state.view === "failed") root = $("#bk-step-failed");
    else if (state.view === "checkout") root = $("#bk-step-checkout");
    if (!root) return [];
    return $$("input, select, textarea", root).filter(function (el) {
      if (!el || el.tagName === "TEXTAREA" || el.disabled) return false;
      const type = String(el.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio" || type === "hidden" || type === "button" || type === "submit" || type === "file") return false;
      return !(el.closest && el.closest("[hidden]"));
    });
  }

  function syncEnterKeyHints() {
    const fields = entryFields();
    const described = fields.map(describeEntry);
    fields.forEach(function (el, index) {
      if (el && typeof el.setAttribute === "function") el.setAttribute("enterkeyhint", enterKeyHintFor(described, index, state.view));
    });
  }

  function onFormReturn(e) {
    const t = e.target;
    if (!t || (t.tagName !== "INPUT" && t.tagName !== "SELECT") || t.tagName === "TEXTAREA") return false;
    const type = String(t.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio" || type === "button" || type === "submit" || type === "file" || type === "hidden") return false;
    if (state.view !== "details" && state.view !== "checkout" && state.view !== "failed") return false;
    const fields = entryFields();
    const index = fields.indexOf(t);
    if (index < 0) return false;
    e.preventDefault();
    const next = nextFormFieldIndex(fields.map(describeEntry), index);
    if (next >= 0 && fields[next] && fields[next] !== t) {
      if (typeof fields[next].focus === "function") fields[next].focus({ preventScroll: true });
      scrollFieldIntoView(fields[next]);
      syncEnterKeyHints();
      return true;
    }
    if (next >= 0) {
      scrollFieldIntoView(t);
      if (state.view === "details") validateDetails(true);
      else if (!paymentsLive()) validateCard(true);
      syncEnterKeyHints();
      return true;
    }
    syncEnterKeyHints();
    if (state.view === "details") {
      onDetailsSubmit(e);
      return true;
    }
    onPay();
    return true;
  }

  // Official Vipps mark, from Vipps MobilePay's button library
  // (https://cdn.vippsmobilepay.com/js/button/button.js, "vipps-mini-logo"), on brand orange #FF5B24.
  const ICON_VIPPS =
    '<svg class="bk-vipps-mark" viewBox="0 0 16 14" role="img" aria-label="Vipps" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="#fff" fill-rule="evenodd" clip-rule="evenodd" d="M10.8534 4.59892C11.8702 4.59892 12.7416 3.83825 12.7416 2.74489H12.7419C12.7419 1.65128 11.8702 0.890869 10.8534 0.890869C9.8368 0.890869 8.96564 1.65128 8.96564 2.74489C8.96564 3.83825 9.8368 4.59892 10.8534 4.59892ZM13.3225 7.59445C12.0635 9.21049 10.7323 10.3278 8.38428 10.3279C5.98851 10.3279 4.12419 8.90154 2.6719 6.80984C2.09078 5.9539 1.19517 5.76386 0.541469 6.21552C-0.0635844 6.64349 -0.208475 7.54682 0.347935 8.33143C2.35689 11.3504 5.1405 13.1091 8.38402 13.1091C11.3617 13.1091 13.6856 11.6831 15.5008 9.30582C16.1784 8.42645 16.1542 7.52313 15.5008 7.02383C14.8955 6.54796 13.9999 6.71508 13.3225 7.59445Z"/>' +
    "</svg>";

  function methodIcon(id) {
    if (id === "apple") return '<span class="bk-it bk-it-ap" aria-hidden="true">' + ICON_APPLE + "</span>";
    if (id === "google") return '<span class="bk-it bk-it-gp" aria-hidden="true">' + ICON_GOOGLE + "</span>";
    if (id === "vipps") return '<span class="bk-it bk-it-vp" aria-hidden="true">' + ICON_VIPPS + "</span>";
    return '<span class="bk-it bk-it-cd" aria-hidden="true">' + ICON_CARD + "</span>";
  }

  function methodChoices() {
    // Wallets are Stripe's own buttons when payments are on. A custom radio
    // cannot open the native sheet, because Pay would have to await the
    // PaymentIntent first and the browser would drop the tap.
    if (paymentsLive()) return ["vipps", "card"];
    return MOBILE_METHODS.slice();
  }

  function normalizeLiveMethod() {
    const methods = methodChoices();
    if (methods.indexOf(state.paymentMethod) === -1) {
      state.paymentMethod = methods.indexOf("card") !== -1 ? "card" : methods[0] || "card";
    }
  }

  function renderPayMethods() {
    normalizeLiveMethod();
    const methods = methodChoices();
    const list = $("#bk-pay-list");
    const fail = $("#bk-fail-pay");
    if (list) {
      list.innerHTML = methods.map((id) => payRow(id, "pay-mobile")).join("");
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
      '<span class="bk-pay-name">' + METHOD_LABEL[id] + "</span></label>"
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
    fields.classList.toggle("is-attached", show);
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
    // While Stripe checks the wallet, a 42px placeholder of the button's shape holds the space on
    // devices that will very likely show one, so nothing jumps when the real button fades in.
    const loading = !paymentUi.walletsReady && !paymentUi.walletsSettled && walletLikely();
    host.classList.toggle("is-loading", loading);
    host.hidden = !(onStep && (paymentUi.walletsReady ? nightsMatch : loading));
  }

  function walletLikely(env) {
    // Synchronous guess only (no wallet query): Apple Pay-capable Safari, or a Chromium browser that
    // Google Pay "always" covers. Samsung Internet, Firefox, Edge and Opera are left out.
    const w = env || window;
    const ua = (w.navigator && w.navigator.userAgent) || "";
    try {
      if (w.ApplePaySession && typeof w.ApplePaySession.canMakePayments === "function") {
        return !!w.ApplePaySession.canMakePayments();
      }
    } catch (err) {
      return false;
    }
    if (/iPhone|iPad|iPod/.test(ua)) return false;
    if (/SamsungBrowser|Firefox|FxiOS|Edg|OPR|CriOS/.test(ua)) return false;
    return !!w.PaymentRequest && /Chrome\//.test(ua);
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
    const method = state.paymentMethod || "card";
    const payText = $("#bk-pay-text");
    if (payText && !state.submitting) payText.textContent = "Pay " + amt + " kr";
    ["bk-order-total", "bk-order-sub", "bk-fail-total", "bk-subtotal"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = amt + " kr";
    });
    const payBtn = $("#bk-pay");
    const retryBtn = $("#bk-fail-retry");
    [payBtn, retryBtn].forEach(function (btn) {
      if (!btn) return;
      btn.classList.toggle("bk-btn-vipps", method === "vipps");
      btn.classList.toggle("bk-btn-primary", method !== "vipps");
    });
    const retry = $("#bk-fail-retry-text");
    if (retry && !state.submitting) retry.textContent = "Pay " + amt + " kr";
    const wallet = paymentsLive() && (method === "apple" || method === "google");
    if (payBtn) payBtn.hidden = wallet && !state.submitting;
    if (retryBtn) retryBtn.hidden = wallet && !state.submitting;
    syncPayBusy();
    placeCardFields();
    placeWalletHost();
    placePaymentHost();
    syncCardBox();
    syncFootPad();
  }

  function syncCardBox() {
    [
      ["bk-card-slot", "checkout"],
      ["bk-fail-card-slot", "failed"],
    ].forEach(function (pair) {
      const slot = document.getElementById(pair[0]);
      if (!slot) return;
      const fields = $("#bk-card-fields");
      const host = $("#bk-payment-host");
      const showFields = fields && fields.parentElement === slot && !fields.hidden;
      const showHost = host && host.parentElement === slot && !host.hidden;
      slot.classList.toggle("is-open", state.view === pair[1] && state.paymentMethod === "card" && (showFields || showHost));
    });
  }

  // Clearance under the bottom buttons: 16px from the bottom of the visible
  // viewport, plus the home-indicator inset only when nothing else covers it.
  // With viewport-fit=cover, env(safe-area-inset-bottom) can report the home
  // indicator even while the browser's own bottom toolbar (Chrome on iPhone,
  // Safari with the toolbar showing) already sits between the page and it,
  // which added that inset again on top of the padding. A standalone web app,
  // or a browser whose toolbars are collapsed, leaves less than ~140 CSS px of
  // browser UI on the screen; only then is the inset added.
  function safeAreaInsetBottom(sheet) {
    if (!sheet || typeof document.createElement !== "function" || typeof window.getComputedStyle !== "function") return 0;
    const probe = document.createElement("div");
    probe.className = "bk-safe-probe";
    probe.setAttribute("aria-hidden", "true");
    sheet.appendChild(probe);
    const value = parseFloat(window.getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
    return value;
  }

  function bottomUiCoversInset(viewport) {
    if (viewport.standalone) return false;
    const portrait = viewport.innerHeight >= viewport.innerWidth;
    const screenH = portrait ? Math.max(viewport.screenWidth, viewport.screenHeight) : Math.min(viewport.screenWidth, viewport.screenHeight);
    if (!screenH || !viewport.innerHeight) return false;
    return screenH - viewport.innerHeight >= 140;
  }

  function safeBottomExtra(inset, viewport) {
    if (!(inset > 0)) return 0;
    return bottomUiCoversInset(viewport) ? 0 : Math.round(inset);
  }

  function syncSafeBottom() {
    const sheet = $("#book-sheet");
    if (!sheet || !sheet.style || typeof sheet.style.setProperty !== "function") return;
    const screenInfo = window.screen || {};
    const standalone = (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) || (window.navigator && window.navigator.standalone === true);
    const extra = safeBottomExtra(safeAreaInsetBottom(sheet), {
      standalone: !!standalone,
      innerHeight: window.innerHeight || 0,
      innerWidth: window.innerWidth || 0,
      screenHeight: screenInfo.height || 0,
      screenWidth: screenInfo.width || 0,
    });
    sheet.style.setProperty("--bk-safe-bottom", extra + "px");
  }

  function viewportScale() {
    const vv = window.visualViewport;
    const scale = vv && typeof vv.scale === "number" ? vv.scale : 1;
    return scale || 1;
  }

  // One height, taken when the sheet opens (scale === 1). Pinch-zoom and the
  // keyboard must not resize or move the sheet, so the Next button stays at
  // the bottom of the layout viewport instead of riding up.
  function captureSheetBox() {
    const sheet = $("#book-sheet");
    if (!sheet || !sheet.style || typeof sheet.style.setProperty !== "function") return;
    if (Math.abs(viewportScale() - 1) > 0.01) return;
    const vv = window.visualViewport;
    const height = Math.round((vv && vv.height) || 0);
    const width = Math.round((vv && vv.width) || window.innerWidth || 0);
    if (!height || !width) return;
    sheetBox.width = width;
    sheetBox.height = height;
    sheet.style.setProperty("height", height + "px");
    sheet.style.setProperty("max-height", height + "px");
  }

  function releaseSheetBox() {
    sheetBox.width = 0;
    sheetBox.height = 0;
    const sheet = $("#book-sheet");
    if (!sheet || !sheet.style || typeof sheet.style.removeProperty !== "function") return;
    sheet.style.removeProperty("height");
    sheet.style.removeProperty("max-height");
    sheet.style.removeProperty("top");
  }

  function onSheetViewport() {
    if (!state.sheetOpen) return;
    if (Math.abs(viewportScale() - 1) > 0.01) return;
    const vv = window.visualViewport;
    const width = Math.round((vv && vv.width) || window.innerWidth || 0);
    const active = document.activeElement;
    const tag = active && active.tagName;
    const field = !!(active && active.closest && active.closest("#book-sheet") && (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA"));
    const typing = field && !/^(radio|checkbox|button|submit)$/i.test(active.type || "");
    // A browser toolbar showing or hiding changes the layout height too, so the
    // sheet follows it. The keyboard only shrinks the visual viewport
    // (interactive-widget=resizes-visual), so Next stays behind it.
    const height = Math.round(window.innerHeight || 0);
    const keyboardOpen = !!(vv && vv.height && height - vv.height > 1);
    if (width && sheetBox.width && width !== sheetBox.width) captureSheetBox();
    else if (height && sheetBox.height && Math.abs(height - sheetBox.height) > 1 && !keyboardOpen && !typing) captureSheetBox();
    if (field) scrollFieldIntoView(active);
  }

  function lockBackgroundScroll() {
    const body = document.body;
    if (!body || !body.style || (body.dataset && body.dataset.bkScrollLock === "1")) return;
    const y = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
    if (body.dataset) {
      body.dataset.bkScrollLock = "1";
      body.dataset.bkScrollY = String(y);
    }
    body.style.position = "fixed";
    body.style.top = (-y) + "px";
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
  }

  function unlockBackgroundScroll() {
    const body = document.body;
    if (!body || !body.style || !body.dataset || body.dataset.bkScrollLock !== "1") return;
    const y = Number(body.dataset.bkScrollY || "0") || 0;
    body.dataset.bkScrollLock = "";
    body.style.position = "";
    body.style.top = "";
    body.style.left = "";
    body.style.right = "";
    body.style.width = "";
    if (typeof window.scrollTo === "function") window.scrollTo(0, y);
  }

  // The terms line wraps, so the reserved note and the footer are measured
  // rather than hard-coded. --bk-foot-h is the bar's border box. The checkout
  // body pads by that height plus the safe-area inset so the card fields can
  // scroll fully above the bar, including when the iOS keyboard is open.
  function syncFootPad() {
    const sheet = $("#book-sheet");
    const foot = sheet && $(".bk-foot", sheet);
    if (!sheet || !foot) return;
    syncSafeBottom();
    let height = 0;
    if (typeof foot.getBoundingClientRect === "function") {
      const rect = foot.getBoundingClientRect();
      if (rect && Number.isFinite(rect.height)) height = Math.ceil(rect.height);
    }
    if (sheet.style && typeof sheet.style.setProperty === "function") {
      sheet.style.setProperty("--bk-foot-h", height + "px");
    }
    const payBar = (state.view === "checkout" || state.view === "failed") && !foot.hidden;
    sheet.classList.toggle("is-clear-foot", payBar);
    revealPayRows();
  }

  // On a short phone, or with the keyboard open, the card box can sit under
  // the pay bar. Scroll the focused field, or the last card field, fully above it.
  function revealPayRows() {
    const sheet = $("#book-sheet");
    const body = sheet && $(".bk-body", sheet);
    const foot = sheet && $(".bk-foot", sheet);
    if (!sheet || !body || !foot || !sheet.classList.contains("is-clear-foot") || foot.hidden) return;
    if (typeof foot.getBoundingClientRect !== "function") return;
    const active = document.activeElement;
    const inPay = active && typeof active.closest === "function" && (active.closest("#bk-step-checkout") || active.closest("#bk-step-failed") || active.closest("#bk-card-fields"));
    const fields = $$("#bk-card-slot.is-open input, #bk-card-slot.is-open .bk-payment-host, #bk-fail-card-slot.is-open input, #bk-fail-card-slot.is-open .bk-payment-host").filter(function (el) {
      return el.offsetParent !== null;
    });
    const slots = $$("#bk-card-slot.is-open, #bk-fail-card-slot.is-open").filter(function (slot) {
      return slot.offsetParent !== null;
    });
    const rows = $$("#bk-pay-list .bk-mrow, #bk-fail-pay .bk-mrow").filter(function (row) {
      return row.offsetParent !== null;
    });
    const target = (inPay && typeof active.getBoundingClientRect === "function" && active) || fields[fields.length - 1] || slots[slots.length - 1] || rows[rows.length - 1];
    if (!target || typeof target.getBoundingClientRect !== "function") return;
    const extra = target.getBoundingClientRect().bottom - foot.getBoundingClientRect().top;
    if (extra > 1) body.scrollTop += Math.ceil(extra) + 8;
  }

  function visibleLimit() {
    const vv = window.visualViewport;
    let limit = window.innerHeight || 0;
    if (vv && vv.height) limit = Math.round((vv.offsetTop || 0) + vv.height);
    const foot = $(".bk-foot");
    if (foot && typeof foot.getBoundingClientRect === "function" && !foot.hidden) {
      const top = foot.getBoundingClientRect().top;
      if (top > 0) limit = Math.min(limit, top);
    }
    return limit - 12;
  }

  function scrollFieldIntoView(el) {
    const sheet = $("#book-sheet");
    const body = sheet && $(".bk-body", sheet);
    if (!body || !el || typeof el.getBoundingClientRect !== "function") return;
    const rect = el.getBoundingClientRect();
    const limit = visibleLimit();
    const topBar = sheet && $(".bk-top", sheet);
    const minTop = topBar && typeof topBar.getBoundingClientRect === "function" ? topBar.getBoundingClientRect().bottom + 8 : 8;
    if (rect.bottom > limit) body.scrollTop += Math.ceil(rect.bottom - limit);
    else if (rect.top < minTop) body.scrollTop -= Math.ceil(minTop - rect.top);
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
      window.addEventListener("resize", function () {
        onSheetViewport();
        syncFootPad();
      });
    }
    const vv = window.visualViewport;
    if (vv && typeof vv.addEventListener === "function") {
      vv.addEventListener("resize", onSheetViewport);
    }
    if (typeof document.addEventListener === "function") {
      document.addEventListener("focusin", function (e) {
        const t = e.target;
        const tag = t && t.tagName;
        if (t && t.closest && t.closest("#book-sheet") && (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA")) {
          scrollFieldIntoView(t);
          return;
        }
        revealPayRows();
      });
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
      lines.innerHTML = sortSelections(state.selections).map(orderLine).join("");
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
      lines.innerHTML = sortSelections(state.selections).map(orderLine).join("");
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
    // Drop the idempotency key so Pay again creates a new order. The cart
    // stays in localStorage (2 h) until the payment succeeds.
    paymentUi.prepToken += 1;
    paymentUi.idempotencyKey = "";
    paymentUi.fingerprint = "";
    if (paymentUi.timer) {
      window.clearTimeout(paymentUi.timer);
      paymentUi.timer = null;
    }
    unmountStripeElements();
    paymentUi.orderId = "";
    paymentUi.redirectOrderId = "";
    paymentUi.surface = "";
    paymentUi.complete = false;
    paymentUi.keys = {};
    paymentUi.nightsKey = "";
    paymentUi.idempotencyKey = "";
    paymentUi.fingerprint = "";
    setPaymentNote("");
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
    paymentUi.walletsSettled = false;
    paymentUi.element = null;
    paymentUi.elements = null;
    paymentUi.walletElements = null;
    paymentUi.stripe = null;
    paymentUi.deferred = false;
    paymentUi.mountedKey = "";
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
    const early = state.view === "confirm" || state.view === "details";
    if (!early && state.view !== "checkout" && state.view !== "failed") return;
    if (paymentUi.timer) window.clearTimeout(paymentUi.timer);
    // Deferred mode creates no order, so there's nothing to debounce.
    const wait = paymentUi.cfg ? 0 : 250;
    paymentUi.timer = window.setTimeout(function () {
      paymentUi.timer = null;
      prepareStripeElement();
    }, wait);
  }

  async function prepareStripeElement() {
    if (state.submitting) return;
    if (!paymentsLive()) return;
    const cfg = await loadPaymentConfig();
    if (state.submitting) return;
    if (cfg) {
      // Deferred intent: Elements and the wallet button mount from the cart total alone (already on
      // the confirm/details step), and the PaymentIntent is created only when the person pays.
      if (!state.selections.length) return;
      const mounted = await mountDeferred();
      if (!mounted.ok && (state.view === "checkout" || state.view === "failed")) setPaymentNote(PAY_FAIL, true);
      return;
    }
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
      nights: sortSelections(state.selections).map((sel) => ({
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
        const fallback = res.status >= 500 ? SERVER_FAIL : PAY_FAIL;
        return { ok: false, message: data.message || fallback };
      }
      return data;
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
  }

  // GET /config gives the publishable key without creating an order. An older Worker without it
  // answers 404, and the site falls back to creating the PaymentIntent first (the previous flow).
  function loadPaymentConfig() {
    if (!paymentsLive()) return Promise.resolve(null);
    if (paymentUi.config) return paymentUi.config;
    paymentUi.config = fetch(workerUrl("/config"))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const cfg = data && data.ok && publishableKeyOk(data.publishableKey) ? { publishableKey: data.publishableKey } : null;
        paymentUi.cfg = cfg;
        return cfg;
      })
      .catch(() => {
        paymentUi.config = null; // a network blip retries on the next prepare
        return null;
      });
    return paymentUi.config;
  }

  function preconnectWorker() {
    // index.html preconnects to Stripe; the Worker origin is only known here.
    if (!paymentsLive() || !document.head) return;
    let origin = "";
    try {
      origin = new URL(CONFIG.PAYMENTS_WORKER_URL).origin;
    } catch (err) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }

  function warmPayments() {
    if (!paymentsLive()) return;
    loadPaymentConfig();
    loadStripeJs()
      .then(() => loadPaymentConfig())
      .then((cfg) => {
        if (cfg) sharedStripe(cfg.publishableKey);
      })
      .catch(() => {});
  }

  function sharedStripe(publishableKey) {
    if (!window.Stripe) return null;
    if (!paymentUi.stripeShared || paymentUi.stripeKey !== publishableKey) {
      paymentUi.stripeShared = window.Stripe(publishableKey, { locale: "en" });
      paymentUi.stripeKey = publishableKey;
    }
    return paymentUi.stripeShared;
  }

  function deferredElementsOptions(amountKr) {
    // Must match the PaymentIntent POST /checkout creates: NOK, card only (Apple Pay and Google Pay
    // are card wallets), automatic capture, no setup_future_usage.
    return {
      mode: "payment",
      amount: Math.round(Number(amountKr) * 100),
      currency: "nok",
      paymentMethodTypes: ["card"],
      captureMethod: "automatic",
      locale: "en",
      appearance: STRIPE_APPEARANCE,
    };
  }

  function deferredKey() {
    return nightsKey() + "|" + currentAmount();
  }

  function premountHosts() {
    // Mount straight into the checkout slots (even while that step is still hidden), so arriving on
    // checkout doesn't move the hosts and restart Stripe's iframes.
    if (state.view === "failed") return;
    const wallet = $("#bk-wallet-host");
    const walletSlot = $("#bk-wallet-slot");
    if (wallet && walletSlot && wallet.parentElement !== walletSlot) walletSlot.appendChild(wallet);
    const card = $("#bk-payment-host");
    const cardSlot = $("#bk-card-slot");
    if (card && cardSlot && card.parentElement !== cardSlot) cardSlot.appendChild(card);
  }

  function mountDeferred() {
    const run = () => mountDeferredNow();
    paymentUi.mountChain = (paymentUi.mountChain || Promise.resolve()).then(run, run);
    return paymentUi.mountChain;
  }

  async function mountDeferredNow() {
    const cfg = paymentUi.cfg;
    if (!cfg) return { ok: false, message: PAY_FAIL };
    const generation = paymentUi.prepToken;
    try {
      await loadStripeJs();
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    if (generation !== paymentUi.prepToken || state.submitting) return { ok: true };
    const amountKr = currentAmount();
    if (!(amountKr > 0)) return { ok: false, message: PAY_FAIL };
    const key = deferredKey();
    if (paymentUi.deferred && paymentUi.mountedKey === key && paymentUi.wallets && paymentUi.element) {
      placeWalletHost();
      placePaymentHost();
      return { ok: true };
    }
    premountHosts();
    const cardHost = $("#bk-payment-element");
    const walletHost = $("#bk-express-checkout");
    const stripe = sharedStripe(cfg.publishableKey);
    if (!cardHost || !walletHost || !stripe) return { ok: false, message: PAY_FAIL };
    unmountStripeElements();
    // Separate groups, so a wallet's elements.submit() never validates the empty card form.
    const walletElements = stripe.elements(deferredElementsOptions(amountKr));
    const cardElements = stripe.elements(deferredElementsOptions(amountKr));
    const wallets = createWalletElement(walletElements);
    const element = createCardElement(cardElements);
    paymentUi.stripe = stripe;
    paymentUi.elements = cardElements;
    paymentUi.walletElements = walletElements;
    paymentUi.wallets = wallets;
    paymentUi.element = element;
    paymentUi.deferred = true;
    paymentUi.mountedKey = key;
    paymentUi.nightsKey = nightsKey();
    paymentUi.surface = "stripe";
    wallets.mount("#bk-express-checkout");
    element.mount("#bk-payment-element");
    placeWalletHost();
    placePaymentHost();
    return { ok: true };
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

  const STRIPE_APPEARANCE = {
    theme: "night",
    variables: {
      colorPrimary: "#ffffff",
      colorBackground: "#1c1c1f",
      colorText: "#f4f4f5",
      borderRadius: "12px",
      fontFamily: "DM Sans, sans-serif",
    },
  };

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
    const stripe = window.Stripe(created.publishableKey, { locale: "en" });
    const elements = stripe.elements({
      locale: "en",
      clientSecret: created.clientSecret,
      appearance: STRIPE_APPEARANCE,
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
        billingDetails: cardBillingDefaults(),
      },
    });
  }

  function cardBillingDefaults() {
    const billing = { address: { country: "NO" } };
    const name = $("#bk-name") ? $("#bk-name").value.trim() : "";
    const email = $("#bk-email") ? $("#bk-email").value.trim() : "";
    if (name) billing.name = name;
    if (email) billing.email = email;
    return billing;
  }

  function googlePayMode() {
    // With "auto", Stripe shows Google Pay only when the shopper already has a card saved in Google
    // Wallet and Chrome's "Allow sites to check if you have payment methods saved" is on, so most
    // Android phones saw no button. "always" shows it on every Google Pay-capable browser (a card can be
    // added in the Google Pay sheet). Apple devices keep "auto" so Safari shows Apple Pay on its own.
    const ua = navigator.userAgent || "";
    const appleTouch = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const desktopSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Android|Edg|OPR|SamsungBrowser|Firefox|FxiOS/.test(ua);
    return appleTouch || desktopSafari ? "auto" : "always";
  }

  function createWalletElement(elements) {
    const element = elements.create("expressCheckout", {
      paymentMethods: {
        applePay: "auto",
        googlePay: googlePayMode(),
        link: "never",
        paypal: "never",
        amazonPay: "never",
        klarna: "never",
      },
      // Brand-guideline plain buttons (no "Buy with"), white, 42px tall: the logo renders ~16px.
      buttonHeight: 42,
      buttonType: { applePay: "plain", googlePay: "plain" },
      buttonTheme: { applePay: "white", googlePay: "white" },
      layout: { maxColumns: 1, maxRows: 0, overflow: "never" },
    });
    element.on("ready", (event) => {
      if (paymentUi.wallets !== element) return;
      const methods = (event && event.availablePaymentMethods) || {};
      paymentUi.walletsReady = !!(methods.applePay || methods.googlePay);
      paymentUi.walletsSettled = true;
      placeWalletHost();
    });
    element.on("loaderror", () => {
      if (paymentUi.wallets !== element) return;
      paymentUi.walletsReady = false;
      paymentUi.walletsSettled = true;
      placeWalletHost();
    });
    element.on("click", (event) => {
      // Synchronous: Apple Pay needs the sheet opened inside the tap. The PaymentIntent is created
      // later, in "confirm" (deferred mode), or existed before this button (fallback mode).
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
    if (paymentUi.deferred) return confirmWalletDeferred(walletEvent);
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

  // Stripe's deferred-intent Express Checkout pattern: in "confirm" (the wallet sheet is already
  // authorized) submit the wallet group, create the PaymentIntent, then confirm with its clientSecret.
  async function confirmWalletDeferred(walletEvent) {
    const stripe = paymentUi.stripe;
    const elements = paymentUi.walletElements;
    if (state.submitting || !stripe || !elements) {
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
      const submitted = await elements.submit();
      if (submitted && submitted.error) {
        walletPaymentFailed(walletEvent, submitted.error.message);
        return;
      }
      state.termsAcceptedAt = new Date().toISOString();
      const created = await postCheckout("card");
      if (!created.ok || created.status === "failed" || created.status === "cancelled") {
        const message = (created && created.message) || PAY_FAIL;
        walletPaymentFailed(walletEvent, message);
        showPaymentFailed(message);
        return;
      }
      if (created.status === "paid" || created.status === "reserved") {
        walletPaymentFailed(walletEvent, "You’re already booked.");
        rememberPaidMethod(created);
        const done = resultFromOrder(created);
        if (done.ok) {
          paymentUi.orderId = created.orderId;
          showConfirmation(done.booking || { ok: true, confirmationSent: false, paidByWorker: true });
        }
        return;
      }
      if (!created.clientSecret) {
        walletPaymentFailed(walletEvent, PAY_FAIL);
        showPaymentFailed(PAY_FAIL);
        return;
      }
      paymentUi.orderId = created.orderId;
      savePaymentSession(created.orderId);
      const confirmed = await stripe.confirmPayment({
        elements: elements,
        clientSecret: created.clientSecret,
        confirmParams: {
          return_url: window.location.origin + window.location.pathname + "?order=" + encodeURIComponent(created.orderId),
        },
        redirect: "if_required",
      });
      logTiming("stripe-confirm", started, { surface: "wallet-deferred" });
      const result = await resolveConfirmed(created.orderId, confirmed, started);
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

  // Card in deferred mode: validate the card form first, then create the PaymentIntent, then confirm.
  async function payCardDeferred(method) {
    const stripe = paymentUi.stripe;
    const elements = paymentUi.elements;
    if (!stripe || !elements || !paymentUi.element) {
      schedulePrepare();
      return { ok: false, reason: "needs-details", message: "Enter your payment details, then press Pay again." };
    }
    let submitted;
    const submitStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      submitted = await elements.submit();
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    logTiming("elements-submit", submitStarted, { deferred: true });
    if (submitted && submitted.error) {
      const message = submitted.error.message || "Enter your payment details, then press Pay again.";
      setPaymentNote(message, true);
      return { ok: false, reason: "needs-details", message: message };
    }
    const created = await postCheckout(method);
    if (!created.ok) return { ok: false, message: created.message || PAY_FAIL };
    if (created.status === "failed" || created.status === "cancelled") return { ok: false, message: PAY_FAIL };
    if (created.status === "paid" || created.status === "reserved") {
      rememberPaidMethod(created);
      paymentUi.orderId = created.orderId;
      return resultFromOrder(created);
    }
    if (!created.clientSecret) return { ok: false, message: PAY_FAIL };
    paymentUi.orderId = created.orderId;
    setPaymentNote("");
    savePaymentSession(created.orderId);
    const person = buildPersonFields();
    let confirmed;
    const confirmStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      confirmed = await stripe.confirmPayment({
        elements: elements,
        clientSecret: created.clientSecret,
        confirmParams: {
          return_url: window.location.origin + window.location.pathname + "?order=" + encodeURIComponent(created.orderId),
          payment_method_data: { billing_details: { name: person.fullName, email: person.email } },
        },
        redirect: "if_required",
      });
    } catch (err) {
      return { ok: false, message: PAY_FAIL };
    }
    logTiming("stripe-confirm", confirmStarted, { surface: "card-deferred" });
    return resolveConfirmed(created.orderId, confirmed, confirmStarted);
  }

  function resultFromOrder(data) {
    const result = window.HustlePaymentStatus.checkoutResult(data);
    if (result.ok) return result;
    if (result.reason === "missing") return { ok: false, message: failureMessage("missing") };
    return { ok: false, message: failureMessage(result.failureReason || result.reason) };
  }

  function failureMessage(reason) {
    if (reason === "missing") {
      return "We couldn’t find that payment. If money left your account, don’t pay again. Email hustleinoslo@gmail.com.";
    }
    const stopped = { aborted: 1, expired: 1, cancelled: 1, terminated: 1 };
    if (reason && stopped[String(reason).toLowerCase()]) {
      return "Vipps didn’t complete the payment. You haven’t been charged.";
    }
    return PAY_FAIL;
  }

  async function fetchOrder(orderId) {
    try {
      const res = await fetch(workerUrl("/order/" + encodeURIComponent(orderId)));
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 404 || (data && data.error === "not-found")) return { status: "unknown", error: "not-found" };
      return data;
    } catch (err) {
      return { status: "pending" };
    }
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

  function rememberPaidMethod(data) {
    const raw = data && typeof data.method === "string" ? data.method : "";
    const label = METHOD_LABEL[raw] || (raw === "Apple Pay" || raw === "Google Pay" || raw === "Card" || raw === "Vipps" ? raw : "");
    if (label) state.paidMethodLabel = label;
  }

  async function resolveConfirmed(orderId, confirmed, started) {
    const immediate = window.HustlePaymentStatus.clientPaymentResult(confirmed);
    if (immediate) {
      if (immediate.ok) {
        // The read writes the sheet and replaces Card with the wallet Stripe recorded.
        const recorded = await fetchOrder(orderId);
        rememberPaidMethod(recorded);
      }
      logTiming("success-resolve", started, { orderId: orderId, ok: !!immediate.ok, immediate: true });
      return immediate.ok ? immediate : { ok: false, message: immediate.message || PAY_FAIL };
    }
    const pollStarted = typeof performance !== "undefined" ? performance.now() : Date.now();
    const polled = await pollOrder(orderId, { stripeSucceeded: false });
    logTiming("order-poll", pollStarted, { orderId: orderId, status: polled && polled.status });
    const screen = window.HustlePaymentStatus.returnScreen(polled);
    logTiming("success-resolve", started, { orderId: orderId, ok: screen.kind === "paid" });
    if (screen.kind === "paid") {
      rememberPaidMethod(polled);
      return resultFromOrder(polled);
    }
    return { ok: false, message: failureMessage(screen.kind === "failed" ? screen.reason : "pending") };
  }

  function nightSnapshot(sel) {
    const ev = (sel && sel.event) || {};
    const ticket = (sel && sel.ticket) || {};
    return {
      eventId: ev.id,
      ticketId: ticket.id,
      priceTier: sel.priceTier || "standard",
      event: {
        id: ev.id,
        date: ev.date,
        weekday: ev.weekday,
        type: ev.type,
        location: ev.location,
        venue: ev.venue,
        start: ev.start,
        end: ev.end,
        label: ev.label,
      },
      ticket: {
        id: ticket.id,
        name: ticket.name,
        prices: ticket.prices || {},
      },
    };
  }

  function cartSelections(snapshot, events, tickets) {
    const nights = snapshot && Array.isArray(snapshot.nights) ? snapshot.nights : [];
    const catalogEvents = events || window.HUSTLE_EVENTS || [];
    const catalogTickets = tickets || window.HUSTLE_TICKETS || {};
    return nights.map(function (night) {
      if (!night) return null;
      const ev = catalogEvents.find(function (item) { return item.id === night.eventId; }) || night.event || null;
      if (!ev || !ev.id) return null;
      const list = catalogTickets[ev.type] || [];
      const ticket = list.find(function (item) { return item.id === night.ticketId; }) || night.ticket || null;
      if (!ticket || !ticket.id) return null;
      return { event: ev, ticket: ticket, priceTier: night.priceTier === "student" ? "student" : "standard" };
    }).filter(Boolean).sort(compareSelections);
  }

  function storeGet(key) {
    let raw = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch (err) {
      raw = null;
    }
    if (raw == null) {
      try {
        raw = window.sessionStorage.getItem(key);
      } catch (err) {
        raw = null;
      }
    }
    let data = null;
    try {
      data = JSON.parse(raw || "null");
    } catch (err) {
      data = null;
    }
    if (!data || typeof data !== "object") return null;
    if (typeof data.savedAt === "number" && Date.now() - data.savedAt > SAVED_CART_TTL_MS) {
      storeRemove(key);
      return null;
    }
    return data;
  }

  function storeSet(key, data) {
    const json = JSON.stringify(Object.assign({}, data, { savedAt: Date.now() }));
    try {
      window.localStorage.setItem(key, json);
      return;
    } catch (err) {
      /* private mode or full: fall back to this tab */
    }
    try {
      window.sessionStorage.setItem(key, json);
    } catch (err) {
      /* private mode */
    }
  }

  function storeRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      /* private mode */
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch (err) {
      /* private mode */
    }
  }

  function readSavedCart() {
    return storeGet(PAYMENT_SESSION_KEY);
  }

  function clearSavedCart() {
    storeRemove(PAYMENT_SESSION_KEY);
  }

  function clearSavedDetails() {
    storeRemove(DETAILS_DRAFT_KEY);
  }

  function readDetailsForm() {
    const repeat = $("#bk-repeat");
    const experience = $("#bk-experience");
    const referral = $("#bk-referral");
    const other = $("#bk-referral-other");
    return {
      priceTier: state.priceTier || "",
      customer: {
        fullName: $("#bk-name") ? $("#bk-name").value.trim() : "",
        email: $("#bk-email") ? $("#bk-email").value.trim() : "",
        phone: $("#bk-phone") ? $("#bk-phone").value.trim() : "",
      },
      repeat: !!(repeat && repeat.checked),
      experience: experience ? experience.value : "",
      referral: referral ? referral.value : "",
      referralOther: other ? other.value.trim() : "",
    };
  }

  // Name, email, phone, the student answer and the other answers. Card fields are never read here.
  function saveDetailsDraft() {
    storeSet(DETAILS_DRAFT_KEY, readDetailsForm());
  }

  function fillDetails(saved, onlyEmpty) {
    if (!saved) return;
    const customer = saved.customer || {};
    const fill = (el, value) => {
      if (!el || typeof value !== "string" || !value) return;
      if (onlyEmpty && el.value) return;
      el.value = value;
    };
    fill($("#bk-name"), customer.fullName);
    fill($("#bk-email"), customer.email);
    fill($("#bk-phone"), customer.phone);
    const repeat = $("#bk-repeat");
    if (repeat && saved.repeat && !(onlyEmpty && repeat.checked)) repeat.checked = true;
    fill($("#bk-experience"), saved.experience);
    fill($("#bk-referral"), saved.referral);
    fill($("#bk-referral-other"), saved.referralOther);
    syncFirstTimer();
    syncSelectPlaceholder($("#bk-experience"));
    syncSelectPlaceholder($("#bk-referral"));
    syncOther();
  }

  function restoreDetailsDraft() {
    const saved = storeGet(DETAILS_DRAFT_KEY);
    if (!saved) return false;
    fillDetails(saved, true);
    if (!state.priceTier && (saved.priceTier === "student" || saved.priceTier === "standard")) {
      setTier(saved.priceTier);
    }
    return true;
  }

  function savePaymentSession(orderId, cartEdited) {
    // After an edit the old order no longer matches the cart, so don't carry its id over.
    const prior = cartEdited ? null : readSavedCart();
    const details = readDetailsForm();
    const snapshot = Object.assign(details, {
      orderId: orderId || paymentUi.orderId || (prior && prior.orderId) || "",
      pendingPayment: true,
      priceTier: state.priceTier,
      paymentMethod: state.paymentMethod,
      termsAcceptedAt: state.termsAcceptedAt,
      nights: sortSelections(state.selections).map(nightSnapshot),
    });
    storeSet(PAYMENT_SESSION_KEY, snapshot);
    saveDetailsDraft();
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return false;
    state.priceTier = snapshot.priceTier === "student" ? "student" : "standard";
    state.paymentMethod = METHOD_LABEL[snapshot.paymentMethod] ? snapshot.paymentMethod : "card";
    state.termsAcceptedAt = snapshot.termsAcceptedAt || "";
    state.selections = cartSelections(snapshot);
    setTier(state.priceTier);
    fillDetails(snapshot, false);
    restoreDetailsDraft();
    return state.selections.length > 0;
  }

  // Last resort for a return in another browser (no local copy): the Worker hands back the
  // order's classes (ids and price tier only, no personal data) while it is unpaid.
  function applyServerCart(cart) {
    if (!cart || !Array.isArray(cart.nights) || !cart.nights.length || state.selections.length) return false;
    const selections = cartSelections({ nights: cart.nights });
    if (!selections.length) return false;
    state.selections = selections;
    // The Worker only records "student" where it changed the price, so only that is a sure answer.
    if (!state.priceTier && selections.some((sel) => sel.priceTier === "student")) setTier("student");
    const method = Object.keys(METHOD_LABEL).find((key) => key === cart.method || METHOD_LABEL[key] === cart.method);
    if (method) state.paymentMethod = method;
    restoreDetailsDraft();
    return true;
  }

  function cartMatchesOrder(snapshot, orderId) {
    if (!snapshot || snapshot.pendingPayment !== true || !(snapshot.nights && snapshot.nights.length)) return false;
    if (!orderId || !snapshot.orderId) return true;
    return snapshot.orderId === orderId;
  }

  function selectionFromIds(eventId, ticketId, priceTier) {
    const ev = (window.HUSTLE_EVENTS || []).find((item) => item.id === eventId);
    if (!ev) return null;
    const tickets = (window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[ev.type]) || [];
    const ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket) return null;
    return { event: ev, ticket: ticket, priceTier: priceTier || "standard" };
  }

  function restorePendingCart(orderId) {
    const snapshot = readSavedCart();
    if (!cartMatchesOrder(snapshot, orderId)) {
      if (orderId) state.view = "checkout";
      return false;
    }
    const restored = applySnapshot(snapshot);
    state.view = restored ? (state.view === "failed" ? "failed" : "checkout") : "student";
    return restored;
  }

  function restorePaymentSession(orderId) {
    return restorePendingCart(orderId);
  }

  function stripPaymentQuery() {
    const url = new URL(window.location.href);
    ["order", "payment_intent", "payment_intent_client_secret", "redirect_status"].forEach((key) => {
      url.searchParams.delete(key);
    });
    const next = url.pathname + (url.search ? url.search : "") + url.hash;
    window.history.replaceState({}, "", next);
  }

  function showVippsWaiting(provider, redirectUrl) {
    const heading = $("#bk-waiting-heading");
    const sub = $("#bk-waiting-sub");
    const again = $("#bk-vipps-again");
    const vipps = provider === "vipps";
    if (heading) heading.textContent = vipps ? "Waiting for Vipps…" : "Waiting for payment…";
    if (sub) sub.textContent = "We haven’t seen a payment yet, so this isn’t booked.";
    const url = typeof redirectUrl === "string" ? redirectUrl : "";
    const open = vipps && /^https:\/\//.test(url);
    if (again) {
      again.hidden = !open;
      if (open) again.href = url;
      else again.removeAttribute("href");
    }
    if (state.view !== "waiting") go("waiting");
    const step = $("#bk-step-status");
    if (step) step.textContent = vipps ? "Waiting for Vipps." : "Waiting for payment.";
  }

  function startOver() {
    paymentUi.resumeGen += 1;
    clearSavedCart();
    stripPaymentQuery();
    resetBooking();
    go("student");
  }

  async function resumePayment(orderId) {
    const gen = (paymentUi.resumeGen += 1);
    paymentUi.orderId = orderId;
    const deadline = Date.now() + window.HustlePaymentStatus.returnWaitMs();
    let attempt = 0;
    let redirectUrl = "";
    let provider = state.paymentMethod === "vipps" ? "vipps" : "";
    while (gen === paymentUi.resumeGen && Date.now() < deadline) {
      const data = await fetchOrder(orderId);
      if (gen !== paymentUi.resumeGen) return;
      if (data && data.cart && applyServerCart(data.cart)) savePaymentSession(orderId);
      const screen = window.HustlePaymentStatus.returnScreen(data);
      if (screen.kind === "paid") {
        stripPaymentQuery();
        rememberPaidMethod(data);
        state.transactionNumber = screen.transactionNumber || "";
        state.paymentPending = false;
        showConfirmation({
          ok: true,
          confirmationSent: screen.confirmationSent === true,
          paidByWorker: true,
        });
        return;
      }
      if (screen.kind === "failed") {
        stripPaymentQuery();
        showPaymentFailed(failureMessage(screen.reason));
        return;
      }
      if (screen.provider) provider = screen.provider;
      if (screen.redirectUrl) redirectUrl = screen.redirectUrl;
      showVippsWaiting(provider, redirectUrl);
      const wait = window.HustlePaymentStatus.returnPollDelayMs(attempt);
      attempt += 1;
      if (Date.now() + wait >= deadline) break;
      await new Promise(function (resolve) { window.setTimeout(resolve, wait); });
    }
    if (gen === paymentUi.resumeGen) showVippsWaiting(provider, redirectUrl);
  }

  async function recoverServerCart(orderId) {
    const data = await fetchOrder(orderId);
    if (!data || !data.cart || !applyServerCart(data.cart)) return;
    savePaymentSession(orderId);
    if (state.view === "failed") showPaymentFailed(PAY_FAIL);
  }

  function maybeResumePayment() {
    if (!paymentsLive()) return;
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("order");
    if (!orderId) return;
    restorePaymentSession(orderId);
    if (params.get("redirect_status") === "failed") {
      state.view = "failed";
      openSheet();
      stripPaymentQuery();
      paymentUi.orderId = orderId;
      showPaymentFailed(PAY_FAIL);
      if (!state.selections.length) recoverServerCart(orderId);
      return;
    }
    state.view = "waiting";
    openSheet();
    if (state.paymentMethod === "vipps") showVippsWaiting("vipps", "");
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
    paymentUi.redirectOrderId = "";
    if (method !== "vipps" && paymentUi.cfg) return payCardDeferred(method);
    const created = await postCheckout(method);
    if (!created.ok) return { ok: false, message: created.message || PAY_FAIL };
    if (created.status === "failed" || created.status === "cancelled") return { ok: false, message: PAY_FAIL };
    if (created.status === "paid" || created.status === "reserved") {
      rememberPaidMethod(created);
      return resultFromOrder(created);
    }
    if (method === "vipps") {
      if (!created.redirectUrl) return { ok: false, message: PAY_FAIL };
      // A card form prepared in the background can leave paymentUi.orderId on
      // a different order. Pin the Vipps order so pagehide saves the one that
      // ?order= comes back with, or a second cancel loses the cart.
      paymentUi.redirectOrderId = created.orderId;
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
      nights: sortSelections(state.selections).map((s) => ({
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

  // The banner already titles the failure. Drop a repeated title so a decline
  // or a cancelled payment shows "Payment didn’t go through" once.
  function paymentFailDetail(message) {
    const fallback = "Your card was declined. You haven’t been charged. Try again or pick another method.";
    let text = String(message || "").trim();
    if (!text) return fallback;
    const title = "Payment didn’t go through";
    if (text === title || text.indexOf(title + ".") === 0 || text.indexOf(title + " ") === 0) {
      text = text.slice(title.length).replace(/^[.\s]+/, "").trim();
      return text || fallback;
    }
    return text;
  }

  function showPaymentFailed(message) {
    // go() calls schedulePrepare(), which bails while a payment is in flight.
    // Clear that flag first so a decline remounts the card form.
    // Keep the nights, tickets, and details. A retry uses a new idempotency key.
    state.submitting = false;
    const orderId = paymentUi.orderId || "";
    if (state.selections.length) savePaymentSession(orderId);
    else restorePendingCart(orderId);
    resetPaymentAttempt();
    const el = $("#bk-fail-message");
    if (el) el.textContent = paymentFailDetail(message);
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
    const selections = sortSelections(state.selections).slice();
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

  const CALENDAR_ADDRESS = "Sentralen, Øvre Slottsgate 3, 0157 Oslo";
  const CALENDAR_NAMES = {
    beginners: "Beginner class",
    intermediate: "Intermediate class",
    bundle: "Two class bundle",
    socialClass: "Social Only",
    socialNight: "Social",
  };
  const ICON_CAL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"></rect><path d="M3.5 10h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path></svg>';
  const ORDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function calendarPlatform() {
    const ua = navigator.userAgent || "";
    const iPadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    if (/iPad|iPhone|iPod/.test(ua) || iPadOs) return "ios";
    if (/Android/i.test(ua)) return "android";
    return "other";
  }

  function calendarDateLabel(ev) {
    if (!ev || !ev.date) return "";
    return formatCheckoutDate(ev) + " " + String(ev.date).slice(0, 4);
  }

  function calendarDatePhrase() {
    return state.selections.map((sel) => calendarDateLabel(sel.event)).filter(Boolean).join(", ");
  }

  function calendarName(ticketId, eventType) {
    if (ticketId === "beginners" || ticketId === "intermediate" || ticketId === "bundle") return CALENDAR_NAMES[ticketId];
    if (ticketId === "social") return eventType === "class" ? CALENDAR_NAMES.socialClass : CALENDAR_NAMES.socialNight;
    return "Class";
  }

  function calendarTitle(sel) {
    const ticket = sel && sel.ticket;
    const ev = sel && sel.event;
    return "Hustle Oslo: " + calendarName(ticket && ticket.id, ev && ev.type);
  }

  function calendarRoomNote(ev) {
    const room = ev && ev.location ? String(ev.location).trim() : "";
    return room ? "Room: " + room : "";
  }

  function icsAlarms(title) {
    const desc = icsEscape(title);
    return [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-P1D",
      "DESCRIPTION:" + desc,
      "END:VALARM",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT2H",
      "DESCRIPTION:" + desc,
      "END:VALARM",
    ].join("\r\n");
  }

  function osloBasicStamp(date, hm) {
    const parts = String(date).split("-").map(Number);
    const clock = String(hm).split(":").map(Number);
    const desired = Date.UTC(parts[0], parts[1] - 1, parts[2], clock[0] || 0, clock[1] || 0, 0);
    let utc = desired;
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Oslo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 4; i++) {
      const got = {};
      fmt.formatToParts(new Date(utc)).forEach((part) => {
        got[part.type] = part.value;
      });
      const actual = Date.UTC(Number(got.year), Number(got.month) - 1, Number(got.day), Number(got.hour), Number(got.minute), Number(got.second));
      if (actual === desired) break;
      utc -= actual - desired;
    }
    return new Date(utc).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function googleCalendarHref(sel) {
    const times = timeParts(sel);
    const start = osloBasicStamp(sel.event.date, times.start);
    const end = osloBasicStamp(sel.event.date, times.end);
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: calendarTitle(sel),
      location: CALENDAR_ADDRESS,
    });
    const notes = calendarRoomNote(sel.event);
    if (notes) params.set("details", notes);
    return "https://calendar.google.com/calendar/render?" + params.toString() + "&dates=" + start + "/" + end;
  }

  function hostedIcsUrl(eventId) {
    try {
      const base = String(CONFIG.PAYMENTS_WORKER_URL || "").replace(/\/$/, "");
      const orderId = paymentUi.orderId || "";
      if (!base || !ORDER_UUID.test(orderId)) return "";
      const url = new URL(base + "/ics");
      url.searchParams.set("order", orderId);
      if (eventId) url.searchParams.set("eventId", eventId);
      return url.toString();
    } catch (err) {
      return "";
    }
  }

  function icsButtonHtml(href) {
    const dates = calendarDatePhrase();
    const many = state.selections.length > 1;
    const aria = "Add " + (many ? "all nights" : dates || "this night") + " to Apple Calendar or Outlook (.ics)";
    const label = ICON_CAL + "<span>Apple / Outlook (.ics)</span>";
    if (!href) {
      return (
        '<button type="button" class="bk-btn bk-btn-secondary cf-cal-btn" data-action="ics-all" aria-label="' +
        escapeHtml(aria) +
        '">' +
        label +
        "</button>"
      );
    }
    const download = calendarPlatform() === "ios" ? "" : ' download="hustle-oslo.ics"';
    return (
      '<a class="bk-btn bk-btn-secondary cf-cal-btn" href="' +
      escapeHtml(href) +
      '"' +
      download +
      ' aria-label="' +
      escapeHtml(aria) +
      '">' +
      label +
      "</a>"
    );
  }

  function googleButtonHtml() {
    if (state.selections.length > 1) {
      return (
        '<button type="button" class="bk-btn bk-btn-secondary cf-cal-btn" id="bk-gcal-open" data-action="gcal-open" aria-haspopup="dialog" aria-expanded="false" aria-controls="cf-gcal-list">' +
        ICON_PLUS +
        "<span>Google Calendar</span></button>"
      );
    }
    const sel = state.selections[0];
    if (!sel) return "";
    const label = "Add " + formatCheckoutDate(sel.event) + " to Google Calendar (opens in a new tab)";
    return (
      '<a class="bk-btn bk-btn-secondary cf-cal-btn" target="_blank" rel="noopener noreferrer" href="' +
      escapeHtml(googleCalendarHref(sel)) +
      '" aria-label="' +
      escapeHtml(label) +
      '">' +
      ICON_PLUS +
      "<span>Google Calendar</span></a>"
    );
  }

  function calendarPairHtml(href) {
    return '<div class="cf-cal-pair">' + icsButtonHtml(href) + googleButtonHtml() + "</div>";
  }

  function hostedCalendarHtml() {
    const all = hostedIcsUrl();
    if (!all) return "";
    return calendarPairHtml(all);
  }

  function fallbackCalendarHtml() {
    return calendarPairHtml("");
  }

  function gcalIsDesktop() {
    return window.matchMedia("(min-width: 960px)").matches;
  }

  function closeGcalList(restoreFocus) {
    const list = $("#cf-gcal-list");
    const scrim = $(".cf-gl-scrim");
    if (list) list.remove();
    if (scrim) scrim.remove();
    const btn = $("#bk-gcal-open");
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (restoreFocus && btn && typeof btn.focus === "function") btn.focus();
  }

  function gcalListHtml(desktop) {
    const rows = state.selections
      .map((sel) => {
        const name = classLineName(sel);
        const meta = formatCheckoutDate(sel.event) + ", " + ticketTime(sel.event, sel.ticket.id);
        const label = "Add " + name + ", " + formatCheckoutDate(sel.event) + " to Google Calendar (opens in a new tab)";
        return (
          '<li class="cf-gl-row"><span class="cf-gl-main"><span class="cf-gl-name">' +
          escapeHtml(name) +
          '</span><span class="cf-gl-meta">' +
          escapeHtml(meta) +
          "</span></span>" +
          '<a class="bk-btn bk-btn-secondary cf-gl-add" target="_blank" rel="noopener noreferrer" href="' +
          escapeHtml(googleCalendarHref(sel)) +
          '" aria-label="' +
          escapeHtml(label) +
          '">Add</a></li>'
        );
      })
      .join("");
    return (
      '<div class="cf-gl' +
      (desktop ? "" : " cf-gl--sheet") +
      '" id="cf-gcal-list" role="dialog" aria-modal="' +
      (desktop ? "false" : "true") +
      '" aria-labelledby="cf-gl-title">' +
      (desktop ? "" : '<div class="bk-grab" aria-hidden="true"></div>') +
      '<div class="cf-gl-hd"><p class="cf-gl-title" id="cf-gl-title">Add to Google Calendar</p>' +
      '<button type="button" class="cf-gl-x" data-action="gcal-close" aria-label="Close">&#10005;</button></div>' +
      '<p class="cf-gl-sub">Google adds one night at a time.</p>' +
      '<ul class="cf-gl-list">' +
      rows +
      "</ul></div>"
    );
  }

  function openGcalList() {
    closeGcalList(false);
    const desktop = gcalIsDesktop();
    const html = gcalListHtml(desktop);
    if (desktop) {
      const sec = $(".cf-cal-sec");
      if (sec) sec.insertAdjacentHTML("beforeend", html);
    } else {
      const sheet = $("#book-sheet");
      if (!sheet) return;
      sheet.insertAdjacentHTML("beforeend", '<div class="cf-gl-scrim" data-action="gcal-close" aria-hidden="true"></div>' + html);
    }
    const btn = $("#bk-gcal-open");
    if (btn) btn.setAttribute("aria-expanded", "true");
    const closeBtn = $("#cf-gcal-list .cf-gl-x");
    if (closeBtn && typeof closeBtn.focus === "function") closeBtn.focus();
  }

  function renderCalendarActions() {
    const host = $("#bk-cal-actions");
    if (!host) return;
    host.innerHTML = hostedCalendarHtml() || fallbackCalendarHtml();
  }

  function buildIcs(selections) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const events = selections
      .map((sel) => {
        const times = timeParts(sel);
        const start = sel.event.date.replace(/-/g, "") + "T" + times.start.replace(":", "") + "00";
        const end = sel.event.date.replace(/-/g, "") + "T" + times.end.replace(":", "") + "00";
        const title = calendarTitle(sel);
        const notes = calendarRoomNote(sel.event);
        const lines = [
          "BEGIN:VEVENT",
          "UID:" + sel.event.id + "-" + sel.ticket.id + "@hustleoslo.com",
          "DTSTAMP:" + stamp,
          "DTSTART;TZID=Europe/Oslo:" + start,
          "DTEND;TZID=Europe/Oslo:" + end,
          "SUMMARY:" + icsEscape(title),
          "LOCATION:" + icsEscape(CALENDAR_ADDRESS),
        ];
        if (notes) lines.push("DESCRIPTION:" + icsEscape(notes));
        lines.push(icsAlarms(title), "END:VEVENT");
        return lines.join("\r\n");
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
    const pendingConfirmation = !!(result && result.pendingConfirmation);
    const step = $("#bk-step-status");
    if (step) {
      if (pendingConfirmation) step.textContent = "We’re confirming your payment.";
      else if (saved) step.textContent = "You’re registered.";
      else step.textContent = "We couldn’t save your booking.";
    }
    if (heading) {
      if (pendingConfirmation) heading.textContent = "We’re confirming your payment";
      else heading.textContent = saved ? "You’re registered!" : "We couldn’t save your booking";
    }
    if (mark) mark.hidden = !saved;
    if (sub) {
      const registered = saved && !pendingConfirmation;
      if (registered && email) {
        sub.hidden = false;
        sub.textContent = "Confirmation email has been sent to " + email;
      } else if (registered) {
        sub.hidden = true;
        sub.textContent = "";
      } else if (pendingConfirmation) {
        sub.hidden = false;
        sub.textContent = "We’re confirming your payment.";
      } else if (!state.paymentPending) {
        sub.hidden = false;
        sub.textContent = "Paid " + amt + " kr";
      } else sub.textContent = "";
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
    const table = $("#bk-done-table");
    const cal = $("#bk-cal-actions");
    const sec = $(".cf-cal-sec");
    if (!saved) {
      if (table) {
        table.innerHTML = "";
        table.hidden = true;
      }
      if (cal) cal.innerHTML = "";
      if (sec) sec.hidden = true;
      if (mark) mark.hidden = true;
      return;
    }
    if (table) {
      const nights = sortSelections(state.selections)
        .map((s) => {
          const meta = formatCheckoutDate(s.event) + ", " + ticketTime(s.event, s.ticket.id);
          return "<li>" + escapeHtml(classLineName(s)) + '<span class="cf-night-meta">' + escapeHtml(meta) + "</span></li>";
        })
        .join("");
      const method = state.paidMethodLabel || METHOD_LABEL[state.paymentMethod] || "";
      table.hidden = false;
      table.innerHTML =
        '<div class="cf-row"><dt>Class(es)</dt><dd><ul class="cf-nights">' +
        nights +
        "</ul></dd></div>" +
        '<div class="cf-row"><dt>Payment method</dt><dd>' +
        escapeHtml(method) +
        "</dd></div>" +
        '<div class="cf-row cf-row--total"><dt>Total</dt><dd>' +
        currentAmount() +
        " kr</dd></div>";
    }
    if (sec) sec.hidden = false;
    renderCalendarActions();
  }

  function showConfirmation(result) {
    state.submitResult = result;
    state.submitted = true;
    clearSavedCart();
    clearSavedDetails();
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
    if (!state.paymentMethod) {
      setErr("pay", true);
      announce("Choose how you’d like to pay.");
      return;
    }
    setErr("pay", false);
    if (!validateDetails(false)) {
      // A return in another browser can bring the classes back without the details.
      go("details");
      validateDetails(true);
      return;
    }
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
    state.checkoutFrom = "details";
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
    if (e.key === "Tab") sheet.classList.remove("bk-touch");
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      const a = document.activeElement;
      if (isTicketInput(a) && sheet.contains(a)) {
        // Enter and Space both toggle an offer card. A checked radio ignores
        // Space natively, so both keys go through the same click.
        e.preventDefault();
        if (!e.repeat) a.click();
        return;
      }
    }
    if (e.key === "Enter" && onFormReturn(e)) return;
    if (onStudentChoiceKey(e)) return;
    if (e.key === "Escape") {
      if ($("#cf-gcal-list")) {
        closeGcalList(true);
        e.preventDefault();
        return;
      }
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
    if (onTicketClick(e)) return;
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
      const target = nextAfterConfirm();
      if (target === "checkout") state.checkoutFrom = "confirm";
      return go(target);
    }
    if (action === "edit-order") return go("confirm");
    if (action === "edit-details") return go("details");
    if (action === "pay") return onPay();
    if (action === "fail-back") return go("checkout");
    if (action === "start-over") return startOver();
    if (action === "done") return closeSheet();
    if (action === "gcal-open") {
      if ($("#cf-gcal-list")) closeGcalList(true);
      else openGcalList();
      return;
    }
    if (action === "gcal-close") return closeGcalList(true);
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
    if (isDraftField(t)) saveDetailsDraft();
    syncEnterKeyHints();
  }

  function isDraftField(t) {
    return !!(t && t.id && /^bk-(name|email|phone|repeat|experience|referral|referral-other)$/.test(t.id));
  }

  function onSheetInput(e) {
    const t = e.target;
    if (t.id === "bk-name" || t.id === "bk-email" || t.id === "bk-phone" || t.id === "bk-referral-other") {
      validateDetails(false);
      schedulePrepare();
    }
    if (isDraftField(t)) saveDetailsDraft();
    syncEnterKeyHints();
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
    preconnectWorker();
    maybeResumePayment();
    const start = $("#btn-start");
    if (start) start.addEventListener("click", openSheet);
    const sheet = $("#book-sheet");
    if (sheet) {
      sheet.addEventListener("pointerdown", function () {
        sheet.classList.add("bk-touch");
      });
      sheet.addEventListener("pointerdown", swallowStudentFollowup);
      sheet.addEventListener("click", onSheetClick);
      sheet.addEventListener("change", onSheetChange);
      sheet.addEventListener("input", onSheetInput);
    }
    const form = $("#bk-details-form");
    if (form) form.addEventListener("submit", onDetailsSubmit);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("keyup", function (e) {
      // Keydown already toggled the card; stop the native Space activation on keyup.
      if ((e.key === " " || e.key === "Spacebar") && isTicketInput(document.activeElement)) e.preventDefault();
    });
    if (typeof window.addEventListener === "function") {
      // iOS keeps the page in the back/forward cache while Vipps or 3-D Secure is open.
      // Coming back that way must not leave the drawer stuck in "Paying…" with an old total.
      window.addEventListener("pageshow", function (e) {
        if (!e || !e.persisted || state.submitted) return;
        if (state.submitting) {
          state.submitting = false;
          $$("#bk-pay, #bk-fail-retry").forEach((btn) => { btn.disabled = false; });
          const sheet = $("#book-sheet");
          if (sheet) sheet.setAttribute("aria-busy", "false");
        }
        updatePayChrome();
        if (state.view === "confirm") renderConfirm();
      });
      window.addEventListener("pagehide", function () {
        if (state.submitted || !state.selections.length) return;
        if (state.view === "checkout" || state.view === "failed" || state.view === "waiting" || paymentUi.orderId) {
          savePaymentSession(paymentUi.redirectOrderId || paymentUi.orderId || "");
        }
      });
    }
    watchFootPad();
  }

  window.HustleOsloLookup = lookupByEmail;
  window.HustleOslo = {
    safeBottomExtra: safeBottomExtra,
    startPayment: startPayment,
    showPaymentFailed: showPaymentFailed,
    buildOrder: buildOrder,
    resultFromOrder: resultFromOrder,
    publishableKeyOk: publishableKeyOk,
    walletLikely: walletLikely,
    deferredElementsOptions: deferredElementsOptions,
    config: CONFIG,
    formFieldNeedsAttention: formFieldNeedsAttention,
    nextFormFieldIndex: nextFormFieldIndex,
    enterKeyHintFor: enterKeyHintFor,
    cartSelections: cartSelections,
    cartMatchesOrder: cartMatchesOrder,
    STUDENT_FEEDBACK_MS: STUDENT_FEEDBACK_MS,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
