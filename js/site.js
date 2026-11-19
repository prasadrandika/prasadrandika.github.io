(function () {
  "use strict";

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var hasIO = "IntersectionObserver" in window;

  // Run fn once when el comes into view. Uses IntersectionObserver, with a
  // plain scroll check as a safety net so nothing can stay hidden.
  function whenVisible(el, fn, margin) {
    var done = false;
    margin = margin || 0;
    function fire() { if (!done) { done = true; cleanup(); fn(); } }
    function inView() {
      var r = el.getBoundingClientRect();
      return r.top < window.innerHeight - margin && r.bottom > margin;
    }
    var t = null;
    function onScroll() {
      if (t) return;
      t = setTimeout(function () { t = null; if (inView()) fire(); }, 120);
    }
    var io = hasIO ? new IntersectionObserver(function (es) { if (es[0].isIntersecting) fire(); }, { rootMargin: "0px 0px -" + margin + "px 0px" }) : null;
    function cleanup() {
      if (io) io.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    }
    if (io) io.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
  }

  function mailto(subject) {
    return "mailto:" + ["prasadrandika618", "gmail.com"].join("@") + "?subject=" + encodeURIComponent(subject);
  }
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------
  // Fade sections in as they scroll into view.
  // ------------------------------------------------------------------
  (function () {
    if (reduce) return;
    var els = document.querySelectorAll("section, .deadline");
    Array.prototype.forEach.call(els, function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) return; // already visible: leave it alone
      el.classList.add("reveal");
      whenVisible(el, function () { el.classList.add("in"); }, 40);
    });
  })();

  // ------------------------------------------------------------------
  // Animated terminal: types the real command, then prints the real output.
  // ------------------------------------------------------------------
  (function () {
    var term = document.getElementById("demo");
    if (!term) return;
    var cmd = document.getElementById("cmdtext");
    var replay = document.getElementById("replay");
    var full = cmd.textContent;
    var lines = Array.prototype.slice.call(term.querySelectorAll(".tl:not(.t-cmd)"));
    var timers = [];

    if (reduce) return; // final output is already in the page

    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function reset() {
      timers.forEach(clearTimeout); timers = [];
      lines.forEach(function (l) { l.classList.remove("shown"); });
      cmd.textContent = "";
      term.classList.add("armed");
      term.classList.remove("typing");
      replay.hidden = true;
    }
    function play() {
      reset();
      term.classList.add("typing");
      var t = 400;
      for (var i = 1; i <= full.length; i++) {
        (function (n) { later(function () { cmd.textContent = full.slice(0, n); }, t); })(i);
        t += 38 + Math.round(Math.random() * 40);
      }
      t += 450;
      later(function () { term.classList.remove("typing"); }, t);
      lines.forEach(function (l) {
        var text = l.textContent;
        t += text.trim() === "" ? 90 : /^Found /.test(text) ? 380 : /^\s+line \d/.test(text) ? 260 : 110;
        later(function () { l.classList.add("shown"); }, t);
      });
      later(function () { replay.hidden = false; }, t + 300);
    }

    replay.addEventListener("click", play);
    reset();
    whenVisible(term, play, 120);
  })();

  // ------------------------------------------------------------------
  // "Check your code": runs LunaCheck (js/luna-check.js) on the pasted text.
  // ------------------------------------------------------------------
  (function () {
    var area = document.getElementById("code");
    if (!area || !window.LunaCheck) return;
    var langSel = document.getElementById("lang");
    var runBtn = document.getElementById("run");
    var exBtn = document.getElementById("example");
    var note = document.getElementById("example-note");
    var out = document.getElementById("results");
    var exampleText = null;
    var LANG_NAME = { python: "Python", javascript: "JavaScript / TypeScript", go: "Go" };
    var MAX = 300000;

    function render() {
      var text = area.value;
      out.hidden = false;
      if (!text.trim()) {
        out.innerHTML = '<div class="res-summary"><p>Paste some code first, or click <strong>Try an example</strong>.</p></div>';
        return;
      }
      if (text.length > MAX) {
        out.innerHTML = '<div class="res-summary"><p>That\'s more than ' + MAX.toLocaleString() + ' characters. Paste one file at a time, or run luna-check on the whole project.</p></div>';
        return;
      }
      var lang = langSel.value === "auto" ? LunaCheck.detectLanguage(text) : langSel.value;
      var findings = LunaCheck.check(text, lang);
      var srcLines = text.replace(/\r\n?/g, "\n").split("\n");
      if (srcLines.length > 1 && srcLines[srcLines.length - 1] === "") srcLines.pop(); // trailing newline
      var detected = langSel.value === "auto" ? " (detected as " + LANG_NAME[lang] + ")" : "";
      var html = "";

      if (!findings.length) {
        html += '<div class="res-summary clean"><p><strong>No findings.</strong> None of the 4 rules matched in ' +
          srcLines.length + " line" + (srcLines.length === 1 ? "" : "s") + detected + ".</p></div>";
        out.innerHTML = html;
        return;
      }

      var n = findings.length;
      html += '<div class="res-summary"><p><strong>' + n + " finding" + (n === 1 ? "" : "s") + "</strong> in " +
        srcLines.length + " line" + (srcLines.length === 1 ? "" : "s") + detected + ".</p></div>";

      // Which lines to show: everything for short code, otherwise 3 lines around each finding.
      var byLine = {};
      findings.forEach(function (f) { (byLine[f.line] = byLine[f.line] || []).push(f); });
      var show = {};
      if (srcLines.length <= 40) {
        for (var i = 1; i <= srcLines.length; i++) show[i] = true;
      } else {
        Object.keys(byLine).forEach(function (l) {
          l = +l;
          for (var k = Math.max(1, l - 3); k <= Math.min(srcLines.length, l + 3); k++) show[k] = true;
        });
      }

      html += '<div class="res-code" tabindex="0" aria-label="Your code with findings">';
      var last = 0;
      for (var ln = 1; ln <= srcLines.length; ln++) {
        if (!show[ln]) continue;
        if (last && ln > last + 1) html += '<div class="res-gap">⋯</div>';
        last = ln;
        var hit = byLine[ln];
        html += '<div class="res-line' + (hit ? " hit" : "") + '"><span class="no">' + ln + '</span><span class="tx">' +
          esc(srcLines[ln - 1]) + "</span></div>";
        if (hit) hit.forEach(function (f) {
          html += '<div class="res-note"><span class="t-high">' + f.severity.toUpperCase() + '</span><span class="rid">' + f.rule +
            "</span><b>" + esc(f.title) + "</b><p>" + esc(f.message) + '</p><p class="fx"><b>Fix:</b> ' + esc(f.fix) +
            '</p><a href="' + esc(f.source) + '">Source</a></div>';
        });
      }
      html += "</div>";
      html += '<div class="res-cta"><p>Want this fixed?</p><a class="button small" href="' +
        esc(mailto("Help fixing luna-check findings")) + '">Email me</a></div>';
      out.innerHTML = html;
    }

    function run() {
      render();
      out.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    }

    runBtn.addEventListener("click", run);
    area.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
    });
    area.addEventListener("input", function () {
      if (exampleText !== null && area.value !== exampleText) note.hidden = true;
    });
    exBtn.addEventListener("click", function () {
      exBtn.disabled = true;
      fetch("examples/nasiko-books-llm.go").then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(function (t) {
        exampleText = t;
        area.value = t;
        langSel.value = "go";
        note.hidden = false;
        run();
      }).catch(function () {
        out.hidden = false;
        out.innerHTML = '<div class="res-summary"><p>Couldn\'t load the example. Please try again.</p></div>';
      }).then(function () { exBtn.disabled = false; });
    });
  })();
})();
