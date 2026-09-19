(function () {
  var invoke = window.__TAURI_INTERNALS__.invoke;
  var HOST = 'spike-host';
  var TOP = 150;
  var GUTTER = 8;
  var PANES = [
    { label: 'spike-a', color: '#c04040', text: 'PANE A' },
    { label: 'spike-b', color: '#3a7bd5', text: 'PANE B' }
  ];
  var EXTRA = [
    { label: 'spike-c', color: '#2fa84f', text: 'PANE C' },
    { label: 'spike-d', color: '#d58f2f', text: 'PANE D' },
    { label: 'spike-e', color: '#8a4fd5', text: 'PANE E' },
    { label: 'spike-f', color: '#d54f8a', text: 'PANE F' }
  ];

  var splitX = Math.round(window.innerWidth / 2);
  var mounted = {};
  var extrasVisible = false;
  var overlayOn = false;
  var winW = window.innerWidth;
  var winH = window.innerHeight;

  function refreshMetrics() {
    return invoke('spike_wv_window_metrics').then(function (m) {
      var changed = winW !== m.inner_size[0] || winH !== m.inner_size[1];
      winW = m.inner_size[0];
      winH = m.inner_size[1];
      return changed;
    });
  }

  document.title = 'Houston spike — child webviews';
  document.documentElement.setAttribute('style', 'height:100%');
  document.body.setAttribute(
    'style',
    'margin:0;height:100vh;overflow:hidden;background:#1b1e24;color:#e6e6e6;' +
      'font:13px/1.45 system-ui,sans-serif;box-sizing:border-box;padding:8px 12px;' +
      'display:flex;gap:16px'
  );
  document.body.innerHTML =
    '<div style="flex:0 0 auto;display:flex;flex-direction:column;gap:6px;max-width:660px">' +
      '<strong style="font-size:14px">Child-webview spike — drag the grey divider below this strip</strong>' +
      '<div id="btns" style="display:flex;flex-wrap:wrap;gap:6px"></div>' +
    '</div>' +
    '<pre id="log" style="flex:1 1 auto;margin:0;overflow:auto;background:#0f1114;' +
      'border:1px solid #2b2f36;border-radius:4px;padding:6px 8px;' +
      'font:11px/1.4 ui-monospace,monospace"></pre>';

  var grip = document.createElement('div');
  grip.setAttribute(
    'style',
    'position:fixed;bottom:0;width:' + GUTTER + 'px;height:26px;background:#8b96a4;' +
      'cursor:col-resize;border-radius:3px 3px 0 0;z-index:5'
  );
  grip.title = 'drag me';
  document.body.appendChild(grip);

  var logEl = document.getElementById('log');
  function log(line) {
    logEl.textContent =
      new Date().toISOString().slice(11, 23) + '  ' + line + '\n' +
      logEl.textContent.split('\n').slice(0, 300).join('\n');
  }

  function button(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.setAttribute(
      'style',
      'padding:4px 9px;background:#2b303a;color:#e6e6e6;border:1px solid #444c58;' +
        'border-radius:4px;cursor:pointer;font:12px system-ui,sans-serif'
    );
    b.addEventListener('click', function () {
      Promise.resolve().then(fn).catch(function (err) { log('ERROR ' + label + ': ' + err); });
    });
    document.getElementById('btns').appendChild(b);
    return b;
  }

  function rects() {
    var out = [
      { label: HOST, x: 0, y: 0, width: winW, height: TOP }
    ];
    var bodyH = winH - TOP;
    if (mounted['spike-a']) {
      out.push({ label: 'spike-a', x: 0, y: TOP, width: Math.max(1, splitX), height: bodyH });
    }
    if (mounted['spike-b']) {
      out.push({
        label: 'spike-b', x: splitX + GUTTER, y: TOP,
        width: Math.max(1, winW - splitX - GUTTER), height: bodyH
      });
    }
    if (extrasVisible) {
      EXTRA.forEach(function (spec, i) {
        if (!mounted[spec.label]) return;
        out.push({
          label: spec.label,
          x: 30 + (i % 2) * 320,
          y: TOP + 30 + Math.floor(i / 2) * 210,
          width: 300, height: 190
        });
      });
    }
    if (overlayOn && mounted['spike-f']) {
      out.push({ label: 'spike-f', x: 90, y: TOP + 70, width: 340, height: 240 });
    }
    return out;
  }

  function apply(quiet) {
    grip.style.left = splitX + 'px';
    return invoke('spike_wv_gtk_layout', { rects: rects(), adoptHost: true })
      .then(function (report) {
        if (!quiet) {
          if (report.notes.length) log('notes: ' + report.notes.join(' | '));
          log('layout: ' + report.allocations.map(function (a) {
            return a[0] + '@' + a[1] + ',' + a[2] + ' ' + a[3] + 'x' + a[4];
          }).join('  '));
        }
        return report;
      });
  }

  function mount(spec) {
    if (mounted[spec.label]) return Promise.resolve();
    return invoke('spike_wv_mount', {
      spec: {
        label: spec.label, color: spec.color, text: spec.text,
        x: 0, y: 0, width: 400, height: 300
      }
    }).then(function () {
      mounted[spec.label] = true;
      log('mounted ' + spec.label);
    });
  }

  var dragging = false;
  var moves = 0;
  var dragStart = 0;

  function beginDrag(ev) {
    dragging = true;
    moves = 0;
    dragStart = performance.now();
    if (grip.setPointerCapture) grip.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }
  grip.addEventListener('pointerdown', beginDrag);
  window.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    moves++;
    splitX = Math.max(60, Math.min(winW - GUTTER - 60, Math.round(ev.clientX)));
    apply(true);
  });
  window.addEventListener('pointerup', function () {
    if (!dragging) return;
    dragging = false;
    var ms = performance.now() - dragStart;
    log('drag: ' + moves + ' pointermove events over ' + Math.round(ms) + ' ms (' +
      (ms > 0 ? Math.round(moves / (ms / 1000)) : 0) + '/s), splitX=' + splitX);
    apply();
  });
  window.addEventListener('resize', function () {
    refreshMetrics().then(function (changed) {
      if (!changed) return null;
      splitX = Math.min(splitX, winW - GUTTER - 60);
      return apply(true);
    });
  });

  button('Tauri set_bounds (expect: no-op)', function () {
    return invoke('spike_wv_set_bounds', {
      label: 'spike-a', x: 400, y: 400, width: 300, height: 200
    }).then(function (geometry) {
      log('set_bounds commanded (400,400) 300x200 -> reported ' + JSON.stringify(geometry) +
        ' — and nothing moved on screen. This is the Linux no-op.');
    });
  });

  button('Mount 4 extras (overlapping the panes)', function () {
    var chain = Promise.resolve();
    EXTRA.forEach(function (spec) { chain = chain.then(function () { return mount(spec); }); });
    return chain.then(function () {
      extrasVisible = true;
      return settle();
    }).then(function () {
      return invoke('spike_wv_webkit_processes');
    }).then(function (procs) {
      log('WebKit processes: ' + procs.length + ', total RSS ' +
        procs.reduce(function (a, p) { return a + p.rss_kib; }, 0) + ' KiB');
    });
  });

  button('Hide extras', function () {
    extrasVisible = false;
    overlayOn = false;
    var chain = Promise.resolve();
    EXTRA.forEach(function (spec) {
      chain = chain.then(function () {
        if (!mounted[spec.label]) return null;
        return invoke('spike_wv_destroy', { label: spec.label })
          .then(function () { mounted[spec.label] = false; });
      });
    });
    return chain.then(function () { return apply(); });
  });

  button('Toggle child-over-child overlay', function () {
    return mount(EXTRA[3]).then(function () {
      extrasVisible = true;
      overlayOn = !overlayOn;
      log('overlay ' + (overlayOn ? 'ON' : 'OFF') + ' — PANE F over PANE A');
      return settle();
    });
  });

  button('Host HTML overlay (expect: cannot cross the strip)', function () {
    var old = document.getElementById('overlay');
    if (old) { old.remove(); log('host overlay removed'); return; }
    var o = document.createElement('div');
    o.id = 'overlay';
    o.setAttribute(
      'style',
      'position:fixed;left:60px;top:40px;width:420px;height:600px;z-index:2147483647;' +
        'background:#fffb00;color:#000;border:4px solid #000;border-radius:8px;padding:14px;' +
        'font:700 18px/1.3 system-ui,sans-serif'
    );
    o.textContent =
      'HOST HTML at z-index 2147483647, 600px tall. The host webview is only ' + TOP +
      'px tall, so this is clipped at the strip edge — host HTML cannot reach over a pane.';
    document.body.appendChild(o);
    log('host overlay added — it stops at the strip edge, it does not cover the panes');
  });

  button('Hide pane B 2s (timer probe)', function () {
    return invoke('spike_wv_read_tick', { label: 'spike-b' }).then(function (before) {
      return invoke('spike_wv_set_visible', { label: 'spike-b', visible: false })
        .then(function () { return new Promise(function (r) { setTimeout(r, 2000); }); })
        .then(function () { return invoke('spike_wv_read_tick', { label: 'spike-b' }); })
        .then(function (during) {
          return invoke('spike_wv_set_visible', { label: 'spike-b', visible: true })
            .then(function () { return apply(true); })
            .then(function () {
              log('hidden 2000 ms: tick ' + before + ' -> ' + during + ' (delta ' +
                (during - before) + '; ~40 if timers ran at full speed)');
            });
        });
    });
  });

  var keys = 0;
  window.addEventListener('keydown', function (ev) {
    keys++;
    log('HOST keydown #' + keys + ': ' + ev.key);
  });

  button('Focus pane A, then type', function () {
    return invoke('spike_wv_focus', { label: 'spike-a' }).then(function () {
      log('focus -> pane A. Now press keys: do HOST keydown lines still appear?');
    });
  });
  button('Focus back to host', function () {
    return invoke('spike_wv_focus', { label: null }).then(function () {
      log('focus -> host strip');
    });
  });

  button('Scripted drag (120 GTK moves)', function () {
    var t0 = performance.now();
    var chain = Promise.resolve();
    for (var i = 0; i < 120; i++) {
      (function (step) {
        chain = chain.then(function () {
          splitX = 80 + Math.round((winW - 200) * (step / 119));
          return apply(true);
        });
      })(i);
    }
    return chain.then(function () {
      log('scripted drag: 120 GTK layout round trips in ' +
        Math.round(performance.now() - t0) + ' ms');
      return apply();
    });
  });

  button('Window metrics', function () {
    return invoke('spike_wv_window_metrics').then(function (m) {
      log('window ' + JSON.stringify(m) + ' | host webview reports ' +
        window.innerWidth + 'x' + window.innerHeight + ' dpr ' + window.devicePixelRatio);
    });
  });

  button('Destroy ALL children', function () {
    return invoke('spike_wv_labels').then(function (labels) {
      var chain = Promise.resolve();
      labels.filter(function (l) { return l !== 'main'; }).forEach(function (l) {
        chain = chain.then(function () {
          return invoke('spike_wv_destroy', { label: l }).then(function () {
            mounted[l] = false;
            log('destroyed ' + l);
          });
        });
      });
      return chain;
    });
  });

  function settle() {
    return apply(true)
      .then(function () { return new Promise(function (r) { setTimeout(r, 120); }); })
      .then(function () { return apply(); });
  }

  refreshMetrics()
    .then(function () { splitX = Math.round(winW / 2); return mount(PANES[0]); })
    .then(function () { return mount(PANES[1]); })
    .then(settle)
    .then(function () {
      log('window client area ' + winW + 'x' + winH +
        ' (window.innerHeight now reports ' + window.innerHeight + ' — the strip)');
      log('ready — drag the grey grip at the bottom-left of this strip.');
      log('close the window normally (title bar) when done.');
    })
    .catch(function (err) {
      log('MOUNT/LAYOUT FAILED: ' + err);
    });

  grip.style.left = splitX + 'px';
})();
