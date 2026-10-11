"use strict";
(function () {
  var TOKEN_KEY = "houston.remote.token";
  var FILTER_KEY = "houston.remote.workspace";
  var REPLIES_KEY = "houston.remote.replies";
  var COLLAPSED_KEY = "houston.remote.collapsed";
  var KEYBOARD_KEY = "houston.remote.keyboard";
  // With the event stream up, polling is only a safety net; without it, the
  // client polls at these rates until the stream reconnects.
  var SAFETY_MS = 30000, LIST_MS = 3000, FEED_MS = 2500, SCREEN_MS = 1500, SCREEN_LINES = 40;
  // Bound retained DOM/feed data even on a phone left open for days.
  var FEED_ENTRIES = 256, ACTIVITY_ENTRIES = 200, SSE_BUFFER = 65536;
  // Twice the server's 15 s heartbeat plus margin: a stream silent this long
  // is dead (for example after a network change) and is reopened.
  var RETRY_MAX_MS = 30000, STREAM_SILENCE_MS = 40000;
  // Deeper markdown nesting is shown as plain text, so a hostile reply cannot
  // exhaust the stack.
  var MD_DEPTH_MAX = 6;
  // Quick replies are short prompts kept on this device; the cap keeps the row scannable.
  var REPLIES_MAX = 12, REPLY_CHARS_MAX = 80;
  var DEFAULT_REPLIES = ["Continue", "Commit it", "Open a PR", "Explain that"];
  // A horizontal drag this long pages the inbox; shorter drags spring back.
  var SWIPE_PX = 64;
  var STATUS = { "needs-input": "Needs you", working: "Working", idle: "Idle", spawning: "Starting", unavailable: "No status" };
  var STATES = { sleeping: "Sleeping", exited: "Exited", killed: "Killed", interrupted: "Interrupted" };
  var KINDS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", cursor: "Cursor", grok: "Grok", custom: "Shell", ssh: "SSH" };
  var GLYPHS = { claude: 1, codex: 1, antigravity: 1, opencode: 1, cursor: 1, grok: 1 };
  var KEYS = [
    ["Esc", ["esc"]], ["↑", ["up"]], ["↓", ["down"]], ["←", ["left"]], ["→", ["right"]], ["Tab", ["tab"]], ["⏎", ["enter"]], ["^C", ["ctrl+c"], true]
  ];
  // Stroke icons in the desktop's 24px grid: p = path, c = circle, r = rect.
  var ICONS = {
    back: ["p:M15 5l-7 7 7 7"], chevR: ["p:m9 18 6-6-6-6"], chevD: ["p:m6 9 6 6 6-6"], up: ["p:m5 12 7-7 7 7M12 19V5"], down: ["p:M12 5v14M5 12l7 7 7-7"],
    inbox: ["p:M22 12h-6l-2 3h-4l-2-3H2", "p:M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
    grid: ["r:3,3,7,7,1", "r:14,3,7,7,1", "r:3,14,7,7,1", "r:14,14,7,7,1"],
    activity: ["p:M22 12h-4l-3 9L9 3l-3 9H2"],
    computer: ["r:3,4,18,12,2", "p:M8 20h8M12 16v4"],
    eye: ["p:M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z", "c:12,12,3"],
    search: ["c:11,11,7", "p:m20 20-3.5-3.5"], globe: ["c:12,12,9", "p:M12 3a14 14 0 0 0 0 18 14 14 0 0 0 0-18M3 12h18"],
    pencil: ["p:M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"], prompt: ["p:m4 17 6-6-6-6M12 19h8"],
    file: ["p:M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "p:M14 2v4a2 2 0 0 0 2 2h4"],
    files: ["p:M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "p:M14 2v4a2 2 0 0 0 2 2h4", "p:M9 15h6"],
    folder: ["p:M20 19a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"],
    zap: ["p:M13 2 3 14h9l-1 8 10-12h-9l1-8z"], tasks: ["p:m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"],
    layers: ["p:m12 2 10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5"], clock: ["c:12,12,9", "p:M12 7v5l3 2"],
    check: ["p:M20 6 9 17l-5-5"], alert: ["c:12,12,9", "p:M12 8v4M12 16h.01"], help: ["c:12,12,9", "p:M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"],
    square: ["r:5,5,14,14,1"], x: ["p:M18 6 6 18M6 6l12 12"], plus: ["p:M5 12h14M12 5v14"], term: ["r:3,3,18,18,2", "p:m7 9 3 3-3 3M13 15h4"],
    branch: ["p:M6 3v12", "c:18,6,3", "c:6,18,3", "p:M18 9a9 9 0 0 1-9 9"], unlink: ["p:M18.84 12.25 20.25 10.84a4 4 0 0 0-5.66-5.66l-1.41 1.41M5.16 11.75 3.75 13.16a4 4 0 0 0 5.66 5.66l1.41-1.41M8 2v3M2 8h3M16 22v-3M22 16h-3"],
    phone: ["r:6,2,12,20,2.5", "p:M11 18h2"], bell: ["p:M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"],
    download: ["p:M12 3v12M7 10l5 5 5-5M5 21h14"], shield: ["p:M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"]
  };

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    token: null, pendingPair: null, sessions: [], grids: [], loaded: false, filter: null, view: null, home: "inbox", inboxIndex: 0, inboxFeed: {}, me: {}, activity: [], activityLast: 0, activityEpoch: null, activityLoaded: false, reachable: false, lastSeen: 0, disconnectedAt: 0, deepLink: false,
    pane: null, tab: "conv", entries: [], last: 0, epoch: null, pending: null, expanded: {}, turns: {},
    shown: 0, tailSteps: null, tailNode: null,
    live: false, stream: null, retry: 1000, timers: {}, busy: false, other: null,
    sent: {}, seenPending: {}, selection: {}, activityFilter: "all", activityAt: null, feedBusy: false, activityBusy: false,
    swapIn: null, inboxDir: null,
    authGeneration: 0, paneGeneration: 0, requests: {}, httpRequests: new Set()
  };

  // Storage can be blocked (private mode); the page works without it.
  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function store(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* not persisted */ }
  }
  function storedJson(key, fallback) {
    try { var v = JSON.parse(stored(key) || "null"); return v == null ? fallback : v; } catch (e) { return fallback; }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(name, cls) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    if (cls) s.setAttribute("class", cls);
    (ICONS[name] || ICONS.zap).forEach(function (spec) {
      var kind = spec[0], v = spec.slice(2), n;
      if (kind === "p") { n = document.createElementNS(ns, "path"); n.setAttribute("d", v); }
      else {
        var a = v.split(",");
        if (kind === "c") { n = document.createElementNS(ns, "circle"); n.setAttribute("cx", a[0]); n.setAttribute("cy", a[1]); n.setAttribute("r", a[2]); }
        else { n = document.createElementNS(ns, "rect"); n.setAttribute("x", a[0]); n.setAttribute("y", a[1]); n.setAttribute("width", a[2]); n.setAttribute("height", a[3]); n.setAttribute("rx", a[4] || 0); }
      }
      s.appendChild(n);
    });
    return s;
  }

  function button(cls, text, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  // Restarts a one-shot CSS animation on an element that stays in the DOM.
  function animate(node, cls) {
    if (!node) return;
    ["enter-push", "enter-pop", "enter-fade", "from-left", "from-right"].forEach(function (c) { node.classList.remove(c); });
    void node.offsetWidth;
    node.classList.add(cls);
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }

  function ago(ms) {
    if (!ms) return "";
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  }

  function duration(ms) {
    var seconds = Math.max(0, Math.round((ms || 0) / 1000));
    if (seconds < 60) return seconds + "s";
    var m = Math.floor(seconds / 60), r = seconds % 60;
    if (m < 60) return m + "m " + (r < 10 ? "0" : "") + r + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  function kindName(kind) { return KINDS[kind] || kind || "Agent"; }

  function statusOf(s) {
    if (!s) return { cls: "", label: "" };
    if (s.state !== "running") return { cls: "exited", label: STATES[s.state] || "No status" };
    return { cls: s.status || "", label: STATUS[s.status] || "No status" };
  }

  function needsYou(s) { return s.state === "running" && s.status === "needs-input"; }

  function excerpt(text) {
    var node = el("span"); inline(node, text || "");
    return node.textContent.replace(/\s+/g, " ").trim();
  }

  function dayLabel(at) {
    var date = new Date(at), today = new Date(), yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  function session(id) {
    for (var i = 0; i < S.sessions.length; i++) if (S.sessions[i].id === id) return S.sessions[i];
    return null;
  }

  function paneTitle(s) { return s ? (s.role && s.parent != null ? s.role : s.title || "Pane " + s.id) : ""; }

  // ---- Provider marks and status ----

  function providerMark(kind, size) {
    var wrap = el("span", "pv " + (kind || "custom") + (size ? " " + size : ""));
    wrap.setAttribute("aria-hidden", "true");
    if (GLYPHS[kind]) {
      var ns = "http://www.w3.org/2000/svg", g = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
      g.setAttribute("class", "pg"); use.setAttribute("href", "#p-" + kind); g.appendChild(use);
      wrap.appendChild(g);
    } else {
      wrap.appendChild(icon(kind === "ssh" ? "globe" : "prompt"));
    }
    return wrap;
  }

  function avatar(s) {
    var wrap = el("span", "avatar");
    wrap.appendChild(providerMark(s.kind));
    wrap.appendChild(el("span", "sdot " + statusOf(s).cls));
    return wrap;
  }

  function statusLine(s, withAgo) {
    var st = statusOf(s), line = el("span", "status-line " + st.cls);
    if (st.cls === "working") line.appendChild(el("span", "spinner"));
    else line.appendChild(el("span", "sdot " + st.cls));
    line.appendChild(document.createTextNode(st.label));
    var since = needsYou(s) ? (s.waiting_since || s.status_since) : s.status_since;
    if (withAgo && since && st.cls !== "working") line.appendChild(el("span", "ago", " · " + ago(since)));
    return line;
  }

  // ---- Step vocabulary: tool names become a verb, an icon and a target ----

  function stepCategory(tool) {
    if (/^(Read|read_file|read)$/.test(tool)) return "read";
    if (/^(Grep|Glob|WebSearch|search|grep|glob)$/.test(tool)) return "search";
    if (/^(Edit|MultiEdit|Write|NotebookEdit|edit|write|edit_file|write_file|apply_patch)$/.test(tool)) return "edit";
    if (/^(Bash|Shell|shell|run_command|exec_command)$/.test(tool)) return "run";
    return "other";
  }

  function stepWords(tool, target) {
    tool = tool || "tool";
    var mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
    if (mcp) return { verb: "Used", icon: "zap", target: mcp[1] + " · " + mcp[2].replace(/_/g, " ") + (target ? " " + target : "") };
    if (tool === "WebSearch") return { verb: "Searched web", icon: "globe", target: target };
    if (tool === "WebFetch") return { verb: "Fetched", icon: "globe", target: target };
    if (/^(Glob|glob)$/.test(tool)) return { verb: "Listed", icon: "folder", target: target };
    if (/^(Write|write|write_file)$/.test(tool)) return { verb: "Wrote", icon: "pencil", target: target };
    if (/^(Task|Agent)$/.test(tool)) return { verb: "Delegated", icon: "layers", target: target };
    if (tool === "TodoWrite") return { verb: "Updated tasks", icon: "tasks", target: "" };
    if (tool === "Skill") return { verb: "Used skill", icon: "layers", target: target };
    var cat = stepCategory(tool);
    if (cat === "read") return { verb: "Read", icon: "eye", target: target };
    if (cat === "search") return { verb: "Searched", icon: "search", target: target };
    if (cat === "edit") return { verb: "Edited", icon: "pencil", target: target };
    if (cat === "run") return { verb: "Ran", icon: "prompt", target: target };
    return { verb: tool.replace(/_/g, " "), icon: "zap", target: target };
  }

  // `last_step` is "<tool> <target>"; tiles show it with the same verbs as the log.
  function lastStepText(text) {
    if (!text) return "";
    var at = text.indexOf(" "), w = stepWords(at < 0 ? text : text.slice(0, at), at < 0 ? "" : text.slice(at + 1));
    return w.verb + (w.target ? " " + w.target : "");
  }

  function turnSummary(turn) {
    var c = turn.counts || {}, parts = [];
    if (c.read) parts.push("read " + plural(c.read, "file", "files"));
    if (c.search) parts.push("searched " + plural(c.search, "time", "times"));
    if (c.edit) parts.push("edited " + plural(c.edit, "file", "files"));
    if (c.run) parts.push("ran " + plural(c.run, "command", "commands"));
    if (c.other) parts.push("used " + plural(c.other, "tool", "tools"));
    var text = parts.join(", ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
  }

  // ---- HTTP ----

  // Allow the server's ten-second input deadline plus network overhead.
  var REQUEST_MS = 15000;
  // Allow the server's 180-second transcription deadline plus upload/response overhead.
  var DICTATE_REQUEST_MS = 190000;

  function staleRequest() {
    var err = new Error("Ignored an older request."); err.stale = true; return err;
  }

  function beginRequest(name, paneScoped) {
    if (S.requests[name]) S.requests[name].ctrl.abort();
    var request = { ctrl: new AbortController(), auth: S.authGeneration, pane: paneScoped === false ? null : S.paneGeneration };
    S.requests[name] = request;
    request.current = function () { return S.requests[name] === request && request.auth === S.authGeneration && (request.pane == null || request.pane === S.paneGeneration); };
    return request;
  }

  function resetPaneRequests() {
    S.paneGeneration++;
    ["feed", "input", "screen", "dictate"].forEach(function (name) { if (S.requests[name]) S.requests[name].ctrl.abort(); delete S.requests[name]; });
    S.feedBusy = false; S.busy = false;
  }

  function resetAuthRequests() {
    S.authGeneration++;
    S.httpRequests.forEach(function (ctrl) { ctrl.abort(); });
    S.requests = {}; S.activityBusy = false;
    resetPaneRequests();
  }

  function api(method, path, body, request) {
    var raw = body instanceof Uint8Array, token = S.token, auth = S.authGeneration, code = S.pendingPair;
    var ctrl = request ? request.ctrl : new AbortController();
    var headers = { "Content-Type": raw ? "application/octet-stream" : "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    var current = function () { return auth === S.authGeneration && token === S.token && (path !== "/api/pair" || code === S.pendingPair) && (!request || request.current()); };
    var timer, onAbort;
    S.httpRequests.add(ctrl);
    var deadline = new Promise(function (_, reject) {
      onAbort = function () { reject(current() ? new Error("Request cancelled.") : staleRequest()); };
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(function () {
        reject(new Error(method === "POST" && /\/(input|decide)$/.test(path) ? "Request timed out; the input may already have reached the pane." : "Request timed out. Try again."));
        ctrl.abort();
      }, method === "POST" && /\/dictate$/.test(path) ? DICTATE_REQUEST_MS : REQUEST_MS);
    });
    var response = fetch(path, { method: method, headers: headers, body: raw ? body : body ? JSON.stringify(body) : undefined, cache: "no-store", signal: ctrl.signal })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!current() || ctrl.signal.aborted) throw staleRequest();
          if (r.status === 401 && token && path !== "/api/pair") unpair(data.reason === "revoked" ? "revoked" : "invalid");
          if (!r.ok) {
            var err = new Error(data.error || ("Request failed with status " + r.status));
            err.status = r.status; err.reason = data.reason; err.retry = Number(r.headers.get("Retry-After")) || 0;
            throw err;
          }
          return data;
        });
      });
    return Promise.race([response, deadline]).finally(function () {
      clearTimeout(timer); ctrl.signal.removeEventListener("abort", onAbort); S.httpRequests.delete(ctrl);
    });
  }

  function later(name, fn, ms) {
    clearTimeout(S.timers[name]);
    S.timers[name] = setTimeout(fn, ms);
    return S.timers[name];
  }

  function stopTimers() {
    Object.keys(S.timers).forEach(function (k) { clearTimeout(S.timers[k]); });
    S.timers = {};
  }

  // ---- Live events: fetch streaming carries the bearer header that EventSource cannot ----

  function hostName() { return (S.me.host || {}).name || location.hostname; }

  function setLive(on) {
    S.live = on;
    if (on) { S.lastSeen = Date.now(); }
    var c = $("conn");
    c.className = "host-pill " + (on ? "live" : "reconnecting") + (S.view === "list" && S.home !== "computer" ? "" : " hidden");
    $("conn-label").textContent = hostName();
    c.setAttribute("aria-label", on ? "Live updates from " + hostName() : "Live updates reconnecting; polling available");
  }

  function connect() {
    if (!S.token || S.stream || document.hidden || typeof AbortController === "undefined") return;
    var ctrl = new AbortController();
    S.stream = ctrl;
    fetch("/api/events", { headers: { Authorization: "Bearer " + S.token, Accept: "text/event-stream" }, cache: "no-store", signal: ctrl.signal })
      .then(function (r) {
        if (r.status === 401) return r.json().catch(function () { return {}; }).then(function (d) { if (S.stream === ctrl) unpair(d.reason === "revoked" ? "revoked" : "invalid"); throw new Error("unpaired"); });
        if (!r.ok || !r.body) throw new Error("event stream answered " + r.status);
        var reader = r.body.getReader(), decoder = new TextDecoder(), buf = "";
        var silence = function () { later("stream-silence", function () { if (S.stream === ctrl) ctrl.abort(); }, STREAM_SILENCE_MS); };
        silence();
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done || S.stream !== ctrl) return;
            silence();
            buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
            if (buf.length > SSE_BUFFER) { ctrl.abort(); throw new Error("Event stream exceeded its buffer limit"); }
            var at;
            while ((at = buf.indexOf("\n\n")) >= 0) {
              onEvent(buf.slice(0, at));
              buf = buf.slice(at + 2);
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () { /* reconnects below */ })
      .then(function () {
        clearTimeout(S.timers["stream-silence"]);
        if (S.stream !== ctrl) return;
        S.stream = null;
        setLive(false);
        if (S.token) setReachable(false);
        if (!S.token || document.hidden) return;
        later("connect", connect, S.retry);
        S.retry = Math.min(S.retry * 2, RETRY_MAX_MS);
        schedulePoll();
      });
  }

  function disconnect() {
    if (S.stream) { var c = S.stream; S.stream = null; c.abort(); }
    setLive(false);
  }

  function onEvent(block) {
    var name = "", data = "";
    block.split("\n").forEach(function (line) {
      if (line.indexOf("event:") === 0) name = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
    });
    if (!name) return;
    var d = {};
    try { d = JSON.parse(data || "{}"); } catch (e) { d = {}; }
    if (name === "ended") {
      unpair(d.reason === "revoked" ? "revoked" : d.reason === "disabled" ? "disabled" : "ended");
    } else if (name === "ready") {
      S.retry = 1000;
      setLive(true);
      refreshAll();
    } else if (name === "session") {
      later("sessions", loadSessions, 150);
      if (d.id === S.pane) later("feed", loadFeed, 100);
    } else if (name === "feed") {
      if (d.id === S.pane) later("feed", loadFeed, 100);
      later("sessions", loadSessions, 400);
    } else if (name === "grids") {
      later("sessions", loadSessions, 150);
    } else if (name === "resync") {
      refreshAll();
    }
  }

  function refreshAll() {
    loadSessions();
    if (S.home === "activity") loadActivity();
    if (S.pane != null) { loadFeed(); if (S.tab === "term") loadScreen(); }
  }

  function schedulePoll() {
    if (!S.token || document.hidden) return;
    var ms = S.live ? SAFETY_MS : (S.pane != null ? FEED_MS : LIST_MS);
    later("poll", function () {
      refreshAll();
      schedulePoll();
    }, ms);
  }

  // ---- Views ----

  function show(view) {
    var from = S.view;
    if (from === "pane" && view !== "pane") resetPaneRequests();
    S.view = view;
    ["pair", "list", "pane"].forEach(function (v) { $("view-" + v).classList.toggle("hidden", v !== view); });
    $("back").classList.toggle("hidden", view !== "pane");
    $("pane-status").classList.toggle("hidden", view !== "pane");
    $("subheading").classList.toggle("hidden", view !== "pane");
    $("pane-menu").classList.toggle("hidden", view !== "pane");
    $("provider-avatar").classList.toggle("hidden", view !== "pane");
    $("tabbar").classList.toggle("hidden", view !== "list");
    $("bar-meta").classList.add("hidden");
    $("jump").classList.add("hidden");
    document.body.dataset.view = view;
    document.body.classList.remove("scrolled", "composing");
    setLive(S.live);
    if (view !== "pane") $("heading").textContent = view === "list" ? homeTitle() : "Houston";
    if (from && from !== view) {
      if (view === "pane") animate($("view-pane"), "enter-push");
      else if (view === "list" && from === "pane") animate($("view-list"), "enter-pop");
      else animate($("view-" + view), "enter-fade");
    }
  }

  // Pairing screens: the confirm step, a fresh visit, and every way pairing ends.
  var ENDINGS = {
    revoked: ["This phone was disconnected", "It was revoked on the computer. Nothing from your panes is kept here.", "danger"],
    disabled: ["Remote access is off", "It was turned off on the computer. Nothing from your panes is kept here.", "danger"],
    invalid: ["This phone is no longer paired", "The computer no longer accepts this device. Nothing from your panes is kept here.", "danger"],
    ended: ["The connection ended", "Pair this phone again to keep following your panes.", "danger"],
    forgot: ["This phone forgot its pairing", "Its token stays valid until you revoke it under Settings ▸ Remote access ▸ Devices on the computer.", "device"],
    expired: ["This code has expired", "Pairing codes work once and last 10 minutes.", "warn"],
    used: ["This code was already used", "Pairing codes work once and last 10 minutes.", "warn"]
  };

  function setMark(kind) {
    var mark = $("pair-mark");
    mark.replaceChildren();
    mark.className = "pair-mark" + (kind === "logo" ? "" : " mark-tile " + kind);
    if (kind === "logo") { var img = el("img"); img.src = "icon-192.png"; img.alt = ""; img.width = 72; img.height = 72; mark.appendChild(img); }
    else mark.appendChild(icon({ ok: "check", warn: "clock", danger: "unlink", device: "phone" }[kind] || "phone"));
  }

  // Android installs the authority as a CA certificate; iOS installs a profile, then needs full trust turned on.
  var TRUST_STEPS = [
    ["Android", "Settings ▸ Security ▸ Encryption & credentials ▸ Install a certificate ▸ CA certificate, then pick houston-ca.crt."],
    ["iPhone or iPad", "Settings ▸ Profile Downloaded ▸ Install, then Settings ▸ General ▸ About ▸ Certificate Trust Settings and turn on full trust for it."]
  ];

  // This computer's certificate authority, when the listener serves its own HTTPS;
  // behind a proxy such as tailscale serve there is none (404).
  function loadCa() {
    return api("GET", "/api/ca").then(function (d) { S.ca = d; }, function () { S.ca = null; }).then(function () {
      renderTrust();
      if (S.view === "list" && S.home === "computer") renderList();
    });
  }

  function trustLinks(root) {
    var a = el("a", "btn block", "Android: download certificate"); a.href = "houston-ca.crt"; a.setAttribute("download", "houston-ca.crt");
    var i = el("a", "btn block", "iPhone or iPad: download profile"); i.href = "houston-ca.mobileconfig";
    root.appendChild(a); root.appendChild(i);
  }

  function renderTrust() {
    var root = $("trust"), show = !!S.ca && !$("pair-form").classList.contains("hidden");
    root.classList.toggle("hidden", !show);
    if (!show) return;
    root.replaceChildren();
    root.appendChild(el("b", null, "Trust this computer"));
    root.appendChild(el("span", null, "Houston serves this page over HTTPS with a certificate from the computer itself. If the browser warned about this site, install the certificate once; the microphone and the home-screen app need it."));
    var actions = el("div", "trust-actions"); trustLinks(actions); root.appendChild(actions);
    var ol = el("ol", "mini-steps");
    TRUST_STEPS.forEach(function (t) { var li = el("li"); li.appendChild(el("b", null, t[0] + ": ")); li.appendChild(document.createTextNode(t[1])); ol.appendChild(li); });
    root.appendChild(ol);
    var fp = el("span", "trust-fp", "Before trusting it, check that this fingerprint matches Settings ▸ Remote access on the computer: ");
    fp.appendChild(el("code", null, S.ca.fingerprint));
    root.appendChild(fp);
  }

  function pairFacts() {
    var root = $("pair-facts"), https = location.protocol === "https:";
    root.replaceChildren();
    [["Address", location.host, "mono"], ["Connection", https ? "Encrypted (HTTPS)" : "Not encrypted (HTTP)", https ? "good" : "bad"]].forEach(function (r) {
      root.appendChild(el("dt", null, r[0])); root.appendChild(el("dd", r[2], r[1]));
    });
  }

  function showPair(ending, detail) {
    cancelDictation(); resetAuthRequests();
    $("pair-submit").disabled = false; $("pair-submit").textContent = "Connect";
    stopTimers(); disconnect(); resetKeys();
    S.pane = null;
    $("reconnect").classList.add("hidden");
    var confirm = !!S.pendingPair && !ending, info = ending ? ENDINGS[ending] || ["Cannot connect", detail || "", "warn"] : null;
    setMark(info ? info[2] : confirm ? "device" : "logo");
    $("pair-title").textContent = info ? info[0] : confirm ? "Connect to " + location.hostname + "?" : "Connect your phone";
    $("pair-lede").textContent = info ? info[1] : confirm ? "Houston on this computer asked to pair." : "Follow and answer your Houston panes from here.";
    $("pair-steps").classList.toggle("hidden", confirm || !!info);
    $("pair-facts").classList.toggle("hidden", !confirm);
    if (confirm) pairFacts();
    $("pair-form").classList.toggle("hidden", !confirm);
    renderTrust();
    if (confirm) loadCa();
    $("route-warning").classList.toggle("hidden", !confirm || location.protocol === "https:");
    $("pair-submit").classList.toggle("hidden", !confirm);
    $("pair-connected").classList.add("hidden");
    $("pair-continue").classList.add("hidden");
    $("pair-recover").classList.toggle("hidden", !info);
    $("pair-again").classList.toggle("hidden", !info);
    $("pair-again").textContent = ending === "expired" || ending === "used" ? "Scan a new code" : "Pair again";
    $("pair-error").textContent = detail || "";
    $("pair-error").classList.toggle("hidden", !detail || !!info && !!ENDINGS[ending]);
    show("pair");
  }

  function unpair(ending) {
    resetAuthRequests();
    S.token = null;
    S.sessions = []; S.grids = []; S.entries = []; S.pending = null; S.inboxFeed = {}; S.activity = []; S.activityLast = 0; S.activityEpoch = null; S.activityLoaded = false; S.me = {}; S.sent = {}; S.seenPending = {}; S.pendingPair = null; S.deepLink = false; S.reachable = false; S.loaded = false; S.selection = {}; S.busy = false; S.feedBusy = false; S.activityBusy = false; S.stopArmed = false; S.activityAt = null;
    $("text").value = ""; setOther(null); toggleKeys(false);
    $("quick-replies").replaceChildren(); $("children").replaceChildren(); $("child-band").replaceChildren(); $("screen-keys").replaceChildren();
    $("feed").replaceChildren(); $("list").replaceChildren(); $("card").replaceChildren(); $("screen").textContent = "";
    ["screen-sheet", "menu-sheet", "replies-sheet"].forEach(function (id) { if ($(id).open) $(id).close(); });
    document.body.classList.remove("offline");
    document.title = "Houston";
    store(TOKEN_KEY, null);
    showPair(ending);
  }

  function updateTitle() {
    var n = S.sessions.filter(needsYou).length;
    document.title = n ? "(" + n + ") Houston" : "Houston";
  }

  function notePending() {
    var fresh = false, seen = {}, sent = {};
    S.sessions.forEach(function (s) {
      if (!s.pending) return;
      var key = s.id + ":" + s.pending.epoch + ":" + s.pending.seq + ":" + s.pending.type;
      if (!S.seenPending[key] && S.loaded) fresh = true;
      seen[key] = true;
      var tap = s.id + ":" + s.pending.epoch + ":" + s.pending.seq;
      if (S.sent[tap]) sent[tap] = true;
    });
    // Only cards still listed are remembered, so neither map grows.
    S.seenPending = seen;
    S.sent = sent;
    if (fresh && stored("houston.remote.vibrate") !== "off" && !document.hidden && navigator.vibrate) {
      try { navigator.vibrate(40); } catch (e) { /* unsupported */ }
    }
  }

  function loadSessions() {
    if (!S.token) return Promise.resolve();
    // Polls and stream events share a refresh until it settles in this generation.
    var pending = S.requests.sessions;
    if (pending && pending.current() && pending.promise) return pending.promise;
    var request = beginRequest("sessions", false);
    request.promise = api("GET", "/api/sessions", null, request).then(function (d) {
      if (!request.current()) return;
      S.sessions = d.sessions || [];
      S.grids = d.grids || [];
      // Refresh decision identities before re-enabling any offline controls.
      setReachable(true);
      notePending();
      S.loaded = true;
      updateTitle();
      $("list-error").classList.add("hidden");
      if (S.view === "list") renderList();
      S.inboxFeed = Object.fromEntries(Object.entries(S.inboxFeed).filter(function (pair) { return S.sessions.some(function (s) { return String(s.id) === pair[0] && s.pending; }); }));
      if (S.view === "pane") {
        var current = session(S.pane);
        S.pending = current && current.pending || null;
        renderBar();
        renderChildren();
        renderQuickReplies();
        renderCard();
        renderWorking();
      }
    }).catch(function (e) {
      if (!request.current() || e.stale) return;
      if (S.token && (!e.status || e.status >= 500)) setReachable(false);
      if (S.view === "list" && S.token) {
        $("list-error").textContent = e.message;
        $("list-error").classList.remove("hidden");
      }
    }).finally(function () { request.promise = null; });
    return request.promise;
  }

  // ---- Home ----

  function homeTitle() { return { inbox: "Inbox", panes: "Panes", activity: "Activity", computer: "Computer" }[S.home]; }

  function renderList() {
    document.body.dataset.home = S.home;
    $("heading").textContent = homeTitle();
    renderTabs();
    setLive(S.live);
    $("chips").classList.add("hidden");
    $("bar-meta").classList.add("hidden");
    var root = $("list"); root.replaceChildren();
    if (S.home === "inbox") renderInbox(root);
    else if (S.home === "activity") renderActivity(root);
    else if (S.home === "computer") renderComputer(root);
    else renderPanes(root);
    if (S.swapIn) { animate(root, "enter-fade"); S.swapIn = null; }
  }

  function setHome(tab) {
    if (S.home === tab) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    S.home = tab; S.swapIn = true;
    window.scrollTo(0, 0);
    renderList();
    if (tab === "activity") loadActivity();
    if (tab === "computer") { loadMe().catch(function (e) { if (!e.stale) toast(e.message, true); }); loadCa(); }
  }

  function renderTabs() {
    var root = $("tabbar"), n = S.sessions.filter(needsYou).length;
    if (!root.children.length) {
      [["inbox", "Inbox", "inbox"], ["panes", "Panes", "grid"], ["activity", "Activity", "activity"], ["computer", "Computer", "computer"]].forEach(function (t) {
        var b = button("nav-tab", null, function () { setHome(t[0]); });
        b.dataset.tab = t[0];
        b.appendChild(icon(t[2])); b.appendChild(el("span", null, t[1]));
        root.appendChild(b);
      });
    }
    Array.prototype.forEach.call(root.children, function (b) {
      b.setAttribute("aria-current", S.home === b.dataset.tab ? "page" : "false");
      if (b.dataset.tab !== "inbox") return;
      var badge = b.querySelector(".badge");
      if (!n) { if (badge) badge.remove(); return; }
      if (!badge) { badge = el("span", "badge"); b.appendChild(badge); }
      if (badge.textContent !== String(n)) { badge.textContent = String(n); animate(badge, "enter-fade"); }
      b.setAttribute("aria-label", "Inbox, " + plural(n, "request", "requests"));
    });
  }

  function skeleton(root, kind, n) {
    var wrap = el("div", kind === "tile" ? "tiles" : "");
    for (var i = 0; i < n; i++) wrap.appendChild(el("div", "skel " + kind + "-skel"));
    root.appendChild(wrap);
  }

  function emptyState(root, iconName, title, body) {
    var e = el("div", "empty");
    var i = el("span", "empty-icon"); i.appendChild(icon(iconName)); e.appendChild(i);
    e.appendChild(el("p", "empty-title", title));
    if (body) e.appendChild(el("p", "empty-body", body));
    root.appendChild(e);
    return e;
  }

  // ---- Panes tab: workspaces, then the grids the desktop shows ----

  function workspaces() {
    var seen = {}, out = [];
    S.sessions.forEach(function (s) {
      if (!seen[s.workspace.path]) { seen[s.workspace.path] = true; out.push(s.workspace); }
    });
    return out;
  }

  function renderChips() {
    var list = workspaces(), root = $("chips");
    if (S.filter && !list.some(function (w) { return w.path === S.filter; })) S.filter = null;
    root.classList.toggle("hidden", list.length < 2);
    root.replaceChildren();
    if (list.length < 2) return;
    [{ name: "All", path: null }].concat(list).forEach(function (w) {
      var group = S.sessions.filter(function (s) { return !w.path || s.workspace.path === w.path; });
      var b = button("chip", null, function () {
        if (S.filter === w.path) return;
        S.filter = w.path; S.swapIn = true;
        store(FILTER_KEY, w.path);
        renderList();
      });
      b.appendChild(el("span", null, w.name));
      b.appendChild(el("span", "n", String(group.length)));
      if (group.some(needsYou)) { var dot = el("span", "attention-dot"); dot.setAttribute("aria-label", "A pane here needs you"); b.appendChild(dot); }
      b.setAttribute("aria-pressed", String(S.filter === w.path));
      b.setAttribute("aria-label", w.name + ", " + plural(group.length, "pane", "panes"));
      root.appendChild(b);
    });
  }

  function rank(s) {
    if (s.state !== "running") return 4;
    return { "needs-input": 0, working: 1, idle: 2 }[s.status] != null ? { "needs-input": 0, working: 1, idle: 2 }[s.status] : 3;
  }

  function byAttention(list) {
    return list.map(function (s, i) { return [s, i]; }).sort(function (a, b) { return rank(a[0]) - rank(b[0]) || a[1] - b[1]; }).map(function (p) { return p[0]; });
  }

  function tile(s, index) {
    var t = button("tile" + (needsYou(s) ? " need" : "") + (s.state !== "running" ? " ended" : ""), null, function () { openPane(s.id); });
    t.style.animationDelay = Math.min(index, 8) * 25 + "ms";
    var top = el("span", "tile-top");
    top.appendChild(providerMark(s.kind, "sm"));
    var parent = s.parent != null ? session(s.parent) : null;
    if (parent) top.appendChild(el("span", "tile-child", "↳ " + (parent.title || "Pane " + parent.id)));
    t.appendChild(top);
    t.appendChild(el("b", null, paneTitle(s)));
    var sub;
    if (s.pending) sub = el("small", "quote", pendingWhat(s.pending));
    else if (s.status === "working" && s.last_step) sub = el("small", null, lastStepText(s.last_step));
    else if (s.last_reply_excerpt) sub = el("small", "quote", "“" + excerpt(s.last_reply_excerpt) + "”");
    else if (s.last_step) sub = el("small", null, lastStepText(s.last_step));
    else sub = el("small", "quote", kindName(s.kind) + (s.state === "running" ? "" : " · " + statusOf(s).label));
    t.appendChild(sub);
    t.appendChild(statusLine(s, true));
    t.setAttribute("aria-label", paneTitle(s) + ", " + kindName(s.kind) + ", " + statusOf(s).label);
    return t;
  }

  function pendingWhat(p) {
    if (!p) return "Needs you";
    if (p.type === "permission") return permissionWords(p.title).ask;
    if (p.type === "question") return "Asks: " + p.title;
    return "Waiting for you";
  }

  function collapsed() { return storedJson(COLLAPSED_KEY, {}); }

  function group(root, key, name, ws, list, index) {
    var shut = !!collapsed()[key], g = el("section", "group" + (shut ? " collapsed" : ""));
    var head = button("group-head", null, function () {
      var c = collapsed(), now = !c[key];
      if (now) c[key] = true; else delete c[key];
      store(COLLAPSED_KEY, JSON.stringify(c));
      g.classList.toggle("collapsed", now);
      head.setAttribute("aria-expanded", String(!now));
    });
    head.setAttribute("aria-expanded", String(!shut));
    head.appendChild(icon("chevD", "chev"));
    head.appendChild(icon("grid", "group-icon"));
    head.appendChild(el("span", "group-name", name));
    if (ws) head.appendChild(el("span", "group-ws", "· " + ws));
    var count = el("span", "group-count");
    if (list.some(needsYou)) count.appendChild(el("span", "attention-dot"));
    count.appendChild(document.createTextNode(String(list.length)));
    head.appendChild(count);
    g.appendChild(head);
    var body = el("div", "group-body"), tiles = el("div", "tiles");
    byAttention(list).forEach(function (s, i) { tiles.appendChild(tile(s, index + i)); });
    body.appendChild(tiles); g.appendChild(body);
    root.appendChild(g);
    return list.length;
  }

  function renderPanes(root) {
    renderChips();
    if (!S.loaded) { skeleton(root, "tile", 4); return; }
    var visible = S.sessions.filter(function (s) { return !S.filter || s.workspace.path === S.filter; });
    if (!visible.length) { emptyState(root, "grid", "No panes open", S.filter ? "Nothing is running in this workspace." : "Panes you open in Houston on the computer appear here."); return; }
    var need = visible.filter(needsYou).length, summary = el("p", "summary");
    summary.appendChild(document.createTextNode(plural(visible.length, "pane", "panes")));
    if (need) { summary.appendChild(document.createTextNode(" · ")); summary.appendChild(el("b", null, need + " need you")); }
    root.appendChild(summary);
    var ids = {}, placed = {}, index = 0, many = workspaces().length > 1 && !S.filter;
    visible.forEach(function (s) { ids[s.id] = s; });
    workspaces().filter(function (w) { return !S.filter || w.path === S.filter; }).forEach(function (w) {
      var grids = S.grids.filter(function (g) { return g.workspace === w.path; });
      grids.forEach(function (g) {
        var list = g.sessions.map(function (id) { return ids[id]; }).filter(function (s) { return s && !placed[s.id]; });
        if (!list.length) return;
        list.forEach(function (s) { placed[s.id] = true; });
        index += group(root, w.path + "::" + g.id, g.name || "Grid", many ? w.name : "", list, index);
      });
      var rest = visible.filter(function (s) { return s.workspace.path === w.path && !placed[s.id]; });
      if (!rest.length) return;
      rest.forEach(function (s) { placed[s.id] = true; });
      index += group(root, w.path + "::-", grids.length ? "Not in a grid" : w.name, grids.length && many ? w.name : "", rest, index);
    });
  }

  // ---- Inbox ----

  function lastSaid(s) {
    if (!s || !s.last_reply_excerpt) return null;
    var p = el("p", "last-said");
    p.appendChild(el("small", null, "Last said"));
    p.appendChild(document.createTextNode("“" + excerpt(s.last_reply_excerpt) + "”"));
    return p;
  }

  function pageInbox(step, total) {
    if (total < 2) return;
    S.inboxIndex = (S.inboxIndex + step + total) % total;
    S.inboxDir = step > 0 ? "from-right" : "from-left";
    renderList();
  }

  function renderInbox(root) {
    if (!S.loaded) { skeleton(root, "card", 1); return; }
    var needs = byAttention(S.sessions.filter(needsYou));
    if (!needs.length) { renderAllClear(root); return; }
    S.inboxIndex = Math.min(S.inboxIndex, needs.length - 1);
    var s = needs[S.inboxIndex], p = s.pending;
    if (needs.length > 1) { $("bar-meta").textContent = (S.inboxIndex + 1) + " of " + needs.length; $("bar-meta").classList.remove("hidden"); }
    var wrap = el("div", "inbox"), stage = el("div", "inbox-stage"), card = el("div", "inbox-card");
    if (S.inboxDir) { card.classList.add(S.inboxDir); S.inboxDir = null; }
    var who = button("inbox-who", null, function () { openPane(s.id); });
    who.appendChild(providerMark(s.kind, "sm")); who.appendChild(el("b", null, paneTitle(s))); who.appendChild(el("small", null, "· " + s.workspace.name));
    who.appendChild(el("span", "ago", ago(s.waiting_since || s.status_since)));
    card.appendChild(who);
    var content = el("div", "decision");
    card.appendChild(content);
    stage.appendChild(card);
    wrap.appendChild(stage);
    renderCard(content, p || { type: "input", title: "Needs you", decidable: false }, s, (S.inboxFeed[s.id] || {}).entries || []);
    var open = button("link-btn", "Open pane", function () { openPane(s.id); });
    open.appendChild(icon("chevR"));
    content.appendChild(open);
    if (needs.length > 1) {
      var pager = el("div", "pager");
      var prev = button("icon-btn", null, function () { pageInbox(-1, needs.length); }); prev.appendChild(icon("back")); prev.setAttribute("aria-label", "Previous request");
      var dots = el("span", "dots");
      needs.slice(0, 9).forEach(function (_, i) { dots.appendChild(el("i", i === S.inboxIndex ? "on" : "")); });
      var next = button("icon-btn", null, function () { pageInbox(1, needs.length); }); next.appendChild(icon("chevR")); next.setAttribute("aria-label", "Next request");
      pager.appendChild(prev); pager.appendChild(dots); pager.appendChild(next);
      wrap.appendChild(pager);
      wrap.appendChild(el("p", "hint", "Swipe for the next one"));
      swipe(stage, card, function (dir) { pageInbox(dir, needs.length); });
    }
    root.appendChild(wrap);
    if (p && (!S.inboxFeed[s.id] || S.inboxFeed[s.id].epoch !== p.epoch || !S.inboxFeed[s.id].entries.some(function (e) { return e.seq === p.seq; }))) {
      api("GET", "/api/sessions/" + s.id + "/feed?after=0").then(function (d) {
        var current = session(s.id);
        if (!current || !current.pending || current.pending.seq !== p.seq || current.pending.epoch !== d.epoch) return;
        S.inboxFeed[s.id] = { epoch: d.epoch, entries: d.entries || [] };
        if (S.view === "list" && S.home === "inbox" && content.isConnected) { renderCard(content, current.pending, current, d.entries || []); content.appendChild(open); }
      }).catch(function (e) { toast(e.message, true); });
    }
  }

  // Follows a horizontal drag; past the threshold the card leaves and the next one enters.
  function swipe(stage, card, done) {
    var x0 = null, y0 = 0, dx = 0, locked = null;
    stage.addEventListener("touchstart", function (ev) {
      if (ev.touches.length !== 1 || ev.target.closest("button, textarea, input, pre")) { x0 = null; return; }
      x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; locked = null;
      card.style.transition = "none";
    }, { passive: true });
    stage.addEventListener("touchmove", function (ev) {
      if (x0 == null) return;
      var mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
      if (locked == null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my);
      if (!locked) return;
      dx = mx;
      card.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 40) + "deg)";
      card.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 400));
    }, { passive: true });
    stage.addEventListener("touchend", function () {
      if (x0 == null) return;
      x0 = null;
      card.style.transition = "";
      if (locked && Math.abs(dx) > SWIPE_PX) { done(dx < 0 ? 1 : -1); return; }
      card.style.transform = ""; card.style.opacity = "";
    });
  }

  function renderAllClear(root) {
    var working = byAttention(S.sessions.filter(function (s) { return s.state === "running" && s.status === "working"; }));
    var clear = el("div", "all-clear");
    var i = el("span", "clear-icon"); i.appendChild(icon("check")); clear.appendChild(i);
    clear.appendChild(el("p", "empty-title", "All clear"));
    clear.appendChild(el("p", "empty-body", "Nothing is waiting for you." + (working.length ? " " + plural(working.length, "agent is", "agents are") + " working." : "")));
    root.appendChild(clear);
    if (working.length) {
      root.appendChild(el("h2", "section-head", "Working now"));
      var rows = el("div", "card rows");
      working.forEach(function (s) { rows.appendChild(row(s, lastStepText(s.last_step) || kindName(s.kind) + " is working", true)); });
      root.appendChild(rows);
    }
    var idle = S.sessions.filter(function (s) { return s.state === "running" && s.status === "idle" && s.last_reply_excerpt; }).sort(function (a, b) { return (b.status_since || 0) - (a.status_since || 0); }).slice(0, 3);
    if (idle.length) {
      root.appendChild(el("h2", "section-head", "Last finished"));
      var done = el("div", "card rows");
      idle.forEach(function (s) { done.appendChild(row(s, "“" + excerpt(s.last_reply_excerpt) + "”", false, ago(s.status_since))); });
      root.appendChild(done);
    }
  }

  function row(s, sub, mono, end) {
    var b = button("row", null, function () { openPane(s.id); });
    b.appendChild(avatar(s));
    var main = el("span", "row-main");
    main.appendChild(el("span", "row-title", paneTitle(s)));
    main.appendChild(el("span", "row-sub" + (mono ? " mono" : ""), sub));
    b.appendChild(main);
    var st = statusOf(s), tail = el("span", "row-end " + st.cls);
    if (end) tail.textContent = end;
    else if (st.cls === "working") tail.appendChild(el("span", "spinner"));
    else tail.textContent = st.label;
    b.appendChild(tail);
    b.appendChild(icon("chevR", "row-chev"));
    return b;
  }

  // ---- Activity ----

  function loadMe() {
    var request = beginRequest("me", false);
    return api("GET", "/api/me", null, request).then(function (d) { if (!request.current()) return; S.me = d; setLive(S.live); renderMic(); if (S.view === "list" && S.home === "computer") renderList(); });
  }

  function loadActivity() {
    if (!S.token || S.activityBusy) return;
    S.activityBusy = true;
    var request = beginRequest("activity", false), after = S.activityLast;
    return api("GET", "/api/activity?after=" + S.activityLast, null, request).then(function (d) {
      if (!request.current()) return;
      if (S.activityEpoch !== d.epoch || d.truncated) {
        S.activity = []; S.activityLast = 0;
        if (after && S.activityEpoch !== d.epoch) { S.activityEpoch = d.epoch; S.activityBusy = false; return loadActivity(); }
      }
      S.activityEpoch = d.epoch;
      (d.entries || []).forEach(function (e) { if (e.seq > S.activityLast) S.activity.push(e); });
      S.activityLast = S.activity.reduce(function (n, e) { return Math.max(n, e.seq); }, S.activityLast);
      // A long-lived phone retains at most 200 activity rows.
      S.activity = S.activity.slice(-ACTIVITY_ENTRIES); S.activityUnavailable = false; S.activityError = ""; S.activityLoaded = true;
      if (S.view === "list" && S.home === "activity") renderList();
    }).catch(function (e) { if (!request.current() || e.stale) return; S.activityLoaded = true; S.activityUnavailable = e.status === 404; S.activityError = S.activityUnavailable ? "" : e.message; if (S.view === "list" && S.home === "activity") renderList(); }).then(function () { if (request.current()) S.activityBusy = false; });
  }

  function activityWords(e) {
    if (e.kind === "finished") return [" finished", e.excerpt ? "“" + excerpt(e.excerpt) + "”" : ""];
    if (e.kind === "needs_you") return [" needs you", "Waiting for a decision"];
    return [" was answered", e.excerpt ? "Answered " + excerpt(e.excerpt) : ""];
  }

  function renderActivity(root) {
    var filters = $("chips");
    filters.replaceChildren(); filters.classList.remove("hidden");
    [["all", "All"], ["finished", "Finished"], ["decisions", "Decisions"]].forEach(function (f) {
      var b = button("chip", f[1], function () { if (S.activityFilter !== f[0]) { S.activityFilter = f[0]; S.swapIn = true; renderList(); } });
      b.setAttribute("aria-pressed", String(S.activityFilter === f[0])); filters.appendChild(b);
    });
    if (S.activityError) root.appendChild(el("p", "callout danger", S.activityError));
    if (!S.activityLoaded) { for (var k = 0; k < 5; k++) { var sk = el("div", "skel line"); sk.style.margin = "18px 0"; root.appendChild(sk); } return; }
    if (S.activityUnavailable) { emptyState(root, "activity", "Activity isn't available", "This computer runs a Houston without the activity log. Open a pane to see its conversation."); return; }
    var day = "", visible = S.activity.filter(function (e) { return S.activityFilter === "all" || (S.activityFilter === "decisions" ? e.kind !== "finished" : e.kind === "finished"); });
    if (!visible.length) { emptyState(root, "activity", S.activity.length ? "Nothing in this filter" : "No activity yet", "Finished turns and decisions appear here while remote access is on."); return; }
    var list = null;
    visible.slice().reverse().forEach(function (e) {
      var date = dayLabel(e.at);
      if (date !== day) { day = date; root.appendChild(el("h2", "section-head", date)); list = el("div"); root.appendChild(list); }
      var b = button("act", null, function () { S.activityAt = e.at; openPane(e.session); });
      b.appendChild(el("span", "act-time", clock(e.at)));
      var body = el("span", "act-body"), words = activityWords(e);
      body.appendChild(el("b", null, excerpt(e.title)));
      body.appendChild(document.createTextNode(words[0]));
      if (words[1]) body.appendChild(el("small", null, words[1]));
      b.appendChild(body);
      var kind = el("span", "act-kind " + e.kind);
      if (e.kind === "needs_you") kind.textContent = "?"; else kind.appendChild(icon("check"));
      b.appendChild(kind);
      list.appendChild(b);
    });
  }

  // ---- Computer ----

  function installSteps() {
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return ["In Safari, tap Share", "Choose Add to Home Screen, then Add"];
    if (/Android/.test(navigator.userAgent)) return ["Open the browser menu (⋮)", "Choose Install app or Add to Home screen"];
    return ["Use the browser's Install app option", "Or bookmark this page"];
  }

  function installHelp(root) {
    root.replaceChildren();
    root.appendChild(el("b", null, "Add Houston to your home screen"));
    root.appendChild(el("span", null, "It opens like an app, full screen, in one tap."));
    var ol = el("ol", "mini-steps");
    installSteps().forEach(function (t) { ol.appendChild(el("li", null, t)); });
    root.appendChild(ol);
  }

  function standalone() { return window.matchMedia && matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }

  function pref(root, label, value, onClick, cls) {
    var r = onClick ? button("pref" + (cls ? " " + cls : ""), null, onClick) : el("div", "pref" + (cls ? " " + cls : ""));
    r.appendChild(el("span", null, label));
    if (value != null) { if (typeof value === "string") r.appendChild(el("span", "val", value)); else r.appendChild(value); }
    root.appendChild(r);
    return r;
  }

  function renderComputer(root) {
    var host = S.me.host || {}, connection = S.me.connection || {};
    var https = connection.https == null ? location.protocol === "https:" : connection.https;
    var card = el("div", "card hostcard");
    var hi = el("span", "host-icon"); hi.appendChild(icon("computer")); card.appendChild(hi);
    var main = el("span", "host-main");
    main.appendChild(el("b", null, hostName()));
    main.appendChild(el("small", null, (connection.url || location.origin).replace(/^https?:\/\//, "") + " · " + (https ? "HTTPS" : "HTTP")));
    card.appendChild(main);
    card.appendChild(el("span", "live-badge" + (S.reachable ? "" : " off"), S.reachable ? (S.live ? "Live" : "Polling") : "Offline"));
    root.appendChild(card);

    var device = el("div", "card prefs");
    pref(device, "This device", S.me.name || "This browser");
    pref(device, "Houston", host.version ? "Version " + host.version : "Version not reported");
    pref(device, "Connection", https ? "Encrypted" : "Not encrypted");
    root.appendChild(device);

    var alerts = el("div", "card prefs");
    pref(alerts, "Notifications", "Set on the computer");
    var vib = stored("houston.remote.vibrate") !== "off", sw = el("span", "switch" + (vib ? " on" : ""));
    var v = pref(alerts, "Vibrate on new request", sw, function () { store("houston.remote.vibrate", vib ? "off" : "on"); renderList(); });
    v.setAttribute("role", "switch"); v.setAttribute("aria-checked", String(vib));
    root.appendChild(alerts);

    var tools = el("div", "card prefs");
    var size = screenSize(), stepper = el("span", "stepper");
    [[-1, "A−", "Smaller screen text"], [1, "A+", "Larger screen text"]].forEach(function (d, i) {
      var b = button(null, d[1], function () { store("houston.remote.screenSize", String(Math.max(9, Math.min(18, size + d[0])))); renderList(); });
      b.setAttribute("aria-label", d[2]);
      if (i === 1) stepper.appendChild(el("span", null, size + " px"));
      stepper.insertBefore(b, i === 1 ? null : stepper.firstChild);
    });
    pref(tools, "Screen text size", stepper);
    var count = el("span", "val", String(replies().length));
    count.appendChild(icon("chevR", "row-chev"));
    count.style.display = "inline-flex"; count.style.alignItems = "center"; count.style.gap = "4px";
    pref(tools, "Quick replies", count, openReplies);
    root.appendChild(tools);

    if (S.ca) {
      var trust = el("div", "card howto");
      trust.appendChild(el("b", null, "This computer's certificate"));
      trust.appendChild(el("span", null, "Install it once so the microphone and the home-screen app work. Fingerprint: " + S.ca.fingerprint));
      var links = el("div", "trust-actions"); trustLinks(links); trust.appendChild(links);
      root.appendChild(trust);
      trust.style.marginBottom = "var(--s3)";
    }
    if (!standalone()) {
      var app = el("div", "card howto");
      installHelp(app);
      root.appendChild(app);
      app.style.marginBottom = "var(--s3)";
    }
    var danger = el("div", "card prefs");
    pref(danger, "Disconnect this phone", null, function () {
      if (window.confirm("Forget this phone's pairing? To revoke its token, use Settings ▸ Remote access ▸ Devices on the computer.")) unpair("forgot");
    }, "danger");
    root.appendChild(danger);
    root.appendChild(el("p", "foot-note", "Remote access settings live on the computer. Preferences on this page stay on this phone."));
  }

  function setReachable(on) {
    var was = S.reachable;
    S.reachable = on;
    if (on) { S.lastSeen = Date.now(); S.disconnectedAt = 0; clearTimeout(S.timers.offline); }
    else { S.stopArmed = false; resetKeys(); if (!S.disconnectedAt) S.disconnectedAt = Date.now(); }
    var banner = $("reconnect"); banner.replaceChildren(); banner.classList.toggle("hidden", on || !S.token);
    if (!on && S.token) {
      var asleep = Date.now() - S.disconnectedAt >= 30000;
      if (!asleep) banner.appendChild(el("span", "spinner"));
      banner.appendChild(el("span", null, asleep ? "Can't reach " + hostName() + ". Is it asleep?" : "Reconnecting to " + hostName() + "… showing " + (S.lastSeen ? clock(S.lastSeen) : "last known state")));
      banner.appendChild(button("link-btn", "Retry", function () { S.retry = 1000; refreshAll(); connect(); }));
      if (!document.hidden) later("offline", function () { setReachable(false); }, 30000);
    }
    if (on && was === false && S.token && S.loaded) toast("Back online");
    document.body.classList.toggle("offline", !on && !!S.token);
    document.querySelectorAll(".key").forEach(function (b) { b.disabled = !on; });
    document.querySelectorAll("[data-decision]").forEach(function (b) { b.disabled = S.busy || !on || b.dataset.locked === "true"; });
    updateSend();
  }

  // ---- Toast ----

  function toast(text, isError) {
    var t = $("toast");
    t.textContent = text;
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    later("toast", function () { t.classList.remove("show"); }, isError ? 4000 : 2200);
  }

  // ---- Pane: children and quick replies ----

  function renderChildren() {
    var root = $("children"), band = $("child-band"); root.replaceChildren(); band.replaceChildren(); band.classList.add("hidden");
    var children = byAttention(S.sessions.filter(function (s) { return s.parent === S.pane; }));
    root.classList.toggle("hidden", !children.length);
    if (!children.length) return;
    var head = el("div", "card-head"), stack = el("span", "stack");
    children.slice(0, 4).forEach(function (s) { stack.appendChild(providerMark(s.kind)); });
    head.appendChild(stack);
    head.appendChild(el("span", null, plural(children.length, "child", "children")));
    root.appendChild(head);
    children.forEach(function (s) { root.appendChild(row(s, s.pending ? pendingWhat(s.pending) : lastStepText(s.last_step) || (s.last_reply_excerpt ? excerpt(s.last_reply_excerpt) : s.title))); });
    var need = children.find(needsYou);
    if (need) {
      band.classList.remove("hidden");
      var b = el("div", "band"); b.setAttribute("role", "status");
      b.appendChild(el("b", null, paneTitle(need) + " needs you"));
      b.appendChild(el("span", null, need.pending ? pendingWhat(need.pending) : ""));
      b.appendChild(button("btn", "Open", function () { openPane(need.id); }));
      band.appendChild(b);
    }
  }

  function replies() {
    var list = storedJson(REPLIES_KEY, null);
    return Array.isArray(list) ? list.filter(function (t) { return typeof t === "string" && t.trim(); }).slice(0, REPLIES_MAX) : DEFAULT_REPLIES.slice();
  }

  function renderQuickReplies() {
    var root = $("quick-replies"), s = session(S.pane), list = replies();
    var finished = S.entries.some(function (e) { return e.type === "turn_end" || e.type === "reply" || e.type === "status" && e.status === "finished"; });
    var showIt = !!s && s.state === "running" && s.status === "idle" && (finished || !!s.last_reply_excerpt) && !S.pending && !S.other && !$("text").value.trim();
    var was = !root.classList.contains("hidden");
    root.classList.toggle("hidden", !showIt);
    if (!showIt) return;
    if (was && root.dataset.list === JSON.stringify(list)) return;
    root.dataset.list = JSON.stringify(list);
    root.replaceChildren();
    list.forEach(function (text) {
      root.appendChild(button("sug", text, function () { $("text").value = text; grow(); $("text").focus(); renderQuickReplies(); }));
    });
    var edit = button("sug edit", null, openReplies); edit.appendChild(icon("pencil")); edit.setAttribute("aria-label", "Edit quick replies");
    root.appendChild(edit);
  }

  function openReplies() {
    renderRepliesSheet();
    openSheet($("replies-sheet"));
  }

  function renderRepliesSheet() {
    var root = $("replies-list"), list = replies();
    root.replaceChildren();
    root.classList.toggle("hidden", !list.length);
    list.forEach(function (text, i) {
      var r = el("div", "sheet-row");
      r.appendChild(el("span", null, text));
      var rm = button("remove", null, function () { var l = replies(); l.splice(i, 1); store(REPLIES_KEY, JSON.stringify(l)); renderRepliesSheet(); renderQuickReplies(); });
      rm.appendChild(icon("x")); rm.setAttribute("aria-label", "Remove " + text);
      r.appendChild(rm);
      root.appendChild(r);
    });
    $("replies-input").disabled = list.length >= REPLIES_MAX;
    $("replies-input").placeholder = list.length >= REPLIES_MAX ? "Limit of " + REPLIES_MAX + " replies reached" : "Add a reply";
  }

  function openList() {
    cancelDictation();
    S.pane = null;
    S.other = null; S.deepLink = false; S.inboxFeed = {};
    selectTab("conv");
    if (location.hash) history.replaceState(null, "", location.pathname);
    show("list");
    renderList();
    loadSessions();
    connect();
    schedulePoll();
  }

  // ---- Pane ----

  function renderBar() {
    var s = session(S.pane);
    if (!s) return;
    $("heading").textContent = paneTitle(s);
    var parent = s.parent != null ? session(s.parent) : null;
    $("subheading").textContent = parent ? (parent.title || "Pane " + parent.id) + " / " + s.workspace.name : s.workspace.name + " · " + kindName(s.kind);
    // The status pill beside the title already says what a dot would.
    $("provider-avatar").replaceChildren(providerMark(s.kind, "lg"));
    var st = statusOf(s), chip = $("pane-status");
    chip.className = "pill " + st.cls;
    chip.replaceChildren();
    if (st.cls === "working") chip.appendChild(el("span", "spinner"));
    chip.appendChild(document.createTextNode(st.label));
    if (!S.other) $("text").placeholder = s.state === "running" ? "Message " + kindName(s.kind) + "…" : kindName(s.kind) + " is not running";
    $("menu-title").textContent = paneTitle(s);
    $("menu-sub").textContent = s.workspace.name + " · " + kindName(s.kind);
    $("menu-id").textContent = "#" + s.id;
    updateSend();
  }

  function openPane(id, tab, deepLink) {
    S.deepLink = !!deepLink;
    if (S.pane !== id) {
      cancelDictation(); resetPaneRequests();
      S.stopArmed = false; S.selection = {}; S.feedBusy = false; resetKeys(); toggleKeys(false); clearTimeout(S.timers["stop-arm"]);
      S.entries = []; S.last = 0; S.epoch = null; S.pending = null; S.expanded = {}; S.turns = {}; S.other = null;
      renderFeed(true);
      $("screen").textContent = "";
      setDockStatus("");
      $("text").value = "";
      grow();
      window.scrollTo(0, 0);
    }
    S.pane = id;
    if (location.hash !== "#pane=" + id) history.replaceState(null, "", "#pane=" + id);
    show("pane");
    $("feed-empty").classList.add("hidden");
    if (!S.entries.length) { var sk = el("div", "skel line"); sk.style.width = "70%"; $("feed").replaceChildren(sk); }
    selectTab("conv");
    if (tab === "term") selectTab("term");
    renderBar();
    renderChildren();
    renderQuickReplies();
    renderCard();
    renderMic();
    loadFeed(true);
    loadSessions();
    loadMe().catch(function () { /* the mic keeps its last state */ });
    connect();
    schedulePoll();
  }

  function selectTab(tab) {
    S.tab = tab;
    if (tab === "term") { $("screen-keys").replaceChildren(); buildKeys($("screen-keys")); openSheet($("screen-sheet")); loadScreen(); }
    else { if ($("screen-sheet").open) closeSheet($("screen-sheet")); clearTimeout(S.timers.screen); }
  }

  // While typing on a touch screen the conversation scrolls inside a frame
  // (see fitKeyboard); otherwise the document scrolls.
  function scroller() {
    return document.body.classList.contains("composing") ? $("conv") : document.scrollingElement || document.documentElement;
  }

  function pinned() {
    var d = scroller();
    return d.scrollTop + d.clientHeight >= d.scrollHeight - 120;
  }

  function toBottom(smooth) {
    var d = scroller();
    if (smooth && d.scrollTo) d.scrollTo({ top: d.scrollHeight, behavior: "smooth" });
    else d.scrollTop = d.scrollHeight;
    $("jump").classList.add("hidden");
  }

  function loadFeed(first) {
    var id = S.pane;
    if (id == null || !S.token || S.feedBusy) return Promise.resolve();
    S.feedBusy = true;
    var request = beginRequest("feed");
    return api("GET", "/api/sessions/" + id + "/feed?after=" + S.last, null, request).then(function (d) {
      if (!request.current()) return;
      // Another epoch (a daemon restart, or remote access turned off and on)
      // numbers its entries afresh, so everything shown so far is dropped.
      var reset = (S.epoch != null && d.epoch !== S.epoch) || d.last_seq < S.last || d.truncated;
      if (reset) {
        var refetch = S.last > 0 && !d.truncated;
        S.entries = []; S.last = 0; S.epoch = d.epoch;
        renderFeed(true);
        if (refetch) { S.feedBusy = false; return loadFeed(first); }
      }
      if (first === true && !S.shown) $("feed").replaceChildren();
      S.epoch = d.epoch;
      var stick = first === true || pinned(), before = S.entries.length;
      (d.entries || []).forEach(function (e) { if (e.seq > S.last) S.entries.push(e); });
      S.last = Math.max(S.last, d.last_seq || 0);
      S.pending = d.pending || null;
      if (S.entries.length > FEED_ENTRIES) { S.entries = S.entries.slice(-FEED_ENTRIES); S.expanded = {}; S.turns = {}; renderFeed(true); }
      // The card first: it is what the person must act on.
      renderCard();
      renderQuickReplies();
      renderFeed(false);
      renderLateLink();
      if (S.activityAt != null) {
        var nearest = S.entries.reduce(function (best, e) { return !best || Math.abs(e.at - S.activityAt) < Math.abs(best.at - S.activityAt) ? e : best; }, null);
        var target = nearest && document.querySelector('[data-feed-seq="' + nearest.seq + '"]');
        if (target) target.scrollIntoView({ block: "center" });
        else toast("That event is no longer in this pane's recent history.");
        S.activityAt = null;
      } else if (stick && S.tab === "conv") toBottom();
      else if (S.entries.length > before) $("jump").classList.remove("hidden");
    }).catch(function (e) { if (request.current() && S.token && !e.stale) { if (!e.status || e.status >= 500) setReachable(false); setDockStatus(e.message, true); } })
      .then(function () { if (request.current()) S.feedBusy = false; });
  }

  // Appends entries not yet shown; `reset` starts over. Existing nodes are
  // kept, so text selection survives and only new entries animate.
  function renderFeed(reset) {
    var root = $("feed"), s = session(S.pane);
    if (reset) { root.replaceChildren(); S.shown = 0; S.tailSteps = null; S.tailNode = null; }
    $("feed-empty").classList.toggle("hidden", S.entries.length > 0 || S.epoch == null);
    var arrive = !reset && S.shown > 0;
    while (S.shown < S.entries.length) {
      var e = S.entries[S.shown++];
      if (e.type === "turn_end") {
        finishTurn(e, root); continue;
      }
      // The daemon follows a turn summary with a compatibility status event.
      var previous = S.entries[S.shown - 2];
      if (e.type === "status" && e.status === "finished" && previous && previous.type === "turn_end") continue;
      if (e.type === "step") {
        if (S.tailSteps) {
          S.tailSteps.push(e);
          var grown = stepGroup(S.tailSteps);
          S.tailNode.replaceWith(grown);
          S.tailNode = grown;
        } else {
          S.tailSteps = [e];
          S.tailNode = stepGroup(S.tailSteps);
          if (arrive) S.tailNode.classList.add("arrive");
          root.appendChild(S.tailNode);
        }
        continue;
      }
      if (e.type === "prompt" || e.type === "reply") {
        if (S.tailSteps) { S.expanded[String(S.tailSteps[0].seq)] = false; var folded = stepGroup(S.tailSteps); S.tailNode.replaceWith(folded); S.tailNode = folded; }
        if (e.type === "prompt") { S.tailSteps = null; S.tailNode = null; }
      }
      var node = safeEntry(e, s);
      if (node) {
        node.dataset.feedSeq = e.seq;
        node.dataset.feedType = e.type;
        if (arrive) node.classList.add("arrive");
        root.appendChild(node);
      }
    }
    root.querySelectorAll('[data-feed-type="question"], [data-feed-type="permission"]').forEach(function (node) {
      node.classList.toggle("hidden", !!S.pending && S.pending.epoch === S.epoch && String(S.pending.seq) === node.dataset.feedSeq && !cardState(S.pane, S.pending));
    });
    renderWorking();
  }

  function renderWorking() {
    clearTimeout(S.timers.working);
    var root = $("working-row"), s = session(S.pane), prompt = null;
    for (var i = S.entries.length - 1; i >= 0; i--) {
      var e = S.entries[i];
      if (e.type === "prompt") { prompt = e; break; }
      if (e.type === "turn_end") break;
    }
    var active = S.view === "pane" && !!s && s.state === "running" && s.status === "working";
    root.classList.toggle("hidden", !active);
    if (!active) return;
    var since = (prompt && prompt.at) || s.status_since;
    $("working-elapsed").textContent = since ? duration(Math.max(0, Date.now() - since)) : "";
    // One row updates once a second, only while visible and the agent works.
    if (!document.hidden) later("working", renderWorking, 1000);
  }

  function safeEntry(e, s) {
    try {
      return entryNode(e, s);
    } catch (err) {
      var n = el("div", "msg plain");
      n.textContent = e.text || "";
      return n;
    }
  }

  function stepRow(st) {
    var w = stepWords(st.tool, st.target), li = el("li", "step");
    li.appendChild(icon(w.icon));
    li.appendChild(el("span", "verb", w.verb));
    if (w.target) li.appendChild(el("span", "target", w.target));
    if (st.failed === true) li.appendChild(el("span", "result failed", "failed"));
    else if (st.result) li.appendChild(el("span", "result", st.result));
    return li;
  }

  function stepGroup(steps) {
    var key = String(steps[0].seq), turn = S.turns[key], open = S.expanded[key] != null ? S.expanded[key] : !turn;
    var wrap = el("div", "worklog" + (turn && turn.outcome === "stopped" ? " warn" : turn && turn.outcome === "failed" ? " failed" : ""));
    wrap.dataset.feedSeq = steps[0].seq;
    var toggle = button("worklog-toggle", null, function () {
      S.expanded[key] = !open;
      var fresh = stepGroup(steps);
      wrap.replaceWith(fresh);
      if (S.tailNode === wrap) S.tailNode = fresh;
    });
    toggle.setAttribute("aria-expanded", String(open));
    toggle.appendChild(icon("chevR", "chev"));
    var counts = { read: 0, search: 0, edit: 0, run: 0, other: 0 };
    steps.forEach(function (st) { counts[stepCategory(st.tool)]++; });
    var sum = turn ? turnSummary(turn) : turnSummary({ counts: counts });
    if (turn) toggle.appendChild(el("b", null, (turn.outcome === "stopped" ? "Stopped after " : turn.outcome === "failed" ? "Failed after " : "Worked for ") + duration(turn.duration_ms)));
    else toggle.appendChild(el("b", null, plural(steps.length, "step", "steps")));
    if (sum) toggle.appendChild(el("span", "sum", "· " + sum));
    wrap.appendChild(toggle);
    if (open) {
      var ul = el("ul", "steps-list");
      steps.forEach(function (st) { ul.appendChild(stepRow(st)); });
      wrap.appendChild(ul);
    }
    return wrap;
  }

  function entryNode(e, s) {
    var n, b;
    switch (e.type) {
      case "prompt":
        if (e.origin) {
          n = el("div", "card origin-card");
          var meta = el("div", "meta"); meta.appendChild(icon("clock")); meta.appendChild(el("b", null, "From " + e.origin)); meta.appendChild(document.createTextNode("· " + clock(e.at)));
          n.appendChild(meta); n.appendChild(el("div", "text", e.text));
          return n;
        }
        n = el("div", "me");
        n.appendChild(el("div", "bubble", e.text));
        n.appendChild(el("div", "meta", clock(e.at)));
        return n;
      case "answer":
        n = el("div", "answer");
        n.appendChild(el("div", "bubble", (e.answers || []).join(", ") || "Answered"));
        n.appendChild(el("div", "meta", "Answered · " + clock(e.at)));
        return n;
      case "reply":
        n = el("div", "reply md");
        n.appendChild(markdown(e.text));
        return n;
      case "question":
        n = el("div", "event");
        (e.questions || []).forEach(function (q) {
          var h = el("div", "event-head"); h.appendChild(icon("help")); h.appendChild(document.createTextNode("Asked" + (q.header ? " · " + q.header : ""))); n.appendChild(h);
          n.appendChild(el("div", null, q.question));
          var ol = el("ol", "event-options");
          q.options.forEach(function (o) { ol.appendChild(el("li", null, o.label)); });
          n.appendChild(ol);
        });
        return n;
      case "permission":
        n = el("div", "event");
        b = el("div", "event-head"); b.appendChild(icon(permissionWords(e.tool).icon)); b.appendChild(document.createTextNode(permissionWords(e.tool).ask + (e.outcome ? " · " + e.outcome : ""))); n.appendChild(b);
        if (e.target) n.appendChild(el("div", "event-target", e.target));
        return n;
      case "usage_limit":
        n = el("div", "callout-card warn");
        b = el("b"); b.appendChild(icon("clock")); b.appendChild(document.createTextNode("Usage limit")); n.appendChild(b);
        n.appendChild(el("span", null, e.text || ((e.limit || "Limit") + ": " + (e.value == null ? "unknown" : e.value) + " · Resets " + (e.resets_at || "not reported"))));
        return n;
      case "divider": return el("div", "tdiv", e.text || "");
      case "status":
        if (e.status === "finished") return el("div", "tdiv", "Finished · " + clock(e.at));
        if (e.status === "exited") return el("div", "tdiv", "Exited · " + clock(e.at));
        return null;
      default:
        return null;
    }
  }

  function finishTurn(e, root) {
    if (S.tailSteps) {
      var key = String(S.tailSteps[0].seq);
      S.turns[key] = e;
      if (S.expanded[key] == null || S.tailNode && S.tailNode.querySelector(".steps-list")) S.expanded[key] = false;
      var group = stepGroup(S.tailSteps); S.tailNode.replaceWith(group);
    }
    if (e.files && e.files.length) {
      var files = el("div", "files"); files.dataset.feedSeq = e.seq;
      var head = el("div", "card-head"); head.appendChild(icon("files")); head.appendChild(el("span", null, plural(e.files.length, "changed file", "changed files")));
      files.appendChild(head);
      e.files.forEach(function (path) { var r = el("div", "file-row"); r.appendChild(icon("file")); r.appendChild(el("span", null, path)); files.appendChild(r); });
      root.appendChild(files);
    }
    if (e.outcome === "stopped" || e.outcome === "failed") {
      var d = el("div", "tdiv warn");
      d.appendChild(icon("square")); d.appendChild(document.createTextNode((e.outcome === "stopped" ? "Stopped" : "Failed") + " · " + clock(e.at)));
      root.appendChild(d);
    }
    S.tailSteps = null; S.tailNode = null;
  }

  function renderLateLink() {
    if (!S.deepLink || S.pending) return;
    var answered = S.entries.slice().reverse().find(function (e) { return e.type === "answer" || e.type === "permission" && e.outcome || e.type === "question" && e.answers; });
    var root = $("card"); root.classList.remove("hidden"); root.replaceChildren();
    var k = el("div", "decision-kicker"); k.style.color = "var(--ok)"; k.appendChild(icon("check")); k.appendChild(document.createTextNode(answered ? "Already answered" : "No request waiting")); root.appendChild(k);
    root.appendChild(el("p", "decision-note", (answered ? "The agent has already moved past this request. " : "This notification no longer has a request to answer. ") + statusOf(session(S.pane)).label + "."));
    var acts = el("div", "decision-actions");
    acts.appendChild(button("btn", "Open conversation", function () { S.deepLink = false; renderCard(); }));
    root.appendChild(acts);
  }

  function diffNode(diff) {
    var wrap = el("div", "diff"), head = el("div", "card-head");
    head.appendChild(icon("pencil")); head.appendChild(el("span", "mono", diff.path || "Edit"));
    wrap.appendChild(head);
    var pre = el("pre"); (diff.lines || []).forEach(function (line) { pre.appendChild(el("span", line.op === "+" ? "tadd" : line.op === "-" ? "tdel" : "", line.op + line.text)); }); wrap.appendChild(pre);
    if (diff.truncated) wrap.appendChild(el("p", "decision-note", "Diff shortened. Read the full edit on the computer before approving."));
    return wrap;
  }

  // ---- Decision card ----

  function permissionWords(tool) {
    var cat = stepCategory(tool || "");
    if (cat === "run") return { icon: "prompt", ask: "Run a command?" };
    if (cat === "edit") return { icon: "pencil", ask: /^(Write|write|write_file)$/.test(tool) ? "Write a file?" : "Edit a file?" };
    if (tool === "WebFetch" || tool === "WebSearch") return { icon: "globe", ask: "Use the web?" };
    var mcp = /^mcp__(.+?)__(.+)$/.exec(tool || "");
    if (mcp) return { icon: "zap", ask: "Use " + mcp[2].replace(/_/g, " ") + "?" };
    return { icon: "shield", ask: "Allow " + (tool || "this tool") + "?" };
  }

  // Why a card takes no tap, or "" while it does.
  function cardState(id, p) {
    if (!p) return "";
    if (p.answered_elsewhere) return "Already answered in the terminal · waiting for the agent";
    if (p.sent || S.sent[id + ":" + p.epoch + ":" + p.seq]) return "Sent · waiting for the agent";
    return "";
  }

  function kicker(root, iconName, text, since) {
    var k = el("div", "decision-kicker");
    k.appendChild(icon(iconName)); k.appendChild(el("span", null, text));
    if (since) k.appendChild(el("span", "ago", ago(since)));
    root.appendChild(k);
  }

  function renderCard(root, p, s, entries) {
    var docked = !root;
    root = root || $("card"); p = arguments.length ? p : S.pending; s = s || session(S.pane);
    var id = s ? s.id : S.pane;
    entries = entries || S.entries;
    var wasHidden = root.classList.contains("hidden");
    root.replaceChildren();
    root.classList.toggle("hidden", !p);
    if (!p) { if (docked) { if (S.other) setOther(null); renderLateLink(); } return; }
    if (docked && wasHidden) animate(root, "enter-fade");
    if (S.other && (S.other.seq !== p.seq || S.other.epoch !== p.epoch || cardState(id, p))) setOther(null);
    var state = cardState(id, p), sent = !!state, src = entries.find(function (e) { return e.seq === p.seq; });
    if (docked && S.epoch !== p.epoch) src = null;
    var since = s && (s.waiting_since || s.status_since);
    var screenLabel = docked ? "View screen" : "Open terminal";
    var toScreen = function () { if (S.pane !== id) openPane(id, "term"); else selectTab("term"); };
    if (p.type === "permission") {
      var words = permissionWords(p.title);
      kicker(root, words.icon, words.ask, docked ? since : null);
      var target = (src && src.target) || p.detail, diff = p.diff || (src && src.diff);
      if (target && !(diff && diff.path === target)) root.appendChild(el("div", "decision-target", target));
      if (diff) root.appendChild(diffNode(diff));
      if (!docked) { var said = lastSaid(s); if (said) root.appendChild(said); }
      if (p.decidable && p.answered_elsewhere) {
        var look = el("div", "decision-actions");
        look.appendChild(button("btn primary", screenLabel, toScreen));
        root.appendChild(look);
      } else if (p.decidable) {
        var acts = el("div", docked ? "decision-actions" : "inbox-actions");
        if (p.truncated || src && src.truncated) {
          root.appendChild(el("div", "decision-note", "Only part of this command is shown: it was too long, or it held invisible characters. Read it in the terminal and approve it there."));
          var r1 = el("div", docked ? "" : "row2"); if (docked) r1 = acts;
          r1.appendChild(button("btn danger", "Deny", function () { decide(id, p.seq, "deny", undefined, p.epoch); }));
          r1.appendChild(button("btn primary", screenLabel, toScreen));
          if (!docked) acts.appendChild(r1);
        } else if (docked) {
          acts.appendChild(button("btn danger", "Deny", function () { decide(id, p.seq, "deny", undefined, p.epoch); }));
          if (src && src.always) acts.appendChild(button("btn", "Always", function () { decide(id, p.seq, "always", undefined, p.epoch); }));
          acts.appendChild(button("btn primary", "Approve", function () { decide(id, p.seq, "approve", undefined, p.epoch); }));
        } else {
          acts.appendChild(button("btn primary", "Approve", function () { decide(id, p.seq, "approve", undefined, p.epoch); }));
          var r2 = el("div", "row2");
          if (src && src.always) r2.appendChild(button("btn", "Always allow", function () { decide(id, p.seq, "always", undefined, p.epoch); }));
          r2.appendChild(button("btn danger", "Deny", function () { decide(id, p.seq, "deny", undefined, p.epoch); }));
          if (r2.children.length === 1) acts.appendChild(r2.firstChild); else acts.appendChild(r2);
        }
        acts.querySelectorAll("button").forEach(function (b) { if (b.textContent !== screenLabel) b.disabled = sent; });
        root.appendChild(acts);
      }
    } else if (p.type === "question" && src && src.questions) {
      var staged = docked && p.decidable && src.questions.length === 1;
      var choiceKey = id + ":" + p.epoch + ":" + p.seq;
      var selection = S.selection[choiceKey] || null, next = null;
      src.questions.forEach(function (q, qi) {
        kicker(root, "help", (q.header || "Question") + (src.questions.length > 1 ? " · " + (qi + 1) + " of " + src.questions.length : ""), qi === 0 && docked ? since : null);
        root.appendChild(el("div", "decision-title", q.question));
        if (!p.decidable && (q.multi_select || src.questions.length > 1)) root.appendChild(el("div", "decision-note", "Answer this question in the terminal with the screen and keys."));
        var opts = el("div", "options");
        if (staged) { opts.setAttribute("role", "radiogroup"); opts.setAttribute("aria-label", "Choose one answer, then Send answer"); }
        q.options.forEach(function (o, i) {
          var b = button("option", null, function () {
            if (staged) { selection = String(i + 1); S.selection = {}; S.selection[choiceKey] = selection; opts.querySelectorAll(".option:not(.alt)").forEach(function (o) { o.classList.remove("chosen"); o.setAttribute("aria-checked", "false"); }); b.classList.add("chosen"); b.setAttribute("aria-checked", "true"); if (next) { next.dataset.locked = "false"; next.disabled = !S.reachable || sent; } }
            else { b.classList.add("chosen"); decide(id, p.seq, String(i + 1), undefined, p.epoch); }
          });
          b.appendChild(el("span", "option-n", String(i + 1)));
          if (staged || q.multi_select) b.appendChild(el("span", q.multi_select ? "choice-box" : "choice-radio"));
          var body = el("span", "option-body");
          body.appendChild(el("span", "option-label", o.label));
          if (o.description) body.appendChild(el("span", "option-desc", o.description));
          b.appendChild(body);
          if (staged) { b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(selection === String(i + 1))); if (selection === String(i + 1)) b.classList.add("chosen"); }
          b.disabled = sent || !p.decidable;
          opts.appendChild(b);
        });
        if (p.decidable && !sent && !q.previews && q.options.length < 9) {
          var other = button("option alt", null, function () { if (S.pane !== id) { openPane(id); } setOther({ seq: p.seq, epoch: p.epoch, question: q.question }); });
          other.appendChild(el("span", "option-n", String(q.options.length + 1)));
          var ob = el("span", "option-body");
          ob.appendChild(el("span", "option-label", "Something else…"));
          ob.appendChild(el("span", "option-desc", "Type your own answer"));
          other.appendChild(ob);
          other.disabled = sent;
          opts.appendChild(other);
        }
        root.appendChild(opts);
        if (staged) { next = button("btn primary", "Send answer", function () { if (selection) decide(id, p.seq, selection, undefined, p.epoch); }); next.disabled = sent || !selection; var actions = el("div", "decision-actions"); actions.appendChild(next); root.appendChild(actions); }
      });
    } else {
      kicker(root, "alert", p.type === "question" ? "Question" : kindName(s && s.kind) + " is waiting", docked ? since : null);
      if (p.type === "question") root.appendChild(el("div", "decision-title", p.title));
    }
    if (!p.decidable) {
      root.appendChild(el("div", "decision-note", undecidableNote(p, s)));
      var go = el("div", "decision-actions");
      go.appendChild(button("btn", "Show keys", function () { if (S.pane !== id) openPane(id); toggleKeys(true); }));
      go.appendChild(button("btn primary", screenLabel, toScreen));
      root.appendChild(go);
    }
    if (p.answered_elsewhere && p.type === "question") {
      var term = el("div", "decision-actions");
      term.appendChild(button("btn primary", screenLabel, toScreen));
      root.appendChild(term);
    }
    if (sent) { var sn = el("div", "sent"); sn.appendChild(el("span", "spinner")); sn.appendChild(document.createTextNode(state)); root.appendChild(sn); }
    root.querySelectorAll(".decision-actions button, .inbox-actions button, .option").forEach(function (b) {
      if (b.textContent === screenLabel || b.textContent === "Show keys") return;
      b.dataset.decision = "true"; b.dataset.locked = String(b.disabled || sent || !p.decidable); b.disabled = S.busy || !S.reachable || !s || s.state !== "running" || b.dataset.locked === "true";
    });
    if (s && s.kind !== "claude" && s.status === "needs-input") {
      var pre = el("pre", "tscreen", "Loading screen…"); root.appendChild(pre);
      if (S.view === "pane") toggleKeys(true);
      api("GET", "/api/sessions/" + id + "/screen?lines=12").then(function (d) { pre.textContent = (d.lines || []).join("\n"); }).catch(function (e) { if (!e.stale) pre.textContent = e.message; });
    }
  }

  function undecidableNote(p, s) {
    var kind = s && s.kind;
    if (kind !== "claude") return "Houston can't answer " + kindName(kind) + " requests with a tap yet. Read the screen and answer with keys or a message.";
    if (p.type === "input") return "It did not report what it is asking. Read the terminal and answer with the keys or a message.";
    if (p.type === "question") return "This request has several questions or allows several answers. Answer it in the terminal.";
    return "Answer it in the terminal.";
  }

  function pendingOf(id) {
    var s = session(id);
    return id === S.pane ? S.pending : s && s.pending;
  }

  function notice(text, isError) {
    if (S.view === "pane") { setDockStatus(text, isError); return; }
    if (text && isError) toast(text, true);
  }

  function decide(id, seq, choice, text, epoch) {
    var pending = pendingOf(id);
    if (!pending || pending.seq !== seq || pending.epoch !== epoch || !pending.decidable || cardState(id, pending)) { notice("This request changed or was already answered. Refreshing…", true); refreshAll(); return Promise.resolve(false); }
    if (pending.truncated && (choice === "approve" || choice === "always")) { notice("Only part of this command is shown. Read the full request in the terminal.", true); return Promise.resolve(false); }
    if (!S.reachable) { notice("Answers are paused until the connection is back.", true); return Promise.resolve(false); }
    if (S.busy) { notice("Wait for the previous send to finish, then tap again.", true); return Promise.resolve(false); }
    var request = beginRequest("input");
    S.busy = true;
    notice("Sending…");
    var key = id + ":" + epoch + ":" + seq;
    document.querySelectorAll("[data-decision]").forEach(function (b) { b.disabled = true; });
    updateSend();
    return api("POST", "/api/sessions/" + id + "/decide", { epoch: epoch, entry_seq: seq, choice: choice, text: text }, request)
      .then(function () {
        if (!request.current()) return false;
        // Held until the server's card changes: the daemon keeps it consumed.
        S.sent[key] = true;
        if (S.pane === id) S.deepLink = false;
        if (S.pane === id) renderFeed(false);
        notice("");
        toast(choice === "deny" ? "Denied" : choice === "approve" || choice === "always" ? "Approved" : "Answer sent");
        if (choice === "other") setOther(null);
        return true;
      })
      .catch(function (e) { if (request.current() && !e.stale) notice(e.message, true); return false; })
      .then(function (ok) {
        if (!request.current()) return false;
        S.busy = false;
        updateSend();
        renderCard();
        if (S.view === "list") { if (ok) S.inboxDir = "from-right"; renderList(); }
        later("feed", loadFeed, 300);
        later("sessions", loadSessions, 300);
        return ok;
      });
  }

  function setOther(o) {
    S.other = o;
    $("other").classList.toggle("hidden", !o);
    $("other-label").textContent = o ? "Answering: " + o.question : "";
    if (o) { $("text").placeholder = "Your answer"; $("text").focus(); }
    else { var s = session(S.pane); $("text").placeholder = s ? "Message " + kindName(s.kind) + "…" : "Message"; }
    renderQuickReplies();
    updateSend();
  }

  // ---- Composer and keys ----

  function setDockStatus(text, isError) {
    var p = $("dock-status");
    p.textContent = text || "";
    p.classList.toggle("error", !!isError);
  }

  function grow() {
    var t = $("text");
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, Math.round(window.innerHeight * 0.35)) + "px";
    updateSend();
  }

  function updateSend() {
    var s = session(S.pane), b = $("send"), stop = s && s.state === "running" && s.status === "working" && !$("text").value.trim();
    if (!stop && S.stopArmed) { S.stopArmed = false; clearTimeout(S.timers["stop-arm"]); }
    b.disabled = S.busy || !S.reachable || !s || s.state !== "running" || (!stop && !$("text").value.trim());
    b.setAttribute("aria-label", S.stopArmed ? "Tap again to stop the agent" : stop ? "Stop the agent (sends Esc)" : "Send");
    var mode = S.stopArmed ? "armed" : stop ? "stop" : "send";
    if (b.dataset.mode === mode) return;
    b.dataset.mode = mode;
    b.className = "send" + (mode === "send" ? "" : mode === "stop" ? " stop" : " stop armed");
    b.replaceChildren();
    if (mode === "armed") b.textContent = "Stop?";
    else if (mode === "stop") b.appendChild(el("span", "sq"));
    else b.appendChild(icon("up"));
  }

  function input(body, what) {
    var id = S.pane;
    if (S.busy || id == null || !S.reachable) return Promise.resolve(false);
    var request = beginRequest("input");
    S.busy = true;
    updateSend();
    setDockStatus("Sending…");
    return api("POST", "/api/sessions/" + id + "/input", body, request).then(function () {
      if (!request.current()) return false;
      setDockStatus(what ? "Sent " + what : "");
      later("clear-status", function () { if (request.current()) setDockStatus(""); }, 2500);
      if (S.tab === "term") later("screen", loadScreen, 250);
      return true;
    }).catch(function (e) { if (request.current() && !e.stale) setDockStatus(e.message, true); return false; })
      .then(function (ok) { if (request.current()) { S.busy = false; updateSend(); } return ok; });
  }

  function send() {
    var text = $("text").value, id = S.pane, generation = S.paneGeneration;
    if (!text.trim()) {
      var s = session(S.pane); if (!s || s.status !== "working" || !S.reachable) return;
      if (!S.stopArmed) { S.stopArmed = true; updateSend(); later("stop-arm", function () { S.stopArmed = false; updateSend(); }, 2500); return; }
      S.stopArmed = false;
      input({ keys: ["esc"] }, "Esc").then(function (ok) {
        if (!ok || S.pane !== id || generation !== S.paneGeneration) return;
        var d = el("div", "tdiv warn arrive"); d.appendChild(icon("square")); d.appendChild(document.createTextNode("Stop requested from this phone"));
        $("feed").appendChild(d);
      });
      updateSend(); return;
    }
    var done = function (ok) { if (ok && S.pane === id && generation === S.paneGeneration && $("text").value === text) { $("text").value = ""; grow(); renderQuickReplies(); toBottom(true); } };
    if (S.pending && S.pending.type === "permission" && S.pending.decidable && !cardState(S.pane, S.pending)) { setDockStatus("Deny the request first, then send your instruction.", true); return; }
    if (S.other) { decide(S.pane, S.other.seq, "other", text.trim(), S.other.epoch).then(done); return; }
    input({ text: text, keys: ["enter"] }, "").then(done);
  }

  function toggleKeys(force) {
    var root = $("keys"), open = force != null ? force : root.classList.contains("hidden");
    root.classList.toggle("hidden", !open);
    if (open) root.scrollLeft = 0;
    $("more").setAttribute("aria-expanded", String(open));
    $("menu-keys").querySelector("span").textContent = open ? "Hide keys" : "Show keys";
  }

  function resetKeys() {
    clearTimeout(S.timers["key-arm-keys"]); clearTimeout(S.timers["key-arm-screen-keys"]);
    $("keys").replaceChildren(); buildKeys();
    $("screen-keys").replaceChildren(); if ($("screen-sheet").open) buildKeys($("screen-keys"));
  }

  function buildKeys(root) {
    root = root || $("keys");
    KEYS.forEach(function (k) {
      var armed = null;
      var b = button("key" + (k[2] ? " danger" : ""), k[0], function () {
        if (!S.reachable || S.busy) return;
        if (k[2] && !armed) {
          b.classList.add("armed"); b.textContent = "Again";
          armed = later("key-arm-" + root.id, function () { armed = null; b.classList.remove("armed"); b.textContent = k[0]; }, 2500);
          return;
        }
        if (armed) { clearTimeout(armed); armed = null; b.classList.remove("armed"); b.textContent = k[0]; }
        input({ keys: k[1] }, k[0]);
      });
      b.setAttribute("aria-label", "Send " + k[1][0]); b.disabled = !S.reachable;
      root.appendChild(b);
    });
  }

  // ---- Dictation ----

  // The daemon refuses longer recordings; recording stops here first.
  var DICTATE_MAX_SECS = 120, DICTATE_RATE = 16000;
  var D = { state: "idle", ctx: null, stream: null, source: null, node: null, chunks: [], samples: 0, started: 0, tick: null, pane: null, then: null, flushed: null, request: null };

  // Why the page cannot dictate, or null when it can.
  function micBlocked() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return "The microphone needs a trusted HTTPS connection: trust this computer's certificate (Computer tab), or use your keyboard's microphone in the message box.";
    }
    if (!window.AudioWorkletNode) return "This browser cannot record audio for dictation. Your keyboard's microphone still works in the message box.";
    if (S.me.dictation === false) return "Dictation is off. Turn on Allow dictation from paired devices in Houston's Settings ▸ Remote access.";
    return null;
  }

  function clockOf(secs) {
    var s = Math.max(0, Math.floor(secs));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function renderMic() {
    var why = D.state === "idle" ? micBlocked() : null;
    $("mic").classList.toggle("hidden", !!why || S.me.dictation == null);
    $("mic-note").textContent = why || "";
    $("mic-note").classList.toggle("hidden", !why);
    var recording = D.state === "recording";
    $("mic").classList.toggle("recording", recording);
    $("mic").setAttribute("aria-pressed", String(recording));
    $("mic").setAttribute("aria-label", recording ? "Stop and put the text in the message box" : "Dictate");
    $("mic").disabled = D.state === "transcribing";
    $("rec").classList.toggle("hidden", D.state === "idle");
    $("rec-send").disabled = !recording;
    $("rec-cancel").disabled = false;
    if (D.state === "transcribing") $("rec-time").textContent = "Transcribing…";
    else if (D.state === "starting") $("rec-time").textContent = "Starting the microphone…";
    else if (recording) $("rec-time").textContent = clockOf((Date.now() - D.started) / 1000) + " / " + clockOf(DICTATE_MAX_SECS);
  }

  function releaseMic() {
    clearInterval(D.tick);
    if (D.stream) D.stream.getTracks().forEach(function (t) { t.stop(); });
    try { if (D.source) D.source.disconnect(); if (D.node) D.node.disconnect(); } catch (e) { /* already gone */ }
    if (D.ctx) D.ctx.close().catch(function () {});
    D.ctx = D.stream = D.source = D.node = D.tick = D.flushed = null;
  }

  function micError(e) {
    if (e && e.name === "NotAllowedError") return "Microphone access was denied. Allow it in this site's browser settings, then tap the microphone again.";
    if (e && e.name === "NotFoundError") return "No microphone was found on this device.";
    return "The microphone could not start: " + ((e && e.message) || e);
  }

  function startDictation() {
    if (D.state !== "idle" || S.pane == null || micBlocked()) return;
    var Ctx = window.AudioContext || window.webkitAudioContext, ctx;
    // Created inside the tap, so iOS lets it run.
    try { ctx = new Ctx(); } catch (e) { toast(micError(e), true); return; }
    D.state = "starting"; D.ctx = ctx; D.chunks = []; D.samples = 0; D.pane = S.pane; D.then = null; D.request = beginRequest("dictate");
    setDockStatus("");
    renderMic();
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        if (D.ctx !== ctx) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        D.stream = stream;
        return ctx.audioWorklet.addModule("pcm-worklet.js").then(function () {
          if (D.ctx !== ctx) return;
          D.source = ctx.createMediaStreamSource(stream);
          // Connected to the output (it writes silence) so every browser keeps pulling it.
          D.node = new AudioWorkletNode(ctx, "pcm-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          var node = D.node;
          node.port.onmessage = function (ev) { if (D.node === node) onPcm(ev); };
          D.source.connect(D.node);
          D.node.connect(ctx.destination);
          return ctx.resume();
        }).then(function () {
          if (D.ctx !== ctx) return;
          D.state = "recording";
          D.started = Date.now();
          D.tick = setInterval(renderMic, 250);
          renderMic();
        });
      })
      .catch(function (e) {
        if (D.ctx !== ctx) return;
        releaseMic();
        D.state = "idle";
        renderMic();
        toast(micError(e), true);
      });
  }

  function onPcm(ev) {
    if (ev.data && ev.data.done) { if (D.flushed) D.flushed(); return; }
    if (!(ev.data instanceof Int16Array) || D.state !== "recording" && D.state !== "transcribing") return;
    var room = DICTATE_MAX_SECS * DICTATE_RATE - D.samples;
    if (room <= 0) return;
    var chunk = ev.data.length > room ? ev.data.subarray(0, room) : ev.data;
    D.chunks.push(chunk);
    D.samples += chunk.length;
    if (D.samples >= DICTATE_MAX_SECS * DICTATE_RATE && D.state === "recording") {
      stopDictation(null, "Recording stopped at the " + clockOf(DICTATE_MAX_SECS) + " limit.");
    }
  }

  // `then` is "send" to send the transcript at once; otherwise it lands in the box.
  function stopDictation(then, note) {
    if (D.state !== "recording") return;
    D.state = "transcribing";
    D.then = then;
    renderMic();
    if (note) setDockStatus(note);
    var finished = false, request = D.request;
    var finish = function () {
      if (finished || D.request !== request || !request.current()) return;
      finished = true;
      releaseMic();
      upload();
    };
    D.flushed = finish;
    D.node.port.postMessage("flush");
    // The worklet answers within a render quantum; this only guards a stalled context.
    later("dictate-flush", finish, 1000);
  }

  function cancelDictation() {
    if (D.state === "idle") return;
    var request = D.request;
    D.request = null;
    if (S.requests.dictate === request) delete S.requests.dictate;
    if (request) request.ctrl.abort();
    clearTimeout(S.timers["dictate-flush"]);
    releaseMic();
    D.state = "idle";
    D.chunks = [];
    D.samples = 0;
    renderMic();
    setDockStatus("Dictation discarded.");
  }

  function upload() {
    var pane = D.pane, then = D.then, request = D.request;
    if (!request || !request.current()) return;
    var pcm = new Uint8Array(D.samples * 2), view = new DataView(pcm.buffer), off = 0;
    D.chunks.forEach(function (c) {
      for (var i = 0; i < c.length; i++, off += 2) view.setInt16(off, c[i], true);
    });
    D.chunks = [];
    D.samples = 0;
    var current = function () { return D.request === request && request.current(); };
    var done = function () { if (!current()) return; D.request = null; D.state = "idle"; renderMic(); };
    if (pcm.length === 0) { done(); toast("Nothing was recorded.", true); return; }
    api("POST", "/api/sessions/" + pane + "/dictate", pcm, request).then(function (d) {
      if (!current()) return;
      done();
      var t = $("text"), cur = t.value;
      t.value = cur && !/\s$/.test(cur) ? cur + " " + d.text : cur + d.text;
      grow();
      if (then === "send") send(); else setDockStatus("Edit the text if needed, then send.");
    }).catch(function (e) {
      if (!current()) return;
      done();
      if (!e.stale) toast(e.message, true);
    });
  }

  // ---- Sheets ----

  function openSheet(d) {
    if (d.open) return;
    d.classList.remove("closing");
    d.style.transform = "";
    d.showModal();
    // The sheet, not its first button, takes focus, so no ring shows on open.
    d.focus();
  }

  function closeSheet(d) {
    if (!d.open || d.classList.contains("closing")) return;
    var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { d.close(); return; }
    d.style.transform = "";
    d.classList.add("closing");
    setTimeout(function () { d.classList.remove("closing"); if (d.open) d.close(); }, 200);
  }

  // A tap on the backdrop or a downward drag from the top of the sheet closes it.
  function sheetGestures(d, onClose) {
    d.addEventListener("click", function (ev) { if (ev.target === d) { var r = d.getBoundingClientRect(); if (ev.clientY < r.top || ev.clientX < r.left || ev.clientX > r.right) closeSheet(d); } });
    d.addEventListener("cancel", function (ev) { ev.preventDefault(); closeSheet(d); });
    d.addEventListener("close", onClose || function () {});
    var y0 = null, dy = 0;
    d.addEventListener("touchstart", function (ev) { y0 = d.scrollTop <= 0 && !ev.target.closest("pre, .sheet-list, input") ? ev.touches[0].clientY : null; dy = 0; }, { passive: true });
    d.addEventListener("touchmove", function (ev) {
      if (y0 == null) return;
      dy = Math.max(0, ev.touches[0].clientY - y0);
      d.classList.add("dragging");
      d.style.transform = "translateY(" + dy + "px)";
    }, { passive: true });
    d.addEventListener("touchend", function () {
      if (y0 == null) return;
      y0 = null; d.classList.remove("dragging");
      if (dy > 90) closeSheet(d); else d.style.transform = "";
    });
  }

  // ---- Terminal ----

  function screenSize() { return Math.max(9, Math.min(18, Number(stored("houston.remote.screenSize")) || 11)); }

  function fitScreen() { $("screen").style.fontSize = screenSize() + "px"; }

  function loadScreen() {
    var id = S.pane;
    clearTimeout(S.timers.screen);
    if (id == null || S.tab !== "term" || document.hidden) return;
    var pending = S.requests.screen;
    if (pending && pending.current() && pending.promise) return pending.promise;
    var request = beginRequest("screen");
    request.promise = api("GET", "/api/sessions/" + id + "/screen?lines=" + SCREEN_LINES, null, request).then(function (d) {
      if (!request.current()) return;
      var pre = $("screen"), stick = !pre.textContent || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      fitScreen();
      pre.textContent = (d.lines || []).join("\n");
      var raw = d.source === "scrollback";
      $("screen-note").textContent = raw ? "Raw output: this build has no terminal emulator." : "";
      $("screen-note").classList.toggle("hidden", !raw);
      if (stick) pre.scrollTop = pre.scrollHeight;
    }).catch(function (e) { if (request.current() && !e.stale) setDockStatus(e.message, true); })
      .then(function () {
        if (request.current() && S.tab === "term") S.timers.screen = setTimeout(loadScreen, SCREEN_MS);
      }).finally(function () { request.promise = null; });
    return request.promise;
  }

  // ---- Markdown: a small renderer that builds nodes, never markup ----

  var LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+/;

  function safeUrl(raw) {
    try {
      var u = new URL(raw);
      return (u.protocol === "http:" || u.protocol === "https:") ? u.href : null;
    } catch (e) { return null; }
  }

  function link(parent, url, label) {
    var href = safeUrl(url);
    if (!href) { parent.appendChild(document.createTextNode(label)); return; }
    var a = el("a");
    a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
    inline(a, label);
    parent.appendChild(a);
  }

  var INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*][\s\S]*?)\*\*|__([^_][\s\S]*?)__|\*([^*\s](?:[^*]*[^*\s])?)\*|_([^_\s](?:[^_]*[^_\s])?)_|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])/g;

  function inline(parent, text) {
    var re = new RegExp(INLINE.source, "g"), at = 0, m;
    while ((m = re.exec(text))) {
      var word = /[A-Za-z0-9]/;
      if (m[6] != null && ((m.index > 0 && word.test(text[m.index - 1])) || word.test(text[re.lastIndex] || ""))) {
        re.lastIndex = m.index + 1;
        continue;
      }
      if (m.index > at) parent.appendChild(document.createTextNode(text.slice(at, m.index)));
      if (m[1]) parent.appendChild(el("code", null, m[2]));
      else if (m[3] != null || m[4] != null) { var b = el("strong"); inline(b, m[3] != null ? m[3] : m[4]); parent.appendChild(b); }
      else if (m[5] != null || m[6] != null) { var i = el("em"); inline(i, m[5] != null ? m[5] : m[6]); parent.appendChild(i); }
      else if (m[7] != null) link(parent, m[8], m[7]);
      else if (m[9] != null) link(parent, m[9], m[9]);
      at = re.lastIndex;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
  }

  function lines(parent, text) {
    text.split("\n").forEach(function (line, i) {
      if (i) parent.appendChild(el("br"));
      inline(parent, line);
    });
  }

  function startsBlock(line) {
    return /^\s*(```|~~~)/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) ||
      /^\s*\|/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
  }

  function blocks(root, src, depth) {
    depth = depth || 0;
    if (depth > MD_DEPTH_MAX) { root.appendChild(el("p", "md-flat", src)); return; }
    var ls = src.replace(/\r\n?/g, "\n").split("\n"), i = 0, m, buf;
    while (i < ls.length) {
      var line = ls[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if ((m = /^\s*(`{3,}|~{3,})/.exec(line))) {
        buf = []; i++;
        while (i < ls.length && ls[i].trim().indexOf(m[1]) !== 0) buf.push(ls[i++]);
        i++;
        var pre = el("pre");
        pre.appendChild(el("code", null, buf.join("\n")));
        root.appendChild(pre);
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        var h = el(m[1].length <= 2 ? "h3" : "h4");
        inline(h, m[2]);
        root.appendChild(h);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { root.appendChild(el("hr")); i++; continue; }
      if (/^\s*\|/.test(line)) {
        buf = [];
        while (i < ls.length && /^\s*\|/.test(ls[i])) buf.push(ls[i++].trim());
        var tableWrap = el("div", "tmd"), table = el("table");
        buf.forEach(function (line, index) {
          if (/^\|?[\s:|-]+\|?$/.test(line)) return;
          var tr = el("tr"); line.replace(/^\||\|$/g, "").split("|").forEach(function (cell) { var td = el(index === 0 ? "th" : "td"); inline(td, cell.trim()); tr.appendChild(td); }); table.appendChild(tr);
        }); tableWrap.appendChild(table); root.appendChild(tableWrap);
        continue;
      }
      if (/^\s*>/.test(line)) {
        buf = [];
        while (i < ls.length && /^\s*>/.test(ls[i])) buf.push(ls[i++].replace(/^\s*>\s?/, ""));
        var alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(buf[0]);
        var q = el("blockquote", alert ? "callout-card" + (/WARNING|CAUTION/.test(alert[1]) ? " warn" : "") : "");
        if (alert) { q.appendChild(el("b", null, alert[1])); buf.shift(); }
        blocks(q, buf.join("\n"), depth + 1);
        root.appendChild(q);
        continue;
      }
      if (LIST_ITEM.test(line)) { i = list(root, ls, i, depth); continue; }
      buf = [];
      while (i < ls.length && !/^\s*$/.test(ls[i]) && !(buf.length && startsBlock(ls[i]))) buf.push(ls[i++].trim());
      var p = el("p");
      lines(p, buf.join("\n"));
      root.appendChild(p);
    }
  }

  function list(root, ls, i, depth) {
    var first = LIST_ITEM.exec(ls[i]), base = first[1].length, ordered = /\d/.test(first[2]);
    var node = el(ordered ? "ol" : "ul"), li = null, sub = [];
    if (ordered) { var start = parseInt(first[2], 10); if (start !== 1) node.start = start; }
    var flush = function () {
      if (li && sub.length) blocks(li, sub.join("\n"), depth + 1);
      sub = [];
    };
    while (i < ls.length) {
      var line = ls[i], m = LIST_ITEM.exec(line);
      if (m && m[1].length <= base + 1) {
        if (/\d/.test(m[2]) !== ordered) break;
        flush();
        li = el("li");
        inline(li, line.slice(m[0].length));
        node.appendChild(li);
        i++;
        continue;
      }
      if (/^\s*$/.test(line)) {
        var next = ls[i + 1];
        if (next != null && /^\s+\S/.test(next) && li) { sub.push(""); i++; continue; }
        if (next != null && LIST_ITEM.test(next) && LIST_ITEM.exec(next)[1].length <= base + 1) { i++; continue; }
        break;
      }
      if (/^\s+\S/.test(line) && li) {
        var indent = line.search(/\S/), cut = Math.min(indent, base + 2);
        if (m || sub.length) sub.push(line.slice(cut));
        else { li.appendChild(el("br")); inline(li, line.trim()); }
        i++;
        continue;
      }
      break;
    }
    flush();
    root.appendChild(node);
    return i;
  }

  function markdown(text) {
    var root = el("div", "md");
    blocks(root, text || "");
    return root;
  }

  // ---- Routing and wiring ----

  function route() {
    var h = location.hash.replace(/^#/, ""), m;
    if ((m = /^pair=([0-9a-fA-F]+)$/.exec(h))) {
      S.pendingPair = m[1];
      history.replaceState(null, "", location.pathname);
      showPair();
      return;
    }
    if (!S.token) { showPair(); return; }
    if ((m = /^(session|pane)=(\d+)$/.exec(h))) { openPane(Number(m[2]), null, m[1] === "session"); return; }
    openList();
  }

  $("pair-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("device-name").value.trim();
    if (!name || !S.pendingPair) return;
    $("pair-submit").disabled = true;
    $("pair-submit").replaceChildren(el("span", "spinner"), document.createTextNode("Connecting…"));
    $("pair-error").classList.add("hidden");
    var pairingGeneration = S.authGeneration;
    api("POST", "/api/pair", { code: S.pendingPair, device_name: name }).then(function (d) {
      if (pairingGeneration !== S.authGeneration) return;
      resetAuthRequests();
      pairingGeneration = S.authGeneration;
      S.token = d.token;
      store(TOKEN_KEY, S.token);
      S.pendingPair = null;
      S.me.name = name;
      setMark("ok");
      $("pair-title").textContent = "You're connected";
      $("pair-lede").textContent = "Houston is ready on this phone.";
      ["pair-form", "pair-facts", "pair-submit", "trust"].forEach(function (id) { $(id).classList.add("hidden"); });
      installHelp($("install-help"));
      $("install-help").classList.toggle("hidden", standalone());
      $("pair-connected").classList.remove("hidden");
      $("pair-continue").classList.remove("hidden");
      animate(document.querySelector(".pair-card"), "enter-fade");
      Promise.all([loadMe(), api("GET", "/api/sessions")]).then(function (r) {
        var n = (r[1].sessions || []).length;
        if (S.view === "pair") $("pair-lede").textContent = hostName() + " · " + plural(n, "pane", "panes");
      }).catch(function () { /* the lede stays generic */ });
    }).catch(function (e) {
      if (e.stale || pairingGeneration !== S.authGeneration) return;
      if (e.status === 410 || /expired|already used|not valid/i.test(e.message)) {
        S.pendingPair = null;
        showPair(/used/i.test(e.message) ? "used" : "expired");
        return;
      }
      $("pair-error").textContent = e.message + (e.retry ? " Try again in " + e.retry + " seconds." : "");
      $("pair-error").classList.remove("hidden");
    }).then(function () { if (pairingGeneration !== S.authGeneration) return; $("pair-submit").disabled = false; $("pair-submit").textContent = "Connect"; });
  });

  $("back").addEventListener("click", openList);
  $("pair-again").addEventListener("click", function () { S.pendingPair = null; showPair(); });
  $("pair-continue").addEventListener("click", function () { openList(); });
  $("pane-menu").addEventListener("click", function () { openSheet($("menu-sheet")); });
  $("menu-close").addEventListener("click", function () { closeSheet($("menu-sheet")); });
  $("view-screen").addEventListener("click", function () { closeSheet($("menu-sheet")); selectTab("term"); });
  $("menu-keys").addEventListener("click", function () { closeSheet($("menu-sheet")); toggleKeys(); });
  $("copy-id").addEventListener("click", function () {
    var id = String(S.pane);
    closeSheet($("menu-sheet"));
    if (navigator.clipboard) navigator.clipboard.writeText(id).then(function () { toast("Pane id " + id + " copied"); }).catch(function () { toast("Pane id: " + id); });
    else toast("Pane id: " + id);
  });
  $("screen-close").addEventListener("click", function () { selectTab("conv"); });
  $("replies-close").addEventListener("click", function () { closeSheet($("replies-sheet")); });
  $("replies-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = $("replies-input").value.trim().slice(0, REPLY_CHARS_MAX), list = replies();
    if (!text) return;
    if (list.length >= REPLIES_MAX) { toast("Quick replies are limited to " + REPLIES_MAX + "; remove one to add “" + text + "”", true); return; }
    if (list.indexOf(text) < 0) list.push(text);
    store(REPLIES_KEY, JSON.stringify(list));
    $("replies-input").value = "";
    renderRepliesSheet();
    renderQuickReplies();
    if (S.view === "list" && S.home === "computer") renderList();
  });
  sheetGestures($("menu-sheet"));
  sheetGestures($("replies-sheet"), function () { if (S.view === "list" && S.home === "computer") renderList(); });
  sheetGestures($("screen-sheet"), function () { S.tab = "conv"; clearTimeout(S.timers.screen); });
  $("send").addEventListener("click", send);
  $("mic").addEventListener("click", function () {
    if (D.state === "idle") startDictation();
    else if (D.state === "recording") stopDictation(null);
    else if (D.state === "starting") cancelDictation();
  });
  $("rec-send").addEventListener("click", function () { stopDictation("send"); });
  $("rec-cancel").addEventListener("click", cancelDictation);
  $("more").addEventListener("click", function () { toggleKeys(); });
  $("other-cancel").addEventListener("click", function () { setOther(null); });
  $("jump").addEventListener("click", function () { toBottom(true); });
  $("text").addEventListener("input", function () { grow(); renderQuickReplies(); });
  $("text").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); }
  });
  window.addEventListener("resize", function () { if (S.tab === "term") fitScreen(); });
  window.addEventListener("scroll", function () {
    if (S.view === "list") document.body.classList.toggle("scrolled", window.scrollY > 8);
    else if (document.body.classList.contains("composing")) fitKeyboard();
    else if (S.view === "pane" && pinned()) $("jump").classList.add("hidden");
  }, { passive: true });
  if (window.ResizeObserver) {
    new ResizeObserver(function () { document.documentElement.style.setProperty("--dock-h", $("dock").offsetHeight + "px"); }).observe($("dock"));
  }

  // A drag from the left edge of a pane goes back, as in native navigation.
  (function () {
    var x0 = null, y0 = 0, view = $("view-pane");
    document.addEventListener("touchstart", function (ev) {
      x0 = S.view === "pane" && ev.touches.length === 1 && ev.touches[0].clientX < 24 && !document.querySelector("dialog[open]") ? ev.touches[0].clientX : null;
      y0 = x0 == null ? 0 : ev.touches[0].clientY;
    }, { passive: true });
    document.addEventListener("touchmove", function (ev) {
      if (x0 == null) return;
      var dx = ev.touches[0].clientX - x0;
      if (Math.abs(ev.touches[0].clientY - y0) > Math.abs(dx)) { x0 = null; view.style.transform = ""; return; }
      view.style.transform = "translateX(" + Math.max(0, dx) + "px)";
    }, { passive: true });
    document.addEventListener("touchend", function (ev) {
      if (x0 == null) return;
      var dx = ev.changedTouches[0].clientX - x0;
      x0 = null;
      view.style.transform = "";
      if (dx > 90) openList();
    });
  })();

  // iOS ignores interactive-widget=resizes-content and pans the page itself
  // when the keyboard opens, so lifting the dock by the covered height counts
  // the keyboard twice. While the message box has focus on a touch screen, the
  // page becomes a frame the size of the visible area instead: the bar on top,
  // the conversation scrolling inside, the dock at the bottom right above the
  // keyboard. The decision card folds to its title meanwhile.
  var touch = !!window.visualViewport && !!window.matchMedia && matchMedia("(pointer: coarse)").matches;

  // Safari scrolls the whole page up when the box it focuses sits where the
  // keyboard will appear, and only comes back once the keyboard has settled.
  // So the frame takes its keyboard-open size on the tap itself, before the
  // focus, using the height the keyboard covered last time (per width and
  // display mode); the box is then already clear of the keyboard.
  var kb = { base: 0, guess: 0, pending: false };
  // A shrink smaller than this is the browser's toolbar, not a keyboard.
  var KEYBOARD_MIN_PX = 120;
  // Before the first measurement on a phone: an iPhone keyboard with its
  // suggestion and form bars covers about 44% of a portrait screen.
  var KEYBOARD_FIRST_GUESS = 0.44, PHONE_WIDTH_MAX = 600;
  function keyboardSlot() { return window.innerWidth + (standalone() ? "-app" : "-tab"); }

  function fitKeyboard() {
    var vv = window.visualViewport, body = document.body, root = document.documentElement;
    var typing = document.activeElement === $("text");
    $("dock").classList.toggle("composing", typing || kb.pending);
    var frame = touch && (typing || kb.pending) && S.view === "pane";
    if (frame && !body.classList.contains("composing")) {
      var stick = pinned(), at = window.scrollY;
      kb.base = vv.height;
      kb.guess = storedJson(KEYBOARD_KEY, {})[keyboardSlot()] || (window.innerWidth <= PHONE_WIDTH_MAX ? Math.round(vv.height * KEYBOARD_FIRST_GUESS) : 0);
      body.classList.add("composing");
      var conv = $("conv");
      conv.scrollTop = stick ? conv.scrollHeight : at;
    } else if (!frame && body.classList.contains("composing")) {
      var inner = $("conv"), bottom = inner.scrollTop + inner.clientHeight >= inner.scrollHeight - 120, top = inner.scrollTop;
      body.classList.remove("composing");
      if (S.view === "pane") { if (bottom) toBottom(); else window.scrollTo(0, top); }
    }
    if (frame) {
      var waiting = kb.guess && vv.height > kb.base - KEYBOARD_MIN_PX;
      if (!waiting) kb.guess = 0;
      root.style.setProperty("--vv-top", Math.round(vv.offsetTop) + "px");
      root.style.setProperty("--vv-h", Math.round(waiting ? kb.base - kb.guess : vv.height) + "px");
    }
  }
  (function () {
    var x0 = 0, y0 = 0;
    $("text").addEventListener("touchstart", function (ev) { x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; }, { passive: true });
    $("text").addEventListener("touchend", function (ev) {
      var t = ev.changedTouches[0];
      if (document.activeElement === $("text") || Math.abs(t.clientX - x0) > 10 || Math.abs(t.clientY - y0) > 10) return;
      // The box moves before the focus, so the tap is not left for the browser
      // to resolve at a point the box has just left.
      ev.preventDefault();
      kb.pending = true;
      fitKeyboard();
      $("text").focus({ preventScroll: true });
      if (document.activeElement !== $("text")) { kb.pending = false; fitKeyboard(); }
    });
  })();
  // iOS pans the page to the focused box after the keyboard has opened and
  // does not always report the final position, so the frame follows the
  // visible area every frame until the keyboard has settled. 1 s covers the
  // keyboard animation (about 0.4 s) and the pan that follows it.
  var KEYBOARD_SETTLE_MS = 1000, settleUntil = 0;
  function settleKeyboard() {
    var running = Date.now() < settleUntil;
    settleUntil = Date.now() + KEYBOARD_SETTLE_MS;
    if (running) return;
    (function tick() {
      fitKeyboard();
      if (Date.now() < settleUntil && document.activeElement === $("text")) { requestAnimationFrame(tick); return; }
      settleUntil = 0;
      if (!document.body.classList.contains("composing")) return;
      var shrink = kb.base - window.visualViewport.height;
      if (shrink >= KEYBOARD_MIN_PX) {
        var known = storedJson(KEYBOARD_KEY, {});
        known[keyboardSlot()] = Math.round(shrink);
        store(KEYBOARD_KEY, JSON.stringify(known));
      }
      // No keyboard came (a hardware keyboard): drop the guess.
      kb.guess = 0;
      fitKeyboard();
    })();
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", settleKeyboard);
    window.visualViewport.addEventListener("scroll", fitKeyboard);
  }
  $("text").addEventListener("focus", function () { kb.pending = false; clearTimeout(S.timers["blur-fit"]); settleKeyboard(); });
  // A blur that a tap on the dock causes is followed by a refocus; waiting a
  // moment keeps the frame from jumping in between.
  $("text").addEventListener("blur", function () { later("blur-fit", fitKeyboard, 120); });
  // Taps on the dock's buttons keep the keyboard open, as in a messaging app.
  $("dock").addEventListener("mousedown", function (ev) {
    if (document.activeElement === $("text") && ev.target.closest("button")) ev.preventDefault();
  });
  $("conv").addEventListener("scroll", function () { if (pinned()) $("jump").classList.add("hidden"); }, { passive: true });
  fitKeyboard();

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { cancelDictation(); S.stopArmed = false; stopTimers(); disconnect(); setReachable(false); resetKeys(); return; }
    if (!S.token || S.view === "pair") return;
    S.retry = 1000;
    refreshAll();
    connect();
    schedulePoll();
  });

  window.addEventListener("hashchange", function () {
    var h = location.hash;
    if (/^#pair=/.test(h)) { route(); return; }
    var m = /^#pane=(\d+)$/.exec(h);
    if (S.token && m) openPane(Number(m[1]));
    else if (S.token && !h) openList();
  });

  $("device-name").value = /iPhone/.test(navigator.userAgent) ? "iPhone" : (/iPad/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(navigator.userAgent) ? "Android phone" : "Browser";
  buildKeys();
  updateSend();
  S.filter = stored(FILTER_KEY);
  S.token = stored(TOKEN_KEY);
  if (S.token && !/^#pair=/.test(location.hash)) {
    api("GET", "/api/me").then(function (d) { S.me = d; route(); }).catch(function (e) {
      if (!e.stale && e.status !== 401) {
        route();
        toast(e.message, true);
      }
    });
  } else {
    route();
  }
})();
