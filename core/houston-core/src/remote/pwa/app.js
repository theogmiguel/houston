"use strict";
(function () {
  var TOKEN_KEY = "houston.remote.token";
  var FILTER_KEY = "houston.remote.workspace";
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
  var STATUS = { "needs-input": "Needs you", working: "Working", idle: "Idle", spawning: "Starting", unavailable: "No status" };
  var STATES = { sleeping: "Sleeping", exited: "Exited", killed: "Killed", interrupted: "Interrupted" };
  var KINDS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", cursor: "Cursor", grok: "Grok", custom: "Shell" };
  var KEYS = [
    ["Esc", ["esc"]], ["↑", ["up"]], ["↓", ["down"]], ["←", ["left"]], ["→", ["right"]], ["Tab", ["tab"]], ["Enter", ["enter"]], ["Ctrl+C", ["ctrl+c"], true]
  ];

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    token: null, pendingPair: null, sessions: [], loaded: false, filter: null, view: null, home: "inbox", inboxIndex: 0, inboxFeed: {}, me: {}, activity: [], activityLast: 0, activityEpoch: null, reachable: false, lastSeen: 0, disconnectedAt: 0, deepLink: false,
    pane: null, tab: "conv", entries: [], last: 0, epoch: null, pending: null, expanded: {}, turns: {},
    shown: 0, tailSteps: null, tailNode: null,
    live: false, stream: null, retry: 1000, timers: {}, busy: false, other: null,
    sent: {}, seenPending: {}, screenSource: "screen", selection: {}, activityFilter: "all", activityAt: null, feedBusy: false, activityBusy: false
  };

  // Storage can be blocked (private mode); the page works without it.
  function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function store(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* not persisted */ }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(path) {
    var ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
    p.setAttribute("d", path); s.appendChild(p);
    return s;
  }

  function button(cls, text, onClick) {
    var b = el("button", cls, text);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  function clock(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }

  function ago(ms) {
    if (!ms) return "";
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return Math.round(s / 3600) + " h";
    return Math.round(s / 86400) + " d";
  }

  function kindName(kind) { return KINDS[kind] || kind || "Agent"; }

  function statusOf(s) {
    if (!s) return { cls: "", label: "" };
    if (s.state !== "running") return { cls: "exited", label: STATES[s.state] || "No status" };
    return { cls: s.status || "", label: STATUS[s.status] || "No status" };
  }

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

  // ---- HTTP ----

  function api(method, path, body) {
    var token = S.token, headers = { "Content-Type": "application/json" };
    if (S.token) headers.Authorization = "Bearer " + S.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (token !== S.token && path !== "/api/pair") throw new Error("Pairing changed; ignored an older response.");
          if (r.status === 401 && S.token && path !== "/api/pair") unpair(data.reason === "revoked" ? "This device was revoked on the computer." : "This device is no longer paired. Connect it again from Houston.");
          if (!r.ok) {
            var err = new Error(data.error || ("Request failed with status " + r.status));
            err.status = r.status; err.reason = data.reason; err.retry = Number(r.headers.get("Retry-After")) || 0;
            throw err;
          }
          return data;
        });
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

  function setLive(on, label) {
    S.live = on;
    if (on) { S.lastSeen = Date.now(); }
    var c = $("conn");
    c.className = "conn " + (on ? "live" : "reconnecting") + (S.view === "list" ? "" : " hidden");
    $("conn-label").textContent = label || ((S.me.host || {}).name || location.hostname);
    c.setAttribute("aria-label", on ? "Live updates" : "Live updates reconnecting; polling available");
  }

  function connect() {
    if (!S.token || S.stream || document.hidden || typeof AbortController === "undefined") return;
    var ctrl = new AbortController();
    S.stream = ctrl;
    fetch("/api/events", { headers: { Authorization: "Bearer " + S.token, Accept: "text/event-stream" }, cache: "no-store", signal: ctrl.signal })
      .then(function (r) {
        if (r.status === 401) return r.json().catch(function () { return {}; }).then(function (d) { if (S.stream === ctrl) unpair(d.reason === "revoked" ? "This device was revoked on the computer." : "This device is no longer paired. Connect it again from Houston."); throw new Error("unpaired"); });
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
      unpair(d.reason === "revoked" ? "This device was revoked on the computer." : d.reason === "disabled" ? "Remote access was turned off on the computer." : "The connection ended.");
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
    S.view = view;
    ["pair", "list", "pane"].forEach(function (v) { $("view-" + v).classList.toggle("hidden", v !== view); });
    $("back").classList.toggle("hidden", view !== "pane");
    $("pane-status").classList.toggle("hidden", view !== "pane");
    $("subheading").classList.toggle("hidden", view !== "pane");
    $("conn").classList.toggle("hidden", view !== "list");
    $("pane-menu").classList.toggle("hidden", view !== "pane");
    $("provider-avatar").classList.toggle("hidden", view !== "pane");
    $("tabbar").classList.toggle("hidden", view !== "list");
    document.body.dataset.view = view;
    if (view !== "pane") $("heading").textContent = view === "list" ? homeTitle() : "Houston";
  }

  function showPair(message) {
    stopTimers(); disconnect(); resetKeys();
    S.pane = null;
    $("reconnect").classList.add("hidden");
    $("pair-connected").classList.add("hidden");
    $("pair-again").classList.toggle("hidden", !message);
    $("pair-steps").classList.toggle("hidden", !!S.pendingPair || !!message);
    $("pair-title").textContent = message ? "Disconnected" : S.pendingPair ? "Connect to Houston" : "Connect your phone";
    $("pair-lede").textContent = "Follow and answer your Houston panes from here.";
    $("route-warning").classList.toggle("hidden", location.protocol === "https:" || !S.pendingPair);
    var have = !!S.pendingPair;
    $("step-1").className = have ? "done" : "current";
    $("step-2").className = have ? "done" : "";
    $("step-3").className = have ? "current" : "";
    $("pair-form").classList.toggle("hidden", !have);
    $("pair-error").textContent = message || "";
    $("pair-error").classList.toggle("hidden", !message);
    show("pair");
  }

  function unpair(message) {
    S.token = null;
    S.sessions = []; S.entries = []; S.pending = null; S.inboxFeed = {}; S.activity = []; S.activityLast = 0; S.activityEpoch = null; S.me = {}; S.sent = {}; S.seenPending = {}; S.pendingPair = null; S.deepLink = false; S.reachable = false; S.loaded = false; S.selection = {}; S.busy = false; S.feedBusy = false; S.activityBusy = false; S.stopArmed = false; S.activityAt = null;
    $("text").value = ""; setOther(null); toggleKeys(false);
    $("quick-replies").replaceChildren(); $("children").replaceChildren(); $("child-band").replaceChildren(); $("screen-keys").replaceChildren();
    $("feed").replaceChildren(); $("list").replaceChildren(); $("card").replaceChildren(); $("screen").textContent = "";
    $("screen-sheet").close(); $("menu-sheet").close();
    document.body.classList.remove("offline");
    document.title = "Houston";
    store(TOKEN_KEY, null);
    showPair(message);
  }

  function updateTitle() {
    var n = S.sessions.filter(function (s) { return s.state === "running" && s.status === "needs-input"; }).length;
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
    return api("GET", "/api/sessions").then(function (d) {
      S.sessions = d.sessions || [];
      // Refresh decision identities before re-enabling any offline controls.
      setReachable(true);
      notePending();
      S.loaded = true;
      updateTitle();
      $("list-error").classList.add("hidden");
      if (S.view === "list") renderList();
      S.inboxFeed = Object.fromEntries(Object.entries(S.inboxFeed).filter(function (pair) { return S.sessions.some(function (s) { return String(s.id) === pair[0] && s.pending; }); }));
      if (S.view === "pane") {
        var currentPane = session(S.pane);
        S.pending = currentPane && currentPane.pending || null;
        var known = S.kindShown;
        renderBar();
        renderChildren();
        renderQuickReplies();
        renderCard();
        // Reply labels name the agent, which the feed alone does not carry.
        var s = session(S.pane);
        if (s && s.kind !== known) S.kindShown = s.kind;
        renderFeed(!!s && s.kind !== known);
      }
    }).catch(function (e) {
      if (S.token && (!e.status || e.status >= 500)) setReachable(false);
      if (S.view === "list" && S.token) {
        $("list-error").textContent = e.message;
        $("list-error").classList.remove("hidden");
      }
    });
  }

  // ---- Home ----

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
    var all = [{ name: "All", path: null }].concat(list);
    all.forEach(function (w) {
      var group = S.sessions.filter(function (s) { return !w.path || s.workspace.path === w.path; });
      var b = button("chip", w.name + " " + group.length, function () {
        S.filter = w.path;
        store(FILTER_KEY, w.path);
        renderList();
      });
      if (group.some(function (s) { return s.state === "running" && s.status === "needs-input"; })) { var dot = el("span", "attention-dot"); dot.setAttribute("aria-label", "Needs you"); b.appendChild(dot); }
      b.setAttribute("aria-pressed", String(S.filter === w.path));
      root.appendChild(b);
    });
  }

  function pendingWhat(p) {
    if (!p) return "Needs you";
    if (p.type === "permission") return "Permission · " + p.title;
    if (p.type === "question") return "Question · " + p.title;
    return "Needs you";
  }

  function row(s, sub, mono) {
    var b = button("row", null, function () { openPane(s.id); });
    b.appendChild(el("span", "kind " + s.kind));
    var main = el("span", "row-main");
    main.appendChild(el("span", "row-title", s.title || ("Pane " + s.id)));
    main.appendChild(el("span", "row-sub" + (mono ? " mono" : ""), excerpt(sub)));
    b.appendChild(main);
    var st = statusOf(s);
    b.appendChild(el("span", "status " + st.cls, st.label));
    return b;
  }

  function homeTitle() { return { inbox: "Inbox", panes: "Panes", activity: "Activity", computer: "Computer" }[S.home]; }

  function renderList() {
    document.body.dataset.home = S.home;
    $("heading").textContent = homeTitle();
    renderTabs();
    $("chips").classList.add("hidden");
    $("list-empty").classList.add("hidden");
    var root = $("list"); root.replaceChildren();
    if (S.home === "inbox") { renderInbox(root); return; }
    if (S.home === "activity") { renderActivity(root); return; }
    if (S.home === "computer") { renderComputer(root); return; }
    renderChips();
    var visible = S.sessions.filter(function (s) { return !S.filter || s.workspace.path === S.filter; });
    var order = { "needs-input": 0, working: 1, idle: 2 };
    visible.sort(function (a, b) { return (a.state === "running" ? order[a.status] ?? 3 : 4) - (b.state === "running" ? order[b.status] ?? 3 : 4); });
    root.appendChild(el("p", "pane-count", visible.length + (visible.length === 1 ? " pane · " : " panes · ") + visible.filter(function (s) { return s.state === "running" && s.status === "needs-input"; }).length + " need you"));
    var tiles = el("div", "g2");
    visible.forEach(function (s) {
      var tile = button("mt" + (s.status === "needs-input" ? " need" : ""), null, function () { openPane(s.id); });
      tile.appendChild(avatar(s)); tile.appendChild(el("b", null, s.title || "Pane " + s.id));
      tile.appendChild(el("small", null, excerpt(s.pending ? pendingWhat(s.pending) : s.last_step || s.last_reply_excerpt || s.workspace.name)));
      var st = statusOf(s); tile.appendChild(el("span", "status " + st.cls, st.label + (s.status === "needs-input" ? " · " + ago(s.waiting_since || s.status_since) : ""))); tiles.appendChild(tile);
    });
    root.appendChild(tiles);
    if (!visible.length) root.appendChild(el("p", "empty", "No panes are open in this workspace."));
  }

  function renderTabs() {
    var root = $("tabbar"); root.replaceChildren();
    var icons = { inbox: "M3 4h18v16H3zM3 12h5l2 3h4l2-3h5", panes: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", activity: "M2 12h4l3-8 6 16 3-8h4", computer: "M3 4h18v12H3zM8 21h8M12 16v5" };
    Object.keys(icons).forEach(function (tab) {
      var b = button("nav-tab", null, function () { S.home = tab; renderList(); if (tab === "activity") loadActivity(); if (tab === "computer") loadMe().catch(function (e) { notice(e.message, true); }); });
      b.setAttribute("aria-current", S.home === tab ? "page" : "false");
      b.appendChild(svg(icons[tab])); b.appendChild(el("span", null, { inbox: "Inbox", panes: "Panes", activity: "Activity", computer: "Computer" }[tab]));
      var n = S.sessions.filter(function (s) { return s.state === "running" && s.status === "needs-input"; }).length;
      if (tab === "inbox" && n) b.appendChild(el("span", "badge", String(n)));
      root.appendChild(b);
    });
  }

  function avatar(s) { return el("span", "kd " + s.kind, s.kind === "codex" ? "X" : kindName(s.kind).slice(0, 1)); }

  function providerGlyph(kind) {
    if (kind !== "claude" && kind !== "codex" && kind !== "opencode") return document.createTextNode(kindName(kind).slice(0, 1));
    var ns = "http://www.w3.org/2000/svg", icon = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
    icon.setAttribute("class", "pg"); icon.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#p-" + kind); icon.appendChild(use);
    return icon;
  }

  function renderInbox(root) {
    var needs = S.sessions.filter(function (s) { return s.state === "running" && s.status === "needs-input"; });
    if (!needs.length) {
      root.appendChild(el("div", "all-clear", "✓")); root.appendChild(el("h2", "pair-title", "You're all clear"));
      root.appendChild(el("p", "empty", S.loaded ? "Nothing is waiting for you. The next request appears here." : "Loading requests…"));
      var working = S.sessions.filter(function (s) { return s.status === "working" && s.state === "running"; });
      if (working.length) root.appendChild(el("h2", "section-head", "Still working"));
      working.forEach(function (s) { root.appendChild(row(s, s.last_step || kindName(s.kind) + " is working")); });
      var idle = S.sessions.filter(function (s) { return s.status === "idle" && s.last_reply_excerpt; }).sort(function (a, b) { return b.status_since - a.status_since; }).slice(0, 3);
      if (idle.length) root.appendChild(el("h2", "section-head", "Last finished"));
      idle.forEach(function (s) { root.appendChild(row(s, s.last_reply_excerpt)); });
      return;
    }
    S.inboxIndex = Math.min(S.inboxIndex, needs.length - 1);
    var s = needs[S.inboxIndex], p = s.pending;
    var nav = el("div", "inbox-nav");
    var previous = button("icon-btn", "‹", function () { S.inboxIndex = (S.inboxIndex + needs.length - 1) % needs.length; renderList(); }); previous.setAttribute("aria-label", "Previous request"); nav.appendChild(previous);
    nav.appendChild(el("span", null, (S.inboxIndex + 1) + " of " + needs.length));
    var next = button("icon-btn", "›", function () { S.inboxIndex = (S.inboxIndex + 1) % needs.length; renderList(); }); next.setAttribute("aria-label", "Next request"); nav.appendChild(next); root.appendChild(nav);
    var card = el("div", "inbox-card");
    var who = button("inbox-who", null, function () { openPane(s.id); }); who.appendChild(avatar(s)); who.appendChild(el("b", null, s.title || "Pane " + s.id)); who.appendChild(el("small", null, s.workspace.name)); card.appendChild(who);
    var content = el("div", "decision tapp"); card.appendChild(content); root.appendChild(card);
    renderCard(content, p || { type: "input", title: "Needs you", decidable: false }, s, (S.inboxFeed[s.id] || {}).entries || []);
    root.appendChild(button("btn block open-pane", "Open pane", function () { openPane(s.id); }));
    if (p && (!S.inboxFeed[s.id] || S.inboxFeed[s.id].epoch !== p.epoch || !S.inboxFeed[s.id].entries.some(function (e) { return e.seq === p.seq; }))) {
      api("GET", "/api/sessions/" + s.id + "/feed?after=0").then(function (d) {
        var current = session(s.id);
        if (!current || !current.pending || current.pending.seq !== p.seq || current.pending.epoch !== d.epoch) return;
        S.inboxFeed[s.id] = { epoch: d.epoch, entries: d.entries || [] };
        if (S.view === "list" && S.home === "inbox" && content.isConnected) renderCard(content, current.pending, current, d.entries || []);
      }).catch(function (e) { notice(e.message, true); });
    }
  }

  function loadMe() {
    return api("GET", "/api/me").then(function (d) { S.me = d; setLive(S.live); if (S.view === "list" && S.home === "computer") renderList(); });
  }

  function loadActivity() {
    if (!S.token || S.activityBusy) return;
    S.activityBusy = true;
    var after = S.activityLast;
    return api("GET", "/api/activity?after=" + S.activityLast).then(function (d) {
      if (S.activityEpoch !== d.epoch || d.truncated) {
        S.activity = []; S.activityLast = 0;
        if (after && S.activityEpoch !== d.epoch) { S.activityEpoch = d.epoch; S.activityBusy = false; return loadActivity(); }
      }
      S.activityEpoch = d.epoch;
      (d.entries || []).forEach(function (e) { if (e.seq > S.activityLast) S.activity.push(e); });
      S.activityLast = S.activity.reduce(function (n, e) { return Math.max(n, e.seq); }, S.activityLast);
      // A long-lived phone retains at most 200 activity rows.
      S.activity = S.activity.slice(-ACTIVITY_ENTRIES); S.activityUnavailable = false; S.activityError = "";
      if (S.view === "list" && S.home === "activity") renderList();
    }).catch(function (e) { S.activityUnavailable = e.status === 404; S.activityError = S.activityUnavailable ? "" : e.message; if (S.view === "list" && S.home === "activity") renderList(); }).then(function () { S.activityBusy = false; });
  }

  function renderActivity(root) {
    if (!S.activity.length) { if (S.activityError) root.appendChild(el("p", "notice danger", S.activityError)); root.appendChild(el("p", "empty", S.activityUnavailable ? "Activity isn't available on this computer yet. Open a pane to see its conversation." : "No activity yet. Updates appear while remote access is on.")); return; }
    var filters = el("div", "chips");
    [["all", "All"], ["finished", "Finished"], ["decisions", "Decisions"]].forEach(function (f) { var b = button("chip", f[1], function () { S.activityFilter = f[0]; renderList(); }); b.setAttribute("aria-pressed", String(S.activityFilter === f[0])); filters.appendChild(b); }); root.appendChild(filters);
    if (S.activityError) root.appendChild(el("p", "notice danger", S.activityError));
    var day = "", visible = S.activity.filter(function (e) { return S.activityFilter === "all" || (S.activityFilter === "decisions" ? e.kind !== "finished" : e.kind === "finished"); });
    if (!visible.length) root.appendChild(el("p", "empty", "No activity in this filter."));
    visible.slice().reverse().forEach(function (e) {
      var date = dayLabel(e.at);
      if (date !== day) { day = date; root.appendChild(el("h2", "section-head", date)); }
      var b = button("act-item", null, function () { openPane(e.session); S.activityAt = e.at; });
      b.appendChild(el("span", "activity-time", clock(e.at))); var body = el("span", "row-main");
      body.appendChild(el("b", null, excerpt(e.title))); if (e.excerpt) body.appendChild(el("small", null, excerpt(e.excerpt))); b.appendChild(body); b.appendChild(el("span", "activity-kind " + e.kind, e.kind === "needs_you" ? "?" : "✓")); root.appendChild(b);
    });
  }

  function installHelp() {
    return (/iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "In Safari, tap Share, then Add to Home Screen, then Add." : /Android/.test(navigator.userAgent) ? "In your browser's menu, choose Install app or Add to Home screen." : "Use your browser's Install app option, if available, or bookmark this page.";
  }

  function renderComputer(root) {
    var host = S.me.host || {}, connection = S.me.connection || {};
    root.appendChild(el("h2", "hostcard", host.name || location.hostname));
    var kv = el("dl", "kv");
    [["Houston", host.version || "Version not reported"], ["Route", connection.url || location.origin], ["Transport", (connection.https == null ? location.protocol === "https:" : connection.https) ? "Encrypted · HTTPS" : "Not encrypted · HTTP"], ["Device", S.me.name || "This browser"]].forEach(function (r) { kv.appendChild(el("dt", null, r[0])); kv.appendChild(el("dd", null, r[1])); }); root.appendChild(kv);
    root.appendChild(el("h2", "section-head", "On this device"));
    [ ["vibrate", "Vibrate for new requests"], ["quick", "Quick replies"] ].forEach(function (pref) {
      var on = stored("houston.remote." + pref[0]) !== "off";
      var b = button("pref", pref[1], function () { store("houston.remote." + pref[0], on ? "off" : "on"); renderList(); }); b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(on)); b.appendChild(el("span", "toggle" + (on ? "" : " off"))); root.appendChild(b);
    });
    root.appendChild(el("p", "decision-note", "Notifications are configured on the computer in Settings ▸ Remote access."));
    var sizes = el("div", "pref", "Screen text size"), size = Number(stored("houston.remote.screenSize")) || 11;
    [ -1, 1 ].forEach(function (delta) { var b = button("icon-btn", delta < 0 ? "A−" : "A+", function () { store("houston.remote.screenSize", String(Math.max(9, Math.min(18, size + delta)))); renderList(); }); b.setAttribute("aria-label", delta < 0 ? "Decrease screen text size" : "Increase screen text size"); sizes.appendChild(b); }); sizes.appendChild(el("span", null, size + " px")); root.appendChild(sizes);
    root.appendChild(el("h2", "section-head", "App")); root.appendChild(el("p", "howto", installHelp()));
    root.appendChild(button("btn danger block", "Disconnect this device", function () {
      if (window.confirm("Forget this browser's pairing? To revoke its token, use Devices on the computer.")) unpair("This browser's pairing was removed. Revoke its token under Devices on the computer.");
    }));
  }

  function setReachable(on) {
    S.reachable = on;
    if (on) { S.lastSeen = Date.now(); S.disconnectedAt = 0; clearTimeout(S.timers.offline); }
    else { S.stopArmed = false; resetKeys(); if (!S.disconnectedAt) S.disconnectedAt = Date.now(); }
    var banner = $("reconnect"); banner.replaceChildren(); banner.classList.toggle("hidden", on || !S.token);
    if (!on && S.token) {
      banner.appendChild(el("span", null, Date.now() - S.disconnectedAt >= 30000 ? "Can't reach " + ((S.me.host || {}).name || "the computer") + " — is it asleep?" : "Reconnecting… showing " + (S.lastSeen ? clock(S.lastSeen) : "last known state")));
      banner.appendChild(button("link-btn", "Retry", function () { S.retry = 1000; refreshAll(); connect(); }));
      if (!document.hidden) later("offline", function () { setReachable(false); }, 30000);
    }
    document.body.classList.toggle("offline", !on && !!S.token);
    document.querySelectorAll(".key").forEach(function (b) { b.disabled = !on; });
    document.querySelectorAll("[data-decision]").forEach(function (b) { b.disabled = S.busy || !on || b.dataset.locked === "true"; });
    updateSend();
  }

  function renderChildren() {
    var root = $("children"), band = $("child-band"); root.replaceChildren(); band.replaceChildren(); band.classList.add("hidden");
    var children = S.sessions.filter(function (s) { return s.parent === S.pane; });
    root.classList.toggle("hidden", !children.length);
    if (!children.length) return;
    root.appendChild(el("b", "tfh", children.length + " children"));
    children.forEach(function (s) { root.appendChild(row(s, s.role || s.last_step || s.workspace.name)); });
    var need = children.find(function (s) { return s.status === "needs-input"; });
    if (need) { band.classList.remove("hidden"); band.appendChild(button("tban", (need.role || need.title) + " needs you · Open", function () { openPane(need.id); })); }
  }

  function renderQuickReplies() {
    var root = $("quick-replies"), s = session(S.pane); root.replaceChildren();
    var finished = S.entries.some(function (e) { return e.type === "turn_end" || e.type === "status" && e.status === "finished"; });
    root.classList.toggle("hidden", !s || s.state !== "running" || s.status !== "idle" || !(finished || s.last_reply_excerpt) || !!S.pending || stored("houston.remote.quick") === "off");
    ["Commit it", "Open a PR", "Explain the fix"].forEach(function (text) { root.appendChild(button("tsug", text, function () { $("text").value = text; grow(); $("text").focus(); })); });
  }

  function openList() {
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
    $("heading").textContent = s.title || ("Pane " + s.id);
    $("subheading").textContent = s.workspace.name + " · " + kindName(s.kind);
    var parent = s.parent != null ? session(s.parent) : null;
    if (parent) $("subheading").textContent = (parent.title || "Pane " + parent.id) + " / " + s.workspace.name;
    $("provider-avatar").className = "tav " + s.kind; $("provider-avatar").replaceChildren(providerGlyph(s.kind));
    var st = statusOf(s), chip = $("pane-status");
    chip.className = "status " + st.cls;
    chip.textContent = st.label;
    $("text").placeholder = "Message " + kindName(s.kind) + "…";
    updateSend();
  }

  function openPane(id, tab, deepLink) {
    S.deepLink = !!deepLink;
    if (S.pane !== id) {
      S.stopArmed = false; S.selection = {}; S.activityAt = null; S.feedBusy = false; resetKeys(); toggleKeys(false); clearTimeout(S.timers["stop-arm"]);
      S.entries = []; S.last = 0; S.epoch = null; S.pending = null; S.expanded = {}; S.turns = {}; S.other = null; S.kindShown = null;
      renderFeed(true);
      $("screen").textContent = "";
      setDockStatus("");
      $("text").value = "";
      grow();
    }
    S.pane = id;
    if (location.hash !== "#pane=" + id) history.replaceState(null, "", "#pane=" + id);
    show("pane");
    selectTab("conv");
    if (tab === "term") selectTab("term");
    renderBar();
    renderChildren();
    renderQuickReplies();
    renderCard();
    loadFeed(true);
    loadSessions();
    connect();
    schedulePoll();
  }

  function selectTab(tab) {
    S.tab = tab;
    if (tab === "term") { $("screen-keys").replaceChildren(); buildKeys($("screen-keys")); if (!$("screen-sheet").open) $("screen-sheet").showModal(); loadScreen(); }
    else { $("screen-sheet").close(); clearTimeout(S.timers.screen); }
  }

  function pinned() {
    var d = document.scrollingElement || document.documentElement;
    return d.scrollTop + window.innerHeight >= d.scrollHeight - 120;
  }

  function toBottom() {
    var d = document.scrollingElement || document.documentElement;
    d.scrollTop = d.scrollHeight;
  }

  function loadFeed(first) {
    var id = S.pane;
    if (id == null || !S.token || S.feedBusy) return Promise.resolve();
    S.feedBusy = true;
    return api("GET", "/api/sessions/" + id + "/feed?after=" + S.last).then(function (d) {
      if (S.pane !== id) return;
      // Another epoch (a daemon restart, or remote access turned off and on)
      // numbers its entries afresh, so everything shown so far is dropped.
      var reset = (S.epoch != null && d.epoch !== S.epoch) || d.last_seq < S.last || d.truncated;
      if (reset) {
        var refetch = S.last > 0 && !d.truncated;
        S.entries = []; S.last = 0; S.epoch = d.epoch;
        renderFeed(true);
        if (refetch) { S.feedBusy = false; return loadFeed(first); }
      }
      S.epoch = d.epoch;
      var stick = first || pinned();
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
        else setDockStatus("That event is no longer in this pane’s recent history.");
        S.activityAt = null;
      } else if (stick && S.tab === "conv") toBottom();
    }).catch(function (e) { if (S.pane === id && S.token) { if (!e.status || e.status >= 500) setReachable(false); setDockStatus(e.message, true); } })
      .then(function () { if (S.pane === id) S.feedBusy = false; });
  }

  // Appends entries not yet shown; `reset` starts over. Existing nodes are
  // kept, so text selection survives and only new entries animate.
  function renderFeed(reset) {
    var root = $("feed"), s = session(S.pane);
    if (reset) { root.replaceChildren(); S.shown = 0; S.tailSteps = null; S.tailNode = null; }
    $("feed-empty").classList.toggle("hidden", S.entries.length > 0);
    var arrive = !reset && S.shown > 0;
    while (S.shown < S.entries.length) {
      var e = S.entries[S.shown++];
      if (e.type === "turn_end") {
        finishTurn(e, root); continue;
      }
      if (e.type === "step") {
        if (S.tailSteps) {
          S.tailSteps.push(e);
          var grown = stepGroup(S.tailSteps);
          S.tailNode.replaceWith(grown);
          S.tailNode = grown;
        } else {
          S.tailSteps = [e];
          S.tailNode = stepGroup(S.tailSteps);
          root.appendChild(S.tailNode);
        }
        continue;
      }
      if (e.type === "prompt") {
        if (S.tailSteps) { S.expanded[String(S.tailSteps[0].seq)] = false; var folded = stepGroup(S.tailSteps); S.tailNode.replaceWith(folded); }
        S.tailSteps = null; S.tailNode = null;
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
    var root = $("working-row"), s = session(S.pane), prompt = null, hasStep = false;
    for (var i = S.entries.length - 1; i >= 0; i--) {
      var e = S.entries[i];
      if (e.type === "step") hasStep = true;
      if (e.type === "prompt") { prompt = e; break; }
      if (e.type === "turn_end") break;
    }
    var active = S.view === "pane" && s && s.state === "running" && s.status === "working" && !hasStep;
    root.classList.toggle("hidden", !active);
    if (!active) return;
    var since = s.status_since || (prompt && prompt.at);
    $("working-elapsed").textContent = since ? duration(Math.max(0, Date.now() - since)) : "";
    // One row updates once a second, only while visible and awaiting reported steps.
    if (!document.hidden) later("working", renderWorking, 1000);
  }

  function safeEntry(e, s) {
    try {
      return entryNode(e, s);
    } catch (err) {
      var n = el("div", "msg agent plain");
      n.textContent = e.text || "";
      return n;
    }
  }

  function stepGroup(steps) {
    var key = String(steps[0].seq), open = S.expanded[key] !== false;
    var wrap = el("div", "steps-group tlive"); wrap.dataset.feedSeq = steps[0].seq;
    var toggle = button("steps-toggle", null, function () {
      S.expanded[key] = !open;
      var fresh = stepGroup(steps);
      wrap.replaceWith(fresh);
      if (S.tailNode === wrap) S.tailNode = fresh;
    });
    toggle.setAttribute("aria-expanded", String(open));
    toggle.appendChild(svg("M9 6l6 6-6 6"));
    toggle.appendChild(el("span", null, steps.length + (steps.length === 1 ? " step" : " steps")));
    var turn = S.turns[key];
    if (turn) { wrap.dataset.finished = "true"; if (turn.outcome !== "done") wrap.classList.add("warn"); toggle.querySelector("span").textContent = (turn.outcome === "stopped" ? "Stopped after " : turn.outcome === "failed" ? "Failed after " : "Worked for ") + duration(turn.duration_ms); }
    var last = steps[steps.length - 1];
    if (!open) toggle.appendChild(el("span", "steps-last", turn ? turnSummary(turn) : last.tool + (last.target ? " " + last.target : "")));
    wrap.appendChild(toggle);
    if (open) {
      var ul = el("ul", "step-list");
      steps.forEach(function (st) {
        var li = el("li", "twr");
        li.appendChild(el("span", "step-tool", st.tool));
        if (st.target) li.appendChild(el("span", "step-target", st.target));
        if (st.result) li.appendChild(el("span", "step-result", st.result));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    return wrap;
  }

  function entryNode(e, s) {
    var n;
    switch (e.type) {
      case "prompt":
        n = el("div", e.origin ? "ticard" : "msg me tu tbub");
        n.appendChild(el("div", "msg-label", (e.origin || "You") + " · " + clock(e.at)));
        n.appendChild(document.createTextNode(e.text));
        return n;
      case "answer":
        n = el("div", "msg me tu tbub");
        n.appendChild(el("div", "msg-label", "Answered · " + clock(e.at)));
        n.appendChild(document.createTextNode((e.answers || []).join(", ") || "Answered"));
        return n;
      case "reply":
        n = el("div", "msg agent ta");
        n.appendChild(el("div", "msg-label", kindName(s && s.kind) + " · " + clock(e.at)));
        n.appendChild(markdown(e.text));
        return n;
      case "question":
        n = el("div", "event");
        (e.questions || []).forEach(function (q) {
          n.appendChild(el("div", "event-head", "Question" + (q.header ? " · " + q.header : "")));
          n.appendChild(el("div", null, q.question));
          var ol = el("ol", "event-options");
          q.options.forEach(function (o) { ol.appendChild(el("li", null, o.label)); });
          n.appendChild(ol);
        });
        return n;
      case "permission":
        n = el("div", "event");
        n.appendChild(el("div", "event-head", "Permission · " + e.tool));
        if (e.target) n.appendChild(el("div", "event-target", e.target));
        return n;
      case "usage_limit":
        n = el("div", "tcall warn"); n.appendChild(el("b", null, "Usage limit")); n.appendChild(el("span", null, e.text || ((e.limit || "Limit") + ": " + (e.value == null ? "unknown" : e.value) + " · Resets " + (e.resets_at || "not reported")))); return n;
      case "divider": return el("div", "tdiv", e.text || "");
      case "status":
        if (e.status === "finished") return el("div", "tdiv", "Finished · " + clock(e.at));
        if (e.status === "exited") return el("div", "sep", "Exited · " + clock(e.at));
        return null;
      default:
        return null;
    }
  }

  function duration(ms) {
    var seconds = Math.round((ms || 0) / 1000);
    return seconds >= 60 ? Math.floor(seconds / 60) + "m " + (seconds % 60) + "s" : seconds + "s";
  }

  function turnSummary(turn) {
    var counts = turn.counts || {}, labels = { read: ["file read", "files read"], search: ["search", "searches"], edit: ["edit", "edits"], run: ["command", "commands"], other: ["other tool", "other tools"] };
    return Object.keys(labels).filter(function (k) { return counts[k] > 0; }).map(function (k) { return counts[k] + " " + labels[k][counts[k] === 1 ? 0 : 1]; }).join(" · ") || "Turn finished";
  }

  function finishTurn(e, root) {
    if (S.tailSteps) {
      var key = String(S.tailSteps[0].seq);
      S.expanded[key] = false; S.turns[key] = e;
      var group = stepGroup(S.tailSteps); S.tailNode.replaceWith(group);
    } else root.appendChild(el("div", "tdiv", e.outcome === "stopped" ? "Stopped" : e.outcome === "failed" ? "Failed" : "Turn finished"));
    if (e.files && e.files.length) {
      var files = el("div", "tfiles"); files.dataset.feedSeq = e.seq; files.appendChild(el("b", "tfh", "Changed " + e.files.length + " files"));
      e.files.forEach(function (path) { files.appendChild(el("div", "tfr", path)); }); root.appendChild(files);
    }
    if (e.outcome === "stopped") root.appendChild(el("div", "tdiv", "Turn stopped"));
    S.tailSteps = null; S.tailNode = null;
  }

  function renderLateLink() {
    if (!S.deepLink || S.pending) return;
    var answered = S.entries.slice().reverse().find(function (e) { return e.type === "answer" || e.type === "permission" && e.outcome || e.type === "question" && e.answers; });
    var root = $("card"); root.classList.remove("hidden"); root.replaceChildren();
    root.appendChild(el("b", "decision-title", answered ? "Already answered" : "No request waiting"));
    root.appendChild(el("p", "decision-note", (answered ? "The agent has already moved past this request. " : "This notification no longer has a request to answer. ") + statusOf(session(S.pane)).label + "."));
    root.appendChild(button("btn", "Open conversation", function () { S.deepLink = false; renderCard(); }));
  }

  function diffNode(diff) {
    var wrap = el("div", "tdiff"); wrap.appendChild(el("b", "tfh", diff.path || "Edit"));
    var pre = el("pre"); (diff.lines || []).forEach(function (line) { pre.appendChild(el("span", line.op === "+" ? "tadd" : line.op === "-" ? "tdel" : "", line.op + line.text + "\n")); }); wrap.appendChild(pre);
    if (diff.truncated) wrap.appendChild(el("p", "decision-note", "Diff shortened. Read the full edit on the computer before approving.")); return wrap;
  }

  // ---- Decision card ----

  // Why a card takes no tap, or "" while it does.
  function cardState(id, p) {
    if (!p) return "";
    if (p.answered_elsewhere) return "Already answered in the terminal · waiting for the agent";
    if (p.sent || S.sent[id + ":" + p.epoch + ":" + p.seq]) return "Sent · waiting for the agent";
    return "";
  }

  function renderCard(root, p, s, entries) {
    root = root || $("card"); p = arguments.length ? p : S.pending; s = s || session(S.pane);
    var id = s ? s.id : S.pane;
    entries = entries || S.entries;
    root.replaceChildren();
    root.classList.toggle("hidden", !p);
    if (!p) { if (root === $("card")) { if (S.other) setOther(null); renderLateLink(); } return; }
    if (S.other && (S.other.seq !== p.seq || S.other.epoch !== p.epoch || cardState(id, p))) setOther(null);
    var state = cardState(id, p), sent = !!state, src = entries.find(function (e) { return e.seq === p.seq; });
    if (root === $("card") && S.epoch !== p.epoch) src = null;
    var kicker = function (t) { root.appendChild(el("div", "decision-kicker", t)); };
    if (p.type === "permission") {
      if (s && s.last_reply_excerpt && root !== $("card")) root.appendChild(el("p", "decision-note", "Last said: " + excerpt(s.last_reply_excerpt)));
      kicker("Permission · " + ago(s && (s.waiting_since || s.status_since)));
      root.appendChild(el("div", "decision-title", "Allow " + p.title + "?"));
      var target = (src && src.target) || p.detail;
      if (target) root.appendChild(el("div", "decision-target", target));
      var diff = p.diff || (src && src.diff);
      if (diff) root.appendChild(diffNode(diff));
      if (p.decidable && p.answered_elsewhere) {
        var look = el("div", "decision-actions");
        look.appendChild(button("btn primary", root === $("card") ? "View screen" : "Open terminal", function () { if (S.pane !== id) openPane(id, "term"); else selectTab("term"); }));
        root.appendChild(look);
      } else if (p.decidable) {
        var acts = el("div", "decision-actions");
        acts.appendChild(button("btn danger", "Deny", function () { decide(id, p.seq, "deny", undefined, p.epoch); }));
        if (p.truncated || src && src.truncated) {
          root.appendChild(el("div", "decision-note", "Only part of this command is shown: it was too long, or it held invisible characters. Read it in the terminal and approve it there."));
          acts.appendChild(button("btn primary", root === $("card") ? "View screen" : "Open terminal", function () { if (S.pane !== id) openPane(id, "term"); else selectTab("term"); }));
        } else {
          if (src && src.always && !src.truncated) acts.appendChild(button("btn", "Always", function () { decide(id, p.seq, "always", undefined, p.epoch); }));
          acts.appendChild(button("btn primary", "Approve", function () { decide(id, p.seq, "approve", undefined, p.epoch); }));
        }
        Array.prototype.forEach.call(acts.children, function (b) { if (!/^(View screen|Open terminal)$/.test(b.textContent)) b.disabled = sent; });
        root.appendChild(acts);
      }
    } else if (p.type === "question" && src && src.questions) {
      var staged = root === $("card") && p.decidable && src.questions.length === 1;
      if (staged) root.classList.add("tq");
      var choiceKey = id + ":" + p.epoch + ":" + p.seq;
      var selection = S.selection[choiceKey] || null, next = null;
      src.questions.forEach(function (q, qi) {
        kicker("Question" + (q.header ? " · " + q.header : "") + (src.questions.length > 1 ? " · " + (qi + 1) + " of " + src.questions.length : ""));
        root.appendChild(el("div", "decision-title", q.question));
        if (!p.decidable && (q.multi_select || src.questions.length > 1)) root.appendChild(el("div", "decision-note", "Answer this question in the terminal with the screen and keys."));
        var opts = el("div", "options");
        if (staged) opts.setAttribute("aria-label", "Choose one answer, then Next");
        q.options.forEach(function (o, i) {
          var b = button("option", null, function () {
            if (staged) { selection = String(i + 1); S.selection = {}; S.selection[choiceKey] = selection; opts.querySelectorAll(".option").forEach(function (o) { o.classList.remove("chosen"); o.setAttribute("aria-pressed", "false"); }); b.classList.add("chosen"); b.setAttribute("aria-pressed", "true"); if (next) { next.dataset.locked = "false"; next.disabled = !S.reachable || sent; } }
            else { b.classList.add("chosen"); decide(id, p.seq, String(i + 1), undefined, p.epoch); }
          });
          b.appendChild(el("span", "option-n", String(i + 1)));
          if (staged || q.multi_select) b.appendChild(el("span", q.multi_select ? "choice-box" : "choice-radio"));
          var body = el("span", "option-body");
          body.appendChild(el("span", "option-label", o.label));
          if (o.description) body.appendChild(el("span", "option-desc", o.description));
          b.appendChild(body);
          if (staged) { b.setAttribute("aria-pressed", String(selection === String(i + 1))); if (selection === String(i + 1)) b.classList.add("chosen"); }
          b.disabled = sent || !p.decidable;
          opts.appendChild(b);
        });
        if (p.decidable && !sent && !q.previews && q.options.length < 9) {
          var other = button("option", null, function () { if (S.pane !== id) { openPane(id); } setOther({ seq: p.seq, epoch: p.epoch, question: q.question }); });
          other.appendChild(el("span", "option-n", String(q.options.length + 1)));
          var ob = el("span", "option-body");
          ob.appendChild(el("span", "option-label", "Other…"));
          ob.appendChild(el("span", "option-desc", "Type your own answer below"));
          other.appendChild(ob);
          other.disabled = sent;
          opts.appendChild(other);
        }
        root.appendChild(opts);
        if (staged) { next = button("btn primary", "Next", function () { if (selection) decide(id, p.seq, selection, undefined, p.epoch); }); next.disabled = sent || !selection; var actions = el("div", "decision-actions"); actions.appendChild(next); root.appendChild(actions); }
      });
    } else {
      kicker(p.type === "question" ? "Question" : "Needs you");
      root.appendChild(el("div", "decision-title", p.type === "question" ? p.title : kindName(s && s.kind) + " is waiting for you"));
    }
    if (!p.decidable) {
      root.appendChild(el("div", "decision-note", undecidableNote(p, s)));
      var go = el("div", "decision-actions");
      go.appendChild(button("btn", "Show keys", function () { if (S.pane !== id) openPane(id); toggleKeys(true); }));
      go.appendChild(button("btn primary", root === $("card") ? "View screen" : "Open terminal", function () { if (S.pane !== id) openPane(id, "term"); else selectTab("term"); }));
      root.appendChild(go);
    }
    if (p.answered_elsewhere && p.type === "question") {
      var term = el("div", "decision-actions");
      term.appendChild(button("btn primary", root === $("card") ? "View screen" : "Open terminal", function () { if (S.pane !== id) openPane(id, "term"); else selectTab("term"); }));
      root.appendChild(term);
    }
    if (sent) root.appendChild(el("div", "sent", state));
    root.querySelectorAll(".decision-actions button, .option").forEach(function (b) {
      if (/^(View screen|Open terminal|Show keys)$/.test(b.textContent)) return;
      b.dataset.decision = "true"; b.dataset.locked = String(b.disabled || sent || !p.decidable); b.disabled = S.busy || !S.reachable || !s || s.state !== "running" || b.dataset.locked === "true";
    });
    if (s && s.kind !== "claude" && s.status === "needs-input") {
      var pre = el("pre", "tscreen", "Loading screen…"); root.appendChild(pre);
      if (S.view === "pane") toggleKeys(true);
      api("GET", "/api/sessions/" + id + "/screen?lines=12").then(function (d) { pre.textContent = (d.lines || []).join("\n"); }).catch(function (e) { pre.textContent = e.message; });
    }
  }

  function undecidableNote(p, s) {
    var kind = s && s.kind;
    if (kind !== "claude") return "Houston cannot answer " + kindName(kind) + " requests with a tap yet. Read the screen and answer with keys or a message.";
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
    // The list has no status line; only refusals are worth showing there.
    $("list-error").textContent = isError ? text : "";
    $("list-error").classList.toggle("hidden", !isError);
  }

  function decide(id, seq, choice, text, epoch) {
    var pending = pendingOf(id);
    if (!pending || pending.seq !== seq || pending.epoch !== epoch || !pending.decidable || cardState(id, pending)) { notice("This request changed or was already answered. Refreshing…", true); refreshAll(); return Promise.resolve(false); }
    if (pending.truncated && (choice === "approve" || choice === "always")) { notice("Only part of this command is shown. Read the full request in the terminal.", true); return Promise.resolve(false); }
    if (!S.reachable) { notice("Answers are paused until the connection is back.", true); return Promise.resolve(false); }
    if (S.busy) { notice("Wait for the previous send to finish, then tap again.", true); return Promise.resolve(false); }
    S.busy = true;
    notice("Sending…");
    var key = id + ":" + epoch + ":" + seq;
    document.querySelectorAll("[data-decision]").forEach(function (b) { b.disabled = true; });
    updateSend();
    return api("POST", "/api/sessions/" + id + "/decide", { epoch: epoch, entry_seq: seq, choice: choice, text: text })
      .then(function () {
        // Held until the server's card changes: the daemon keeps it consumed.
        S.sent[key] = true;
        if (S.pane === id) S.deepLink = false;
        if (S.pane === id) renderFeed(false);
        notice("");
        if (choice === "other") setOther(null);
        return true;
      })
      .catch(function (e) { notice(e.message, true); return false; })
      .then(function (ok) {
        S.busy = false;
        updateSend();
        renderCard();
        if (S.view === "list") renderList();
        later("feed", loadFeed, 300);
        later("sessions", loadSessions, 300);
        return ok;
      });
  }

  function setOther(o) {
    S.other = o;
    $("other").classList.toggle("hidden", !o);
    $("other-label").textContent = o ? "Answering: " + o.question : "";
    $("text").placeholder = o ? "Your answer" : "Message";
    if (o) $("text").focus();
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
    var s = session(S.pane), stop = s && s.state === "running" && s.status === "working" && !$("text").value.trim();
    if (!stop && S.stopArmed) { S.stopArmed = false; clearTimeout(S.timers["stop-arm"]); }
    $("send").disabled = S.busy || !S.reachable || !s || s.state !== "running" || (!stop && !$("text").value.trim());
    $("send").setAttribute("aria-label", stop ? "Stop agent (Esc), tap again to confirm" : "Send");
    $("send").classList.toggle("stop", !!stop);
    $("send").textContent = S.stopArmed ? "Again" : stop ? "■" : "↑";
  }

  function input(body, what) {
    var id = S.pane;
    if (S.busy || id == null || !S.reachable) return Promise.resolve(false);
    S.busy = true;
    updateSend();
    setDockStatus("Sending…");
    return api("POST", "/api/sessions/" + id + "/input", body).then(function () {
      setDockStatus(what ? "Sent " + what : "");
      later("clear-status", function () { setDockStatus(""); }, 2500);
      if (S.tab === "term") later("screen", loadScreen, 250);
      return true;
    }).catch(function (e) { setDockStatus(e.message, true); return false; })
      .then(function (ok) { S.busy = false; updateSend(); return ok; });
  }

  function send() {
    var text = $("text").value, id = S.pane;
    if (!text.trim()) {
      var s = session(S.pane); if (!s || s.status !== "working" || !S.reachable) return;
      if (!S.stopArmed) { S.stopArmed = true; updateSend(); later("stop-arm", function () { S.stopArmed = false; updateSend(); }, 2500); return; }
      S.stopArmed = false;
      input({ keys: ["esc"] }, "Esc").then(function (ok) { if (ok && S.pane === id) $("feed").appendChild(el("div", "tdiv", "Stop requested from this phone")); }); updateSend(); return;
    }
    var done = function (ok) { if (ok && S.pane === id && $("text").value === text) { $("text").value = ""; grow(); } };
    if (S.pending && S.pending.type === "permission" && S.pending.decidable && !cardState(S.pane, S.pending)) { setDockStatus("Use Deny first, then send your explanation. This computer cannot attach a reason to a denial.", true); return; }
    if (S.other) { decide(S.pane, S.other.seq, "other", text.trim(), S.other.epoch).then(done); return; }
    input({ text: text, keys: ["enter"] }, "").then(done);
  }

  function toggleKeys(force) {
    var root = $("keys"), open = force != null ? force : root.classList.contains("hidden");
    root.classList.toggle("hidden", !open);
    $("more").setAttribute("aria-expanded", String(open));
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
          b.classList.add("armed"); b.textContent = "Tap again";
          armed = later("key-arm-" + root.id, function () { armed = null; b.classList.remove("armed"); b.textContent = k[0]; }, 2500);
          return;
        }
        if (armed) { clearTimeout(armed); armed = null; b.classList.remove("armed"); b.textContent = k[0]; }
        input({ keys: k[1] }, k[0]);
      });
      b.setAttribute("aria-label", "Send " + k[0]); b.disabled = !S.reachable;
      root.appendChild(b);
    });
  }

  // ---- Terminal ----

  function fitScreen() {
    var pre = $("screen");
    var size = Math.max(9, Math.min(18, Number(stored("houston.remote.screenSize")) || 11));
    pre.style.fontSize = size + "px";
  }

  function loadScreen() {
    var id = S.pane;
    clearTimeout(S.timers.screen);
    if (id == null || S.tab !== "term" || document.hidden) return;
    api("GET", "/api/sessions/" + id + "/screen?lines=" + SCREEN_LINES).then(function (d) {
      if (S.pane !== id) return;
      var pre = $("screen"), stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      fitScreen();
      pre.textContent = (d.lines || []).join("\n");
      var raw = d.source === "scrollback";
      $("screen-note").textContent = raw ? "Raw output: this build has no terminal emulator." : "";
      $("screen-note").classList.toggle("hidden", !raw);
      if (stick) pre.scrollTop = pre.scrollHeight;
    }).catch(function (e) { if (S.pane === id) setDockStatus(e.message, true); })
      .then(function () {
        if (S.pane === id && S.tab === "term") S.timers.screen = setTimeout(loadScreen, SCREEN_MS);
      });
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
        var q = el("blockquote", alert ? "tcall" + (/WARNING|CAUTION/.test(alert[1]) ? " warn" : "") : "");
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
      showPair("");
      $("device-name").focus();
      return;
    }
    if (!S.token) { showPair(""); return; }
    if ((m = /^(session|pane)=(\d+)$/.exec(h))) { openPane(Number(m[2]), null, m[1] === "session"); return; }
    openList();
  }

  $("pair-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("device-name").value.trim();
    if (!name || !S.pendingPair) return;
    $("pair-submit").disabled = true;
    $("pair-error").classList.add("hidden");
    api("POST", "/api/pair", { code: S.pendingPair, device_name: name }).then(function (d) {
      S.token = d.token;
      store(TOKEN_KEY, S.token);
      S.pendingPair = null;
      S.me.name = name;
      loadMe().catch(function () {});
      $("pair-form").classList.add("hidden"); $("pair-steps").classList.add("hidden");
      $("pair-title").textContent = "You're connected"; $("pair-lede").textContent = "Houston is ready on this phone.";
      $("install-help").textContent = installHelp(); $("pair-connected").classList.remove("hidden");
    }).catch(function (e) {
      $("pair-title").textContent = /used/i.test(e.message) ? "Code already used" : /expired/i.test(e.message) ? "Code expired" : "Cannot connect";
      $("pair-error").textContent = e.message + (e.retry ? " Retry in " + e.retry + " seconds." : "");
      if (e.status === 410 || /expired|already used|not valid/i.test(e.message)) { S.pendingPair = null; $("pair-form").classList.add("hidden"); $("pair-again").classList.remove("hidden"); }
      $("pair-error").classList.remove("hidden");
    }).then(function () { $("pair-submit").disabled = false; });
  });

  $("back").addEventListener("click", openList);
  $("pair-again").addEventListener("click", function () { S.pendingPair = null; showPair(""); });
  $("pair-continue").addEventListener("click", function () { $("pair-steps").classList.remove("hidden"); loadMe().catch(function () {}); openList(); });
  $("pane-menu").addEventListener("click", function () { $("menu-sheet").showModal(); });
  $("menu-close").addEventListener("click", function () { $("menu-sheet").close(); });
  $("view-screen").addEventListener("click", function () { $("menu-sheet").close(); selectTab("term"); });
  $("copy-id").addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(String(S.pane)).then(function () { setDockStatus("Pane id copied"); }).catch(function () { setDockStatus("Pane id: " + S.pane); }); else setDockStatus("Pane id: " + S.pane); });
  $("screen-close").addEventListener("click", function () { selectTab("conv"); });
  $("screen-sheet").addEventListener("close", function () { S.tab = "conv"; clearTimeout(S.timers.screen); });
  $("send").addEventListener("click", send);
  $("more").addEventListener("click", function () { toggleKeys(); });
  $("other-cancel").addEventListener("click", function () { setOther(null); });
  $("text").addEventListener("input", grow);
  $("text").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); }
  });
  window.addEventListener("resize", function () { if (S.tab === "term") fitScreen(); });

  // iOS ignores interactive-widget=resizes-content: the keyboard covers the
  // layout viewport, so the dock is lifted by the part the keyboard hides, and
  // the decision card folds to its title while the message box has focus.
  function fitKeyboard() {
    var vv = window.visualViewport;
    if (!vv) return;
    var hidden = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--keyboard", hidden + "px");
    $("dock").classList.toggle("composing", document.activeElement === $("text"));
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", fitKeyboard);
    window.visualViewport.addEventListener("scroll", fitKeyboard);
  }
  $("text").addEventListener("focus", fitKeyboard);
  $("text").addEventListener("blur", fitKeyboard);
  fitKeyboard();

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { S.stopArmed = false; stopTimers(); disconnect(); setReachable(false); resetKeys(); return; }
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
  S.filter = stored(FILTER_KEY);
  S.token = stored(TOKEN_KEY);
  if (S.token && !/^#pair=/.test(location.hash)) {
    api("GET", "/api/me").then(function (d) { S.me = d; route(); }).catch(function (e) {
      if (e.status !== 401) {
        route();
        $("list-error").textContent = e.message;
        $("list-error").classList.remove("hidden");
      }
    });
  } else {
    route();
  }
})();
