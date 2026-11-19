/*
 * luna-check rules, ported to JavaScript for the browser.
 *
 * A line-by-line port of luna-check 0.3.0 (MIT,
 * https://github.com/prasadrandika/luna-check): lexer.py, rules.py,
 * checks.py and config.py, plus the "luna-check: ignore" filter and sort
 * order from scanner.py. It runs entirely in the page; nothing is sent anywhere.
 *
 * Usage: LunaCheck.check(text, "python" | "javascript" | "go" | "env" | "yaml" | "json" | "toml")
 *   -> [{ line, rule, title, severity, message, fix, source, lowReason }]
 *
 * Pasted text has no file name, so the LOW rules that depend on the path
 * (seed/demo files, example configs) do not apply here. Model catalogs do.
 */
(function (root) {
  "use strict";

  var PY = "python", JS = "javascript", GO = "go";

  // ---------------------------------------------------------------- rules.py
  var DEPRECATIONS_URL = "https://developers.openai.com/api/docs/deprecations";
  var LUNA_MODEL_URL = "https://developers.openai.com/api/docs/models/gpt-6-luna";
  // "Using GPT-6" guide. Its migration quickstart names gpt-6-luna as a target model.
  var GUIDE_URL = "https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart";
  var TIKTOKEN_MODEL_URL = "https://github.com/openai/tiktoken/blob/main/tiktoken/model.py";
  var REPLACEMENT = "gpt-6-luna";
  var SHUTDOWN_DATE = "Jan 14, 2027";
  var HIGH = "high", LOW = "low";
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
    return { line: line, rule: rule.id, title: rule.title, severity: HIGH, message: message, fix: fix, source: rule.source, lowReason: "" };
  }

  // LC001
  // Any model name, from any provider. Used only to count how many model names
  // sit together in one list or map, so a catalog is not mistaken for a setting.
  var ANY_MODEL_RE = new RegExp(
    "^(?:[\\w.-]+/)?(?:gpt-|chatgpt-|o[1-9](?:-|$)|claude-|gemini-|text-embedding-|" +
    "text-davinci|davinci|babbage|dall-e|whisper-|tts-|codex-|llama|mistral|mixtral|" +
    "command-|deepseek|qwen|grok-|sonar)[\\w.:-]*$", "i");
  var CATALOG_MIN = 4;
  var CATALOG_NOTE = "model list";
  var CATALOG_MESSAGE = " (One entry in a list of many model names, so lower priority.)";
  var CATALOG_FIX = 'Remove it from the list, or add "' + REPLACEMENT + '" if the list is missing it.';

  function lowerAsCatalog(f) {
    f.severity = LOW;
    f.lowReason = CATALOG_NOTE;
    f.message += CATALOG_MESSAGE;
    f.fix = CATALOG_FIX;
    return f;
  }

  // Map each string's start offset to the offset of its innermost open bracket.
  function innermostContainers(lx) {
    var starts = lx.strings.map(function (lit) { return lit.start; }).sort(function (a, b) { return a - b; });
    var out = {}, stack = [], si = 0, code = lx.code;
    for (var i = 0; i < code.length; i++) {
      while (si < starts.length && starts[si] <= i) {
        out[starts[si]] = stack.length ? stack[stack.length - 1] : null;
        si++;
      }
      var ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") stack.push(i);
      else if ((ch === ")" || ch === "]" || ch === "}") && stack.length) stack.pop();
    }
    for (; si < starts.length; si++) out[starts[si]] = stack.length ? stack[stack.length - 1] : null;
    return out;
  }

  function catalogContainers(lx) {
    var where = innermostContainers(lx), names = {}, catalogs = {};
    lx.strings.forEach(function (lit) {
      var c = where[lit.start];
      if (c !== null && c !== undefined && !lit.docstring && ANY_MODEL_RE.test(lit.value)) {
        (names[c] = names[c] || {})[lit.value] = true;
      }
    });
    Object.keys(names).forEach(function (c) {
      if (Object.keys(names[c]).length >= CATALOG_MIN) catalogs[c] = true;
    });
    return { catalogs: catalogs, where: where };
  }

  function checkModelIds(lx, skipLines) {
    var out = [], seen = {};
    var cc = catalogContainers(lx);
    lx.strings.forEach(function (lit) {
      if (lit.docstring || !lit.value) return;
      if (/\s/.test(lit.value)) return;
      if (inSet(lx.prevChar(lit.start), "{,") && lx.nextChar(lit.end) === ":" && lx.prevChar(lit.start)) return;
      var container = cc.where[lit.start];
      var inCatalog = container !== null && container !== undefined && cc.catalogs[container] === true;
      var base = valueOffset(lx, lit);
      retiringIds(lit.value).forEach(function (m) {
        var line = lx.lineOf(base + m.index);
        var key = line + "|" + m.id;
        if (skipLines[line] || PRICE_RE.test(lx.lineText(line)) || seen[key]) return;
        seen[key] = true;
        var f = finding(line, RULES.MODEL_ID, modelMessage(m.id),
          'Use "' + REPLACEMENT + '" (or read the model name from config).');
        out.push(inCatalog ? lowerAsCatalog(f) : f);
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
      "Function tools are sent to /chat/completions with no reasoning_effort. " +
      "The gpt-6-luna model page says that on Chat Completions it accepts function " +
      'calling only when reasoning_effort is "none".',
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
    return finding(line, RULES.SAMPLING,
      '"' + param + '" is sent and reasoning effort is not "none" (gpt-6-luna defaults ' +
      'to "medium"). OpenAI\'s Using GPT-6 guide says to drop temperature, top_p ' +
      "and top_logprobs in that case, and also logprobs on Chat Completions.",
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

  // ---------------------------------------------------------------- config.py
  // LC001 for config files. A retiring model ID counts only as the value of a
  // model-like key such as model, model_name, default_model or OPENAI_MODEL.
  var ENV = "env", YAML = "yaml", JSON_ = "json", TOML = "toml";
  var CONFIG_KINDS = [ENV, YAML, JSON_, TOML];

  var C_COMMENT = /\s+[#;].*$/;
  var ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
  var YAML_LINE = /^(\s*)(?:-\s+)?(["']?[\w.-]+["']?)\s*:(?:\s+(.*))?$/;
  var YAML_ITEM = /^(\s*)-\s+(.*)$/;
  var TOML_LINE = /^\s*(["']?[\w.-]+["']?)\s*=\s*(.*)$/;
  var JSON_PAIR = /"((?:[^"\\]|\\.)*)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\[\]{}]*\])/g;
  var QUOTED = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

  function stripQuotes(s) { return s.replace(/^["']+|["']+$/g, ""); }

  function isModelKey(key) {
    key = stripQuotes(key.trim());
    key = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"); // camelCase -> snake_case
    key = key.replace(/[-.\s]/g, "_").toLowerCase();
    return /(^|_)models?(_?name|_?id)?$/.test(key);
  }

  function unquote(v) {
    v = v.trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
    return v.replace(C_COMMENT, "").trim();
  }

  function inlineList(v) {
    v = v.trim().replace(C_COMMENT, "").trim();
    if (!(v.charAt(0) === "[" && v.charAt(v.length - 1) === "]")) return null;
    return v.slice(1, -1).split(",").filter(function (x) { return x.trim(); }).map(unquote);
  }

  function quotedValues(s) {
    return findAll(QUOTED, s).map(function (q) { return { index: q.index, value: q[1] !== undefined ? q[1] : (q[2] || "") }; });
  }

  // (open, close) offsets of every {...} object in a JSON text, sorted by open.
  function jsonObjects(text) {
    var spans = [], stack = [], inStr = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") stack.push(i);
      else if (ch === "}" && stack.length) spans.push([stack.pop(), i + 1]);
    }
    return spans.sort(function (a, b) { return a[0] - b[0]; });
  }

  function enclosing(objects, offset) {
    // last object whose open is <= offset (bisect_right), then walk back
    var lo = 0, hi = objects.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (offset < objects[mid][0]) hi = mid; else lo = mid + 1; }
    for (var k = lo - 1; k >= 0; k--) if (objects[k][1] > offset) return objects[k];
    return null;
  }

  // Every key/value shape in a config file: [{ line, key, value, group }].
  function configPairs(text, kind) {
    var out = [];
    function add(line, key, value, group) { out.push({ line: line, key: key, value: value, group: String(group) }); }

    if (kind === JSON_) {
      var starts = [0];
      for (var c = 0; c < text.length; c++) if (text[c] === "\n") starts.push(c + 1);
      var lineAt = function (off) {
        var lo = 0, hi = starts.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (off < starts[mid]) hi = mid; else lo = mid + 1; }
        return lo;
      };
      var objects = jsonObjects(text);
      findAll(JSON_PAIR, text).forEach(function (m) {
        var obj = enclosing(objects, m.index);
        if (obj && PRICE_RE.test(text.slice(obj[0], obj[1]))) return; // a price or usage record
        var raw = m[2], valueAt = m.index + m[0].lastIndexOf(raw);
        if (raw.charAt(0) === "[") {
          quotedValues(raw).forEach(function (q) { add(lineAt(valueAt + q.index), m[1], q.value, m.index); });
        } else {
          add(lineAt(valueAt), m[1], raw.slice(1, -1), m.index);
        }
      });
      return out;
    }

    var lines = text.split("\n");
    var block = null; // [key, indent, group]: a key whose value is a list on the lines below
    var prevName = null; // "name: X" followed by "value: ..."
    lines.forEach(function (line, idx) {
      var n = idx + 1, stripped = line.trim(), m, items;
      if (!stripped || /^(#|;|\/\/)/.test(stripped)) return;
      if (kind === ENV) {
        m = ENV_LINE.exec(line);
        if (m) add(n, m[1], unquote(m[2]), n);
        return;
      }
      if (kind === TOML) {
        if (block !== null) { // inside a multi-line array
          quotedValues(line).forEach(function (q) { add(n, block[0], q.value, block[2]); });
          if (line.replace(C_COMMENT, "").indexOf("]") !== -1) block = null;
          return;
        }
        m = TOML_LINE.exec(line);
        if (!m) return;
        var tkey = stripQuotes(m[1]), v = m[2].trim();
        if (v.charAt(0) === "[" && v.replace(C_COMMENT, "").indexOf("]") === -1) {
          block = [tkey, 0, n];
          quotedValues(v).forEach(function (q) { add(n, tkey, q.value, n); });
          return;
        }
        items = inlineList(v);
        (items !== null ? items : [unquote(v)]).forEach(function (it) { add(n, tkey, it, n); });
        return;
      }
      // YAML
      var indent = line.length - line.replace(/^\s+/, "").length;
      var item = YAML_ITEM.exec(line);
      if (block !== null && (indent < block[1] || (indent === block[1] && !item))) block = null;
      if (item && !YAML_LINE.test(line)) {
        var env = ENV_LINE.exec(item[2]); // docker compose: - OPENAI_MODEL=gpt-4o
        if (env) add(n, env[1], unquote(env[2]), n);
        else if (block !== null) add(n, block[0], unquote(item[2]), block[2]);
        return;
      }
      m = YAML_LINE.exec(line);
      if (!m) return;
      var key = stripQuotes(m[2]), value = (m[3] || "").trim();
      if (!value || /^[#|>]/.test(value)) { block = [key, indent, n]; return; }
      if (key === "name") { prevName = unquote(value); return; }
      if (key === "value" && prevName) { add(n, prevName, unquote(value), n); prevName = null; return; }
      prevName = null;
      items = inlineList(value);
      (items !== null ? items : [unquote(value)]).forEach(function (it) { add(n, key, it, n); });
    });
    return out;
  }

  function checkConfig(text, kind) {
    var lines = text.split("\n");
    var pairs = configPairs(text, kind).filter(function (p) { return isModelKey(p.key); });
    var names = {}, catalogs = {};
    pairs.forEach(function (p) {
      if (ANY_MODEL_RE.test(p.value)) (names[p.group] = names[p.group] || {})[p.value] = true;
    });
    Object.keys(names).forEach(function (g) { if (Object.keys(names[g]).length >= CATALOG_MIN) catalogs[g] = true; });
    var out = [], seen = {};
    pairs.forEach(function (p) {
      if (!p.value || /\s/.test(p.value)) return;
      if (PRICE_RE.test(p.line > 0 && p.line <= lines.length ? lines[p.line - 1] : "")) return;
      retiringIds(p.value).forEach(function (m) {
        var k = p.line + "|" + m.id;
        if (seen[k]) return;
        seen[k] = true;
        var f = finding(p.line, RULES.MODEL_ID, modelMessage(m.id) + ' (Config key "' + p.key + '".)',
          "Set " + p.key + ' to "' + REPLACEMENT + '".');
        out.push(catalogs[p.group] ? lowerAsCatalog(f) : f);
      });
    });
    return out;
  }

  // ---------------------------------------------------------------- scanner.py
  var IGNORE_MARK = "luna-check: ignore";

  function check(text, lang) {
    var found, lines;
    if (CONFIG_KINDS.indexOf(lang) !== -1) {
      text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      lines = text.split("\n");
      found = checkConfig(text, lang).filter(function (f) { return lines[f.line - 1].indexOf(IGNORE_MARK) === -1; });
    } else if ([PY, JS, GO].indexOf(lang) !== -1) {
      var lx = lex(text, lang);
      found = runAll(lx).filter(function (f) { return lx.lineText(f.line).indexOf(IGNORE_MARK) === -1; });
    } else {
      throw new Error("Unknown language: " + lang);
    }
    found.sort(function (a, b) { return a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0); });
    return found;
  }

  // Best guess at the language of pasted code or config.
  function detectLanguage(text) {
    var t = text.trim();
    if (/^[\[{]/.test(t)) {
      try { JSON.parse(t); return JSON_; } catch (e) { /* not JSON */ }
    }
    var lines = t.split(/\r?\n/).filter(function (l) { return l.trim() && !/^\s*#/.test(l); });
    if (lines.length && lines.every(function (l) { return /^\s*(export\s+)?[A-Za-z_][\w.-]*=/.test(l); })) return ENV;
    var section = /^\s*\[[\w."' -]+\]\s*$/;
    if (lines.some(function (l) { return section.test(l); }) && lines.every(function (l) {
      return section.test(l) || /^\s*["']?[\w.-]+["']?\s*=\s*\S/.test(l) || /^\s*["'\]]/.test(l);
    })) return TOML;
    if (lines.length && lines.every(function (l) {
      return /^\s*(-\s+)?["']?[\w.-]+["']?\s*:(\s|$)/.test(l) || /^\s*-\s+\S/.test(l) || /^\s+\S/.test(l);
    }) && YAML_LINE.test(lines[0]) && !/[;{}()]\s*$/m.test(t)) return YAML;
    if (/^\s*package\s+\w+\s*$/m.test(text) || /\bfunc\s+(\([^)]*\)\s*)?\w+\s*\(/.test(text) || /\w+\s*:=\s*/.test(text)) return GO;
    if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(text) || /^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+\s*$)/m.test(text) ||
        /^\s*(if|for|while|try|except|with|elif|else)\b.*:\s*$/m.test(text)) return PY;
    if (/\b(const|let|var|function|await|=>|require\(|export|import\s.+\sfrom\s)/.test(text) || /;\s*$/m.test(text)) return JS;
    return PY;
  }

  root.LunaCheck = { check: check, detectLanguage: detectLanguage, version: "0.3.0" };
})(typeof window !== "undefined" ? window : this);
