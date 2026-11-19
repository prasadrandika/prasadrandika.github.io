/*
 * luna-check rules, ported to JavaScript for the browser.
 *
 * A line-by-line port of luna-check 0.2.0 (MIT,
 * https://github.com/prasadrandika/luna-check): lexer.py, rules.py and
 * checks.py, plus the "luna-check: ignore" filter and sort order from
 * scanner.py. It runs entirely in the page; nothing is sent anywhere.
 *
 * Usage: LunaCheck.check(sourceText, "python" | "javascript" | "go")
 *   -> [{ line, rule, title, severity, message, fix, source }]
 */
(function (root) {
  "use strict";

  var PY = "python", JS = "javascript", GO = "go";

  // ---------------------------------------------------------------- rules.py
  var DEPRECATIONS_URL = "https://developers.openai.com/api/docs/deprecations";
  var LUNA_MODEL_URL = "https://developers.openai.com/api/docs/models/gpt-6-luna";
  var GUIDE_URL = "https://developers.openai.com/api/docs/guides/latest-model";
  var TIKTOKEN_MODEL_URL = "https://github.com/openai/tiktoken/blob/main/tiktoken/model.py";
  var REPLACEMENT = "gpt-6-luna";
  var SHUTDOWN_DATE = "Jan 14, 2027";
  var HIGH = "high";
  var OLD_ENCODING = "o200k_base";

  var RULES = {
    MODEL_ID: { id: "LC001", title: "Model shuts down on " + SHUTDOWN_DATE, source: DEPRECATIONS_URL },
    TIKTOKEN: { id: "LC002", title: "tiktoken.encoding_for_model() raises KeyError for gpt-6-luna", source: TIKTOKEN_MODEL_URL },
    SAMPLING: { id: "LC003", title: 'Sampling parameter sent while reasoning effort is not "none"', source: GUIDE_URL },
    CHAT_TOOLS: { id: "LC004", title: 'Function tools on /chat/completions need reasoning_effort "none" on gpt-6-luna', source: LUNA_MODEL_URL }
  };

  var SNAPSHOTS = {
    "gpt-4o": ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20"],
    "gpt-4o-mini": ["gpt-4o-mini-2024-07-18"],
    "gpt-4.1": ["gpt-4.1-2025-04-14"],
    "gpt-4.1-mini": ["gpt-4.1-mini-2025-04-14"]
  };
  var DATED_IDS = {};
  Object.keys(SNAPSHOTS).forEach(function (alias) {
    SNAPSHOTS[alias].forEach(function (s) { DATED_IDS[s] = alias; });
  });

  var SAMPLING_PARAMS = ["temperature", "top_p", "logprobs", "top_logprobs"];

  function modelMessage(id) {
    if (Object.prototype.hasOwnProperty.call(DATED_IDS, id)) {
      return '"' + id + '" shuts down on ' + SHUTDOWN_DATE + '. Replace it with "' + REPLACEMENT + '".';
    }
    return '"' + id + '" points to the dated snapshot(s) ' + SNAPSHOTS[id].join(", ") +
      ", which shut down on " + SHUTDOWN_DATE + '. Replace it with "' + REPLACEMENT + '".';
  }

  // ---------------------------------------------------------------- helpers
  // Python's `ch in "abc"` is also true for the empty string; keep that.
  function inSet(ch, set) { return ch === "" || set.indexOf(ch) !== -1; }
  function isSpace(ch) { return ch === " " || ch === "\t" || ch === "\r" || ch === "\n"; }
  var ALPHA = /^\p{L}$/u, ALNUM = /^[\p{L}\p{N}]$/u;

  // Run a global regex over s from `start`, with s cut at `end` (like Python's
  // pattern.finditer(s, pos, endpos)).
  function findAll(re, s, start, end) {
    var g = new RegExp(re.source, re.flags.indexOf("g") === -1 ? re.flags + "g" : re.flags);
    var text = end === undefined ? s : s.slice(0, end);
    g.lastIndex = start || 0;
    var out = [], m;
    while ((m = g.exec(text)) !== null) {
      out.push(m);
      if (m[0] === "") g.lastIndex++;
    }
    return out;
  }
  // Like Python's pattern.match(s, pos): match only at pos.
  function matchAt(re, s, pos) {
    var y = new RegExp(re.source, re.flags.replace("g", "") + "y");
    y.lastIndex = pos;
    return y.exec(s);
  }

  // ---------------------------------------------------------------- lexer.py
  var PY_PREFIX = /^(?:rb|br|fr|rf|r|b|f|u)?$/i;
  var REGEX_BEFORE = "(,=:[!&|?{};+-*%<>~^";

  function lex(source, lang) {
    source = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var chars = source.split("");
    var strings = [];
    var n = source.length, i = 0, depth = 0;

    function blank(a, b) { for (var k = a; k < b; k++) if (chars[k] !== "\n") chars[k] = " "; }
    function atLineStart(offset) {
      var k = offset - 1;
      while (k >= 0 && (chars[k] === " " || chars[k] === "\t")) k--;
      return k < 0 || chars[k] === "\n";
    }

    while (i < n) {
      var c = source[i], j;

      if (lang === PY && c === "#") {
        j = source.indexOf("\n", i); j = j === -1 ? n : j;
        blank(i, j); i = j; continue;
      }
      if ((lang === JS || lang === GO) && source.startsWith("//", i)) {
        j = source.indexOf("\n", i); j = j === -1 ? n : j;
        blank(i, j); i = j; continue;
      }
      if ((lang === JS || lang === GO) && source.startsWith("/*", i)) {
        j = source.indexOf("*/", i + 2); j = j === -1 ? n : j + 2;
        blank(i, j); i = j; continue;
      }

      if (lang === JS && c === "/") {
        var k = i - 1;
        while (k >= 0 && isSpace(chars[k])) k--;
        var prev = k >= 0 ? chars[k] : "";
        var word = /[A-Za-z_$][\w$]*$/.exec(chars.slice(Math.max(0, k - 10), k + 1).join(""));
        if (prev === "" || REGEX_BEFORE.indexOf(prev) !== -1 ||
            (word && ["return", "typeof", "case", "in", "of"].indexOf(word[0]) !== -1)) {
          j = i + 1;
          var inClass = false;
          while (j < n && source[j] !== "\n") {
            var ch = source[j];
            if (ch === "\\") { j += 2; continue; }
            if (ch === "[") inClass = true;
            else if (ch === "]") inClass = false;
            else if (ch === "/" && !inClass) break;
            j++;
          }
          if (j < n && source[j] === "/") { blank(i + 1, j); i = j + 1; continue; }
        }
      }

      var quote = null, start = i;
      if (lang === PY && (c === '"' || c === "'")) {
        var kk = i;
        while (kk > 0 && ALPHA.test(source[kk - 1]) && i - kk < 2) kk--;
        if (kk < i && PY_PREFIX.test(source.slice(kk, i)) &&
            (kk === 0 || !(ALNUM.test(source[kk - 1]) || source[kk - 1] === "_"))) {
          start = kk;
        }
        var three = source.slice(i, i + 3);
        quote = (three === '"""' || three === "'''") ? three : c;
      } else if ((lang === JS || lang === GO) && (c === '"' || c === "'" || c === "`")) {
        quote = c;
      }

      if (quote) {
        var raw = lang === GO && quote === "`";
        j = i + quote.length;
        while (j < n) {
          if (!raw && source[j] === "\\") { j += 2; continue; }
          if (source.startsWith(quote, j)) break;
          if (source[j] === "\n" && quote.length === 1 && quote !== "`") break;
          j++;
        }
        var end = Math.min(n, j + quote.length);
        var value = source.slice(i + quote.length, j);
        var doc = false;
        if (lang === PY && quote.length === 3 && depth === 0 && atLineStart(start)) {
          var nl = source.indexOf("\n", end);
          var rest = source.slice(end, nl !== -1 ? nl : n);
          if (rest.split("#")[0].trim() === "") doc = true;
        }
        strings.push({ value: value, start: start, end: end, docstring: doc });
        if (doc) blank(start, end); else blank(i + quote.length, j);
        i = end;
        continue;
      }

      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i++;
    }

    var newlines = [];
    for (var q = 0; q < source.length; q++) if (source[q] === "\n") newlines.push(q);
    var code = chars.join("");
    var lines = source.split("\n");

    return {
      source: source, lang: lang, code: code, strings: strings,
      lineOf: function (offset) {
        // bisect_right(newlines, offset - 1) + 1
        var lo = 0, hi = newlines.length, x = offset - 1;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (x < newlines[mid]) hi = mid; else lo = mid + 1; }
        return lo + 1;
      },
      prevChar: function (offset) {
        var k = offset - 1;
        while (k >= 0 && isSpace(code[k])) k--;
        return k >= 0 ? code[k] : "";
      },
      nextChar: function (offset) {
        var k = offset;
        while (k < code.length && isSpace(code[k])) k++;
        return k < code.length ? code[k] : "";
      },
      lineText: function (line) { return line > 0 && line <= lines.length ? lines[line - 1] : ""; }
    };
  }

  // ---------------------------------------------------------------- checks.py
  // (?<![\w.-])(gpt-4o-mini|gpt-4\.1-mini|gpt-4o|gpt-4\.1)(-\d{4}-\d{2}-\d{2})?(?![\w.-])
  var MODEL_RE = /(?<![\w.-])(gpt-4o-mini|gpt-4\.1-mini|gpt-4o|gpt-4\.1)(-\d{4}-\d{2}-\d{2})?(?![\w.-])/g;
  var PRICE_RE = /(price|pricing|cost|per_?1[km]\b|per_?million|usd\b|\$\s*\d)/i;
  var LUNA_RE = /(?<![\w.-])gpt-6-luna(?![\w.])/;

  function retiringIds(s) {
    var out = [];
    findAll(MODEL_RE, s).forEach(function (m) {
      if (m[2] && !Object.prototype.hasOwnProperty.call(DATED_IDS, m[0])) return;
      out.push({ index: m.index, id: m[0] });
    });
    return out;
  }

  function valueOffset(lx, lit) {
    var idx = lit.value ? lx.source.indexOf(lit.value, lit.start) : -1;
    return idx !== -1 ? idx : lit.start;
  }

  function isRelevant(lx) {
    return lx.strings.some(function (lit) {
      return !lit.docstring && (LUNA_RE.test(lit.value) || retiringIds(lit.value).length > 0);
    });
  }

  function finding(line, rule, message, fix) {
    return { line: line, rule: rule.id, title: rule.title, severity: HIGH, message: message, fix: fix, source: rule.source };
  }

  // LC001
  function checkModelIds(lx, skipLines) {
    var out = [], seen = {};
    lx.strings.forEach(function (lit) {
      if (lit.docstring || !lit.value) return;
      if (/\s/.test(lit.value)) return;
      if (inSet(lx.prevChar(lit.start), "{,") && lx.nextChar(lit.end) === ":" && lx.prevChar(lit.start)) return;
      var base = valueOffset(lx, lit);
      retiringIds(lit.value).forEach(function (m) {
        var line = lx.lineOf(base + m.index);
        var key = line + "|" + m.id;
        if (skipLines[line] || PRICE_RE.test(lx.lineText(line)) || seen[key]) return;
        seen[key] = true;
        out.push(finding(line, RULES.MODEL_ID, modelMessage(m.id),
          'Use "' + REPLACEMENT + '" (or read the model name from config).'));
      });
    });
    return out;
  }

  // LC002
  var TIKTOKEN_CALL = {};
  TIKTOKEN_CALL[PY] = /\bencoding_for_model\s*\(/g;
  TIKTOKEN_CALL[JS] = /\b(?:encoding_for_model|encodingForModel)\s*\(/g;
  TIKTOKEN_CALL[GO] = /\bEncodingForModel\s*\(/g;
  var FALLBACK_RE = /\b(?:get_encoding|getEncoding|GetEncoding)\s*\(/;
  var FALLBACK_WINDOW = 8;

  function firstArgString(lx, openParen) {
    for (var k = 0; k < lx.strings.length; k++) {
      var lit = lx.strings[k];
      if (lit.start >= openParen) {
        return lx.code.slice(openParen + 1, lit.start).trim() === "" ? lit : null;
      }
    }
    return null;
  }

  function checkTiktoken(lx) {
    var out = [];
    findAll(TIKTOKEN_CALL[lx.lang], lx.code).forEach(function (m) {
      var end = m.index + m[0].length;
      var line = lx.lineOf(m.index);
      var lit = firstArgString(lx, end - 1);
      if (lit !== null && retiringIds(lit.value).length === 0 && !LUNA_RE.test(lit.value)) return;
      var windowText = lx.code.split("\n").slice(line - 1, line - 1 + FALLBACK_WINDOW).join("\n");
      if (FALLBACK_RE.test(windowText)) return;
      var arg = lit !== null ? '"' + lit.value + '"' : "the model name";
      out.push(finding(line, RULES.TIKTOKEN,
        "Called with " + arg + '. tiktoken has no entry for "' + REPLACEMENT +
        '", so after the switch this raises KeyError (checked with tiktoken 0.7.0 and 0.14.0).',
        'Catch the error and fall back to get_encoding("' + OLD_ENCODING +
        '"), the encoding tiktoken uses for gpt-4o, gpt-4o-mini, gpt-4.1 and gpt-4.1-mini.'));
    });
    return out;
  }

  // LC004
  var CHAT_CALL = /\bchat\s*\.\s*completions\s*\.\s*(?:create|parse|stream)\s*\(/g;
  var GO_CHAT_CALL = /\b(?:Chat\.Completions\.New|CreateChatCompletion(?:Stream)?)\s*\(/g;
  var PY_TOOLS = /\b(?:tools|functions)\s*=(?!=)/;
  var JS_TOOLS = /\b(?:tools|functions)\s*[:,}]/;
  var EFFORT_RE = /\b(?:reasoning_effort|reasoningEffort|ReasoningEffort)\b/;

  function closeParen(code, openIdx) {
    var depth = 0;
    for (var k = openIdx; k < code.length; k++) {
      var ch = code[k];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) return k; }
    }
    return code.length;
  }

  function hasEffort(lx, start, end) {
    if (EFFORT_RE.test(lx.code.slice(start, end))) return true;
    return lx.strings.some(function (lit) { return start <= lit.start && lit.start < end && EFFORT_RE.test(lit.value); });
  }

  function toolsFinding(line) {
    return finding(line, RULES.CHAT_TOOLS,
      'Function tools are sent to /chat/completions with no reasoning_effort. gpt-6-luna "supports function calling only with `reasoning_effort` set to `none`" on Chat Completions.',
      'Send reasoning_effort "none" with gpt-6-luna, or move to the Responses API.');
  }

  function checkChatTools(lx) {
    var out = [];
    if (lx.lang === PY || lx.lang === JS) {
      var toolsRe = lx.lang === PY ? PY_TOOLS : JS_TOOLS;
      findAll(CHAT_CALL, lx.code).forEach(function (m) {
        var end = m.index + m[0].length;
        var close = closeParen(lx.code, end - 1);
        var args = lx.code.slice(end, close);
        if (toolsRe.test(args) && !hasEffort(lx, end, close)) out.push(toolsFinding(lx.lineOf(m.index)));
      });
      return out;
    }
    if (hasEffort(lx, 0, lx.code.length)) return out;
    var hasTools = /\bTools\s*:/.test(lx.code) || lx.strings.some(function (lit) {
      return /json:"tools[,"]/.test(lit.value) || (lit.value === "tools" && lx.nextChar(lit.end) === ":");
    });
    if (!hasTools) return out;
    lx.strings.forEach(function (lit) {
      if (lit.value.replace(/\/+$/, "").endsWith("/chat/completions")) out.push(toolsFinding(lx.lineOf(lit.start)));
    });
    findAll(GO_CHAT_CALL, lx.code).forEach(function (m) { out.push(toolsFinding(lx.lineOf(m.index))); });
    return out;
  }

  // LC003
  var SAMPLING_ALT = SAMPLING_PARAMS.join("|");
  var PY_KWARG = new RegExp("\\b(" + SAMPLING_ALT + ")\\s*=(?!=)", "g");
  var JS_KEY = new RegExp("\\b(" + SAMPLING_ALT + ")\\s*:", "g");
  var GO_FIELD = /\b(Temperature|TopP|Logprobs|LogProbs|TopLogprobs|TopLogProbs)\s*:/g;
  var GO_ASSIGN = /\.(Temperature|TopP|Logprobs|LogProbs|TopLogprobs|TopLogProbs)\s*=(?!=)/g;
  var NULL_VALUE = /\s*[:=]\s*(None|null|undefined|nil)\b/;
  var EFFORT_CODE = /\b(?:reasoning_effort|reasoningEffort|ReasoningEffort|effort)\b/g;
  var EFFORT_KEYS = ["reasoning_effort", "reasoningEffort", "effort"];
  var GO_PARAM = { Temperature: "temperature", TopP: "top_p", Logprobs: "logprobs", LogProbs: "logprobs", TopLogprobs: "top_logprobs", TopLogProbs: "top_logprobs" };
  var NONE = "none", OTHER = "other", UNKNOWN = "unknown";

  function effortStates(lx, start, end) {
    var marks = findAll(EFFORT_CODE, lx.code, start, end).map(function (m) { return m.index + m[0].length; });
    lx.strings.forEach(function (lit) {
      if (start <= lit.start && lit.start < end && EFFORT_KEYS.indexOf(lit.value) !== -1) marks.push(lit.end);
    });
    var states = {};
    marks.forEach(function (pos) {
      var value = null;
      for (var k = 0; k < lx.strings.length; k++) {
        var lit = lx.strings[k];
        if (lit.start >= pos) {
          if (/^[\s:=]*$/.test(lx.code.slice(pos, lit.start))) value = lit.value;
          break;
        }
      }
      if (value === null) states[UNKNOWN] = true;
      else states[value === "none" ? NONE : OTHER] = true;
    });
    return states;
  }

  function enclosingSpans(code, offset, levels) {
    levels = levels || 2;
    var spans = [], depth = 0, k = offset - 1;
    while (k >= 0 && spans.length < levels) {
      var ch = code[k];
      if (ch === ")" || ch === "]" || ch === "}") depth++;
      else if (ch === "(" || ch === "[" || ch === "{") {
        if (depth === 0) spans.push([k, closeParen(code, k) + 1]);
        else depth--;
      }
      k--;
    }
    return spans;
  }

  function samplingFinding(line, param) {
    // luna-check 0.2.0 quotes OpenAI's guide here. That wording is no longer
    // on the live guide, so this message describes the rule instead of quoting.
    return finding(line, RULES.SAMPLING,
      '"' + param + '" is sent and reasoning effort is not "none" (gpt-6-luna defaults to "medium"). ' +
      "OpenAI's migration guide says to omit temperature, top_p and top_logprobs (and logprobs on Chat Completions) when moving to its newest reasoning models.",
      'Remove "' + param + '" from this request when moving to gpt-6-luna.');
  }

  function checkSampling(lx) {
    var hits = [];
    function keep(valueAt) { return !matchAt(NULL_VALUE, lx.code, valueAt) && !matchAt(NULL_VALUE, lx.source, valueAt); }

    if (lx.lang === PY) {
      findAll(PY_KWARG, lx.code).forEach(function (m) {
        if (inSet(lx.prevChar(m.index), "(,") && keep(m.index + m[1].length)) hits.push([m.index, m[1]]);
      });
    } else if (lx.lang === JS) {
      findAll(JS_KEY, lx.code).forEach(function (m) {
        if (inSet(lx.prevChar(m.index), "{,") && keep(m.index + m[1].length)) hits.push([m.index, m[1]]);
      });
    } else {
      [GO_FIELD, GO_ASSIGN].forEach(function (rx) {
        findAll(rx, lx.code).forEach(function (m) {
          var groupEnd = m.index + m[0].indexOf(m[1]) + m[1].length;
          if ((rx === GO_ASSIGN || inSet(lx.prevChar(m.index), "{,")) && keep(groupEnd)) hits.push([m.index, GO_PARAM[m[1]]]);
        });
      });
    }
    lx.strings.forEach(function (lit) {
      if (SAMPLING_PARAMS.indexOf(lit.value) !== -1 && lx.nextChar(lit.end) === ":" &&
          inSet(lx.prevChar(lit.start), "{,") && keep(lit.end)) hits.push([lit.start, lit.value]);
    });

    hits.sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    var out = [], seen = {};
    var fileStates = lx.lang === GO ? effortStates(lx, 0, lx.code.length) : null;
    hits.forEach(function (h) {
      var states;
      if (lx.lang === GO) states = fileStates;
      else {
        states = {};
        enclosingSpans(lx.code, h[0]).forEach(function (sp) {
          var s = effortStates(lx, sp[0], sp[1]);
          Object.keys(s).forEach(function (key) { states[key] = true; });
        });
      }
      if (states[NONE] || states[UNKNOWN]) return;
      var line = lx.lineOf(h[0]);
      var key = line + "|" + h[1];
      if (!seen[key]) { seen[key] = true; out.push(samplingFinding(line, h[1])); }
    });
    return out;
  }

  function runAll(lx) {
    if (!isRelevant(lx) && !findAll(TIKTOKEN_CALL[lx.lang], lx.code).length) return [];
    var tik = checkTiktoken(lx);
    var skip = {};
    tik.forEach(function (f) { skip[f.line] = true; });
    var findings = tik.concat(checkModelIds(lx, skip));
    if (isRelevant(lx)) findings = findings.concat(checkChatTools(lx), checkSampling(lx));
    return findings;
  }

  // ---------------------------------------------------------------- scanner.py
  var IGNORE_MARK = "luna-check: ignore";

  function check(text, lang) {
    if ([PY, JS, GO].indexOf(lang) === -1) throw new Error("Unknown language: " + lang);
    var lx = lex(text, lang);
    var found = runAll(lx).filter(function (f) { return lx.lineText(f.line).indexOf(IGNORE_MARK) === -1; });
    found.sort(function (a, b) { return a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0); });
    return found;
  }

  // Best guess at the language of pasted code.
  function detectLanguage(text) {
    if (/^\s*package\s+\w+\s*$/m.test(text) || /\bfunc\s+(\([^)]*\)\s*)?\w+\s*\(/.test(text) || /\w+\s*:=\s*/.test(text)) return GO;
    if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(text) || /^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+\s*$)/m.test(text) ||
        /^\s*(if|for|while|try|except|with|elif|else)\b.*:\s*$/m.test(text)) return PY;
    if (/\b(const|let|var|function|await|=>|require\(|export|import\s.+\sfrom\s)/.test(text) || /;\s*$/m.test(text)) return JS;
    return PY;
  }

  root.LunaCheck = { check: check, detectLanguage: detectLanguage, version: "0.2.0" };
})(typeof window !== "undefined" ? window : this);
