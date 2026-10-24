/* Scalloped frame for the landing hero (Claire's approved "half depth, pointed" design).
   Always 5 bumps across. The height is snapped to a whole number of the same bumps so every
   corner lands on a round bump. Edge bumps are shallow arcs that meet in a sharp dip 0.25 x the
   bump width deep; the corner bumps are circles touching both edges. Drawn as an SVG mask, so the
   poster and the video are framed the same way. Without CSS mask support nothing changes and the
   hero keeps its rounded corners. */
(function () {
  "use strict";
  var ACROSS = 5;
  var DEPTH = 0.25;

  function f(n) { return Math.round(n * 100) / 100; }

  // Pure geometry: element width + designed height -> bump grid, snapped height and the mask SVG.
  function scallopGeometry(W, natH) {
    var n = ACROSS, d = W / n;
    var m = Math.max(2, Math.round(natH / d));
    var H = m * d;
    var dd = DEPTH * d;                                     // dip depth
    var R = (d * d / 4 + dd * dd) / (2 * dd);               // edge bump radius: chord d, sagitta dd
    var B = d + dd;
    var rho = B - Math.sqrt(B * B - d * d - dd * dd);       // corner bump: touches both edges, meets neighbours at a point
    var c = "";
    function circle(x, y, r) { c += '<circle cx="' + f(x) + '" cy="' + f(y) + '" r="' + f(r) + '"/>'; }
    circle(rho, rho, rho); circle(W - rho, rho, rho); circle(rho, H - rho, rho); circle(W - rho, H - rho, rho);
    for (var i = 1; i < n - 1; i++) { circle((i + 0.5) * d, R, R); circle((i + 0.5) * d, H - R, R); }
    for (var j = 1; j < m - 1; j++) { circle(R, (j + 0.5) * d, R); circle(W - R, (j + 0.5) * d, R); }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + f(W) + '" height="' + f(H) + '" viewBox="0 0 ' + f(W) + " " + f(H) + '">' +
      '<defs><clipPath id="k"><rect width="' + f(W) + '" height="' + f(H) + '"/></clipPath></defs>' +
      '<g fill="#000" clip-path="url(#k)"><rect x="' + f(dd) + '" y="' + f(dd) + '" width="' + f(W - 2 * dd) + '" height="' + f(H - 2 * dd) + '"/>' + c + "</g></svg>";
    return { n: n, m: m, d: d, H: H, dd: dd, R: R, rho: rho, svg: svg };
  }

  function masksSupported() {
    var css = window.CSS;
    if (!css || typeof css.supports !== "function") return false;
    return css.supports("mask-image", 'url("a.svg")') || css.supports("-webkit-mask-image", 'url("a.svg")');
  }

  function attach(el) {
    if (!el || !masksSupported()) return false;
    el.classList.add("is-scalloped");
    var lastW = -1;
    function draw() {
      var W = el.getBoundingClientRect().width;
      if (!W || Math.abs(W - lastW) < 0.5) return;          // hidden, or only our own height change
      lastW = W;
      el.style.height = ""; el.style.aspectRatio = "";       // measure the height the CSS designs for this width
      var natH = el.getBoundingClientRect().height || W * 9 / 16;
      var g = scallopGeometry(W, natH);
      el.style.aspectRatio = "auto";
      el.style.height = g.H + "px";
      var url = 'url("data:image/svg+xml,' + encodeURIComponent(g.svg) + '")';
      el.style.webkitMaskImage = url;
      el.style.maskImage = url;
      el.setAttribute("data-scallop", g.n + "x" + g.m);
    }
    draw();
    if (window.ResizeObserver) {
      new ResizeObserver(function () { window.requestAnimationFrame(draw); }).observe(el);
    } else {
      window.addEventListener("resize", draw);
    }
    return true;
  }

  window.HustleHeroScallop = { attach: attach, geometry: scallopGeometry, ACROSS: ACROSS, DEPTH: DEPTH };
})();
