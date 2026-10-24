/* About hustle "See more" / "See less".
 * Mobile: 3 lines collapsed. Desktop (2 columns): About sits right under Register and
 * is clamped so its bottom (See more included) is level with the bottom of More Details
 * in the right column; at least 3 lines, and no button when everything fits.
 * The full text stays in the DOM; without JS nothing is clamped. */
(function () {
  "use strict";
  var body = document.getElementById("about-body");
  var btn = document.getElementById("about-toggle");
  var section = document.getElementById("landing-about");
  var details = document.getElementById("landing-details");
  if (!body || !btn || !section) return;

  var MOBILE_LINES = 3;
  var twoCol = window.matchMedia ? window.matchMedia("(min-width: 960px)") : null;
  var reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var expanded = false;
  var clampPx = 0;

  function lineHeight() {
    var p = body.querySelector("p") || body;
    var lh = parseFloat(window.getComputedStyle(p).lineHeight);
    return isFinite(lh) && lh > 0 ? lh : 22;
  }

  var extraPx = 0;

  function setClamped(on) {
    if (on) {
      body.classList.add("is-clamped");
      body.style.maxHeight = clampPx + "px";
      btn.style.marginTop = extraPx ? "calc(0.3rem + " + extraPx.toFixed(2) + "px)" : "";
    } else {
      body.classList.remove("is-clamped");
      body.style.maxHeight = "";
      btn.style.marginTop = "";
    }
  }

  function noClamp() {
    expanded = false;
    extraPx = 0;
    btn.hidden = true;
    btn.textContent = "See more";
    btn.setAttribute("aria-expanded", "false");
    setClamped(false);
    section.removeAttribute("data-about-lines");
  }

  function measure() {
    if (section.getClientRects().length === 0) return; // landing hidden
    var lh = lineHeight();
    var full = body.scrollHeight;
    var lines = MOBILE_LINES;
    extraPx = 0;
    if (twoCol && twoCol.matches && details) {
      // Desktop: About sits right under Register in the left column. Clamp it so
      // the bottom of the About block (See more included) is level with the
      // bottom of More Details in the right column.
      btn.hidden = false;
      btn.style.marginTop = "";
      var bodyTop = body.getBoundingClientRect().top;
      var target = details.getBoundingClientRect().bottom;
      if (bodyTop + full <= target + 1) { noClamp(); return; }
      var toggleOuter = section.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
      var avail = target - bodyTop - toggleOuter;
      lines = Math.floor((avail + 0.5) / lh);
      if (lines < MOBILE_LINES) {
        lines = MOBILE_LINES; // not enough room: show 3 lines anyway
      } else {
        extraPx = Math.max(0, avail - lines * lh);
      }
    }
    clampPx = lines * lh;
    if (full <= clampPx + 2) { noClamp(); return; }
    btn.hidden = false;
    section.setAttribute("data-about-lines", String(lines));
    setClamped(!expanded);
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
      setClamped(false);
      animate(clampPx, body.scrollHeight, function () { body.style.maxHeight = ""; });
    } else {
      var start = body.scrollHeight;
      animate(start, clampPx, function () { setClamped(true); });
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
