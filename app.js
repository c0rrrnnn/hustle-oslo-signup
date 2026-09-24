/**
 * Hustle Oslo — signup app (vanilla JS, no build step)
 * Vipps number #48782 (NOT Vipps Checkout). Payment reference: Vipps transaction number.
 * Flow: Intro → Date (multi calendar) → Tickets → Details (pay via Vipps + transaction #) → confirmation
 */
(function () {
  "use strict";

  // ─── CONFIG ───────────────────────────────────────────────────────────────
  // Claire: paste your deployed Google Apps Script Web App URL here after deploy.
  // Leave empty until then — signup still shows confirmation + local queue.
  const CONFIG = {
    APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbx4hG1wNzoJaZglMuyZE_dPsyTt5ohRCbp5tukFhWPiQc5binIOaVcskl2GIUz4Fzf7/exec",
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

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  const state = {
    step: 1,
    selectedEvents: [],
    calendarFocusDate: null,
    calendarYear: null,
    calendarMonth: null, // 1–12
    selections: [], // [{ event, ticket, priceTier }, ...]
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

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function toDateKey(y, m, d) {
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /** Monday=0 … Sunday=6 for calendar grid. */
  function mondayIndex(y, m, d) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // Sun=0
    return (dow + 6) % 7;
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

  function eventsByDate(dateKey) {
    return upcomingEvents().filter((e) => e.date === dateKey);
  }

  function eventsOnMonth(y, m) {
    const prefix = `${y}-${pad2(m)}-`;
    return upcomingEvents().filter((e) => e.date.startsWith(prefix));
  }

  function isEventSelected(ev) {
    return state.selectedEvents.some((e) => e.id === ev.id);
  }

  function toggleSelectedEvent(ev) {
    const idx = state.selectedEvents.findIndex((e) => e.id === ev.id);
    if (idx >= 0) {
      state.selectedEvents.splice(idx, 1);
    } else {
      state.selectedEvents.push(ev);
      state.selectedEvents.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    }
    // Drop ticket selection for deselected nights
    state.selections = state.selections.filter((s) =>
      state.selectedEvents.some((e) => e.id === s.event.id)
    );
    updateDateNextButton();
    renderCalendar();
    renderDayPills();
  }

  function selectionForEvent(eventId) {
    return state.selections.find((s) => s.event.id === eventId) || null;
  }

  function amountForSelection(sel) {
    if (!sel || !sel.ticket) return 0;
    const tier = sel.priceTier || "standard";
    const prices = sel.ticket.prices;
    if (tier === "student" && typeof prices.student === "number") return prices.student;
    return prices.standard;
  }

  function currentAmount() {
    return state.selections.reduce((sum, s) => sum + amountForSelection(s), 0);
  }

  function allTicketsChosen() {
    if (!state.selectedEvents.length) return false;
    return state.selectedEvents.every((ev) => {
      const sel = selectionForEvent(ev.id);
      return sel && sel.ticket;
    });
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

  // ─── Schedule HTML ────────────────────────────────────────────────────────
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

  // ─── Calendar ─────────────────────────────────────────────────────────────
  function initCalendarMonth() {
    const events = upcomingEvents();
    const now = osloNow();
    if (events.length) {
      const [y, m] = events[0].date.split("-").map(Number);
      state.calendarYear = y;
      state.calendarMonth = m;
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
    const key = state.calendarYear * 12 + state.calendarMonth;
    const min = b.minY * 12 + b.minM;
    return key > min;
  }

  function canNextMonth() {
    const b = monthBounds();
    const key = state.calendarYear * 12 + state.calendarMonth;
    const max = b.maxY * 12 + b.maxM;
    return key < max;
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

  function updateDateNextButton() {
    const btn = $("#btn-to-ticket");
    const n = state.selectedEvents.length;
    if (!btn) return;
    btn.disabled = n < 1;
    if (n < 1) {
      btn.textContent = "Next";
    } else if (n === 1) {
      btn.textContent = "Next · 1 night";
    } else {
      btn.textContent = `Next · ${n} nights`;
    }
  }

  function renderCalendar() {
    const mount = $("#calendar-mount");
    const empty = $("#no-events");
    if (!mount) return;

    const events = upcomingEvents();
    if (!events.length) {
      mount.innerHTML = "";
      mount.hidden = true;
      if (empty) empty.hidden = false;
      updateDateNextButton();
      renderDayPills();
      return;
    }
    mount.hidden = false;
    if (empty) empty.hidden = true;

    if (state.calendarYear == null) initCalendarMonth();

    const y = state.calendarYear;
    const m = state.calendarMonth;
    const now = osloNow();
    const todayKey = toDateKey(now.y, now.m, now.d);
    const dim = daysInMonth(y, m);
    const startPad = mondayIndex(y, m, 1);

    const byDate = {};
    eventsOnMonth(y, m).forEach((ev) => {
      if (!byDate[ev.date]) byDate[ev.date] = [];
      byDate[ev.date].push(ev);
    });

    const selectedDates = new Set(state.selectedEvents.map((e) => e.date));

    let cells = "";
    for (let i = 0; i < startPad; i++) {
      cells += `<button type="button" class="cal-day cal-day--empty" tabindex="-1" aria-hidden="true" disabled></button>`;
    }
    for (let d = 1; d <= dim; d++) {
      const key = toDateKey(y, m, d);
      const dayEvents = byDate[key] || [];
      const has = dayEvents.length > 0;
      const isToday = key === todayKey;
      const isFocused = state.calendarFocusDate === key;
      const isSelected = selectedDates.has(key);
      const classes = [
        "cal-day",
        has ? "cal-day--has-event" : "cal-day--muted",
        isToday ? "cal-day--today" : "",
        isFocused ? "cal-day--focused" : "",
        isSelected ? "cal-day--selected" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const dots = dayEvents
        .map(
          (ev) =>
            `<span class="cal-dot cal-dot--${ev.type === "class" ? "class" : "social"}" aria-hidden="true"></span>`
        )
        .join("");

      const labelParts = [`${d} ${MONTH_NAMES[m - 1]} ${y}`];
      if (has) {
        labelParts.push(
          dayEvents
            .map((ev) => `${ev.label || ev.type} at ${ev.location}`)
            .join(", ")
        );
      }
      if (isSelected) labelParts.push("selected");
      if (isFocused) labelParts.push("focused");

      cells += `
        <button
          type="button"
          class="${classes}"
          data-date="${key}"
          ${has ? "" : "disabled"}
          aria-label="${escapeHtml(labelParts.join(" — "))}"
          aria-pressed="${isSelected ? "true" : "false"}"
          aria-current="${isFocused ? "date" : "false"}"
        >
          <span class="cal-day-num">${d}</span>
          <span class="cal-dots">${dots}</span>
        </button>`;
    }

    mount.innerHTML = `
      <div class="cal-header">
        <button type="button" class="cal-nav" id="cal-prev" aria-label="Previous month" ${canPrevMonth() ? "" : "disabled"}>‹</button>
        <h3 class="cal-title" id="cal-month-label">${MONTH_NAMES[m - 1]} ${y}</h3>
        <button type="button" class="cal-nav" id="cal-next" aria-label="Next month" ${canNextMonth() ? "" : "disabled"}>›</button>
      </div>
      <div class="cal-weekdays" aria-hidden="true">
        ${WEEKDAYS_SHORT.map((w) => `<div class="cal-weekday">${w}</div>`).join("")}
      </div>
      <div class="cal-grid" role="grid" aria-labelledby="cal-month-label">
        ${cells}
      </div>
      <div class="cal-legend" aria-hidden="true">
        <span class="cal-legend-item"><span class="cal-dot cal-dot--class"></span> Class night</span>
        <span class="cal-legend-item"><span class="cal-dot cal-dot--social"></span> Social night</span>
      </div>
    `;

    $("#cal-prev", mount).addEventListener("click", () => {
      if (canPrevMonth()) shiftMonth(-1);
    });
    $("#cal-next", mount).addEventListener("click", () => {
      if (canNextMonth()) shiftMonth(1);
    });
    $$(".cal-day--has-event", mount).forEach((btn) => {
      btn.addEventListener("click", () => {
        state.calendarFocusDate = btn.dataset.date;
        renderCalendar();
        renderDayPills();
        const pills = $("#day-pills");
        if (pills) {
          const firstPill = $(".event-pill", pills);
          if (firstPill) firstPill.focus();
        }
      });
    });

    updateDateNextButton();
  }

  function renderDayPills() {
    const host = $("#day-pills");
    if (!host) return;
    const key = state.calendarFocusDate;
    if (!key) {
      host.innerHTML = `<p class="day-pills-hint">Select a day with a coloured dot to see available nights.</p>`;
      return;
    }
    const dayEvents = eventsByDate(key);
    if (!dayEvents.length) {
      host.innerHTML = `<p class="day-pills-hint">No upcoming nights on this day.</p>`;
      return;
    }

    const [y, m, d] = key.split("-").map(Number);
    const heading = `${WEEKDAYS_SHORT[mondayIndex(y, m, d)]} ${d} ${MONTH_NAMES[m - 1]}`;

    host.innerHTML = `
      <p class="day-pills-hint" id="day-pills-heading">Available on ${escapeHtml(heading)} — tap to select</p>
      ${dayEvents
        .map((ev) => {
          const pressed = isEventSelected(ev);
          const badge =
            ev.type === "class"
              ? `<span class="badge badge-class">Class night</span>`
              : `<span class="badge badge-social">Social only</span>`;
          return `
          <button
            type="button"
            class="event-pill"
            data-event-id="${escapeHtml(ev.id)}"
            aria-pressed="${pressed ? "true" : "false"}"
            aria-describedby="day-pills-heading"
          >
            <span class="event-pill-check" aria-hidden="true"></span>
            <span class="event-pill-body">
              <p class="event-pill-title">${escapeHtml(ev.label || (ev.type === "class" ? "Class night" : "Social night"))}</p>
              <p class="event-pill-meta">${escapeHtml(ev.location)} · ${escapeHtml(ev.venue)} · ${escapeHtml(ev.start)}–${escapeHtml(ev.end)}</p>
              ${badge}
            </span>
          </button>`;
        })
        .join("")}
      ${
        state.selectedEvents.length
          ? `<p class="selected-nights-count" aria-live="polite">${state.selectedEvents.length} night${state.selectedEvents.length === 1 ? "" : "s"} selected</p>`
          : ""
      }
    `;

    $$(".event-pill", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const ev = upcomingEvents().find((x) => x.id === btn.dataset.eventId);
        if (ev) toggleSelectedEvent(ev);
      });
    });
  }

  // ─── Tickets (per selected night) ─────────────────────────────────────────
  function ensureSelectionsScaffold() {
    state.selectedEvents.forEach((ev) => {
      if (!selectionForEvent(ev.id)) {
        state.selections.push({ event: ev, ticket: null, priceTier: "standard" });
      } else {
        // Refresh event ref
        const sel = selectionForEvent(ev.id);
        sel.event = ev;
      }
    });
    state.selections = state.selections.filter((s) =>
      state.selectedEvents.some((e) => e.id === s.event.id)
    );
    state.selections.sort(
      (a, b) => a.event.date.localeCompare(b.event.date) || a.event.id.localeCompare(b.event.id)
    );
  }

  function setSelectionTicket(eventId, ticket) {
    let sel = selectionForEvent(eventId);
    if (!sel) {
      const ev = state.selectedEvents.find((e) => e.id === eventId);
      if (!ev) return;
      sel = { event: ev, ticket: null, priceTier: "standard" };
      state.selections.push(sel);
    }
    sel.ticket = ticket || null;
    if (ticket) {
      const same = ticket.prices.standard === ticket.prices.student;
      if (same) sel.priceTier = "standard";
    }
    updateTicketUi();
  }

  function setSelectionTier(eventId, tier) {
    const sel = selectionForEvent(eventId);
    if (!sel) return;
    sel.priceTier = tier;
    updateTicketUi();
  }

  function updateTicketUi() {
    const ready = allTicketsChosen();
    $("#btn-to-details").disabled = !ready;
    const el = $("#selected-price");
    if (!el) return;
    if (!ready) {
      const n = state.selectedEvents.length;
      const done = state.selections.filter((s) => s.ticket).length;
      el.textContent =
        n > 0
          ? `Choose a ticket for each night (${done}/${n})`
          : "";
      return;
    }
    const amt = currentAmount();
    const n = state.selections.length;
    el.innerHTML = `Total: <strong>${amt} kr</strong> · ${n} night${n === 1 ? "" : "s"}`;
  }

  function renderTickets() {
    const host = $("#ticket-nights");
    const summary = $("#ticket-event-summary");
    if (!host) return;
    ensureSelectionsScaffold();

    const n = state.selectedEvents.length;
    if (summary) {
      summary.textContent =
        n === 1
          ? "Choose your ticket for this night."
          : `Choose a ticket for each of the ${n} nights you selected.`;
    }

    host.innerHTML = "";
    state.selectedEvents.forEach((ev) => {
      const sel = selectionForEvent(ev.id);
      const tickets =
        (window.HUSTLE_TICKETS && window.HUSTLE_TICKETS[ev.type]) || [];
      const block = document.createElement("div");
      block.className = "ticket-night";
      block.dataset.eventId = ev.id;

      const badge =
        ev.type === "class"
          ? `<span class="badge badge-class">Class night</span>`
          : `<span class="badge badge-social">Social only</span>`;

      const ticketItems = tickets
        .map((t) => {
          const std = t.prices.standard;
          const stu = t.prices.student;
          const samePrice = std === stu;
          const priceBits = samePrice
            ? `<span class="price-chip"><span class="amount">${std} kr</span></span>`
            : `<span class="price-chip"><span class="amount">${std} kr</span> <span class="tier-label">standard</span></span>
               <span class="price-chip"><span class="amount">${stu} kr</span> <span class="tier-label">student</span></span>`;
          const checked = sel && sel.ticket && sel.ticket.id === t.id ? "checked" : "";
          const id = `ticket-${escapeHtml(ev.id)}-${escapeHtml(t.id)}`;
          const priceLine = `${std} kr`;
          return `
            <li class="ticket-option">
              <input type="radio" name="ticket-${escapeHtml(ev.id)}" id="${id}" value="${escapeHtml(t.id)}" ${checked} />
              <label for="${id}">
                <span class="radio-check" aria-hidden="true"></span>
                <span class="option-body">
                  <p class="ticket-name">${escapeHtml(t.name)}</p>
                  <p class="ticket-price">${priceLine}</p>
                  <p class="ticket-note">${escapeHtml(t.note)}</p>
                  <div class="price-tiers">${priceBits}</div>
                </span>
              </label>
            </li>`;
        })
        .join("");

      const showTier =
        sel &&
        sel.ticket &&
        sel.ticket.prices.standard !== sel.ticket.prices.student;
      const tierStandardChecked =
        !sel || sel.priceTier !== "student" ? "checked" : "";
      const tierStudentChecked = sel && sel.priceTier === "student" ? "checked" : "";

      block.innerHTML = `
        <div class="ticket-night-header">
          <p class="ticket-night-title">${escapeHtml(formatEventDate(ev))}</p>
          <p class="ticket-night-meta">${escapeHtml(ev.location)} · ${escapeHtml(ev.start)}–${escapeHtml(ev.end)}</p>
          ${badge}
        </div>
        ${scheduleHtml(ev)}
        <fieldset class="ticket-fieldset">
          <legend>Ticket type</legend>
          <ul class="ticket-list" role="list">${ticketItems}</ul>
        </fieldset>
        <div class="tier-select" ${showTier ? "" : "hidden"}>
          <fieldset>
            <legend>Price</legend>
            <div class="radio-row" role="radiogroup" aria-label="Price tier for ${escapeHtml(formatEventDate(ev))}">
              <div class="radio-pill">
                <input type="radio" name="priceTier-${escapeHtml(ev.id)}" id="tier-standard-${escapeHtml(ev.id)}" value="standard" ${tierStandardChecked} />
                <label for="tier-standard-${escapeHtml(ev.id)}">Standard</label>
              </div>
              <div class="radio-pill">
                <input type="radio" name="priceTier-${escapeHtml(ev.id)}" id="tier-student-${escapeHtml(ev.id)}" value="student" ${tierStudentChecked} />
                <label for="tier-student-${escapeHtml(ev.id)}">Student</label>
              </div>
            </div>
            <p class="student-note">
              Student price is on the honour system — if you’re a student, pick student. No proof needed.
            </p>
          </fieldset>
        </div>
      `;

      host.appendChild(block);

      block.querySelector(".ticket-list").addEventListener("change", (e) => {
        if (!e.target.matches('input[type="radio"]')) return;
        const t = tickets.find((x) => x.id === e.target.value);
        setSelectionTicket(ev.id, t || null);
        // Re-render to update tier visibility cleanly
        renderTickets();
      });

      $$('input[name^="priceTier-"]', block).forEach((r) => {
        r.addEventListener("change", () => {
          setSelectionTier(ev.id, r.value);
        });
      });
    });

    updateTicketUi();
  }

  // ─── Details panel ────────────────────────────────────────────────────────
  function renderDetailsSummary() {
    const box = $("#details-summary");
    const scheduleHost = $("#details-schedule");
    if (!allTicketsChosen()) {
      if (box) {
        box.innerHTML = "";
        box.hidden = true;
      }
      if (scheduleHost) scheduleHost.innerHTML = "";
      return;
    }

    const n = state.selections.length;
    const amt = currentAmount();

    if (scheduleHost) {
      // Show first night schedule; multi nights listed in summary
      scheduleHost.innerHTML =
        n === 1
          ? scheduleHtml(state.selections[0].event)
          : `<div class="schedule-block schedule-block--muted" role="region" aria-label="Selected nights">
              <h3 class="schedule-title">Your nights</h3>
              <ul class="schedule-list">
                ${state.selections
                  .map((s) => {
                    const sched =
                      s.event.type === "class"
                        ? "Beginners 18:00 · Intermediate 19:00 · Social 20:00"
                        : "Social 18:00–21:00";
                    return `<li><span class="schedule-slot">${escapeHtml(formatEventDate(s.event))}</span> <span>${escapeHtml(s.event.location)} · ${sched}</span></li>`;
                  })
                  .join("")}
              </ul>
            </div>`;
    }

    const sectionLabel = $(".section-label");
    if (sectionLabel) {
      sectionLabel.textContent = n === 1 ? "Ticket" : "Tickets";
    }

    const heroTitle = $("#reg-hero-title");
    const heroMeta = $("#reg-hero-meta");
    if (heroTitle) {
      heroTitle.textContent =
        n === 1
          ? state.selections[0].event.type === "class"
            ? "Hustle Oslo class night"
            : "Hustle Oslo social night"
          : `Hustle Oslo · ${n} nights`;
    }
    if (heroMeta) {
      if (n === 1) {
        const ev = state.selections[0].event;
        heroMeta.textContent = `${formatEventDate(ev)}, ${ev.start}–${ev.end}`;
      } else {
        heroMeta.textContent = state.selections
          .map((s) => formatEventDate(s.event))
          .join(" · ");
      }
    }

    const tsName = $("#ts-name");
    const tsPrice = $("#ts-price");
    const summaryRow = $("#ticket-summary-row");
    if (summaryRow && n > 1) {
      // Replace single row with multi list
      let list = $("#nights-summary-list");
      if (!list) {
        list = document.createElement("ul");
        list.className = "nights-summary-list";
        list.id = "nights-summary-list";
        summaryRow.insertAdjacentElement("afterend", list);
      }
      summaryRow.hidden = true;
      list.hidden = false;
      list.innerHTML = state.selections
        .map((s) => {
          const tier =
            s.ticket.prices.standard === s.ticket.prices.student
              ? ""
              : ` · ${s.priceTier}`;
          return `
            <li class="nights-summary-item">
              <div class="nsi-main">
                <p class="nsi-title">${escapeHtml(formatEventDate(s.event))} · ${escapeHtml(s.event.location)}</p>
                <p class="nsi-meta">${escapeHtml(ticketLabel(s.ticket))}${escapeHtml(tier)}</p>
              </div>
              <span class="nsi-price">${amountForSelection(s)} kr</span>
            </li>`;
        })
        .join("");
    } else {
      const list = $("#nights-summary-list");
      if (list) list.hidden = true;
      if (summaryRow) summaryRow.hidden = false;
      const s = state.selections[0];
      const tier =
        s.ticket.prices.standard === s.ticket.prices.student
          ? ""
          : ` · ${s.priceTier}`;
      if (tsName) tsName.textContent = `${ticketLabel(s.ticket)}${tier}`;
      if (tsPrice) tsPrice.textContent = `${amountForSelection(s)} kr`;
    }

    if (box) {
      box.hidden = true;
      box.innerHTML = `
      <dl>
        ${state.selections
          .map((s) => {
            const tier =
              s.ticket.prices.standard === s.ticket.prices.student
                ? ""
                : ` · ${s.priceTier}`;
            return `
          <dt>Night</dt>
          <dd>${escapeHtml(formatEventDate(s.event))} · ${escapeHtml(s.event.location)} · ${escapeHtml(ticketLabel(s.ticket))}${escapeHtml(tier)} · ${amountForSelection(s)} kr</dd>`;
          })
          .join("")}
        <dt>Amount</dt>
        <dd>${amt} kr · Vipps #${CONFIG.VIPPS_NUMBER}</dd>
      </dl>`;
    }

    $("#details-amount").textContent = `${amt} kr`;
    updateStickyTotal();
  }

  function updateStickyTotal() {
    const amt = currentAmount();
    const sticky = $("#sticky-amount");
    const btn = $("#btn-submit");
    const ready = allTicketsChosen();
    if (sticky) sticky.textContent = ready ? `${amt} kr` : "";
    if (btn && ready) {
      btn.textContent = `Continue · ${amt} kr`;
    } else if (btn) {
      btn.textContent = "Continue";
    }
  }

  function setFirstTimerVisibility() {
    const repeat = $("#is-repeat").checked;
    const wrap = $("#first-timer-fields");
    wrap.classList.toggle("hidden", repeat);
    wrap.setAttribute("aria-hidden", repeat ? "true" : "false");
    $$("select, input", wrap).forEach((el) => {
      el.disabled = repeat;
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
    if (!s) return true;
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

  // ─── Submit (one POST per night — live Apps Script compatible) ────────────
  function buildPersonFields() {
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
      experience: experience,
      experienceLabel: EXPERIENCE_LABELS[experience] || "",
      howFound: howFound,
      howFoundLabel: HOW_FOUND_LABELS[howFound] || "",
      howFoundOther: howFound === "other" ? $("#how-found-other").value.trim() : "",
      isRepeat: repeat,
      vippsNumber: CONFIG.VIPPS_NUMBER,
      currency: "NOK",
    };
  }

  function buildPayloadForSelection(sel, person) {
    return {
      ...person,
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
      ticketName: sel.ticket.name,
      priceTier: sel.priceTier,
      amount: amountForSelection(sel),
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

  /**
   * Multi-night: loop single-object POSTs so the live Apps Script works
   * without redeploying. Same person + same transactionNumber; per-night amount.
   */
  async function submitAllSignups() {
    const person = buildPersonFields();
    const results = [];
    let mocked = false;
    for (const sel of state.selections) {
      const payload = buildPayloadForSelection(sel, person);
      try {
        const result = await submitSignup(payload);
        if (result && result.mocked) mocked = true;
        results.push({ ok: true, payload, result });
      } catch (err) {
        queueLocally(payload);
        results.push({ ok: false, payload, error: String(err) });
      }
    }
    const allOk = results.every((r) => r.ok);
    const anyOk = results.some((r) => r.ok);
    return {
      ok: allOk,
      partial: anyOk && !allOk,
      mocked,
      results,
    };
  }

  function showConfirmation(submitResult) {
    state.submitted = true;
    state.submitOk = !!(submitResult && submitResult.ok !== false);

    const amt = currentAmount();
    $("#confirm-amount").textContent = `${amt} kr`;
    $("#confirm-transaction").textContent =
      $("#transaction-number").value.trim() || "—";

    const status = $("#submit-status");
    if (submitResult && submitResult.mocked) {
      status.className = "status-banner warning";
      status.innerHTML =
        "<strong>You’re booked — thanks for Vippsing.</strong> " +
        "The online signup sheet is not wired yet (Claire still needs to deploy Apps Script). " +
        "Your details (including transaction #) were saved in this browser session. Screenshot this page and DM @hustleoslo if anything looks off.";
    } else if (submitResult && submitResult.partial) {
      status.className = "status-banner warning";
      status.innerHTML =
        "<strong>Some nights may not have saved online.</strong> Screenshot this page (transaction # + details) and DM @hustleoslo on Instagram so we can confirm you.";
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
    const phone = $("#phone").value.trim();
    const nightsHtml = state.selections
      .map((s) => {
        const tier =
          s.ticket.prices.standard === s.ticket.prices.student
            ? ""
            : ` (${s.priceTier})`;
        const sched =
          s.event.type === "class"
            ? "Beginners 18:00–19:00 · Intermediate 19:00–20:00 · Social 20:00–21:00"
            : "Social 18:00–21:00";
        return `
          <dt>Night</dt>
          <dd>${escapeHtml(formatEventDate(s.event))} · ${escapeHtml(s.event.location)}</dd>
          <dt>Ticket</dt>
          <dd>${escapeHtml(ticketLabel(s.ticket))}${escapeHtml(tier)} · ${amountForSelection(s)} kr</dd>
          <dt>Schedule</dt>
          <dd>${sched}</dd>`;
      })
      .join("");

    box.innerHTML = `
      <dl>
        <dt>Name</dt><dd>${escapeHtml($("#full-name").value.trim())}</dd>
        <dt>Email</dt><dd>${escapeHtml($("#email").value.trim())}</dd>
        ${phone ? `<dt>Phone</dt><dd>${escapeHtml(phone)}</dd>` : ""}
        ${nightsHtml}
        <dt>Total amount</dt><dd>${amt} kr · Vipps #${CONFIG.VIPPS_NUMBER}</dd>
        <dt>Transaction #</dt><dd>${escapeHtml($("#transaction-number").value.trim())}</dd>
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
    if (!allTicketsChosen()) return;

    const amt = currentAmount();
    $("#confirm-amount").textContent = `${amt} kr`;
    $("#confirm-transaction").textContent = $("#transaction-number").value.trim();
    const status = $("#submit-status");
    status.className = "status-banner pending";
    status.textContent =
      state.selections.length > 1
        ? `Saving your ${state.selections.length} signups…`
        : "Saving your signup…";
    goTo(5);

    $("#btn-submit").disabled = true;
    try {
      const result = await submitAllSignups();
      showConfirmation(result);
    } catch (err) {
      console.error(err);
      // Fallback: queue all
      const person = buildPersonFields();
      state.selections.forEach((sel) => {
        queueLocally(buildPayloadForSelection(sel, person));
      });
      showConfirmation({ ok: false, error: String(err) });
    }
  }

  function resetForNewSignup() {
    state.step = 1;
    state.selectedEvents = [];
    state.calendarFocusDate = null;
    state.selections = [];
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
    const list = $("#nights-summary-list");
    if (list) {
      list.hidden = true;
      list.innerHTML = "";
    }
    const summaryRow = $("#ticket-summary-row");
    if (summaryRow) summaryRow.hidden = false;
    setFirstTimerVisibility();
    clearFieldError("full-name");
    clearFieldError("email");
    clearFieldError("phone");
    clearFieldError("experience");
    clearFieldError("how-found");
    clearFieldError("how-found-other");
    clearFieldError("transaction-number");
    initCalendarMonth();
    renderCalendar();
    renderDayPills();
    goTo(1);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    const landingHost = $("#landing-schedule");
    if (landingHost) landingHost.innerHTML = landingScheduleHintHtml();

    initCalendarMonth();
    renderCalendar();
    renderDayPills();

    $$("[data-go]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = +btn.dataset.go;
        if (target === 3) {
          if (!state.selectedEvents.length) return;
          renderTickets();
        }
        if (target === 4) {
          if (!allTicketsChosen()) return;
          renderDetailsSummary();
          validateForm();
        }
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
