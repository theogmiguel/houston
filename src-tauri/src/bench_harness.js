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

  // Flood sizes straddle the reveal paths: 1 MiB fits the 2 MiB attach replay, 3 MiB
  // needs the daemon's 4 MiB ring, 8 MiB overflows it and falls back to a snapshot.
  var M12_FLOOD_MIB = [1, 3, 8];
  var M12_PANE_COUNT = 12;
  var M12_FILL = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
  var M12_FLOOD_DEADLINE_MS = 180000;
  var M12_REVEAL_DEADLINE_MS = 30000;
  // Above HIBERNATE_DEBOUNCE_MS (200) so a hibernating pane has detached before output starts.
  var M12_HIDE_SETTLE_MS = 600;

  function probes() {
    return globalThis.__trBenchProbes__;
  }

  function toggleExpand() {
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    return sleep(100).then(function () { pressKey('z'); });
  }

  function m12LineBytes(tag) {
    // SGR open (5) + tag + space + 8 digits + SGR reset (4) + space + fill + CRLF.
    return 5 + tag.length + 1 + 8 + 4 + 1 + M12_FILL.length + 2;
  }

  // Ends in a foreground sleep so no prompt pushes the end marker off a short pane; the
  // next round sends Ctrl-C first to end it.
  function m12FloodCommand(tag, lines, doneFile) {
    return "awk 'BEGIN{for(i=1;i<=" + lines + ";i++)printf \"\\033[3%dm" + tag +
      " %08d\\033[0m " + M12_FILL + "\\n\", i%7+1, i}'; printf '%s-%s\\n' " + tag +
      ' END; touch ' + doneFile + '; sleep 86400\n';
  }

  function m12CheckContent(text, tag, lines) {
    var expectedRest = ' ' + M12_FILL;
    var seen = 0, gaps = 0, corrupt = 0, prev = null, last = null, firstGap = null;
    var rows = text.split('\n');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i].replace(/\s+$/, '');
      if (row.indexOf(tag + ' ') !== 0) continue;
      var num = Number(row.slice(tag.length + 1, tag.length + 9));
      if (!Number.isInteger(num) || row.slice(tag.length + 9) !== expectedRest) {
        corrupt++;
        continue;
      }
      if (prev !== null && num !== prev + 1) {
        gaps++;
        if (firstGap === null) firstGap = { after: prev, next: num };
      }
      prev = num;
      last = num;
      seen++;
    }
    return {
      retainedLines: seen,
      lastLine: last,
      complete: last === lines,
      gaps: gaps,
      firstGap: firstGap,
      corrupt: corrupt,
      endMarker: text.indexOf(tag + '-END') !== -1
    };
  }

  async function m12Round(mib, ids) {
    var tag = 'M12S' + mib + 'X' + Math.floor(Math.random() * 1e6);
    var lines = Math.floor((mib * 1048576) / m12LineBytes(tag));
    var doneDir = '${TMPDIR:-/tmp}/houston-' + tag;
    var map = probes();

    await toggleExpand();
    await sleep(M12_HIDE_SETTLE_MS);
    // The shortcut expands the active pane, so read which one stayed visible.
    var visibleIds = ids.filter(function (id) {
      var el = document.querySelector('[data-panekey="' + id + '"]');
      return el && getComputedStyle(el).visibility !== 'hidden';
    });
    if (visibleIds.length !== 1) {
      throw new Error('M12: after the expand shortcut ' + visibleIds.length + ' of ' + ids.length +
        ' panes are visible (' + visibleIds.join(',') + '); expected exactly 1');
    }
    var expandedId = visibleIds[0];
    var hiddenIds = ids.filter(function (id) { return id !== expandedId; });
    var detached = 0;
    for (var h = 0; h < hiddenIds.length; h++) {
      var hp = map.get(Number(hiddenIds[h]));
      if (hp && !hp.attached()) detached++;
    }

    var waiter = 'd=' + doneDir + '; mkdir -p "$d"; while [ "$(ls "$d" | wc -l)" -lt ' +
      hiddenIds.length + " ]; do sleep 0.1; done; printf '%s-%s\\n' " + tag + ' ALLDONE\n';
    await invoke('bench_stdin', { session: Number(expandedId), text: waiter });
    await sleep(300);

    for (var k = 0; k < hiddenIds.length; k++) {
      await invoke('bench_stdin', { session: Number(hiddenIds[k]), text: '\x03' });
    }
    // Shells may discard typeahead that arrives while they handle SIGINT.
    await sleep(500);

    var stats0 = globalThis.__trGhosttyPaintStats__;
    var parse0 = { ms: stats0.parseMs, bytes: stats0.parseBytes };
    var floodFrames = startRaf();
    var floodStartedAt = performance.now();
    for (var f = 0; f < hiddenIds.length; f++) {
      await invoke('bench_stdin', {
        session: Number(hiddenIds[f]),
        text: m12FloodCommand(tag, lines, doneDir + '/' + hiddenIds[f])
      });
    }
    var expandedProbe = map.get(Number(expandedId));
    var floodDone = await waitFor(function () {
      return expandedProbe && expandedProbe.screenText().indexOf(tag + '-ALLDONE') !== -1;
    }, M12_FLOOD_DEADLINE_MS, 100);
    var floodMs = performance.now() - floodStartedAt;
    floodFrames.stop();
    var stats1 = globalThis.__trGhosttyPaintStats__;
    var hiddenParse = {
      ms: Math.round((stats1.parseMs - parse0.ms) * 10) / 10,
      mib: Math.round(((stats1.parseBytes - parse0.bytes) / 1048576) * 100) / 100
    };

    var panes = hiddenIds.map(function (id) {
      var p = map.get(Number(id));
      return {
        id: id, probe: p, paints0: p ? p.paintCount() : 0, lastPaints: p ? p.paintCount() : 0,
        blank: 0, intermediate: 0, skeleton: false, settledMs: null, earlyPaints: []
      };
    });
    var revealDeltas = [];
    var sampling = true;
    var lastTs = null;
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(100);
    var t0 = performance.now();
    function sample(ts) {
      if (lastTs !== null) revealDeltas.push(ts - lastTs);
      lastTs = ts;
      for (var i = 0; i < panes.length; i++) {
        var pane = panes[i];
        if (!pane.probe || pane.settledMs !== null) continue;
        if (!pane.probe.synced()) pane.skeleton = true;
        var paints = pane.probe.paintCount();
        if (paints === pane.lastPaints) continue;
        pane.lastPaints = paints;
        var screen = pane.probe.screenText();
        if (pane.earlyPaints.length < 4) {
          pane.earlyPaints.push({
            ms: Math.round(performance.now() - t0), synced: pane.probe.synced(),
            attached: pane.probe.attached(), size: pane.probe.size(), head: screen.trim().slice(0, 60)
          });
        }
        if (screen.indexOf(tag + '-END') !== -1) {
          pane.settledMs = performance.now() - t0;
        } else if (screen.trim() === '') {
          pane.blank++;
        } else {
          pane.intermediate++;
        }
      }
      if (sampling) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
    pressKey('z');
    var allSettled = await waitFor(function () {
      return panes.every(function (p) { return p.settledMs !== null; });
    }, M12_REVEAL_DEADLINE_MS, 50);
    sampling = false;
    await sleep(500);

    var perPane = panes.map(function (pane) {
      var screenNow = pane.probe ? pane.probe.screenText() : '';
      var fullNow = pane.probe ? pane.probe.fullText() : '';
      var content = pane.probe ? m12CheckContent(fullNow, tag, lines) : null;
      return {
        id: pane.id,
        size: pane.probe ? pane.probe.size() : null,
        fullTextLength: fullNow.length,
        fullTail: fullNow.replace(/\s+$/, '').slice(-160),
        syncedAtEnd: pane.probe ? pane.probe.synced() : null,
        attachedAtEnd: pane.probe ? pane.probe.attached() : null,
        screenTail: screenNow.replace(/\s+$/, '').slice(-240),
        settledMs: pane.settledMs === null ? null : Math.round(pane.settledMs),
        paints: (pane.probe ? pane.probe.paintCount() : 0) - pane.paints0,
        blankPaints: pane.blank,
        earlyPaints: pane.earlyPaints,
        intermediatePaints: pane.intermediate,
        skeletonShown: pane.skeleton,
        content: content
      };
    });
    var settled = perPane.map(function (p) { return p.settledMs; })
      .filter(function (v) { return v !== null; })
      .sort(function (a, b) { return a - b; });
    var revealSorted = revealDeltas.slice().sort(function (a, b) { return a - b; });
    var floodSorted = floodFrames.samples.slice().sort(function (a, b) { return a - b; });
    var round = {
      floodMiB: mib,
      linesPerPane: lines,
      hiddenPanes: hiddenIds.length,
      detachedWhileHidden: detached,
      floodDone: floodDone,
      floodMs: Math.round(floodMs),
      hiddenParse: hiddenParse,
      floodFrame: {
        samples: floodSorted.length,
        p95Ms: percentile(floodSorted, 95),
        maxMs: floodSorted.length ? floodSorted[floodSorted.length - 1] : 0
      },
      allSettled: allSettled,
      reveal: {
        p50Ms: percentile(settled, 50),
        maxMs: settled.length ? settled[settled.length - 1] : null,
        frameP95Ms: percentile(revealSorted, 95),
        frameMaxMs: revealSorted.length ? revealSorted[revealSorted.length - 1] : 0,
        blankPaints: perPane.reduce(function (n, p) { return n + p.blankPaints; }, 0),
        intermediatePaints: perPane.reduce(function (n, p) { return n + p.intermediatePaints; }, 0),
        panesWithSkeleton: perPane.filter(function (p) { return p.skeletonShown; }).length
      },
      content: {
        panesComplete: perPane.filter(function (p) { return p.content && p.content.complete; }).length,
        minRetainedLines: Math.min.apply(null, perPane.map(function (p) { return p.content ? p.content.retainedLines : 0; })),
        gaps: perPane.reduce(function (n, p) { return n + (p.content ? p.content.gaps : 0); }, 0),
        corrupt: perPane.reduce(function (n, p) { return n + (p.content ? p.content.corrupt : 0); }, 0)
      },
      perPane: perPane
    };
    log('M12 ' + mib + ' MiB x ' + hiddenIds.length + ' hidden: flood ' + round.floodMs + 'ms, hidden parse ' +
      hiddenParse.mib + ' MiB/' + hiddenParse.ms + 'ms, detached ' + detached + '/' + hiddenIds.length +
      '; reveal p50=' + round.reveal.p50Ms + 'ms max=' + round.reveal.maxMs + 'ms frame p95=' +
      round.reveal.frameP95Ms.toFixed(1) + 'ms, paints blank=' + round.reveal.blankPaints +
      ' intermediate=' + round.reveal.intermediatePaints + ' skeleton=' + round.reveal.panesWithSkeleton +
      '; content complete=' + round.content.panesComplete + '/' + hiddenIds.length + ' minRetained=' +
      round.content.minRetainedLines + '/' + lines + ' gaps=' + round.content.gaps + ' corrupt=' +
      round.content.corrupt + (allSettled ? '' : ' [WARNING: not every pane settled within ' +
      M12_REVEAL_DEADLINE_MS + 'ms]') + (floodDone ? '' : ' [WARNING: floods did not finish]'));
    return round;
  }

  async function m12() {
    globalThis.__trBenchProbes__ = new Map();
    var policy = globalThis.__TR_HIDDEN_PANE_POLICY__ || 'attached';
    log('M12 (' + policy + '): waiting for the real grid...');
    var initialCount = await waitForGrid('M12');
    var ids = await spawnShellPanes(M12_PANE_COUNT, 'M12');
    // Spawning splits the active pane, leaving the last ones a few columns wide.
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(100);
    pressKey('y');
    await sleep(3000);
    var consoleLines = [];
    ['warn', 'error'].forEach(function (level) {
      var original = console[level];
      console[level] = function () {
        var line = level + ': ' + Array.prototype.map.call(arguments, String).join(' ');
        if (consoleLines.length < 200) consoleLines.push(line.slice(0, 400));
        return original.apply(console, arguments);
      };
    });
    var missing = ids.filter(function (id) { return !probes().has(Number(id)); });
    if (missing.length) {
      throw new Error('M12: no bench probe registered for session(s) ' + missing.join(',') +
        ' -- the renderer predates registerBenchProbe or the panes mounted before the harness ran');
    }
    var rounds = [];
    for (var r = 0; r < M12_FLOOD_MIB.length; r++) {
      rounds.push(await m12Round(M12_FLOOD_MIB[r], ids));
    }
    for (var c = 0; c < ids.length; c++) {
      await invoke('bench_session_kill', { session: Number(ids[c]) }).catch(function (err) {
        log('M12: bench_session_kill(' + ids[c] + ') failed: ' + err);
      });
    }
    var renderUnthrottled = await measureRenderCadence(500);
    return {
      policy: policy,
      preExistingPanes: initialCount,
      windowVisible: document.visibilityState === 'visible',
      windowFocused: document.hasFocus(),
      renderUnthrottled: renderUnthrottled,
      paneSizes: ids.map(function (id) { return probes().get(Number(id)).size(); }),
      console: consoleLines,
      rounds: rounds
    };
  }

  var M13_PANE_COUNT = 12;
  var M13_PHASE_MS = 20000;
  // One typed token every 200 ms gives ~100 echo samples per phase.
  var M13_INPUT_EVERY_MS = 200;
  var M13_ECHO_DEADLINE_MS = 5000;
  // 20 lines/s of ~90 bytes per pane, the order of a busy agent's output.
  var M13_STREAM_CMD = "python3 -uc 'import time,itertools;[(print(\"\\x1b[3%dmSTREAM %08d\\x1b[0m " +
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do\" % (i%7+1, i)), " +
    "time.sleep(0.05)) for i in itertools.count()]'\n";

  // Types unique tokens into a pane running `cat` and times each until it is painted.
  function m13InputProbe(probe) {
    var samples = [];
    var timeouts = 0;
    var seq = 0;
    var running = true;
    var pending = [];
    var sentOnLine = 0;
    function check() {
      if (pending.length) {
        var screen = probe.screenText();
        var now = performance.now();
        pending = pending.filter(function (p) {
          if (screen.indexOf(p.token) !== -1) { samples.push(now - p.at); return false; }
          if (now - p.at > M13_ECHO_DEADLINE_MS) { timeouts++; return false; }
          return true;
        });
      }
      if (running || pending.length) requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
    var timer = setInterval(function () {
      seq++;
      var token = 'q' + seq + ';';
      if (sentOnLine >= 8) { probe.sendInput('\r'); sentOnLine = 0; }
      pending.push({ token: token, at: performance.now() });
      probe.sendInput(token);
      sentOnLine++;
    }, M13_INPUT_EVERY_MS);
    return {
      stop: function () {
        running = false;
        clearInterval(timer);
        return sleep(M13_ECHO_DEADLINE_MS).then(function () {
          var sorted = samples.slice().sort(function (a, b) { return a - b; });
          return {
            sent: seq,
            echoed: sorted.length,
            timeouts: timeouts,
            p50Ms: Math.round(percentile(sorted, 50)),
            p95Ms: Math.round(percentile(sorted, 95)),
            p99Ms: Math.round(percentile(sorted, 99)),
            maxMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : null
          };
        });
      }
    };
  }

  async function m13Phase(name, inputProbe) {
    // Typing happens in a focused pane, which is the one pane painted every frame.
    inputProbe.focus();
    await sleep(100);
    var inputFocused = inputProbe.hasFocus();
    var stats0 = globalThis.__trGhosttyPaintStats__;
    var before = { parseMs: stats0.parseMs, parseBytes: stats0.parseBytes, paintMs: stats0.paintMs, paintFrames: stats0.paintFrames };
    var frames = startRaf();
    var input = m13InputProbe(inputProbe);
    var startEpochMs = Date.now();
    log('M13 phase ' + name + ' start');
    await sleep(M13_PHASE_MS);
    var endEpochMs = Date.now();
    frames.stop();
    var stats1 = globalThis.__trGhosttyPaintStats__;
    var echo = await input.stop();
    var sorted = frames.samples.slice().sort(function (a, b) { return a - b; });
    var phase = {
      name: name,
      startEpochMs: startEpochMs,
      endEpochMs: endEpochMs,
      parseMs: Math.round((stats1.parseMs - before.parseMs) * 10) / 10,
      parseMiB: Math.round(((stats1.parseBytes - before.parseBytes) / 1048576) * 100) / 100,
      paintMs: Math.round((stats1.paintMs - before.paintMs) * 10) / 10,
      paintFrames: stats1.paintFrames - before.paintFrames,
      frame: {
        samples: sorted.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0
      },
      echo: echo,
      inputFocused: inputFocused
    };
    log('M13 phase ' + name + (inputFocused ? '' : ' [input pane NOT focused]') + ': parse ' + phase.parseMiB + ' MiB/' + phase.parseMs + 'ms, paint ' +
      phase.paintFrames + ' frames/' + phase.paintMs + 'ms, frame p95=' + phase.frame.p95Ms.toFixed(1) +
      'ms max=' + phase.frame.maxMs.toFixed(1) + 'ms; echo p50=' + echo.p50Ms + 'ms p95=' + echo.p95Ms +
      'ms p99=' + echo.p99Ms + 'ms max=' + echo.maxMs + 'ms (' + echo.echoed + '/' + echo.sent +
      ', timeouts ' + echo.timeouts + ')');
    return phase;
  }

  async function m13() {
    globalThis.__trBenchProbes__ = new Map();
    var policy = globalThis.__TR_HIDDEN_PANE_POLICY__ || 'attached';
    log('M13 (' + policy + '): waiting for the real grid...');
    var initialCount = await waitForGrid('M13');
    var ids = await spawnShellPanes(M13_PANE_COUNT, 'M13');
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(100);
    pressKey('y');
    await sleep(3000);
    var map = probes();

    // The expand shortcut targets the active pane; that pane runs `cat` for the echo probe.
    await toggleExpand();
    await sleep(M12_HIDE_SETTLE_MS);
    var visibleIds = ids.filter(function (id) {
      var el = document.querySelector('[data-panekey="' + id + '"]');
      return el && getComputedStyle(el).visibility !== 'hidden';
    });
    if (visibleIds.length !== 1) {
      throw new Error('M13: after the expand shortcut ' + visibleIds.length + ' of ' + ids.length +
        ' panes are visible; expected exactly 1');
    }
    var inputId = visibleIds[0];
    await toggleExpand();
    await sleep(1000);
    var inputProbe = map.get(Number(inputId));
    var streamIds = ids.filter(function (id) { return id !== inputId; });
    await invoke('bench_stdin', { session: Number(inputId), text: 'cat\n' });
    await sleep(1000);

    var phases = [];
    phases.push(await m13Phase('idle', inputProbe));
    for (var s = 0; s < streamIds.length; s++) {
      await invoke('bench_stdin', { session: Number(streamIds[s]), text: M13_STREAM_CMD });
    }
    await sleep(2000);
    phases.push(await m13Phase('stream-visible', inputProbe));
    await toggleExpand();
    await sleep(M12_HIDE_SETTLE_MS);
    var inputEl = document.querySelector('[data-panekey="' + inputId + '"]');
    if (!inputEl || getComputedStyle(inputEl).visibility === 'hidden') {
      throw new Error('M13: the expand shortcut no longer targets the input pane ' + inputId);
    }
    var detached = streamIds.filter(function (id) { return !map.get(Number(id)).attached(); }).length;
    var phase = await m13Phase('stream-expanded', inputProbe);
    phase.detachedStreams = detached;
    phases.push(phase);
    await toggleExpand();
    await sleep(2000);
    phases.push(await m13Phase('stream-visible-again', inputProbe));

    for (var c = 0; c < ids.length; c++) {
      await invoke('bench_session_kill', { session: Number(ids[c]) }).catch(function (err) {
        log('M13: bench_session_kill(' + ids[c] + ') failed: ' + err);
      });
    }
    var renderUnthrottled = await measureRenderCadence(500);
    return {
      policy: policy,
      backgroundPaintMs: globalThis.__TR_BACKGROUND_PAINT_MS === undefined ? 'default' : globalThis.__TR_BACKGROUND_PAINT_MS,
      preExistingPanes: initialCount,
      paneCount: ids.length,
      inputPane: inputId,
      windowVisible: document.visibilityState === 'visible',
      windowFocused: document.hasFocus(),
      renderUnthrottled: renderUnthrottled,
      paneSizes: ids.map(function (id) { return map.get(Number(id)).size(); }),
      phases: phases
    };
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
    var RENDERER_SCENARIOS = { M9: 1, M10: 1, M11: 1, M12: 1, M13: 1 };
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
    var runM12 = selected('M12');
    var runM13 = selected('M13');
    var needSize16384Only = runM6 && !runChannelSweep;
    results.scenarioSelection = scenarioSelection;
    log('scenario selection: ' + (scenarioSelection ? scenarioSelection.join(',') : 'all transport (default --bench)') +
      ' -- channel sweep(M1-M4)=' + runChannelSweep + (needSize16384Only ? ' (size=16384 only, for M6)' : '') +
      ' ws sweep(M5)=' + runWsSweep + ' M6=' + runM6 + ' M7=' + runM7 + ' M8=' + runM8 +
      ' M9=' + runM9 + ' M10=' + runM10 + ' M11=' + runM11 + ' M12=' + runM12 + ' M13=' + runM13);
    if (!runM10 && !runM9 && !runM11 && !runM12 && !runM13) {
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

    if (runM12) {
      results.m12 = await m12();
      await checkpoint(results);
    }

    if (runM13) {
      results.m13 = await m13();
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
