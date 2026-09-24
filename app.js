/**
 * Hustle Oslo — signup app (vanilla JS, no build step)
 * Vipps number #48782 (NOT Vipps Checkout). Payment reference: Vipps transaction number.
 * Flow: Intro → Date → Ticket → Details (pay via Vipps + transaction #) → confirmation
 */
(function () {
  "use strict";

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  // Claire: paste your deployed Google Apps Script Web App URL here after deploy.
  // Leave empty until then — signup still shows confirmation + local queue.
  const CONFIG = {
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbwU9DQa0TEw7lQbXzBgWvpgYyb68UIiV4603B_u8RPaVIe9QRf3rzXtg-U2Sumtaib71g/exec",
    VIPPS_NUMBER: "48782",
    VIPPS_NAME: "Hustle Oslo",
    TIMEZONE: "Europe/Oslo",
    CLASS_START_HOUR: 18,
    CLASS_START_MINUTE: 0,
    INSTAGRAM: "https://www.instagram.com/hustleoslo/",
    LOCAL_QUEUE_KEY: "hustleOsloSignups",
  };

  const EXPERIENCE_LABELS = {
    never: "I’ve never danced before",
    solo: "Solo dance styles",
    partner: "Other partner dances",
  };
  const HOW_FOUND_LABELS = {
    "taken-class": "I’ve taken hustle before",
    friend: "Friend",
    social: "Social media",
    other: "Other",
  };

  const state = {
    step: 1,
    event: null,
    ticket: null,
    priceTier: "standard",
    submitted: false,
    submitOk: null,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ─── Time helpers (Europe/Oslo) ───────────────────────────────────────────
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
      sec: +get("second"),
    };
  }

  /** Past if earlier day, or same day at/after 18:00 Europe/Oslo. */
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

  function formatEventDate(ev) {
    const [y, m, d] = ev.date.split("-").map(Number);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${ev.weekday || ""} ${d} ${months[m - 1]} ${y}`.trim();
  }

  function sheetTabName(ev) {
    const kind = ev.type === "class" ? "Class" : "Social";
    return `${ev.date} ${kind} ${ev.location}`;
  }

  function currentAmount() {
    if (!state.ticket) return 0;
    const tier = state.priceTier || "standard";
    const prices = state.ticket.prices;
    if (tier === "student" && typeof prices.student === "number") return prices.student;
    return prices.standard;
  }

  function ticketLabel(ticket) {
    return ticket ? ticket.name : "";
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

  // ─── Local queue (when Apps Script URL not set) ───────────────────────────
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

  // ─── Schedule HTML (shown ABOVE tickets once date chosen) ─────────────────
  function scheduleHtml(ev) {
    if (!ev) return "";
    if (ev.type === "class") {
      return `
        <div class="schedule-block" role="region" aria-label="Class night schedule">
          <h3 class="schedule-title">Tonight’s schedule</h3>
          <ul class="schedule-list">
            <li><span class="schedule-slot">Beginners</span> <time datetime="18:00">18:00–19:00</time></li>
            <li><span class="schedule-slot">Intermediate</span> <time datetime="19:00">19:00–20:00</time></li>
            <li><span class="schedule-slot">Social</span> <time datetime="20:00">20:00–21:00</time></li>
          </ul>
        </div>`;
    }
    return `
      <div class="schedule-block" role="region" aria-label="Social night schedule">
        <h3 class="schedule-title">Tonight’s schedule</h3>
        <ul class="schedule-list">
          <li><span class="schedule-slot">Social</span> <time datetime="18:00">18:00–21:00</time></li>
        </ul>
      </div>`;
  }

  function landingScheduleHintHtml() {
    return `
      <div class="schedule-block schedule-block--muted" role="region" aria-label="Typical schedules">
        <h3 class="schedule-title">What a night looks like</h3>
        <p class="schedule-sub"><strong>Class nights</strong></p>
        <ul class="schedule-list">
          <li><span class="schedule-slot">Beginners</span> <time>18:00–19:00</time></li>
          <li><span class="schedule-slot">Intermediate</span> <time>19:00–20:00</time></li>
          <li><span class="schedule-slot">Social</span> <time>20:00–21:00</time></li>
        </ul>
        <p class="schedule-sub"><strong>Social-only nights</strong></p>
        <ul class="schedule-list">
          <li><span class="schedule-slot">Social</span> <time>18:00–21:00</time></li>
        </ul>
      </div>`;
  }

  // ─── Navigation ───────────────────────────────────────────────────────────
  function goTo(step) {
    state.step = step;
    $$(".panel").forEach((panel) => {
      const n = +panel.dataset.panel;
      const on = n === step;
      panel.classList.toggle("active", on);
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    // Step pills only cover 1–4; confirmation (panel 5) marks all pills done
    $$(".step-pill").forEach((pill) => {
      const n = +pill.dataset.step;
      const active = step <= 4 && n === step;
      const done = step > 4 || n < step;
      pill.classList.toggle("active", active);
      pill.classList.toggle("done", done && !active);
      pill.setAttribute("aria-current", active ? "step" : "false");
    });
    const heading = $(`#panel-${step} h2`);
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
    }
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  // ─── Render events ────────────────────────────────────────────────────────
  function renderEvents() {
    const list = $("#event-list");
    const empty = $("#no-events");
    const events = upcomingEvents();
    list.innerHTML = "";
    if (!events.length) {
      empty.hidden = false;
      $("#btn-to-ticket").disabled = true;
      return;
    }
    empty.hidden = true;
    events.forEach((ev) => {
      const li = document.createElement("li");
      li.className = "event-option";
      const id = `event-${ev.id}`;
      const badge =
        ev.type === "class"
          ? `<span class="badge badge-class">Class night</span>`
          : `<span class="badge badge-social">Social only</span>`;
      const checked = state.event && state.event.id === ev.id ? "checked" : "";
      li.innerHTML = `
        <input type="radio" name="event" id="${id}" value="${escapeHtml(ev.id)}" ${checked} />
        <label for="${id}">
          <p class="event-date">${escapeHtml(formatEventDate(ev))}</p>
          <p class="event-meta">${escapeHtml(ev.location)} · ${escapeHtml(ev.venue)} · ${escapeHtml(ev.start)}–${escapeHtml(ev.end)}</p>
          ${badge}
        </label>`;
      list.appendChild(li);
    });
    if (state.event && events.some((e) => e.id === state.event.id)) {
      $("#btn-to-ticket").disabled = false;
    } else {
      $("#btn-to-ticket").disabled = true;
    }
  }

  function onEventChange(e) {
    if (e.target.name !== "event") return;
    const ev = upcomingEvents().find((x) => x.id === e.target.value);
    state.event = ev || null;
    state.ticket = null;
    state.priceTier = "standard";
    $("#btn-to-ticket").disabled = !state.event;
  }

  // ─── Render tickets (schedule ABOVE list) ─────────────────────────────────
  function renderTickets() {
    const list = $("#ticket-list");
    const summary = $("#ticket-event-summary");
    const tierWrap = $("#tier-select");
    const scheduleHost = $("#ticket-schedule");
    list.innerHTML = "";
    if (!state.event) return;

    summary.textContent = `${formatEventDate(state.event)} · ${state.event.location} · ${state.event.start}–${state.event.end}`;
    if (scheduleHost) scheduleHost.innerHTML = scheduleHtml(state.event);

    const tickets =
      (window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[state.event.type]) || [];
    tickets.forEach((t) => {
      const li = document.createElement("li");
      li.className = "ticket-option";
      const id = `ticket-${t.id}`;
      const std = t.prices.standard;
      const stu = t.prices.student;
      const samePrice = std === stu;
      const priceBits = samePrice
        ? `<span class="price-chip"><span class="amount">${std} kr</span></span>`
        : `<span class="price-chip"><span class="amount">${std} kr</span> <span class="tier-label">standard</span></span>
           <span class="price-chip"><span class="amount">${stu} kr</span> <span class="tier-label">student</span></span>`;
      const checked = state.ticket && state.ticket.id === t.id ? "checked" : "";
      li.innerHTML = `
        <input type="radio" name="ticket" id="${id}" value="${escapeHtml(t.id)}" ${checked} />
        <label for="${id}">
          <p class="ticket-name">${escapeHtml(t.name)}</p>
          <p class="ticket-note">${escapeHtml(t.note)}</p>
          <div class="price-tiers">${priceBits}</div>
        </label>`;
      list.appendChild(li);
    });

    list.onchange = (e) => {
      if (e.target.name !== "ticket") return;
      const t = tickets.find((x) => x.id === e.target.value);
      state.ticket = t || null;
      if (state.ticket) {
        const same = state.ticket.prices.standard === state.ticket.prices.student;
        if (same) state.priceTier = "standard";
        tierWrap.hidden = same;
        updateSelectedPrice();
      }
      $("#btn-to-details").disabled = !state.ticket;
    };

    $$('input[name="priceTier"]').forEach((r) => {
      r.checked = r.value === state.priceTier;
      r.onchange = () => {
        state.priceTier = r.value;
        updateSelectedPrice();
      };
    });

    if (state.ticket) {
      const same = state.ticket.prices.standard === state.ticket.prices.student;
      tierWrap.hidden = same;
      $("#btn-to-details").disabled = false;
      updateSelectedPrice();
    } else {
      tierWrap.hidden = true;
      $("#btn-to-details").disabled = true;
      $("#selected-price").textContent = "";
    }
  }

  function updateSelectedPrice() {
    const el = $("#selected-price");
    if (!state.ticket) {
      el.textContent = "";
      return;
    }
    const amt = currentAmount();
    const tierLabel =
      state.ticket.prices.standard === state.ticket.prices.student
        ? ""
        : ` (${state.priceTier})`;
    el.innerHTML = `Selected: <strong>${amt} kr</strong>${tierLabel}`;
  }

  // ─── Details panel ────────────────────────────────────────────────────────
  function renderDetailsSummary() {
    const box = $("#details-summary");
    const scheduleHost = $("#details-schedule");
    if (!state.event || !state.ticket) {
      box.innerHTML = "";
      if (scheduleHost) scheduleHost.innerHTML = "";
      return;
    }
    if (scheduleHost) scheduleHost.innerHTML = scheduleHtml(state.event);
    const amt = currentAmount();
    const tier =
      state.ticket.prices.standard === state.ticket.prices.student
        ? ""
        : ` · ${state.priceTier}`;
    box.innerHTML = `
      <dl>
        <dt>Night</dt>
        <dd>${escapeHtml(formatEventDate(state.event))} · ${escapeHtml(state.event.location)}</dd>
        <dt>Ticket</dt>
        <dd>${escapeHtml(ticketLabel(state.ticket))}${escapeHtml(tier)}</dd>
        <dt>Amount</dt>
        <dd>${amt} kr · Vipps #${CONFIG.VIPPS_NUMBER}</dd>
      </dl>`;

    $("#details-amount").textContent = `${amt} kr`;
  }

  function setFirstTimerVisibility() {
    const repeat = $("#is-repeat").checked;
    const wrap = $("#first-timer-fields");
    wrap.classList.toggle("hidden", repeat);
    wrap.setAttribute("aria-hidden", repeat ? "true" : "false");
    $$("select, input", wrap).forEach((el) => {
      el.disabled = repeat;
      // Experience + how-found stay optional even for first-timers
      if (el.id === "experience" || el.id === "how-found") {
        el.required = false;
        el.setAttribute("aria-required", "false");
      }
    });
    if (repeat) {
      $("#how-found-other-wrap").hidden = true;
      clearFieldError("how-found-other");
      clearFieldError("experience");
      clearFieldError("how-found");
    } else {
      onHowFoundChange();
    }
    validateForm();
  }

  function onHowFoundChange() {
    const val = $("#how-found").value;
    const otherWrap = $("#how-found-other-wrap");
    const show = val === "other" && !$("#is-repeat").checked;
    otherWrap.hidden = !show;
    const otherInput = $("#how-found-other");
    otherInput.required = show;
    otherInput.setAttribute("aria-required", show ? "true" : "false");
    if (!show) {
      otherInput.value = "";
      clearFieldError("how-found-other");
    }
    validateForm();
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  }

  /** Loose Norwegian / intl phone: optional +, digits, spaces, dashes; 8–15 digits. */
  function isValidPhone(v) {
    const s = String(v).trim();
    if (!s) return true; // optional
    if (!/^[+\d][\d\s()./-]*$/.test(s)) return false;
    const digits = s.replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15;
  }

  function isValidTransactionNumber(v) {
    const s = String(v).trim();
    return s.length >= 4 && s.length <= 64;
  }

  function showFieldError(id, show) {
    const input = $(`#${id}`);
    const err = $(`#err-${id}`);
    if (input) {
      input.setAttribute("aria-invalid", show ? "true" : "false");
    }
    if (err) err.classList.toggle("visible", !!show);
  }

  function clearFieldError(id) {
    showFieldError(id, false);
  }

  function validateForm(showErrors) {
    const name = $("#full-name").value.trim();
    const email = $("#email").value.trim();
    const phone = $("#phone").value.trim();
    const repeat = $("#is-repeat").checked;
    const howFound = $("#how-found").value;
    const howOther = $("#how-found-other").value.trim();
    const txn = $("#transaction-number").value.trim();

    const nameOk = name.length >= 2;
    const emailOk = isValidEmail(email);
    const phoneOk = isValidPhone(phone);
    // Experience + how-found optional; blank is OK
    let otherOk = true;
    if (!repeat && howFound === "other") {
      otherOk = howOther.length >= 2;
    }
    const txnOk = isValidTransactionNumber(txn);

    const ok = nameOk && emailOk && phoneOk && otherOk && txnOk;

    if (showErrors) {
      showFieldError("full-name", !nameOk);
      showFieldError("email", !emailOk);
      showFieldError("phone", !phoneOk && !!phone);
      showFieldError("how-found-other", !otherOk && howFound === "other");
      showFieldError("transaction-number", !txnOk);
      const live = $("#form-live");
      if (live) {
        live.textContent = ok
          ? ""
          : "Please fix the highlighted fields before continuing.";
      }
    } else {
      if (nameOk) clearFieldError("full-name");
      if (emailOk) clearFieldError("email");
      if (phoneOk) clearFieldError("phone");
      if (otherOk) clearFieldError("how-found-other");
      if (txnOk) clearFieldError("transaction-number");
      const live = $("#form-live");
      if (live && ok) live.textContent = "";
    }

    $("#btn-submit").disabled = !ok;
    return ok;
  }

  function togglePhoneHelp() {
    const btn = $("#phone-help-toggle");
    const panel = $("#phone-help");
    if (!btn || !panel) return;
    const open = btn.getAttribute("aria-expanded") === "true";
    const next = !open;
    btn.setAttribute("aria-expanded", next ? "true" : "false");
    panel.hidden = !next;
  }

  /**
   * Optional email lookup hook for future “I’ve attended before” prefill.
   * GET ?action=lookup&email=...
   */
  async function lookupByEmail(email) {
    if (!CONFIG.APPS_SCRIPT_URL) return { ok: false, reason: "no-url" };
    try {
      const url =
        CONFIG.APPS_SCRIPT_URL +
        "?action=lookup&email=" +
        encodeURIComponent(email);
      const res = await fetch(url, { method: "GET", redirect: "follow" });
      return await res.json();
    } catch (err) {
      return { ok: false, reason: "network", error: String(err) };
    }
  }
  window.HustleOsloLookup = lookupByEmail;

  // ─── Submit ───────────────────────────────────────────────────────────────
  function buildPayload() {
    const repeat = $("#is-repeat").checked;
    const howFound = repeat ? "" : $("#how-found").value;
    const experience = repeat ? "" : $("#experience").value;
    const phone = $("#phone").value.trim();
    const transactionNumber = $("#transaction-number").value.trim();
    return {
      timestamp: new Date().toISOString(),
      fullName: $("#full-name").value.trim(),
      email: $("#email").value.trim().toLowerCase(),
      phone: phone,
      transactionNumber: transactionNumber,
      eventId: state.event.id,
      eventDate: state.event.date,
      eventType: state.event.type,
      eventLocation: state.event.location,
      eventLabel: state.event.label,
      eventVenue: state.event.venue,
      eventStart: state.event.start,
      eventEnd: state.event.end,
      sheetTabHint: sheetTabName(state.event),
      ticketId: state.ticket.id,
      ticketName: state.ticket.name,
      priceTier: state.priceTier,
      amount: currentAmount(),
      currency: "NOK",
      experience: experience,
      experienceLabel: EXPERIENCE_LABELS[experience] || "",
      howFound: howFound,
      howFoundLabel: HOW_FOUND_LABELS[howFound] || "",
      howFoundOther: howFound === "other" ? $("#how-found-other").value.trim() : "",
      isRepeat: repeat,
      vippsNumber: CONFIG.VIPPS_NUMBER,
    };
  }

  async function submitSignup(payload) {
    if (!CONFIG.APPS_SCRIPT_URL) {
      const queued = queueLocally(payload);
      await new Promise((r) => setTimeout(r, 300));
      console.warn(
        "[Hustle Oslo] APPS_SCRIPT_URL is empty — signup queued in sessionStorage. Set CONFIG.APPS_SCRIPT_URL in app.js after Apps Script deploy."
      );
      return { ok: true, mocked: true, queued };
    }
    const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function showConfirmation(submitResult) {
    state.submitted = true;
    state.submitOk = !!(submitResult && submitResult.ok !== false);

    $("#confirm-amount").textContent = `${currentAmount()} kr`;
    $("#confirm-transaction").textContent =
      $("#transaction-number").value.trim() || "—";

    const status = $("#submit-status");
    if (submitResult && submitResult.mocked) {
      status.className = "status-banner warning";
      status.innerHTML =
        "<strong>You’re booked — thanks for Vippsing.</strong> " +
        "The online signup sheet is not wired yet (Claire still needs to deploy Apps Script). " +
        "Your details (including transaction #) were saved in this browser session. Screenshot this page and DM @hustleoslo if anything looks off.";
    } else if (state.submitOk) {
      status.className = "status-banner success";
      status.innerHTML =
        "<strong>Signup recorded.</strong> See you on the floor — keep your Vipps transaction number handy.";
    } else {
      status.className = "status-banner warning";
      status.innerHTML =
        "<strong>We couldn’t save your signup online.</strong> Screenshot this page (transaction # + details) and DM @hustleoslo on Instagram so we can confirm you.";
    }

    const box = $("#confirm-summary");
    const tier =
      state.ticket.prices.standard === state.ticket.prices.student
        ? ""
        : ` (${state.priceTier})`;
    const phone = $("#phone").value.trim();
    box.innerHTML = `
      <dl>
        <dt>Name</dt><dd>${escapeHtml($("#full-name").value.trim())}</dd>
        <dt>Email</dt><dd>${escapeHtml($("#email").value.trim())}</dd>
        ${phone ? `<dt>Phone</dt><dd>${escapeHtml(phone)}</dd>` : ""}
        <dt>Night</dt><dd>${escapeHtml(formatEventDate(state.event))} · ${escapeHtml(state.event.location)}</dd>
        <dt>Ticket</dt><dd>${escapeHtml(ticketLabel(state.ticket))}${escapeHtml(tier)}</dd>
        <dt>Amount</dt><dd>${currentAmount()} kr · Vipps #${CONFIG.VIPPS_NUMBER}</dd>
        <dt>Transaction #</dt><dd>${escapeHtml($("#transaction-number").value.trim())}</dd>
        <dt>Schedule</dt><dd>${
          state.event.type === "class"
            ? "Beginners 18:00–19:00 · Intermediate 19:00–20:00 · Social 20:00–21:00"
            : "Social 18:00–21:00"
        }</dd>
      </dl>`;

    goTo(5);
  }

  async function onFormSubmit(e) {
    e.preventDefault();
    if (!validateForm(true)) {
      const firstBad = $("#signup-form [aria-invalid='true']");
      if (firstBad) firstBad.focus();
      return;
    }
    if (!state.event || !state.ticket) return;

    const payload = buildPayload();

    $("#confirm-amount").textContent = `${currentAmount()} kr`;
    $("#confirm-transaction").textContent = payload.transactionNumber;
    const status = $("#submit-status");
    status.className = "status-banner pending";
    status.textContent = "Saving your signup…";
    goTo(5);

    $("#btn-submit").disabled = true;
    try {
      const result = await submitSignup(payload);
      showConfirmation(result);
    } catch (err) {
      console.error(err);
      queueLocally(payload);
      showConfirmation({ ok: false, error: String(err) });
    }
  }

  function resetForNewSignup() {
    state.step = 1;
    state.event = null;
    state.ticket = null;
    state.priceTier = "standard";
    state.submitted = false;
    state.submitOk = null;
    $("#signup-form").reset();
    $("#is-repeat").checked = false;
    const live = $("#form-live");
    if (live) live.textContent = "";
    const helpBtn = $("#phone-help-toggle");
    const helpPanel = $("#phone-help");
    if (helpBtn) helpBtn.setAttribute("aria-expanded", "false");
    if (helpPanel) helpPanel.hidden = true;
    setFirstTimerVisibility();
    clearFieldError("full-name");
    clearFieldError("email");
    clearFieldError("phone");
    clearFieldError("experience");
    clearFieldError("how-found");
    clearFieldError("how-found-other");
    clearFieldError("transaction-number");
    renderEvents();
    goTo(1);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    const landingHost = $("#landing-schedule");
    if (landingHost) landingHost.innerHTML = landingScheduleHintHtml();

    renderEvents();
    // Event delegation once (avoid stacking listeners on re-render)
    $("#event-list").addEventListener("change", onEventChange);

    $$("[data-go]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = +btn.dataset.go;
        if (target === 3) {
          if (!state.event) return;
          renderTickets();
        }
        if (target === 4) {
          if (!state.ticket) return;
          renderDetailsSummary();
          validateForm();
        }
        // Leaving details back to ticket: keep code so Back/Continue doesn't churn codes
        goTo(target);
      });
    });

    $("#is-repeat").addEventListener("change", setFirstTimerVisibility);
    $("#how-found").addEventListener("change", onHowFoundChange);
    $("#experience").addEventListener("change", () => validateForm());
    $("#full-name").addEventListener("input", () => validateForm());
    $("#email").addEventListener("input", () => validateForm());
    $("#phone").addEventListener("input", () => validateForm());
    $("#how-found-other").addEventListener("input", () => validateForm());
    $("#transaction-number").addEventListener("input", () => validateForm());
    $("#phone-help-toggle").addEventListener("click", togglePhoneHelp);
    $("#signup-form").addEventListener("submit", onFormSubmit);
    $("#btn-new-signup").addEventListener("click", resetForNewSignup);

    setFirstTimerVisibility();
    validateForm();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
