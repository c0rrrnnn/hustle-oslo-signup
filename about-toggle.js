/* About hustle inline "… See more" / "See less" (Perplexity Discover style).
 * Collapsed: the text is cut at a word so the last visible line ends with
 * "… See more" on the same line. Mobile: 3 lines. Desktop (2 columns): About sits
 * right under Register and keeps as many whole lines as fit above the bottom of
 * More Details in the right column (at least 3). If the cut is in paragraph 1,
 * paragraph 2 is hidden. Expanded: full text with "See less" after the last
 * paragraph. The remainder stays in the DOM (hidden); without JS the full text
 * shows and the button stays hidden. */
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
  var paras = Array.prototype.slice.call(body.querySelectorAll("p"));
  if (!paras.length) return;

  // Words per paragraph, taken once from the original markup.
  var words = paras.map(function (p) {
    return p.textContent.replace(/\s+/g, " ").trim().split(" ");
  });
  var total = words.reduce(function (n, w) { return n + w.length; }, 0);
  var expanded = false;
  var cut = -1; // number of words visible when collapsed; -1 = everything fits

  btn.classList.add("about-toggle--inline");

  function lineHeight() {
    var lh = parseFloat(window.getComputedStyle(paras[0]).lineHeight);
    return isFinite(lh) && lh > 0 ? lh : 22;
  }

  function fill(p, i, shown) {
    // shown: words of paragraph i to show (null = all, no ellipsis)
    var all = words[i];
    while (p.firstChild) p.removeChild(p.firstChild);
    if (shown === null) {
      p.appendChild(document.createTextNode(all.join(" ")));
      return;
    }
    p.appendChild(document.createTextNode(all.slice(0, shown).join(" ").replace(/[\s,;:.\u2013\u2014-]+$/, "")));
    if (shown < all.length) {
      var rest = document.createElement("span");
      rest.className = "about-rest";
      rest.hidden = true;
      rest.textContent = " " + all.slice(shown).join(" ");
      p.appendChild(rest);
    }
    var ell = document.createElement("span");
    ell.className = "about-ellipsis";
    ell.setAttribute("aria-hidden", "true");
    ell.textContent = "\u2026 ";
    p.appendChild(ell);
  }

  // Render collapsed with k words visible in total (1 <= k < total).
  function renderCut(k) {
    var left = k;
    var placed = false;
    paras.forEach(function (p, i) {
      var n = words[i].length;
      if (placed) { p.hidden = true; fill(p, i, null); return; }
      p.hidden = false;
      if (left > n) { fill(p, i, null); left -= n; return; }
      fill(p, i, left);
      p.appendChild(btn);
      placed = true;
    });
  }

  function renderFull(withButton) {
    paras.forEach(function (p, i) { p.hidden = false; fill(p, i, null); });
    if (withButton) {
      var last = paras[paras.length - 1];
      last.appendChild(document.createTextNode(" "));
      last.appendChild(btn);
    } else if (btn.parentNode !== section) {
      section.appendChild(btn);
    }
  }

  function setButton() {
    btn.hidden = cut < 0;
    btn.textContent = expanded ? "See less" : "See more";
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function allowedHeight() {
    var lh = lineHeight();
    var min = MOBILE_LINES * lh;
    if (twoCol && twoCol.matches && details) {
      var avail = details.getBoundingClientRect().bottom - body.getBoundingClientRect().top;
      return Math.max(min, avail);
    }
    return min;
  }

  function measure() {
    if (section.getClientRects().length === 0) return; // landing hidden
    var hadFocus = document.activeElement === btn;
    btn.hidden = false;
    var limit = allowedHeight() + 1;
    renderFull(false);
    if (body.getBoundingClientRect().height <= limit) {
      cut = -1;
    } else {
      // Largest k whose collapsed rendering ("… See more" included) fits.
      var lo = 1, hi = total - 1, best = 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        renderCut(mid);
        if (body.getBoundingClientRect().height <= limit) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      cut = best;
    }
    if (cut < 0) renderFull(false);
    else if (expanded) renderFull(true);
    else renderCut(cut);
    section.setAttribute("data-about-lines", cut < 0 ? "all" : String(Math.round(body.getBoundingClientRect().height / lineHeight())));
    setButton();
    if (hadFocus && !btn.hidden) btn.focus({ preventScroll: true });
  }

  function animate(from, to) {
    if (reduce && reduce.matches) return;
    body.classList.add("is-animating");
    body.style.maxHeight = from + "px";
    void body.offsetHeight;
    body.style.maxHeight = to + "px";
    var finished = false;
    function end() {
      if (finished) return;
      finished = true;
      body.classList.remove("is-animating");
      body.style.maxHeight = "";
      body.removeEventListener("transitionend", end);
    }
    body.addEventListener("transitionend", end);
    window.setTimeout(end, 400);
  }

  btn.addEventListener("click", function () {
    if (cut < 0) return;
    var from = body.getBoundingClientRect().height;
    expanded = !expanded;
    if (expanded) renderFull(true); else renderCut(cut);
    setButton();
    btn.focus({ preventScroll: true });
    animate(from, body.scrollHeight);
  });

  var t = 0, lastW = -1;
  function schedule() { window.clearTimeout(t); t = window.setTimeout(measure, 60); }
  window.addEventListener("resize", schedule);
  if (twoCol && typeof twoCol.addEventListener === "function") twoCol.addEventListener("change", schedule);
  if (window.ResizeObserver) {
    var ro = new window.ResizeObserver(function () {
      var w = section.getBoundingClientRect().width;
      if (w !== lastW) { lastW = w; schedule(); }
    });
    ro.observe(section);
    if (details) new window.ResizeObserver(schedule).observe(details);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  window.addEventListener("load", measure);
  measure();
})();
