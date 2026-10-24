/* About hustle "See more" / "See less".
 * Mobile: about 3 lines collapsed. Desktop (2 columns): the collapsed text fills the
 * same height as More Details beside it, so the two blocks end together.
 * The full text stays in the DOM; without JS nothing is clamped. */
(function () {
  "use strict";
  var body = document.getElementById("about-body");
  var btn = document.getElementById("about-toggle");
  var section = document.getElementById("landing-about");
  var details = document.getElementById("landing-details");
  if (!body || !btn || !section) return;

  var MOBILE_LINES = 3;
  var MIN_LINES = 2;
  var twoCol = window.matchMedia ? window.matchMedia("(min-width: 960px)") : null;
  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var expanded = false;
  var clampPx = 0;

  function lineHeight() {
    var p = body.querySelector("p") || body;
    var lh = parseFloat(window.getComputedStyle(p).lineHeight);
    return isFinite(lh) && lh > 0 ? lh : 22;
  }

  function linesWanted() {
    if (!(twoCol && twoCol.matches) || !details) return MOBILE_LINES;
    var heading = section.querySelector(".landing-label");
    var headH = heading ? heading.getBoundingClientRect().height + parseFloat(window.getComputedStyle(heading).marginBottom || 0) : 0;
    var avail = details.getBoundingClientRect().height - headH;
    return Math.max(MIN_LINES, Math.floor((avail + 1) / lineHeight()));
  }

  function measure() {
    if (!section.offsetParent && section.getClientRects().length === 0) return; // landing hidden
    clampPx = Math.round(linesWanted() * lineHeight());
    var full = body.scrollHeight;
    var needs = full > clampPx + 2;
    btn.hidden = !needs;
    if (!needs) {
      expanded = false;
      body.classList.remove("is-clamped");
      body.style.maxHeight = "";
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    if (expanded) {
      body.classList.remove("is-clamped");
      body.style.maxHeight = "";
    } else {
      body.classList.add("is-clamped");
      body.style.maxHeight = clampPx + "px";
    }
  }

  function animate(from, to, done) {
    if (reduce && reduce.matches) { done(); return; }
    body.classList.add("is-animating");
    body.style.maxHeight = from + "px";
    void body.offsetHeight;
    body.style.maxHeight = to + "px";
    var finished = false;
    function end() {
      if (finished) return;
      finished = true;
      body.classList.remove("is-animating");
      body.removeEventListener("transitionend", end);
      done();
    }
    body.addEventListener("transitionend", end);
    window.setTimeout(end, 400);
  }

  btn.addEventListener("click", function () {
    expanded = !expanded;
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    btn.textContent = expanded ? "See less" : "See more";
    if (expanded) {
      body.classList.remove("is-clamped");
      animate(clampPx, body.scrollHeight, function () { body.style.maxHeight = ""; });
    } else {
      var start = body.scrollHeight;
      animate(start, clampPx, function () {
        body.classList.add("is-clamped");
        body.style.maxHeight = clampPx + "px";
      });
    }
  });

  var t = 0;
  function schedule() { window.clearTimeout(t); t = window.setTimeout(measure, 60); }
  window.addEventListener("resize", schedule);
  if (twoCol && typeof twoCol.addEventListener === "function") twoCol.addEventListener("change", schedule);
  if (window.ResizeObserver && details) new window.ResizeObserver(schedule).observe(details);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  window.addEventListener("load", measure);
  measure();
})();
