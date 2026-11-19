/*
 * luna-check rules, ported to JavaScript for the browser.
 *
 * A line-by-line port of luna-check 0.4.0 (MIT,
 * https://github.com/prasadrandika/luna-check): lexer.py, rules.py,
 * models.py, checks.py, api_checks.py and config.py, plus the
 * "luna-check: ignore" filter and sort order from scanner.py. The model data
 * comes from js/luna-models.js (window.LUNA_MODELS), an export of luna-check's
 * data/models.json. It runs entirely in the page; nothing is sent anywhere.
 *
 * Usage: LunaCheck.check(text, "python" | "javascript" | "go" | "env" | "yaml" | "json" | "toml")
 *   -> [{ line, rule, title, severity, message, fix, source, lowReason, short }]
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

  var ANTHROPIC_DEPRECATIONS_URL = "https://platform.claude.com/docs/en/about-claude/model-deprecations";

  var RULES = {
    MODEL_ID: { id: "LC001", title: "Model is retired or scheduled to shut down", source: DEPRECATIONS_URL },
    TIKTOKEN: { id: "LC002", title: "tiktoken.encoding_for_model() raises KeyError for gpt-6-luna", source: TIKTOKEN_MODEL_URL },
    SAMPLING: { id: "LC003", title: 'Sampling parameter sent while reasoning effort is not "none"', source: GUIDE_URL },
    CHAT_TOOLS: { id: "LC004", title: 'Function tools on /chat/completions need reasoning_effort "none" on gpt-6-luna', source: LUNA_MODEL_URL },
    CLAUDE_SAMPLING: { id: "LC005", title: "Claude API rejects temperature, top_p and top_k", source: ANTHROPIC_DEPRECATIONS_URL },
    OPENAI_ENDPOINT: { id: "LC006", title: "OpenAI API feature or endpoint is retired or shutting down", source: DEPRECATIONS_URL }
  };

  // Anthropic's "API parameter deprecations" table (see rules.py).
  var CLAUDE_SAMPLING_PARAMS = ["temperature", "top_p", "top_k"];

  // OpenAI's feature and endpoint deprecations (see rules.py): [name, shutdown, replacement].
  var OPENAI_ENDPOINTS = {
    assistants: ["The Assistants API", "2026-08-26", "Responses API and Conversations API"],
    prompts: ["The reusable prompt objects feature (/v1/prompts)", "2026-11-30", "prompt content in your application code"],
    evals: ["The Evals API", "2026-11-30", "Promptfoo (the Evals API becomes read-only)"],
    audio_translations: ["/v1/audio/translations", "2027-02-26", "/v1/realtime/translations"],
    videos: ["The Videos API", "2026-09-24", null],
    realtime_v1: ["The OpenAI-Beta: realtime=v1 header", "2026-05-12", "the GA Realtime API (see the Realtime API migration guide)"],
    assistants_v1: ["The OpenAI-Beta: assistants=v1 header", "2024-12-18", "Responses API"],
    legacy: ["This legacy endpoint", "2024-01-04", "the current API endpoints"]
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

  // ---------------------------------------------------------------- models.py
  // The data is window.LUNA_MODELS (js/luna-models.js), exported from
  // luna-check's data/models.json, which is built from each provider's page.
  var LABEL = {
    openai: "OpenAI API", anthropic: "Claude API", "gemini-api": "Gemini API",
    vertex: "Vertex AI", azure: "Azure OpenAI", bedrock: "Amazon Bedrock"
  };
  var DEFAULT_OF = { azure: "openai", vertex: "gemini-api" };
  var NOTE_PLATFORMS = { vertex: true };
  var CONTEXT = {
    azure: new RegExp(
      "\\bAzureOpenAI\\b|\\bAsyncAzureOpenAI\\b|\\bAzureChatOpenAI\\b|\\bAzureOpenAIEmbeddings\\b|" +
      "\\bazure_endpoint\\b|\\bazureEndpoint\\b|\\bAZURE_OPENAI|\\.openai\\.azure\\.com|\\bazopenai\\b|" +
      "openai/azure|@azure/openai|\\bazure_deployment\\b|\\bdeployment_name\\b"),
    vertex: new RegExp(
      "\\bvertexai\\b|\\bvertex_ai\\b|\\bVertexAI\\b|\\bChatVertexAI\\b|\\baiplatform\\b|" +
      "GOOGLE_GENAI_USE_VERTEXAI|vertexai\\s*[=:]\\s*(?:True|true)|@google-cloud/vertexai|" +
      "cloud\\.google\\.com/go/vertexai|aiplatform\\.googleapis\\.com|gemini-enterprise-agent-platform"),
    "gemini-api": new RegExp(
      "google\\.generativeai|\\bChatGoogleGenerativeAI\\b|generativelanguage\\.googleapis\\.com|" +
      "\\bGEMINI_API_KEY\\b|@google/generative-ai|github\\.com/google/generative-ai-go|" +
      "genai\\.Client\\(\\s*api_key|GoogleGenAI\\(\\s*\\{\\s*apiKey")
  };
  var BEDROCK_PREFIX = "(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\\.)?";
  var MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function today() {
    var d = new Date();
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function fmt(iso) {
    var p = iso.split("-");
    return MONTH[+p[1] - 1] + " " + (+p[2]) + ", " + p[0];
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  var CATALOG_DATA = null;
  function modelCatalog() {
    if (CATALOG_DATA) return CATALOG_DATA;
    var data = root.LUNA_MODELS || { models: [] };
    var index = {};
    data.models.forEach(function (e) {
      e.ids.forEach(function (i) { (index[i] = index[i] || []).push([e, false]); });
      (e.aliases || []).forEach(function (a) { (index[a] = index[a] || []).push([e, true]); });
    });
    var keys = Object.keys(index).sort(function (a, b) { return b.length - a.length; });
    var bedrock = keys.filter(function (k) { return index[k].every(function (ea) { return ea[0].platform === "bedrock"; }); });
    var isB = {};
    bedrock.forEach(function (k) { isB[k] = true; });
    var generic = keys.filter(function (k) { return !isB[k]; });
    var altB = bedrock.map(escapeRe).join("|") || "(?!x)x";
    var altG = generic.map(escapeRe).join("|") || "(?!x)x";
    CATALOG_DATA = {
      index: index,
      regex: new RegExp("(?<![\\w.-])(?:" + BEDROCK_PREFIX + "(" + altB + ")|(" + altG + "))(?![\\w.-])", "g")
    };
    return CATALOG_DATA;
  }

  // Reuses the one compiled regex (findAll would recompile it for every string).
  function findModels(s) {
    var re = modelCatalog().regex, out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
      out.push({ index: m.index, id: m[1] || m[2] });
      if (m[0] === "") re.lastIndex++;
    }
    return out;
  }

  function platformsIn(text) {
    var out = {};
    Object.keys(CONTEXT).forEach(function (p) { if (CONTEXT[p].test(text)) out[p] = true; });
    return out;
  }

  function pick(entries, context) {
    var byPlatform = {};
    entries.forEach(function (ea) { (byPlatform[ea[0].platform] = byPlatform[ea[0].platform] || []).push(ea); });
    var platforms = Object.keys(byPlatform);
    var inContext = platforms.filter(function (p) { return context[p]; }).sort();
    var platform;
    if (context.azure && platforms.every(function (p) { return p === "openai" || p === "azure"; })) {
      if (!byPlatform.azure) return null;
      platform = "azure";
    } else if (inContext.length) {
      platform = inContext[0];
    } else {
      var cands = platforms.filter(function (p) {
        return p !== "azure" && !(DEFAULT_OF[p] && byPlatform[DEFAULT_OF[p]]);
      }).sort();
      if (!cands.length) return null;
      platform = cands[0];
    }
    var notes = inContext.length ? [] : platforms.filter(function (p) { return NOTE_PLATFORMS[p] && p !== platform; });
    return { platform: platform, chosen: byPlatform[platform], notes: notes.map(function (p) { return byPlatform[p]; }) };
  }

  function latest(entries) {
    return entries.reduce(function (a, b) { return (b[0].shutdown || "") > (a[0].shutdown || "") ? b : a; });
  }

  function regionsText(groups, now) {
    return groups.map(function (g) {
      var where = g.regions.length <= 4 ? g.regions.join(", ") : g.regions.length + " regions";
      var verb = g.date < now ? "reached end of life on" : "reaches end of life on";
      return verb + " " + fmt(g.date) + " in " + where;
    }).join("; ");
  }

  function report(severity, message, fix, short, source, lowReason) {
    return { severity: severity, message: message, fix: fix, short: short, source: source, lowReason: lowReason || "", replacement: null };
  }

  function describe(modelId, context) {
    var entries = modelCatalog().index[modelId];
    if (!entries) return null;
    var picked = pick(entries, context);
    if (!picked) return null;
    var now = today(), label = LABEL[picked.platform];
    var tag = picked.platform === "openai" ? "" : " (" + label + ")";
    if (picked.platform === "azure" && picked.chosen.some(function (ea) { return ea[1]; })) {
      return azureVersions(modelId, picked.chosen, now);
    }
    var ea = latest(picked.chosen), e = ea[0], alias = ea[1];
    var repl = e.replacement;
    var quoted = repl ? repl.split(" or ").map(function (r) { return '"' + r + '"'; }).join(" or ") : "";
    var use = repl ? " Replace it with " + quoted + "." : "";
    var fix = repl ? "Use " + quoted + " (or read the model name from config)." : "Move to a model the provider still supports.";
    var src = e.source, date = e.shutdown, rep, msg, short, target, verb;
    var subject = alias ? '"' + modelId + '" points to the dated snapshot(s) ' + e.ids.join(", ") + ", which" : '"' + modelId + '"';

    if (e.regions) {
      msg = "On " + label + ', "' + modelId + '" ' + regionsText(e.regions, now) + ".";
      if (e.regions.some(function (g) { return g.date >= now; })) msg += " The Bedrock page names no replacement; move to an Active model.";
      rep = report(HIGH, msg, "Move to an Active Bedrock model in your Region.",
        '"' + modelId + '" Bedrock end of life from ' + fmt(e.regions[0].date), src);
    } else if (!date) {
      msg = '"' + modelId + '" is deprecated' + tag + ", and no shutdown date has been announced yet." + use;
      rep = report(LOW, msg, fix, '"' + modelId + '" deprecated, no date yet', src, "no date yet");
    } else if (e.after_shutdown === "routes") {
      target = e.routes_to;
      if (date >= now) {
        msg = "From " + fmt(date) + ', requests to "' + modelId + '" on the ' + label + ' are routed to "' + target +
          '" and billed at its rates. The ' + label + " page says to review the breaking API changes before then.";
        rep = report(HIGH, msg, "Move to " + (quoted || '"' + target + '"') + " and test it before " + fmt(date) + ".",
          '"' + modelId + '" routed to ' + target + " from " + fmt(date), src);
      } else {
        msg = "Since " + fmt(date) + ', requests to "' + modelId + '" on the ' + label + ' are served by "' + target + '".';
        rep = report(LOW, msg, 'Use "' + (repl || target) + '" directly.',
          '"' + modelId + '" served by ' + target + " since " + fmt(date), src, "routed to a newer model");
      }
    } else if (date >= now) {
      verb = alias ? "shut down" : "shuts down";
      msg = subject + " " + verb + " on " + fmt(date) + tag + "." + use;
      rep = report(HIGH, msg, fix, '"' + modelId + '" shuts down on ' + fmt(date) + (repl ? " -> " + repl : ""), src);
    } else {
      verb = alias ? "were shut down" : "was shut down";
      msg = subject + " " + verb + " on " + fmt(date) + tag + ", so requests to it fail." + use;
      rep = report(HIGH, msg, fix, '"' + modelId + '" shut down on ' + fmt(date) + (repl ? " -> " + repl : ""), src);
    }
    rep.replacement = repl || null;
    picked.notes.forEach(function (others) {
      var o = latest(others)[0];
      if (o.shutdown) rep.message += " On " + LABEL[o.platform] + ": " + (o.shutdown < now ? "retired " : "retires ") + fmt(o.shutdown) + ".";
    });
    return rep;
  }

  function azureVersions(modelId, chosen, now) {
    var byDate = {};
    chosen.forEach(function (ea) { (byDate[ea[0].shutdown] = byDate[ea[0].shutdown] || []).push(ea[0].version); });
    var dates = Object.keys(byDate).sort();
    var parts = dates.map(function (date) {
      var vs = byDate[date].slice().sort(), many = vs.length > 1;
      var verb = date < now ? (many ? "were retired on" : "was retired on") : (many ? "retire on" : "retires on");
      return (many ? "versions " : "version ") + vs.join(", ") + " " + verb + " " + fmt(date);
    });
    var repls = {};
    chosen.forEach(function (ea) { if (ea[0].replacement) repls[ea[0].replacement] = true; });
    var rl = Object.keys(repls).sort();
    var msg = 'On Azure OpenAI, "' + modelId + '" ' + parts.join("; ") + ". Check which version your deployment uses.";
    if (rl.length) msg += " Listed replacement: " + rl.join(" or ") + ".";
    var rep = report(HIGH, msg, "Upgrade the deployment to a supported model version.",
      '"' + modelId + '" Azure retirement from ' + fmt(dates[0]), chosen[0][0].source);
    rep.replacement = rl[0] || null;
    return rep;
  }

  // LC001
  // Any model name, from any provider. Used only to count how many model names
  // sit together in one list or map, so a catalog is not mistaken for a setting.
  var ANY_MODEL_RE = new RegExp(
    "^(?:[\\w.-]+/)?(?:[a-z0-9-]+\\.){0,2}(?:gpt-|chatgpt-|o[1-9](?:-|$)|claude-|gemini-|" +
    "text-embedding-|text-davinci|davinci|babbage|dall-e|whisper-|tts-|codex-|llama|mistral|" +
    "mixtral|command-|deepseek|qwen|grok-|sonar|imagen-|veo-|gemma|nova-|jamba|titan-)[\\w.:@-]*$", "i");
  var CATALOG_MIN = 4;
  var CATALOG_NOTE = "model list";
  var CATALOG_MESSAGE = " (One entry in a list of many model names, so lower priority.)";

  function modelFinding(line, rep, inCatalog) {
    var f = finding(line, RULES.MODEL_ID, rep.message, rep.fix);
    f.severity = rep.severity;
    f.lowReason = rep.lowReason;
    f.source = rep.source;
    f.short = rep.short;
    if (inCatalog && f.severity === HIGH) {
      f.severity = LOW;
      f.lowReason = CATALOG_NOTE;
      f.message += CATALOG_MESSAGE;
      f.fix = "Remove it from the list" + (rep.replacement ? ', or add "' + rep.replacement + '" if the list is missing it.' : ".");
    }
    return f;
  }

  // Map each string's start offset to the offset of its innermost open bracket,
  // and fill `parents` with each bracket's enclosing bracket.
  function innermostContainers(lx, parents) {
    var starts = lx.strings.map(function (lit) { return lit.start; }).sort(function (a, b) { return a - b; });
    var out = {}, stack = [], si = 0, code = lx.code;
    for (var i = 0; i < code.length; i++) {
      while (si < starts.length && starts[si] <= i) {
        out[starts[si]] = stack.length ? stack[stack.length - 1] : null;
        si++;
      }
      var ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") {
        if (parents) parents[i] = stack.length ? stack[stack.length - 1] : null;
        stack.push(i);
      } else if ((ch === ")" || ch === "]" || ch === "}") && stack.length) stack.pop();
    }
    for (; si < starts.length; si++) out[starts[si]] = stack.length ? stack[stack.length - 1] : null;
    return out;
  }

  function catalogContainers(lx) {
    var parents = {}, where = innermostContainers(lx, parents), names = {}, catalogs = {}, records = {};
    lx.strings.forEach(function (lit) {
      var c = where[lit.start];
      if (c !== null && c !== undefined && !lit.docstring && ANY_MODEL_RE.test(lit.value)) {
        (names[c] = names[c] || []).push(lit.value);
      }
    });
    function distinct(list) { var o = {}; list.forEach(function (x) { o[x] = true; }); return Object.keys(o).length; }
    Object.keys(names).forEach(function (c) {
      if (distinct(names[c]) >= CATALOG_MIN) catalogs[c] = true;
      var p = parents[c];
      if (names[c].length === 1 && p !== null && p !== undefined) (records[p] = records[p] || {})[c] = names[c][0];
    });
    Object.keys(records).forEach(function (p) {
      var recs = records[p];
      var vals = Object.keys(recs).map(function (k) { return recs[k]; });
      if (distinct(vals) >= CATALOG_MIN) Object.keys(recs).forEach(function (c) { catalogs[c] = true; });
    });
    return { catalogs: catalogs, where: where };
  }

  var NAME_TEST_CALL = new RegExp(
    "(?:startswith|startsWith|HasPrefix|hasPrefix|has_prefix|endswith|endsWith|HasSuffix|" +
    "hasSuffix|includes|Contains|contains|indexOf|index|find|TrimPrefix|removeprefix)" +
    "\\s*\\(\\s*(?:[^(),]*,\\s*)?[(\\[]?\\s*(?:[^()]*,\\s*)?$");

  // The string is a prefix/substring pattern checked against a model name.
  function isNameTest(lx, lit) {
    var lineStart = lx.code.lastIndexOf("\n", lit.start - 1) + 1;
    if (NAME_TEST_CALL.test(lx.code.slice(lineStart, lit.start))) return true;
    var after = lx.code.slice(lit.end, lit.end + 8);
    return lx.lang === PY && /^\s*(?:not\s+)?in\b/.test(after) && !inSet(lx.prevChar(lit.start), "([{,");
  }

  function checkModelIds(lx, skipLines) {
    var out = [], seen = {};
    var cc = catalogContainers(lx);
    var context = platformsIn(lx.source);
    lx.strings.forEach(function (lit) {
      if (lit.docstring || !lit.value) return;
      if (/\s/.test(lit.value)) return;
      if (inSet(lx.prevChar(lit.start), "{,") && lx.nextChar(lit.end) === ":" && lx.prevChar(lit.start)) return;
      if (isNameTest(lx, lit)) return;
      var container = cc.where[lit.start];
      var inCatalog = container !== null && container !== undefined && cc.catalogs[container] === true;
      var base = valueOffset(lx, lit);
      findModels(lit.value).forEach(function (m) {
        var line = lx.lineOf(base + m.index);
        var key = line + "|" + m.id;
        if (skipLines[line] || PRICE_RE.test(lx.lineText(line)) || seen[key]) return;
        var rep = describe(m.id, context);
        if (!rep) return;
        seen[key] = true;
        out.push(modelFinding(line, rep, inCatalog));
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

  // ---------------------------------------------------------------- api_checks.py
  // LC005: Claude sampling parameters.
  var ANTHROPIC_FILE = new RegExp(
    "^\\s*(?:import\\s+anthropic\\b|from\\s+anthropic\\b)|@anthropic-ai/sdk|anthropic-sdk-go|" +
    "langchain_anthropic|@langchain/anthropic|api\\.anthropic\\.com", "m");
  var CLAUDE_CALL = /\b(?:messages\s*\.\s*(?:batches\s*\.\s*)?(?:create|stream|parse)|ChatAnthropic)\s*\(/g;
  var GO_CLAUDE_PARAMS = /\b(?:Beta)?MessageNewParams\s*\{/g;
  var C_ALT = CLAUDE_SAMPLING_PARAMS.join("|");
  var C_PY_KW = new RegExp("\\b(" + C_ALT + ")\\s*=(?!=)", "g");
  var C_JS_KEY = new RegExp("\\b(" + C_ALT + ")\\s*:", "g");
  var C_GO_FIELD = /\b(Temperature|TopP|TopK)\s*:/g;
  var C_GO_NAME = { Temperature: "temperature", TopP: "top_p", TopK: "top_k" };

  function claudeFinding(line, param) {
    return finding(line, RULES.CLAUDE_SAMPLING,
      '"' + param + '" is sent to the Claude Messages API. In API version 2026-10-21, which ' +
      "the Python SDK 2.0.0 and TypeScript SDK 1.0.0 use, a request with temperature, " +
      "top_p or top_k returns a 400 error on every model, even at the default value. " +
      "On the older API version, Claude 4.7 and later models already return a 400 error " +
      "for a non-default value.",
      'Remove "' + param + '" and steer the output with the prompt instead.');
  }

  function keepValue(lx, valueAt) { return !matchAt(NULL_VALUE, lx.code, valueAt) && !matchAt(NULL_VALUE, lx.source, valueAt); }

  function checkClaudeSampling(lx) {
    if (!ANTHROPIC_FILE.test(lx.source)) return [];
    var hits = [], spans = [];
    if (lx.lang === GO) {
      findAll(GO_CLAUDE_PARAMS, lx.code).forEach(function (m) {
        var open = m.index + m[0].length - 1;
        spans.push([open, closeParen(lx.code, open)]);
      });
      spans.forEach(function (sp) {
        findAll(C_GO_FIELD, lx.code, sp[0], sp[1]).forEach(function (f) {
          if (inSet(lx.prevChar(f.index), "{,") && keepValue(lx, f.index + f[1].length)) hits.push([f.index, C_GO_NAME[f[1]]]);
        });
      });
    } else {
      findAll(CLAUDE_CALL, lx.code).forEach(function (m) {
        if (lx.code.slice(Math.max(0, m.index - 16), m.index).indexOf("threads") !== -1) return;
        var open = m.index + m[0].length - 1;
        spans.push([open, closeParen(lx.code, open)]);
      });
      var rx = lx.lang === PY ? C_PY_KW : C_JS_KEY;
      spans.forEach(function (sp) {
        findAll(rx, lx.code, sp[0], sp[1]).forEach(function (f) {
          if (inSet(lx.prevChar(f.index), "(,{") && keepValue(lx, f.index + f[1].length)) hits.push([f.index, f[1]]);
        });
      });
    }
    var rawHttp = !spans.length && lx.source.indexOf("api.anthropic.com") !== -1;
    lx.strings.forEach(function (lit) {
      if (CLAUDE_SAMPLING_PARAMS.indexOf(lit.value) === -1 || lx.nextChar(lit.end) !== ":") return;
      if (!inSet(lx.prevChar(lit.start), "{,") || !keepValue(lx, lit.end)) return;
      if (rawHttp || spans.some(function (sp) { return sp[0] <= lit.start && lit.start < sp[1]; })) hits.push([lit.start, lit.value]);
    });
    hits.sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    var out = [], seen = {};
    hits.forEach(function (h) {
      var line = lx.lineOf(h[0]), key = line + "|" + h[1];
      if (!seen[key]) { seen[key] = true; out.push(claudeFinding(line, h[1])); }
    });
    return out;
  }

  // LC006: retired OpenAI endpoints.
  var OPENAI_FILE = new RegExp(
    "^\\s*(?:import\\s+openai\\b|from\\s+openai\\b)|[\"']openai[\"']|[\"']openai/|openai-go|" +
    "sashabaranov/go-openai|\\bAzureOpenAI\\b", "m");
  var OA_CALLS = [
    ["assistants", /\bbeta\s*\.\s*(?:assistants|threads)\b/g],
    ["assistants", /\bBeta\s*\.\s*(?:Assistants|Threads)\b/g],
    ["assistants", /\b(?:CreateAssistant|CreateThread|CreateThreadAndRun|CreateRun)\s*\(/g],
    ["evals", /\bevals\s*\.\s*(?:create|update|delete|runs\s*\.\s*create)\s*\(/g],
    ["evals", /\bEvals\s*\.\s*(?:New|Update|Delete|Runs\s*\.\s*New)\s*\(/g],
    ["audio_translations", /\baudio\s*\.\s*translations\s*\.\s*create\s*\(/g],
    ["audio_translations", /\bAudio\s*\.\s*Translations\s*\.\s*New\s*\(|\bCreateTranslation\s*\(/g],
    ["videos", /\bvideos\s*\.\s*(?:create|create_and_poll|createAndPoll|remix|retrieve|list|delete|download_content|downloadContent)\s*\(/g],
    ["videos", /\bVideos\s*\.\s*(?:New|Get|List|Delete|Remix|DownloadContent)\s*\(/g]
  ];
  var OA_STRINGS = [
    ["prompts", /^pmpt_[A-Za-z0-9]+$/],
    ["realtime_v1", /\brealtime=v1\b/],
    ["assistants_v1", /\bassistants=v1\b/],
    ["assistants", /\bassistants=v2\b/]
  ];
  var OA_PATHS = [
    ["assistants", /\/v1\/(?:assistants|threads)\b/],
    ["prompts", /\/v1\/prompts\b/],
    ["evals", /\/v1\/evals\b/],
    ["audio_translations", /\/v1\/audio\/translations\b/],
    ["videos", /\/v1\/videos\b/],
    ["legacy", /\/v1\/(?:fine-tunes|edits|engines|answers|classifications)\b/]
  ];

  function endpointFinding(line, key) {
    var ep = OPENAI_ENDPOINTS[key], name = ep[0], date = ep[1], repl = ep[2], now = today(), verb;
    if (key === "evals") verb = date < now ? "became read-only on" : "becomes read-only on";
    else verb = date < now ? "was shut down on" : "shuts down on";
    var msg = name + " " + verb + " " + fmt(date) + ".";
    if (date < now && key !== "evals") msg += " Requests to it fail.";
    return finding(line, RULES.OPENAI_ENDPOINT, msg,
      repl ? "Move to " + repl + "." : "OpenAI lists no one-to-one replacement; remove this call.");
  }

  function checkOpenaiEndpoints(lx) {
    var hits = [], openaiFile = OPENAI_FILE.test(lx.source);
    if (openaiFile) {
      OA_CALLS.forEach(function (kr) {
        findAll(kr[1], lx.code).forEach(function (m) { hits.push([m.index, kr[0]]); });
      });
    }
    lx.strings.forEach(function (lit) {
      if (lit.docstring || !lit.value) return;
      OA_STRINGS.forEach(function (kr) { if (kr[1].test(lit.value)) hits.push([lit.start, kr[0]]); });
      if (openaiFile || lit.value.indexOf("api.openai.com") !== -1) {
        OA_PATHS.forEach(function (kr) { if (kr[1].test(lit.value)) hits.push([lit.start, kr[0]]); });
      }
    });
    hits.sort(function (a, b) { return a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    var out = [], seen = {};
    hits.forEach(function (h) {
      var line = lx.lineOf(h[0]), key = line + "|" + h[1];
      if (!seen[key]) { seen[key] = true; out.push(endpointFinding(line, h[1])); }
    });
    return out;
  }

  function runAll(lx) {
    var relevant = isRelevant(lx);
    var tiktokenLines = {}, anyTiktoken = false;
    findAll(TIKTOKEN_CALL[lx.lang], lx.code).forEach(function (m) { tiktokenLines[lx.lineOf(m.index)] = true; anyTiktoken = true; });
    // A model name passed to a tokenizer lookup is not an API call, so LC001
    // skips those lines; LC002 reports the ones that break.
    var findings = (relevant || anyTiktoken) ? checkTiktoken(lx) : [];
    findings = findings.concat(checkModelIds(lx, tiktokenLines));
    if (relevant) findings = findings.concat(checkChatTools(lx), checkSampling(lx));
    return findings.concat(checkClaudeSampling(lx), checkOpenaiEndpoints(lx));
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
    var context = platformsIn(text);
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
      findModels(p.value).forEach(function (m) {
        var k = p.line + "|" + m.id;
        if (seen[k]) return;
        var rep = describe(m.id, context);
        if (!rep) return;
        seen[k] = true;
        var f = modelFinding(p.line, rep, catalogs[p.group] === true);
        f.message += ' (Config key "' + p.key + '".)';
        if (f.severity === HIGH && rep.replacement && rep.replacement.indexOf(" or ") === -1) {
          f.fix = "Set " + p.key + ' to "' + rep.replacement + '".';
        }
        out.push(f);
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

  root.LunaCheck = { check: check, detectLanguage: detectLanguage, version: "0.4.0" };
})(typeof window !== "undefined" ? window : this);
