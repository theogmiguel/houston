// The loopback-only rule: this bench may run a local server on 127.0.0.1 with an
// ephemeral port, but nothing here may touch the network -- the process exits with it.
(function () {
  var invoke = window.__TAURI_INTERNALS__.invoke;
  var transformCallback = window.__TAURI_INTERNALS__.transformCallback;

  function Channel(onmessage) {
    this.onmessage = onmessage;
    this._next = 0;
    this._pending = [];
    var self = this;
    this.id = transformCallback(function (raw) {
      var index = raw.index;
      if ('end' in raw) return;
      var message = raw.message;
      if (index === self._next) {
        self.onmessage(message);
        self._next++;
        while (self._next in self._pending) {
          self.onmessage(self._pending[self._next]);
          delete self._pending[self._next];
          self._next++;
        }
      } else {
        self._pending[index] = message;
      }
    });
  }
  Channel.prototype.toJSON = function () {
    return '__CHANNEL__:' + this.id;
  };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return 0;
    var idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
    return sortedAsc[Math.max(0, idx)];
  }

  var logEl;
  function log(line) {
    var stamped = new Date().toISOString().slice(11, 23) + '  ' + line;
    console.log('[bench] ' + stamped);
    if (logEl) {
      logEl.textContent = stamped + '\n' + logEl.textContent.split('\n').slice(0, 500).join('\n');
    }
    invoke('bench_log', { line: stamped }).catch(function () {});
  }

  var resultsPath;
  function checkpoint(results) {
    if (!resultsPath) return Promise.resolve();
    return invoke('bench_checkpoint', { path: resultsPath, json: results }).catch(function (err) {
      log('checkpoint write failed (continuing -- this is best-effort, not fatal): ' + err);
    });
  }

  function takeOverDom() {
    document.title = 'Houston bench — Channel vs WebSocket (item 2)';
    document.body.setAttribute(
      'style',
      'margin:0;height:100vh;overflow:hidden;background:#1b1e24;color:#e6e6e6;' +
        'font:13px/1.45 system-ui,sans-serif;box-sizing:border-box;padding:10px 14px;' +
        'display:flex;flex-direction:column;gap:8px'
    );
    document.body.innerHTML =
      '<strong style="font-size:15px">Phase 2 item 2 -- Channel vs WebSocket bench running. ' +
      'This window closes itself when the run finishes (success or failure).</strong>' +
      '<pre id="benchlog" style="flex:1 1 auto;margin:0;overflow:auto;background:#0f1114;' +
      'border:1px solid #2b2f36;border-radius:4px;padding:8px 10px;' +
      'font:11px/1.4 ui-monospace,monospace"></pre>';
    logEl = document.getElementById('benchlog');
  }

  // MutationObserver first, rAF only as the fallback tick, plus a bounded deadline: the
  // predicates can become true with no further DOM mutation, and the deadline is what
  // keeps a wedged boot from hanging the run.
  function waitForDom(pred, deadlineMs) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      var done = false;
      var observer = null;
      var pollTimer = null;
      function finish(timedOut) {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        if (pollTimer) clearInterval(pollTimer);
        resolve({ timedOut: timedOut });
      }
      function check() {
        if (done) return true;
        if (pred()) { finish(false); return true; }
        if (Date.now() - startedAt > deadlineMs) { finish(true); return true; }
        return false;
      }
      if (check()) return;
      observer = new MutationObserver(function () { check(); });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true
      });
      pollTimer = setInterval(check, 250);
      (function tick() {
        if (check()) return;
        requestAnimationFrame(tick);
      })();
    });
  }

  function measureRenderCadence(durationMs) {
    return new Promise(function (resolve) {
      var frames = 0;
      var start = null;
      function tick(ts) {
        if (start === null) start = ts;
        frames++;
        if (ts - start < durationMs) {
          requestAnimationFrame(tick);
          return;
        }
        var elapsedMs = ts - start;
        var hz = elapsedMs > 0 ? ((frames - 1) * 1000) / elapsedMs : 0;
        resolve({ hz: hz, valid: hz >= 50 });
      }
      requestAnimationFrame(tick);
    });
  }

  function noBootSpinner() {
    return !document.querySelector('.boot-spinner');
  }

  function anyPanePresent() {
    return !!document.querySelector('[data-panekey]');
  }

  function focusedPaneTypeable() {
    return !!document.querySelector('[data-typeable]');
  }

  function parsedBytes() {
    var s = globalThis.__trGhosttyPaintStats__;
    return s ? s.parseBytes : 0;
  }
  function paintedFrames() {
    var s = globalThis.__trGhosttyPaintStats__;
    return s ? s.paintFrames : 0;
  }

  function measureChannelBlast(runId, size, count) {
    return new Promise(function (resolve, reject) {
      var received = 0;
      var ch = new Channel(function (buf) {
        received++;
        if (received === count) {
          invoke('bench_done', { runId: runId, n: received })
            .then(function (elapsedNs) { resolve(Number(elapsedNs)); })
            .catch(reject);
        }
      });
      invoke('bench_channel_blast', { channel: ch, runId: runId, size: size, count: count })
        .catch(reject);
    });
  }

  function measureChannelBlastPaced(runId, size, count, intervalNs) {
    return new Promise(function (resolve, reject) {
      var received = 0;
      var ch = new Channel(function (buf) {
        received++;
        if (received === count) {
          invoke('bench_done', { runId: runId, n: received })
            .then(function (elapsedNs) { resolve(Number(elapsedNs)); })
            .catch(reject);
        }
      });
      invoke('bench_channel_blast_paced', {
        channel: ch, runId: runId, size: size, count: count, intervalNs: intervalNs
      }).catch(reject);
    });
  }

  function wsOpen(port) {
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () { resolve(ws); };
      ws.onerror = function () { reject(new Error('bench WS: connection to port ' + port + ' failed')); };
    });
  }
  function measureWsBlast(ws, size, count) {
    return new Promise(function (resolve, reject) {
      var received = 0;
      var t0;
      var onMessage = function (ev) {
        received++;
        if (received === count) {
          ws.removeEventListener('message', onMessage);
          resolve(Math.round((performance.now() - t0) * 1e6));
        }
      };
      ws.addEventListener('message', onMessage);
      var onErr = function () { reject(new Error('bench WS: socket error mid-blast (size=' + size + ' count=' + count + ')')); };
      ws.addEventListener('error', onErr, { once: true });
      t0 = performance.now();
      ws.send(JSON.stringify({ size: size, count: count }));
    });
  }

  function measureWsBlastPrecise(ws, size, count) {
    return new Promise(function (resolve, reject) {
      var received = 0;
      var onMessage = function (ev) {
        if (typeof ev.data === 'string') {
          ws.removeEventListener('message', onMessage);
          var parsed;
          try {
            parsed = JSON.parse(ev.data);
          } catch (err) {
            reject(new Error('bench WS precise: malformed elapsed_ns reply ' + JSON.stringify(ev.data) + ': ' + err));
            return;
          }
          resolve(Number(parsed.elapsed_ns));
          return;
        }
        received++;
        if (received === count) {
          ws.send('ack');
        }
      };
      ws.addEventListener('message', onMessage);
      var onErr = function () { reject(new Error('bench WS precise: socket error mid-blast (size=' + size + ' count=' + count + ')')); };
      ws.addEventListener('error', onErr, { once: true });
      ws.send(JSON.stringify({ size: size, count: count, precise: true }));
    });
  }

  async function sizeStats(label, bulkFn, singleFn, size) {
    var means = [];
    for (var r = 0; r < 5; r++) {
      var ns = await bulkFn(label + '-m1-' + size + '-' + r, size, 2000);
      means.push(ns / 2000);
    }
    means.sort(function (a, b) { return a - b; });
    var t_msg = means[2];

    var samples = [];
    for (var i = 0; i < 500; i++) {
      var one = await singleFn(label + '-m2-' + size + '-' + i, size, 1);
      samples.push(one);
    }
    samples.sort(function (a, b) { return a - b; });
    var t_rt_p50 = percentile(samples, 50);
    var t_rt_p99 = percentile(samples, 99);

    log(label + ' size=' + size + ': t_msg(mean of 2000, median-of-5)=' + (t_msg / 1e6).toFixed(4) +
      'ms  t_rt p50=' + (t_rt_p50 / 1e6).toFixed(4) + 'ms p99=' + (t_rt_p99 / 1e6).toFixed(4) + 'ms');
    return { size: size, t_msg_ns: t_msg, t_rt_p50_ns: t_rt_p50, t_rt_p99_ns: t_rt_p99 };
  }

  function startRaf() {
    var samples = [];
    var last = performance.now();
    var running = true;
    function tick(ts) {
      samples.push(ts - last);
      last = ts;
      if (running) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return {
      samples: samples,
      stop: function () { running = false; }
    };
  }
  function rafStats(samples) {
    var over16 = samples.filter(function (x) { return x > 16; }).length;
    var max = samples.length ? Math.max.apply(null, samples) : 0;
    return {
      sampleCount: samples.length,
      fractionOver16ms: samples.length ? over16 / samples.length : 0,
      maxIntervalMs: max
    };
  }

  async function m6(t_msg_16384_ns) {
    var targetMs = 5000;
    var perMsgMs = Math.max(0.001, t_msg_16384_ns / 1e6);
    var count = Math.max(1, Math.ceil(targetMs / perMsgMs));
    var raf = startRaf();
    var t0 = performance.now();
    await measureChannelBlast('m6', 16384, count);
    var wallMs = performance.now() - t0;
    raf.stop();
    var stats = rafStats(raf.samples);
    var achievedMiBps = (count * 16384 / 1048576) / (wallMs / 1000);
    log('M6: count=' + count + ' wall=' + wallMs.toFixed(0) + 'ms achieved=' + achievedMiBps.toFixed(1) +
      ' MiB/s fractionOver16ms=' + (stats.fractionOver16ms * 100).toFixed(1) + '% maxInterval=' + stats.maxIntervalMs.toFixed(1) + 'ms');
    return Object.assign({ count: count, wallMs: wallMs, achievedMiBps: achievedMiBps }, stats);
  }

  async function m7Candidate(fraction, uncappedMiBps) {
    var size = 16384;
    var durationS = 5;
    var targetMiBps = uncappedMiBps * fraction;
    var msgsPerSec = (targetMiBps * 1048576) / size;
    var intervalNs = Math.max(0, Math.round(1e9 / msgsPerSec));
    var count = Math.max(1, Math.round(durationS * msgsPerSec));
    var raf = startRaf();
    var t0 = performance.now();
    await measureChannelBlastPaced('m7-' + Math.round(fraction * 100), size, count, intervalNs);
    var wallMs = performance.now() - t0;
    raf.stop();
    var stats = rafStats(raf.samples);
    var achievedMiBps = (count * size / 1048576) / (wallMs / 1000);
    return Object.assign(
      { fraction: fraction, targetMiBps: targetMiBps, achievedMiBps: achievedMiBps, count: count, intervalNs: intervalNs, wallMs: wallMs },
      stats
    );
  }

  async function m7(uncappedMiBps, results) {
    var fractions = [0.25, 0.5, 0.75, 0.9, 1.0];
    var candidates = [];
    var ceiling = null;
    for (var i = 0; i < fractions.length; i++) {
      var res = await m7Candidate(fractions[i], uncappedMiBps);
      log('M7 candidate ' + (fractions[i] * 100).toFixed(0) + '% (target=' + res.targetMiBps.toFixed(1) +
        ' MiB/s achieved=' + res.achievedMiBps.toFixed(1) + ' MiB/s, continuous): maxInterval=' +
        res.maxIntervalMs.toFixed(1) + 'ms' + (res.maxIntervalMs <= 100 ? ' (under 100ms threshold)' : ''));
      candidates.push(res);
      if (res.maxIntervalMs <= 100) ceiling = res.achievedMiBps;
      results.m7 = { uncappedMiBps: uncappedMiBps, candidates: candidates, ceilingMiBps: ceiling };
      await checkpoint(results);
    }
    if (ceiling === null) {
      log('M7: no candidate rate stayed under the 100ms threshold -- ceiling not reachable ' +
        'at achievable throughput (highest tested: ' + candidates[candidates.length - 1].achievedMiBps.toFixed(1) + ' MiB/s)');
    }
    return { uncappedMiBps: uncappedMiBps, candidates: candidates, ceilingMiBps: ceiling };
  }

  async function m8Pass(withA, ceilingMiBps) {
    var aPromise = null;
    if (withA) {
      var aSize = 16384;
      var aDurationS = 6;
      var aCount = Math.max(1, Math.ceil((ceilingMiBps * 1048576 * aDurationS) / aSize));
      aPromise = measureChannelBlast('m8-A', aSize, aCount).catch(function (err) {
        log('M8: Channel A blast error (ignored -- B sampling already complete by the time this settles): ' + err);
      });
    }
    var reps = 100;
    var samples = [];
    for (var i = 0; i < reps; i++) {
      var repStart = performance.now();
      var ns = await measureChannelBlast('m8-B-' + i, 8, 1);
      samples.push(ns);
      var elapsed = performance.now() - repStart;
      var waitMs = 50 - elapsed;
      if (waitMs > 0) await sleep(waitMs);
    }
    if (aPromise) await aPromise;
    samples.sort(function (a, b) { return a - b; });
    return {
      withA: withA, reps: reps,
      p50Ns: percentile(samples, 50), p99Ns: percentile(samples, 99),
      maxNs: samples[samples.length - 1]
    };
  }

  var M9_PANE_COUNT = 12;
  var M9_FLOOD_MIB = 8;
  var M9_EXIT_DEADLINE_MS = 120000;
  var M9_FRAME_P95_FLOOR_MS = 450;
  function paneKeys() {
    var keys = {};
    var els = document.querySelectorAll('[data-panekey]');
    for (var i = 0; i < els.length; i++) keys[els[i].getAttribute('data-panekey')] = true;
    return keys;
  }

  function pressKey(key) {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: key }));
  }

  function waitFor(pred, timeoutMs, everyMs) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      (function poll() {
        if (pred()) return resolve(true);
        if (Date.now() - startedAt > timeoutMs) return resolve(false);
        setTimeout(poll, everyMs || 100);
      })();
    });
  }

  function paneEnded(sessionId) {
    return !!document.querySelector('[data-panekey="' + sessionId + '"].opacity-80');
  }

  async function waitForGrid(tag) {
    var gridUp = await waitFor(function () {
      var launcher = document.querySelector('[data-testid="launcher-hint-footer"]');
      if (launcher) pressKey('Escape');
      if (!launcher &&
        (!!document.querySelector('[data-testid="workspace-empty"]') ||
          !!document.querySelector('.pane') ||
          anyPanePresent())) return true;
      var ws = document.querySelector('[data-testid="ws-disclosure"]');
      if (ws) ws.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return false;
    }, 30000, 500);
    if (!gridUp) {
      throw new Error(tag + ': the grid never became reachable after 30s -- ' +
        'launcher=' + !!document.querySelector('[data-testid="launcher-hint-footer"]') +
        ' workspaceRows=' + document.querySelectorAll('[data-testid="ws-disclosure"]').length +
        ' panes=' + document.querySelectorAll('[data-panekey]').length +
        ' body=' + JSON.stringify((document.body.textContent || '').slice(0, 240)));
    }
    return Object.keys(paneKeys()).length;
  }

  async function spawnShellPanes(count, tag) {
    var spawned = [];
    for (var p = 0; p < count; p++) {
      var before = paneKeys();
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await sleep(100);
      pressKey('t');
      var appeared = await waitFor(function () {
        return Object.keys(paneKeys()).length > Object.keys(before).length;
      }, 5000, 100);
      if (!appeared) {
        throw new Error(tag + ': pane ' + (p + 1) + '/' + count + " never appeared after 't' " +
          '(a setup modal or missing workspace blocks the gesture -- the channel needs at ' +
          'least one workspace selected)');
      }
      var after = paneKeys();
      for (var k in after) if (!before[k]) spawned.push(k);
    }
    return spawned;
  }

  var M11_PANE_COUNT = 12;

  async function m11() {
    log('M11: waiting for the real grid...');
    var initialCount = await waitForGrid('M11');
    log('M11: grid up with ' + initialCount + ' pre-existing pane(s); seeding ' +
      M11_PANE_COUNT + ' shells for the next boot...');
    var ids = await spawnShellPanes(M11_PANE_COUNT, 'M11');
    await sleep(3000);
    var sessionCount = await invoke('bench_session_count');
    log('M11: seeded sessions ' + ids.join(',') + '; daemon now holds ' + sessionCount + '.');
    return {
      requested: M11_PANE_COUNT,
      spawned: ids.length,
      preExistingPanes: initialCount,
      daemonSessionCount: sessionCount
    };
  }

  async function m9(binaryPath) {
    log('M9: waiting for the real grid...');
    var initialCount = await waitForGrid('M9');
    log('M9: grid up with ' + initialCount + ' pre-existing pane(s); spawning ' + M9_PANE_COUNT + ' shells...');
    var floodIds = await spawnShellPanes(M9_PANE_COUNT, 'M9');
    log('M9: spawned sessions ' + floodIds.join(',') + '; letting shells settle...');
    await sleep(3000);

    var rssStartKib = await invoke('bench_rss');
    var rssPeakKib = rssStartKib;
    var rssTimer = setInterval(function () {
      invoke('bench_rss').then(function (kib) {
        if (kib > rssPeakKib) rssPeakKib = kib;
      }).catch(function () {});
    }, 500);

    var deltas = [];
    var sampling = true;
    var lastTs = null;
    function onFrame(ts) {
      if (lastTs !== null) deltas.push(ts - lastTs);
      lastTs = ts;
      if (sampling) requestAnimationFrame(onFrame);
    }
    requestAnimationFrame(onFrame);

    var floodStartedAt = Date.now();
    var cmd = 'exec "' + binaryPath + '" bench-ansi-flood ' + M9_FLOOD_MIB + '\n';
    for (var w = 0; w < floodIds.length; w++) {
      await invoke('bench_stdin', { session: Number(floodIds[w]), text: cmd });
    }
    function paintStatsSnapshot() {
      var s = globalThis.__trGhosttyPaintStats__;
      if (!s) return null;
      return {
        parseMs: s.parseMs, parseCalls: s.parseCalls, parseBytes: s.parseBytes,
        paintMs: s.paintMs, paintFrames: s.paintFrames, coalescedRenders: s.coalescedRenders
      };
    }
    function paintStatsDelta(before, after) {
      if (!before || !after) return null;
      var d = {
        parseMs: Math.round((after.parseMs - before.parseMs) * 10) / 10,
        parseCalls: after.parseCalls - before.parseCalls,
        parseBytes: after.parseBytes - before.parseBytes,
        paintMs: Math.round((after.paintMs - before.paintMs) * 10) / 10,
        paintFrames: after.paintFrames - before.paintFrames,
        coalescedRenders: after.coalescedRenders - before.coalescedRenders
      };
      d.parseMsPerMiB = d.parseBytes > 0
        ? Math.round((d.parseMs / (d.parseBytes / 1048576)) * 10) / 10
        : 0;
      d.paintMsPerFrame = d.paintFrames > 0
        ? Math.round((d.paintMs / d.paintFrames) * 100) / 100
        : 0;
      return d;
    }
    function wqStatsSnapshot() {
      var s = globalThis.__trWriteQueueStats__;
      if (!s) return null;
      return {
        writesStarted: s.writesStarted, completions: s.completions,
        staleCompletions: s.staleCompletions, watchdogFires: s.watchdogFires
      };
    }
    function wqStatsDelta(before, after) {
      if (!before || !after) return null;
      return {
        writesStarted: after.writesStarted - before.writesStarted,
        completions: after.completions - before.completions,
        staleCompletions: after.staleCompletions - before.staleCompletions,
        watchdogFires: after.watchdogFires - before.watchdogFires
      };
    }
    function wsGapStatsSnapshot() {
      var s = globalThis.__trWsGapStats__;
      if (!s) return null;
      return { gaps: s.gaps, reattaches: s.reattaches };
    }
    function wsGapStatsDelta(before, after) {
      if (!before || !after) return null;
      return { gaps: after.gaps - before.gaps, reattaches: after.reattaches - before.reattaches };
    }
    var wsGapStatsBefore = wsGapStatsSnapshot();
    var wqStatsBefore = wqStatsSnapshot();
    var paintStatsBefore = paintStatsSnapshot();
    log('M9: all ' + floodIds.length + ' floods started (' + M9_FLOOD_MIB + ' MiB each); measuring until they exit...');

    var allEnded = await waitFor(function () {
      for (var e = 0; e < floodIds.length; e++) if (!paneEnded(floodIds[e])) return false;
      return true;
    }, M9_EXIT_DEADLINE_MS, 250);
    var floodMs = Date.now() - floodStartedAt;
    sampling = false;
    clearInterval(rssTimer);
    var rssEndKib = await invoke('bench_rss');
    var ghosttyPaint = paintStatsDelta(paintStatsBefore, paintStatsSnapshot());
    var writeQueue = wqStatsDelta(wqStatsBefore, wqStatsSnapshot());
    var wsGap = wsGapStatsDelta(wsGapStatsBefore, wsGapStatsSnapshot());

    var rendererProbe = { canvases: 0, ghosttyCanvases: 0, ghosttyCanvasesAllPanes: 0 };
    var probeEl = floodIds.length > 0
      ? document.querySelector('[data-panekey="' + floodIds[0] + '"]')
      : null;
    if (probeEl) {
      rendererProbe.canvases = probeEl.querySelectorAll('canvas').length;
      rendererProbe.ghosttyCanvases =
        probeEl.querySelectorAll('[data-testid="ghostty-canvas"]').length;
    }
    for (var gp = 0; gp < floodIds.length; gp++) {
      var gpEl = document.querySelector('[data-panekey="' + floodIds[gp] + '"]');
      if (gpEl && gpEl.querySelector('[data-testid="ghostty-canvas"]')) {
        rendererProbe.ghosttyCanvasesAllPanes++;
      }
    }

    var sorted = deltas.slice().sort(function (a, b) { return a - b; });
    var dropped = deltas.filter(function (d) { return d > 32; }).length;
    var frame = {
      samples: deltas.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
      droppedOver32Ms: dropped
    };

    log('M9: cleaning up ' + floodIds.length + ' bench panes...');
    for (var c = 0; c < floodIds.length; c++) {
      await invoke('bench_session_kill', { session: Number(floodIds[c]) }).catch(function (err) {
        log('M9: bench_session_kill(' + floodIds[c] + ') failed: ' + err);
      });
    }
    var cleaned = await waitFor(function () {
      return Object.keys(paneKeys()).length <= initialCount;
    }, 10000, 250);
    var renderUnthrottled = await measureRenderCadence(500);

    var result = {
      renderer: 'ghostty',
      rendererProbe: rendererProbe,
      ghosttyPaint: ghosttyPaint,
      writeQueue: writeQueue,
      wsGap: wsGap,
      paneCount: floodIds.length,
      preExistingPanes: initialCount,
      floodPerPaneMiB: M9_FLOOD_MIB,
      floodDurationMs: floodMs,
      allFloodsExited: allEnded,
      frame: frame,
      rssMib: {
        start: rssStartKib / 1024,
        peak: rssPeakKib / 1024,
        end: rssEndKib / 1024
      },
      windowVisible: document.visibilityState === 'visible',
      windowFocused: document.hasFocus(),
      renderUnthrottled: renderUnthrottled,
      cleanedUp: cleaned
    };
    var engineAttached = rendererProbe.ghosttyCanvasesAllPanes === floodIds.length;
    var floorApplicable = result.windowVisible && renderUnthrottled.valid && allEnded && engineAttached;
    result.engineAttached = engineAttached;
    result.floor = {
      limitMs: M9_FRAME_P95_FLOOR_MS,
      p95Ms: frame.p95Ms,
      applicable: floorApplicable,
      pass: !floorApplicable || frame.p95Ms <= M9_FRAME_P95_FLOOR_MS
    };
    log('M9: frames p50=' + frame.p50Ms.toFixed(1) + 'ms p95=' + frame.p95Ms.toFixed(1) +
      'ms max=' + frame.maxMs.toFixed(1) + 'ms dropped(>32ms)=' + dropped + '/' + deltas.length +
      '; RSS ' + result.rssMib.start.toFixed(0) + '→' + result.rssMib.peak.toFixed(0) +
      '→' + result.rssMib.end.toFixed(0) + ' MiB' +
      (allEnded ? '' : ' [WARNING: floods did not all exit within ' +
        M9_EXIT_DEADLINE_MS + 'ms]') +
      (ghosttyPaint
        ? '; ghostty parse=' + ghosttyPaint.parseMs + 'ms/' +
          (Math.round(ghosttyPaint.parseBytes / 104857.6) / 10) + 'MiB (' +
          ghosttyPaint.parseMsPerMiB + 'ms/MiB), paint=' + ghosttyPaint.paintMs + 'ms/' +
          ghosttyPaint.paintFrames + 'frames (' + ghosttyPaint.paintMsPerFrame +
          'ms/frame), coalesced=' + ghosttyPaint.coalescedRenders
        : '') +
      (wsGap ? '; ws gaps=' + wsGap.gaps + ' reattaches=' + wsGap.reattaches : '') +
      ' engines=' + rendererProbe.ghosttyCanvasesAllPanes + '/' + floodIds.length +
      '; render ' + renderUnthrottled.hz.toFixed(1) + 'Hz' +
      (result.windowFocused ? '' : ' (unfocused)') +
      (result.windowVisible && renderUnthrottled.valid ? '' : ' [WARNING: window hidden/render throttled -- frame numbers void]') +
      (engineAttached ? '' : ' [WARNING: the engine attached to ' +
        rendererProbe.ghosttyCanvasesAllPanes + ' of ' + floodIds.length +
        ' panes -- those panes had no renderer, frame numbers void]'));
    if (!result.floor.pass) {
      log('M9: FLOOR FAIL -- focused p95 ' + frame.p95Ms.toFixed(1) + 'ms is over the ' +
        M9_FRAME_P95_FLOOR_MS + 'ms regression floor (M9_FRAME_P95_FLOOR_MS, ~2x the ' +
        '2026-08-20 baseline p95). Re-check on an idle machine before believing it.');
    }
    return result;
  }

  var SIZES = [16, 64, 256, 900, 1000, 1023, 1024, 1100, 2048, 4096, 16384, 65536, 262144];

  async function run() {
    var results = { channel: {}, ws: {} };

    await invoke('bench_m10_stamp', { name: 'renderer-harness-eval' }).catch(function () {});

    resultsPath = await invoke('bench_config');
    log('checkpoints and final report will write to ' + resultsPath);

    var buildInfo = await invoke('bench_binary_info');
    results.buildInfo = buildInfo;
    log('build: binaryPath=' + buildInfo.binary_path + ' debug_assertions=' + buildInfo.debug_assertions);
    await checkpoint(results);

    var scenarioSelection = await invoke('bench_scenario_selection');
    var selectedSet = null;
    if (scenarioSelection) {
      selectedSet = {};
      for (var sc = 0; sc < scenarioSelection.length; sc++) selectedSet[scenarioSelection[sc]] = true;
    }
    var RENDERER_SCENARIOS = { M9: 1, M10: 1, M11: 1 };
    function selected(name) {
      if (!selectedSet) return RENDERER_SCENARIOS[name] !== 1;
      return !!selectedSet[name];
    }
    var runChannelSweep = selected('M1') || selected('M2') || selected('M3') || selected('M4');
    var runWsSweep = selected('M5');
    var runM6 = selected('M6') || selected('M7') || selected('M8');
    var runM7 = selected('M7') || selected('M8');
    var runM8 = selected('M8');
    var runM9 = selected('M9');
    var runM10 = selected('M10');
    var runM11 = selected('M11');
    var needSize16384Only = runM6 && !runChannelSweep;
    results.scenarioSelection = scenarioSelection;
    log('scenario selection: ' + (scenarioSelection ? scenarioSelection.join(',') : 'all transport (default --bench)') +
      ' -- channel sweep(M1-M4)=' + runChannelSweep + (needSize16384Only ? ' (size=16384 only, for M6)' : '') +
      ' ws sweep(M5)=' + runWsSweep + ' M6=' + runM6 + ' M7=' + runM7 + ' M8=' + runM8 +
      ' M9=' + runM9 + ' M10=' + runM10 + ' M11=' + runM11);
    if (!runM10 && !runM9 && !runM11) {
      takeOverDom();
    } else if (runChannelSweep || runWsSweep || runM6) {
      log('WARNING: transport scenarios selected alongside a renderer scenario -- the app DOM ' +
        'stays mounted for it, so these transport numbers are NOT comparable to a pure ' +
        'transport run\'s (which measures with the app unmounted).');
    }
    await checkpoint(results);

    if (runM10) {
      log('M10: cold-start phase breakdown (waiting for the boot spinner to tear down)...');
      var BOOT_PHASE_DEADLINE_MS = 60000;
      var spinnerGoneAtEval = noBootSpinner();
      var mountWait = spinnerGoneAtEval
        ? { timedOut: false }
        : await waitForDom(noBootSpinner, BOOT_PHASE_DEADLINE_MS);
      await invoke('bench_m10_stamp', { name: 'renderer-app-mounted' });

      var restoredSessions = await invoke('bench_session_count').catch(function () { return 0; });
      var gridWait = null;
      var typeableWait = null;
      var outputWait = null;
      if (restoredSessions > 0) {
        log('M10: ' + restoredSessions + ' session(s) restoring -- timing grid paint and first typeable pane...');
        gridWait = await waitForDom(anyPanePresent, BOOT_PHASE_DEADLINE_MS);
        await invoke('bench_m10_stamp', { name: 'grid-painted' });
        typeableWait = await waitForDom(focusedPaneTypeable, BOOT_PHASE_DEADLINE_MS);
        await invoke('bench_m10_stamp', { name: 'focused-pane-typeable' });

        outputWait = await waitForDom(function () { return parsedBytes() > 0; },
          BOOT_PHASE_DEADLINE_MS);
        var framesAtFirstBytes = paintedFrames();
        var paintWait = await waitForDom(
          function () { return paintedFrames() > framesAtFirstBytes; },
          BOOT_PHASE_DEADLINE_MS
        );
        outputWait = { timedOut: outputWait.timedOut || paintWait.timedOut };
        await invoke('bench_m10_stamp', { name: 'first-output-painted' });
      } else {
        log('M10: 0 restored sessions -- this is a COLD boot, so there is no ' +
          'grid-painted / focused-pane-typeable stamp to take.');
      }

      var stamps = await invoke('bench_m10_stamps');
      var phases = [];
      for (var pi = 1; pi < stamps.length; pi++) {
        phases.push({
          from: stamps[pi - 1][0],
          to: stamps[pi][0],
          ms: (stamps[pi][1] - stamps[pi - 1][1]) / 1000
        });
      }
      function stampMs(name) {
        for (var si = 0; si < stamps.length; si++) if (stamps[si][0] === name) return stamps[si][1] / 1000;
        return null;
      }
      results.m10 = {
        stampsUs: stamps,
        phases: phases,
        totalMs: stamps.length ? stamps[stamps.length - 1][1] / 1000 : 0,
        spinnerGoneBeforeHarness: spinnerGoneAtEval,
        timedOutWaitingForAppMount: mountWait.timedOut,
        warmRestore: restoredSessions > 0,
        restoredSessions: restoredSessions,
        gridPaintedMs: stampMs('grid-painted'),
        focusedPaneTypeableMs: stampMs('focused-pane-typeable'),
        firstOutputPaintedMs: stampMs('first-output-painted'),
        timedOutWaitingForGrid: gridWait ? gridWait.timedOut : null,
        timedOutWaitingForTypeable: typeableWait ? typeableWait.timedOut : null,
        timedOutWaitingForOutput: outputWait ? outputWait.timedOut : null
      };
      for (var pj = 0; pj < phases.length; pj++) {
        log('M10 phase: ' + phases[pj].from + ' -> ' + phases[pj].to + ' = ' + phases[pj].ms.toFixed(1) + 'ms');
      }
      log('M10 total (main-entry -> ' + (stamps.length ? stamps[stamps.length - 1][0] : '?') + '): ' +
        results.m10.totalMs.toFixed(1) + 'ms' +
        (spinnerGoneAtEval ? ' [app already mounted at harness eval]' : '') +
        (mountWait.timedOut ? ' [TIMED OUT waiting for app mount]' : ''));
      if (results.m10.warmRestore) {
        log('M10 WARM RESTORE of ' + restoredSessions + ' session(s): grid-painted=' +
          results.m10.gridPaintedMs.toFixed(1) + 'ms focused-pane-typeable=' +
          results.m10.focusedPaneTypeableMs.toFixed(1) + 'ms' +
          ' first-output-painted=' + results.m10.firstOutputPaintedMs.toFixed(1) + 'ms' +
          (gridWait.timedOut ? ' [TIMED OUT waiting for grid]' : '') +
          (typeableWait.timedOut ? ' [TIMED OUT waiting for typeable]' : '') +
          (outputWait.timedOut ? ' [TIMED OUT waiting for first output]' : ''));
      }
      await checkpoint(results);
    }

    if (runM11) {
      results.m11 = await m11();
      await checkpoint(results);
    }

    if (runM9) {
      results.m9 = await m9(buildInfo.binary_path);
      await checkpoint(results);
    }

    results.channel.bySize = [];
    if (runChannelSweep) {
      log('Channel side: ' + SIZES.length + ' sizes x (5x2000-count runs + 500x1-count reps)...');
      for (var i = 0; i < SIZES.length; i++) {
        var chStat = await sizeStats('ch', measureChannelBlast, measureChannelBlast, SIZES[i]);
        results.channel.bySize.push(chStat);
        log('checkpoint: channel size=' + SIZES[i] + ' done (' + (i + 1) + '/' + SIZES.length + ')');
        await checkpoint(results);
      }
    } else if (needSize16384Only) {
      log('Channel side: M1-M4 not selected -- measuring only size=16384 (M6\'s blast-rate ' +
        'prerequisite), skipping the other ' + (SIZES.length - 1) + ' sizes and the WS side entirely');
      var chStat16384 = await sizeStats('ch', measureChannelBlast, measureChannelBlast, 16384);
      results.channel.bySize.push(chStat16384);
      await checkpoint(results);
    } else {
      log('Channel side (M1-M4) skipped: not selected');
    }

    results.ws.bySize = [];
    if (runWsSweep) {
      log('starting bench_ws_start...');
      var port = await invoke('bench_ws_start');
      log('WS baseline server on 127.0.0.1:' + port);
      log('WS side: same sweep over the loopback baseline server (M1 bulk-timed renderer-side, ' +
        'M2 precise-timed Rust-side per defect 1)...');
      var ws = await wsOpen(port);
      var wsBulk = function (runId, size, count) { return measureWsBlast(ws, size, count); };
      var wsSingle = function (runId, size, count) { return measureWsBlastPrecise(ws, size, count); };
      for (var j = 0; j < SIZES.length; j++) {
        var wsStat = await sizeStats('ws', wsBulk, wsSingle, SIZES[j]);
        results.ws.bySize.push(wsStat);
        log('checkpoint: ws size=' + SIZES[j] + ' done (' + (j + 1) + '/' + SIZES.length + ')');
        await checkpoint(results);
      }
      ws.close();
    } else {
      log('WS side (M5) skipped: not selected');
    }

    if (runM6) {
      var s16384 = results.channel.bySize.filter(function (s) { return s.size === 16384; })[0];
      if (!s16384) {
        throw new Error('bench harness internal error: M6 selected but no Channel size=16384 ' +
          'measurement is available (scenario selection=' + JSON.stringify(scenarioSelection) + ')');
      }
      log('M6: 5s blast at S=16384...');
      results.m6 = await m6(s16384.t_msg_ns);
      await checkpoint(results);
    } else {
      log('M6 skipped: not selected');
    }

    if (runM7) {
      log('M7: sustained-ceiling search (continuous blast per candidate, matches M6)...');
      results.m7 = await m7(results.m6.achievedMiBps, results);
    } else {
      log('M7 skipped: not selected');
    }

    if (runM8) {
      var ceilingKnown = results.m7.ceilingMiBps !== null;
      var ceiling = ceilingKnown ? results.m7.ceilingMiBps : results.m7.uncappedMiBps;
      log('M8: cross-pane coupling (A blasts at ' + ceiling.toFixed(1) + ' MiB/s, ' +
        (ceilingKnown ? 'M7 ceiling' : 'M7 ceiling not reachable -- falling back to the uncapped rate') + ')...');
      results.m8 = { withA: await m8Pass(true, ceiling) };
      await checkpoint(results);
      results.m8.withoutA = await m8Pass(false, ceiling);
      await checkpoint(results);
      log('M8 with A:    p50=' + (results.m8.withA.p50Ns / 1e6).toFixed(3) + 'ms p99=' + (results.m8.withA.p99Ns / 1e6).toFixed(3) + 'ms');
      log('M8 without A: p50=' + (results.m8.withoutA.p50Ns / 1e6).toFixed(3) + 'ms p99=' + (results.m8.withoutA.p99Ns / 1e6).toFixed(3) + 'ms');
    } else {
      log('M8 skipped: not selected');
    }

    results.meta = {
      sizes: SIZES,
      scenarioSelection: scenarioSelection,
      userAgent: navigator.userAgent,
      finishedAtIso: new Date().toISOString()
    };

    log('writing final results to ' + resultsPath + ' and closing...');
    await invoke('bench_report', { path: resultsPath, json: results });
  }

  run().catch(function (err) {
    log('BENCH FAILED: ' + (err && err.message ? err.message : err));
    invoke('bench_failed', { message: String(err && err.stack ? err.stack : err) });
  });
})();
