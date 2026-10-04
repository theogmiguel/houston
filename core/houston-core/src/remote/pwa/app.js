"use strict";
(function () {
  var TOKEN_KEY = "houston.remote.token";
  var FILTER_KEY = "houston.remote.workspace";
  // With the event stream up, polling is only a safety net; without it, the
  // client polls at these rates until the stream reconnects.
  var SAFETY_MS = 30000, LIST_MS = 3000, FEED_MS = 2500, SCREEN_MS = 1500, SCREEN_LINES = 120;
  // Twice the server's 15 s heartbeat plus margin: a stream silent this long
  // is dead (for example after a network change) and is reopened.
  var RETRY_MAX_MS = 30000, STREAM_SILENCE_MS = 40000;
  // Deeper markdown nesting is shown as plain text, so a hostile reply cannot
  // exhaust the stack.
  var MD_DEPTH_MAX = 6;
  var STATUS = { "needs-input": "Needs input", working: "Working", idle: "Idle", spawning: "Starting", unavailable: "No status" };
  var KINDS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", cursor: "Cursor", grok: "Grok", custom: "Shell" };
  var KEYS = [
    ["Esc", ["esc"]], ["↑", ["up"]], ["↓", ["down"]], ["Tab", ["tab"]], ["Enter", ["enter"]], ["Ctrl+C", ["ctrl+c"], true]
  ];

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    token: null, pendingPair: null, sessions: [], loaded: false, filter: null, view: null,
    pane: null, tab: "conv", entries: [], last: 0, epoch: null, pending: null, expanded: {},
    shown: 0, tailSteps: null, tailNode: null,
    live: false, stream: null, retry: 1000, timers: {}, busy: false, other: null,
    sent: {}, seenPending: {}, screenSource: "screen"
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
    if (s.state !== "running") return { cls: "exited", label: "Exited" };
    return { cls: s.status || "", label: STATUS[s.status] || "No status" };
  }

  function session(id) {
    for (var i = 0; i < S.sessions.length; i++) if (S.sessions[i].id === id) return S.sessions[i];
    return null;
  }

  // ---- HTTP ----

  function api(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (S.token) headers.Authorization = "Bearer " + S.token;
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401 && S.token && path !== "/api/pair") unpair("This device is no longer paired. Pair it again from Houston.");
          if (!r.ok) {
            var err = new Error(data.error || ("Request failed with status " + r.status));
            err.status = r.status;
            throw err;
          }
          return data;
        });
      });
  }

  function later(name, fn, ms) {
    clearTimeout(S.timers[name]);
    S.timers[name] = setTimeout(fn, ms);
  }

  function stopTimers() {
    Object.keys(S.timers).forEach(function (k) { clearTimeout(S.timers[k]); });
    S.timers = {};
  }

  // ---- Live events: fetch streaming carries the bearer header that EventSource cannot ----

  function setLive(on, label) {
    S.live = on;
    var c = $("conn");
    c.className = "conn " + (on ? "live" : "reconnecting") + (S.view === "list" ? "" : " hidden");
    $("conn-label").textContent = label || (on ? "Live" : "Reconnecting");
  }

  function connect() {
    if (!S.token || S.stream || document.hidden || typeof AbortController === "undefined") return;
    var ctrl = new AbortController();
    S.stream = ctrl;
    fetch("/api/events", { headers: { Authorization: "Bearer " + S.token, Accept: "text/event-stream" }, cache: "no-store", signal: ctrl.signal })
      .then(function (r) {
        if (r.status === 401) { unpair("This device is no longer paired. Pair it again from Houston."); throw new Error("unpaired"); }
        if (!r.ok || !r.body) throw new Error("event stream answered " + r.status);
        var reader = r.body.getReader(), decoder = new TextDecoder(), buf = "";
        var silence = function () { later("stream-silence", function () { if (S.stream === ctrl) ctrl.abort(); }, STREAM_SILENCE_MS); };
        silence();
        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) return;
            silence();
            buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
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
    if (name === "ready") {
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
    if (view !== "pane") $("heading").textContent = "Houston";
  }

  function showPair(message) {
    stopTimers(); disconnect();
    S.pane = null;
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
      var tap = s.id + ":" + s.pending.seq;
      if (S.sent[tap]) sent[tap] = true;
    });
    // Only cards still listed are remembered, so neither map grows.
    S.seenPending = seen;
    S.sent = sent;
    if (fresh && !document.hidden && navigator.vibrate) {
      try { navigator.vibrate(40); } catch (e) { /* unsupported */ }
    }
  }

  function loadSessions() {
    if (!S.token) return Promise.resolve();
    return api("GET", "/api/sessions").then(function (d) {
      S.sessions = d.sessions || [];
      notePending();
      S.loaded = true;
      updateTitle();
      $("list-error").classList.add("hidden");
      if (S.view === "list") renderList();
      if (S.view === "pane") {
        var known = S.kindShown;
        renderBar();
        // Reply labels name the agent, which the feed alone does not carry.
        var s = session(S.pane);
        if (s && s.kind !== known) { S.kindShown = s.kind; renderFeed(true); }
      }
    }).catch(function (e) {
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
      var b = button("chip", w.name, function () {
        S.filter = w.path;
        store(FILTER_KEY, w.path);
        renderList();
      });
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

  function needCard(s) {
    var card = el("div", "need"), open = button("need-open", null, function () { openPane(s.id); });
    var where = el("div", "need-where");
    where.appendChild(el("span", "need-name", s.workspace.name + " · " + (s.title || "Pane " + s.id)));
    where.appendChild(el("span", "need-ago", ago(s.waiting_since || s.status_since)));
    open.appendChild(where);
    open.appendChild(el("div", "need-what", pendingWhat(s.pending)));
    if (s.pending && s.pending.detail) open.appendChild(el("div", "need-target", s.pending.detail));
    card.appendChild(open);
    var p = s.pending;
    if (p && p.type === "permission" && p.decidable) {
      var actions = el("div", "need-actions"), state = cardState(s.id, p);
      if (state) {
        card.appendChild(el("div", "sent", state));
      } else if (p.truncated) {
        // Approving needs the whole command, which only the terminal shows.
        card.appendChild(el("div", "decision-note", "Only part of this command is shown."));
        actions.appendChild(button("btn primary", "Open terminal", function () { openPane(s.id, "term"); }));
        card.appendChild(actions);
      } else {
        actions.appendChild(button("btn danger", "Deny", function () { decide(s.id, p.seq, "deny"); }));
        actions.appendChild(button("btn primary", "Approve", function () { decide(s.id, p.seq, "approve"); }));
        card.appendChild(actions);
      }
    }
    return card;
  }

  function row(s, sub, mono) {
    var b = button("row", null, function () { openPane(s.id); });
    b.appendChild(el("span", "kind " + s.kind));
    var main = el("span", "row-main");
    main.appendChild(el("span", "row-title", s.title || ("Pane " + s.id)));
    main.appendChild(el("span", "row-sub" + (mono ? " mono" : ""), sub));
    b.appendChild(main);
    var st = statusOf(s);
    b.appendChild(el("span", "status " + st.cls, st.label));
    return b;
  }

  function section(root, title, items, attention) {
    if (!items.length) return;
    var head = el("h2", "section-head" + (attention ? " attention" : ""), title);
    head.appendChild(el("span", "count", String(items.length)));
    root.appendChild(head);
    root.appendChild(items.container);
  }

  function renderList() {
    renderChips();
    var root = $("list");
    root.replaceChildren();
    var visible = S.sessions.filter(function (s) { return !S.filter || s.workspace.path === S.filter; });
    $("list-empty").classList.toggle("hidden", S.sessions.length > 0);
    var many = workspaces().length > 1 && !S.filter;
    var needs = [], working = [], idle = [], other = [];
    visible.forEach(function (s) {
      if (s.state !== "running") other.push(s);
      else if (s.status === "needs-input") needs.push(s);
      else if (s.status === "working") working.push(s);
      else if (s.status === "idle") idle.push(s);
      else other.push(s);
    });
    var prefix = function (s) { return many ? s.workspace.name + " · " : ""; };
    var group = function (list, make, cls) {
      var c = el("div", cls);
      list.forEach(function (s) { c.appendChild(make(s)); });
      list.container = c;
      return list;
    };
    section(root, "Needs you", group(needs, needCard, "needs"), true);
    section(root, "Working", group(working, function (s) {
      return row(s, s.last_step ? prefix(s) + s.last_step : prefix(s) + kindName(s.kind) + " is working", !!s.last_step);
    }, "rows"));
    section(root, "Idle", group(idle, function (s) {
      return row(s, prefix(s) + (s.last_reply_excerpt || kindName(s.kind) + " · " + ago(s.status_since)));
    }, "rows"));
    section(root, "Other", group(other, function (s) {
      return row(s, prefix(s) + kindName(s.kind));
    }, "rows"));
  }

  function openList() {
    S.pane = null;
    S.other = null;
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
    var st = statusOf(s), chip = $("pane-status");
    chip.className = "status " + st.cls;
    chip.textContent = st.label;
  }

  function openPane(id, tab) {
    if (S.pane !== id) {
      S.entries = []; S.last = 0; S.epoch = null; S.pending = null; S.expanded = {}; S.other = null; S.kindShown = null;
      renderFeed(true);
      $("screen").textContent = "";
      setDockStatus("");
      $("text").value = "";
      grow();
    }
    S.pane = id;
    if (location.hash !== "#session=" + id) history.replaceState(null, "", "#session=" + id);
    show("pane");
    selectTab(tab || S.tab);
    renderBar();
    renderCard();
    loadFeed(true);
    loadSessions();
    connect();
    schedulePoll();
  }

  function selectTab(tab) {
    S.tab = tab;
    $("tab-conv").setAttribute("aria-selected", String(tab === "conv"));
    $("tab-term").setAttribute("aria-selected", String(tab === "term"));
    $("conv").classList.toggle("hidden", tab !== "conv");
    $("term").classList.toggle("hidden", tab !== "term");
    if (tab === "term") loadScreen(); else clearTimeout(S.timers.screen);
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
    if (id == null || !S.token) return Promise.resolve();
    return api("GET", "/api/sessions/" + id + "/feed?after=" + S.last).then(function (d) {
      if (S.pane !== id) return;
      // Another epoch (a daemon restart, or remote access turned off and on)
      // numbers its entries afresh, so everything shown so far is dropped.
      var reset = (S.epoch != null && d.epoch !== S.epoch) || d.last_seq < S.last || d.truncated;
      if (reset) {
        var refetch = S.last > 0 && !d.truncated;
        S.entries = []; S.last = 0; S.epoch = d.epoch;
        renderFeed(true);
        if (refetch) return loadFeed(first);
      }
      S.epoch = d.epoch;
      var stick = first || pinned();
      (d.entries || []).forEach(function (e) { if (e.seq > S.last) S.entries.push(e); });
      S.last = Math.max(S.last, d.last_seq || 0);
      S.pending = d.pending || null;
      // The card first: it is what the person must act on.
      renderCard();
      renderFeed(false);
      if (stick && S.tab === "conv") toBottom();
    }).catch(function (e) { if (S.pane === id) setDockStatus(e.message, true); });
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
      S.tailSteps = null; S.tailNode = null;
      var node = safeEntry(e, s);
      if (node) {
        if (arrive) node.classList.add("arrive");
        root.appendChild(node);
      }
    }
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
    var key = String(steps[0].seq), open = !!S.expanded[key];
    var wrap = el("div", "steps-group");
    var toggle = button("steps-toggle", null, function () {
      S.expanded[key] = !S.expanded[key];
      var fresh = stepGroup(steps);
      wrap.replaceWith(fresh);
      if (S.tailNode === wrap) S.tailNode = fresh;
    });
    toggle.setAttribute("aria-expanded", String(open));
    toggle.appendChild(svg("M9 6l6 6-6 6"));
    toggle.appendChild(el("span", null, steps.length + (steps.length === 1 ? " step" : " steps")));
    var last = steps[steps.length - 1];
    if (!open) toggle.appendChild(el("span", "steps-last", last.tool + (last.target ? " " + last.target : "")));
    wrap.appendChild(toggle);
    if (open) {
      var ul = el("ul", "step-list");
      steps.forEach(function (st) {
        var li = el("li");
        li.appendChild(el("span", "step-tool", st.tool));
        if (st.target) li.appendChild(el("span", "step-target", st.target));
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
        n = el("div", "msg me");
        n.appendChild(el("div", "msg-label", "You · " + clock(e.at)));
        n.appendChild(document.createTextNode(e.text));
        return n;
      case "answer":
        n = el("div", "msg me");
        n.appendChild(el("div", "msg-label", "Answered · " + clock(e.at)));
        n.appendChild(document.createTextNode((e.answers || []).join(", ") || "Answered"));
        return n;
      case "reply":
        n = el("div", "msg agent");
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
      case "status":
        if (e.status === "finished") return el("div", "sep", "Finished · " + clock(e.at));
        if (e.status === "exited") return el("div", "sep", "Exited · " + clock(e.at));
        return null;
      default:
        return null;
    }
  }

  // ---- Decision card ----

  function entry(seq) {
    for (var i = S.entries.length - 1; i >= 0; i--) if (S.entries[i].seq === seq) return S.entries[i];
    return null;
  }

  // Why a card takes no tap, or "" while it does.
  function cardState(id, p) {
    if (!p) return "";
    if (p.answered_elsewhere) return "Answered in the terminal · waiting for the agent";
    if (p.sent || S.sent[id + ":" + p.seq]) return "Sent · waiting for the agent";
    return "";
  }

  function renderCard() {
    var root = $("card"), p = S.pending, s = session(S.pane);
    root.replaceChildren();
    root.classList.toggle("hidden", !p);
    if (!p) { if (S.other) setOther(null); return; }
    var state = cardState(S.pane, p), sent = !!state, src = entry(p.seq);
    var kicker = function (t) { root.appendChild(el("div", "decision-kicker", t)); };
    if (p.type === "permission") {
      kicker("Permission");
      root.appendChild(el("div", "decision-title", "Allow " + p.title + "?"));
      var target = (src && src.target) || p.detail;
      if (target) root.appendChild(el("div", "decision-target", target));
      if (p.decidable && p.answered_elsewhere) {
        var look = el("div", "decision-actions");
        look.appendChild(button("btn primary", "Open terminal", function () { selectTab("term"); }));
        root.appendChild(look);
      } else if (p.decidable) {
        var acts = el("div", "decision-actions");
        acts.appendChild(button("btn danger", "Deny", function () { decide(S.pane, p.seq, "deny"); }));
        if (p.truncated) {
          root.appendChild(el("div", "decision-note", "Only part of this command is shown: it was too long, or it held invisible characters. Read it in the terminal and approve it there."));
          acts.appendChild(button("btn primary", "Open terminal", function () { selectTab("term"); }));
        } else {
          if (src && src.always) acts.appendChild(button("btn", "Always", function () { decide(S.pane, p.seq, "always"); }));
          acts.appendChild(button("btn primary", "Approve", function () { decide(S.pane, p.seq, "approve"); }));
        }
        Array.prototype.forEach.call(acts.children, function (b) { if (b.textContent !== "Open terminal") b.disabled = sent; });
        root.appendChild(acts);
      }
    } else if (p.type === "question" && src && src.questions) {
      src.questions.forEach(function (q, qi) {
        kicker("Question" + (q.header ? " · " + q.header : "") + (src.questions.length > 1 ? " · " + (qi + 1) + " of " + src.questions.length : ""));
        root.appendChild(el("div", "decision-title", q.question));
        var opts = el("div", "options");
        q.options.forEach(function (o, i) {
          var b = button("option", null, function () {
            b.classList.add("chosen");
            decide(S.pane, p.seq, String(i + 1));
          });
          b.appendChild(el("span", "option-n", String(i + 1)));
          var body = el("span", "option-body");
          body.appendChild(el("span", "option-label", o.label));
          if (o.description) body.appendChild(el("span", "option-desc", o.description));
          b.appendChild(body);
          b.disabled = sent || !p.decidable;
          opts.appendChild(b);
        });
        if (p.decidable && !sent && q.options.length < 9) {
          var other = button("option", null, function () { setOther({ seq: p.seq, question: q.question }); });
          other.appendChild(el("span", "option-n", String(q.options.length + 1)));
          var ob = el("span", "option-body");
          ob.appendChild(el("span", "option-label", "Other…"));
          ob.appendChild(el("span", "option-desc", "Type your own answer below"));
          other.appendChild(ob);
          other.disabled = sent;
          opts.appendChild(other);
        }
        root.appendChild(opts);
      });
    } else {
      kicker(p.type === "question" ? "Question" : "Needs you");
      root.appendChild(el("div", "decision-title", p.type === "question" ? p.title : kindName(s && s.kind) + " is waiting for you"));
    }
    if (!p.decidable) {
      root.appendChild(el("div", "decision-note", undecidableNote(p, s)));
      var go = el("div", "decision-actions");
      go.appendChild(button("btn", "Show keys", function () { toggleKeys(true); }));
      go.appendChild(button("btn primary", "Open terminal", function () { selectTab("term"); }));
      root.appendChild(go);
    }
    if (p.answered_elsewhere && p.type === "question") {
      var term = el("div", "decision-actions");
      term.appendChild(button("btn primary", "Open terminal", function () { selectTab("term"); }));
      root.appendChild(term);
    }
    if (sent) root.appendChild(el("div", "sent", state));
  }

  function undecidableNote(p, s) {
    var kind = s && s.kind;
    if (p.type === "input") return "It did not report what it is asking. Read the terminal and answer with the keys or a message.";
    if (kind !== "claude") return "Houston cannot answer " + kindName(kind) + " requests with a tap yet. Answer in the terminal.";
    if (p.type === "question") return "This request has several questions or allows several answers. Answer it in the terminal.";
    return "Answer it in the terminal.";
  }

  function epochOf(id) {
    var s = session(id);
    return (id === S.pane && S.pending && S.pending.epoch) || (s && s.pending && s.pending.epoch) || "";
  }

  function notice(text, isError) {
    if (S.view === "pane") { setDockStatus(text, isError); return; }
    // The list has no status line; only refusals are worth showing there.
    $("list-error").textContent = isError ? text : "";
    $("list-error").classList.toggle("hidden", !isError);
  }

  function decide(id, seq, choice, text) {
    if (S.busy) { notice("Wait for the previous send to finish, then tap again.", true); return Promise.resolve(false); }
    S.busy = true;
    notice("Sending…");
    var key = id + ":" + seq;
    return api("POST", "/api/sessions/" + id + "/decide", { epoch: epochOf(id), entry_seq: seq, choice: choice, text: text })
      .then(function () {
        // Held until the server's card changes: the daemon keeps it consumed.
        S.sent[key] = true;
        notice("");
        if (choice === "other") setOther(null);
        return true;
      })
      .catch(function (e) { notice(e.message, true); return false; })
      .then(function (ok) {
        S.busy = false;
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

  function updateSend() { $("send").disabled = S.busy || !$("text").value.trim(); }

  function input(body, what) {
    var id = S.pane;
    if (S.busy || id == null) return Promise.resolve(false);
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
    var text = $("text").value;
    if (!text.trim()) return;
    var done = function (ok) { if (ok) { $("text").value = ""; grow(); } };
    if (S.other) { decide(S.pane, S.other.seq, "other", text.trim()).then(done); return; }
    input({ text: text, keys: ["enter"] }, "").then(done);
  }

  function toggleKeys(force) {
    var root = $("keys"), open = force != null ? force : root.classList.contains("hidden");
    root.classList.toggle("hidden", !open);
    $("more").setAttribute("aria-expanded", String(open));
  }

  function buildKeys() {
    var root = $("keys");
    KEYS.forEach(function (k) {
      var armed = null;
      var b = button("key" + (k[2] ? " danger" : ""), k[0], function () {
        if (k[2] && !armed) {
          b.classList.add("armed"); b.textContent = "Tap again";
          armed = setTimeout(function () { armed = null; b.classList.remove("armed"); b.textContent = k[0]; }, 2500);
          return;
        }
        if (armed) { clearTimeout(armed); armed = null; b.classList.remove("armed"); b.textContent = k[0]; }
        input({ keys: k[1] }, k[0]);
      });
      b.setAttribute("aria-label", "Send " + k[0]);
      root.appendChild(b);
    });
  }

  // ---- Terminal ----

  function fitScreen() {
    var pre = $("screen"), w = pre.clientWidth - 20;
    if (w <= 0) return;
    // Monospace glyphs are about 0.6em wide; fit 80 columns, never below 7px.
    var size = Math.max(7, Math.min(13, Math.floor((w / (80 * 0.6)) * 10) / 10));
    pre.style.fontSize = size + "px";
  }

  function loadScreen() {
    var id = S.pane;
    clearTimeout(S.timers.screen);
    if (id == null || S.tab !== "term" || document.hidden) return;
    api("GET", "/api/sessions/" + id + "/screen?lines=" + SCREEN_LINES).then(function (d) {
      if (S.pane !== id) return;
      var pre = $("screen"), d2 = document.scrollingElement || document.documentElement;
      var stick = d2.scrollTop + window.innerHeight >= d2.scrollHeight - 120;
      fitScreen();
      pre.textContent = (d.lines || []).join("\n");
      var raw = d.source === "scrollback";
      $("screen-note").textContent = raw ? "Raw output: this build has no terminal emulator." : "";
      $("screen-note").classList.toggle("hidden", !raw);
      if (stick) toBottom();
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
        var table = el("pre");
        table.appendChild(el("code", null, buf.join("\n")));
        root.appendChild(table);
        continue;
      }
      if (/^\s*>/.test(line)) {
        buf = [];
        while (i < ls.length && /^\s*>/.test(ls[i])) buf.push(ls[i++].replace(/^\s*>\s?/, ""));
        var q = el("blockquote");
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
    if ((m = /^session=(\d+)$/.exec(h))) { openPane(Number(m[1])); return; }
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
      openList();
    }).catch(function (e) {
      $("pair-error").textContent = e.message;
      $("pair-error").classList.remove("hidden");
    }).then(function () { $("pair-submit").disabled = false; });
  });

  $("back").addEventListener("click", openList);
  $("tab-conv").addEventListener("click", function () { selectTab("conv"); toBottom(); });
  $("tab-term").addEventListener("click", function () { selectTab("term"); });
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
    if (document.hidden) { stopTimers(); disconnect(); return; }
    if (!S.token || S.view === "pair") return;
    S.retry = 1000;
    refreshAll();
    connect();
    schedulePoll();
  });

  window.addEventListener("hashchange", function () {
    var h = location.hash;
    if (/^#pair=/.test(h)) { route(); return; }
    var m = /^#session=(\d+)$/.exec(h);
    if (S.token && m && Number(m[1]) !== S.pane) openPane(Number(m[1]));
  });

  $("device-name").value = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad"
    : /Android/.test(navigator.userAgent) ? "Android phone" : "Browser";
  buildKeys();
  S.filter = stored(FILTER_KEY);
  S.token = stored(TOKEN_KEY);
  if (S.token && !/^#pair=/.test(location.hash)) {
    api("GET", "/api/me").then(route).catch(function (e) {
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
