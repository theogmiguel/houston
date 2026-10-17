import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(process.env.HOUSTON_PWA_TEST_SOURCE || new URL('../core/houston-core/src/remote/pwa/app.js', import.meta.url), 'utf8');
new vm.Script(source);
// Execute the shipped functions; only browser presentation and network I/O are fixtures.
function production(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `production function ${name}`);
  const end = source.indexOf('\n  }', start) + 4;
  return source.slice(start, end);
}
const functions = ['staleRequest', 'beginRequest', 'resetPaneRequests', 'resetAuthRequests', 'api', 'openPane', 'loadFeed', 'input', 'decide', 'send', 'loadScreen', 'loadSessions', 'loadActivity'];
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const nodes = new Map(), timers = new Map(), requests = [], status = [];
  const noop = () => {};
  let nextTimer = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', style: {}, classList: { add: noop, remove: noop, toggle: noop }, replaceChildren: noop, appendChild: noop });
    return nodes.get(id);
  };
  const S = { pane: null, token: 'test', authGeneration: 0, paneGeneration: 0, requests: {}, httpRequests: new Set(), feedBusy: false, busy: false, reachable: true, last: 0, epoch: null, entries: [], shown: true, activityAt: null, tab: 'conv', timers: {}, view: 'pane', sessions: [], sent: {}, activity: [], activityLast: 0 };
  const ctx = {
    S, Promise, AbortController, FEED_ENTRIES: 256, SCREEN_LINES: 80, SCREEN_MS: 1000, ACTIVITY_ENTRIES: 200, REQUEST_MS: 15000,
    fetch: (path, options) => new Promise(resolve => requests.push({ path, options, resolve })),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    renderFeed: noop, renderCard: noop, renderQuickReplies: noop, renderLateLink: noop, renderChildren: noop, renderBar: noop, renderList: noop, renderTabs: noop, renderMic: noop, cancelDictation: noop, loadMe: () => Promise.resolve(),
    resetPaneView: noop, syncTerminal: noop, loadChanges: noop, setTerminal: noop, renderPaneTabs: noop, renderTermToggle: noop, resetKeys: noop, toggleKeys: noop, grow: noop, show: noop, selectTab: noop, connect: noop, schedulePoll: noop, toBottom: noop, pinned: () => false,
    setReachable: value => { S.reachable = value; }, setDockStatus: value => status.push(value), updateSend: noop, later: noop, fitScreen: noop,
    session: () => ({ status: 'working' }), notice: value => status.push(value), toast: value => status.push(value), pendingFor: () => null,
    location: { hash: '' }, history: { replaceState: noop }, window: { scrollTo: noop }, el: () => node('element'), icon: noop,
    document: { hidden: false, querySelectorAll: () => [], createTextNode: noop }, $: node,
    unpair: () => { ctx.resetAuthRequests(); S.token = null; },
  };
  vm.createContext(ctx);
  const dictationDeadline = source.match(/  var DICTATE_REQUEST_MS =[^\n]+/);
  if (dictationDeadline) vm.runInContext(dictationDeadline[0], ctx);
  vm.runInContext(functions.map(production).join('\n'), ctx);
  ctx.loadSessions = noop;
  return { ctx, S, node, requests, status, timers };
}
const page = seq => ({ epoch: 'same', entries: [{ seq }], last_seq: seq, pending: null });
const reply = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: () => Promise.resolve(data) });

test('A → B → A ignores older feed success, error and busy cleanup even when abort is ignored', async () => {
  for (const fails of [false, true]) {
    const { ctx, S, status } = harness(), requests = [];
    ctx.api = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
    ctx.openPane(1); ctx.openPane(2); ctx.openPane(1);
    requests[2].resolve(page(2)); await flush();
    const newer = ctx.loadFeed();
    assert.equal(S.feedBusy, true);
    if (fails) requests[0].reject(new Error('old failure')); else requests[0].resolve(page(1));
    await flush();
    assert.equal(S.last, 2); assert.equal(S.entries[0].seq, 2);
    assert.equal(S.feedBusy, true, 'old cleanup cannot release the current request');
    assert.deepEqual(status.filter(Boolean), []);
    assert.equal(requests.length, 4, 'older feed cannot cause a reset/refetch');
    requests[1].resolve(page(7)); requests[3].resolve(page(3)); await newer; await flush();
    assert.equal(S.last, 3); assert.equal(S.feedBusy, false);
  }
});

test('navigation aborts real feed requests, while a legitimate epoch reset still refetches', async () => {
  const { ctx, S, requests } = harness();
  ctx.openPane(1); ctx.openPane(2);
  assert.equal(requests[0].options.signal.aborted, true);
  requests[0].resolve(reply(page(99))); requests[1].resolve(reply(page(2))); await flush();
  assert.equal(S.last, 2);
  const feed = ctx.loadFeed(); requests[2].resolve(reply({ ...page(1), epoch: 'restart' })); await flush();
  assert.equal(requests.length, 4);
  requests[3].resolve(reply({ ...page(1), epoch: 'restart' })); await feed;
  assert.equal(S.last, 1); assert.equal(S.epoch, 'restart');
});

test('stale input acknowledgement cannot clear a new A composer or its busy state', async () => {
  const { ctx, S, node, status } = harness(), requests = [];
  ctx.api = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
  ctx.openPane(1); requests[0].resolve(page(1)); await flush();
  node('text').value = 'same instruction'; ctx.send();
  ctx.openPane(2); ctx.openPane(1); requests[3].resolve(page(2)); await flush();
  node('text').value = 'same instruction'; const newer = ctx.input({ text: 'new' }, '');
  const before = status.length;
  requests[1].resolve({}); await flush();
  assert.equal(node('text').value, 'same instruction'); assert.equal(S.busy, true);
  assert.equal(status.length, before);
  requests[2].resolve(page(3)); requests[4].resolve({}); await newer;
  assert.equal(S.busy, false);
});

test('input deadline releases busy state and explains uncertain delivery', async () => {
  const { ctx, S, requests, timers, status } = harness(); S.pane = 1;
  const input = ctx.input({ text: 'hello' }, '');
  const deadline = [...timers.values()].find(t => t.ms === 15000); assert.ok(deadline);
  deadline.fn(); assert.equal(await input, false);
  assert.equal(S.busy, false); assert.equal(requests[0].options.signal.aborted, true);
  assert.match(status.at(-1), /may already have reached/); assert.equal(timers.size, 0);
  requests[0].resolve(reply({})); await flush(); assert.equal(S.busy, false);
});

test('old auth 401 and delayed JSON cannot unpair a new authentication generation', async () => {
  for (const status of [200, 401]) {
    const { ctx, S, requests } = harness();
    const request = ctx.api('GET', '/api/me'); const result = request.catch(e => e);
    let json; requests[0].resolve({ ...reply({}, status), json: () => new Promise(resolve => { json = resolve; }) }); await flush();
    ctx.resetAuthRequests(); S.token = 'other'; ctx.resetAuthRequests(); S.token = 'test';
    json({ reason: 'revoked' }); const error = await result; await flush();
    assert.equal(error.stale, true); assert.equal(S.token, 'test');
    assert.equal(S.httpRequests.size, 0);
  }
});

test('old pairing response cannot restore authentication after pairing was replaced', async () => {
  const { ctx, S, requests } = harness(); S.token = null; S.pendingPair = 'a';
  const pairing = ctx.api('POST', '/api/pair', { code: 'a' }).catch(e => e);
  ctx.resetAuthRequests(); S.pendingPair = 'b'; ctx.resetAuthRequests(); S.pendingPair = 'a';
  requests[0].resolve(reply({ token: 'old-token' }));
  assert.equal((await pairing).stale, true); assert.equal(S.token, null);
});

test('feed deadline releases feedBusy so polling can recover', async () => {
  const { ctx, S, requests, timers } = harness(); S.pane = 1;
  const feed = ctx.loadFeed(); [...timers.values()][0].fn(); await feed;
  assert.equal(S.feedBusy, false); assert.equal(requests[0].options.signal.aborted, true);
  const recovery = ctx.loadFeed(); requests[1].resolve(reply(page(2))); await recovery;
  assert.equal(S.last, 2); assert.equal(S.feedBusy, false);
});

test('stale screen cannot replace a newer A screen or schedule more polling', async () => {
  const { ctx, S, node } = harness(), requests = [];
  ctx.api = () => new Promise(resolve => requests.push(resolve)); S.pane = 1; S.tab = 'term';
  const old = ctx.loadScreen(); ctx.resetPaneRequests(); S.pane = 2; ctx.resetPaneRequests(); S.pane = 1;
  const current = ctx.loadScreen(); requests[1]({ lines: ['new'] }); await flush();
  requests[0]({ lines: ['old'] }); await old; await current;
  assert.equal(node('screen').textContent, 'new');
});

test('a blank or unreadable screen says why instead of showing an empty box', async () => {
  const { ctx, S, node } = harness(), requests = [];
  ctx.api = () => new Promise((resolve, reject) => requests.push({ resolve, reject })); S.pane = 1; S.tab = 'term';
  const blank = ctx.loadScreen(); requests[0].resolve({ lines: ['', '   ', ''], source: 'screen' }); await blank;
  assert.match(node('screen-note').textContent, /no text right now/);
  const failed = ctx.loadScreen(); requests[1].reject(new Error('no pane has id 1')); await failed;
  assert.equal(node('screen-note').textContent, 'Could not read the screen: no pane has id 1');
  const shown = ctx.loadScreen(); requests[2].resolve({ lines: ['$ ls'], source: 'screen' }); await shown;
  assert.equal(node('screen-note').textContent, '');
});

test('stale decision success or failure cannot update another navigation or release its busy state', async () => {
  for (const fails of [false, true]) {
    const { ctx, S, status } = harness(), requests = [];
    ctx.api = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
    ctx.pendingOf = () => ({ entry_seq: 1, seq: 1, epoch: 'same', type: 'permission', decidable: true });
    ctx.cardState = () => null; ctx.refreshAll = () => {};
    S.pane = 1; S.epoch = 'same';
    const old = ctx.decide(1, 1, 'approve', null, 'same');
    assert.equal(requests.length, 1);
    ctx.resetPaneRequests(); S.pane = 2; ctx.resetPaneRequests(); S.pane = 1;
    const newer = ctx.input({ text: 'new' }, ''); const before = status.length;
    if (fails) requests[0].reject(new Error('old decision failed')); else requests[0].resolve({});
    assert.equal(await old, false); assert.equal(S.busy, true); assert.equal(status.length, before);
    assert.deepEqual(S.sent, {});
    requests[1].resolve({}); await newer;
  }
});

test('production pairing handler ignores old success and restores controls after current success', async () => {
  const { ctx, S, node, requests } = harness();
  Object.assign(ctx, { TOKEN_KEY: 'token', store: () => {}, setMark: () => {}, installHelp: () => {}, standalone: () => false, animate: () => {}, loadMe: () => Promise.resolve(), hostName: () => 'test', plural: n => String(n) });
  ctx.document.querySelector = () => ({}); S.me = {}; S.token = null; S.pendingPair = 'a';
  node('pair-form').addEventListener = (_, handler) => { ctx.submitPair = handler; };
  const start = source.indexOf('  $("pair-form").addEventListener("submit",');
  vm.runInContext(source.slice(start, source.indexOf('\n  });', start) + 6), ctx);
  node('device-name').value = 'test phone'; ctx.submitPair({ preventDefault: () => {} });
  ctx.resetAuthRequests(); S.pendingPair = 'b'; ctx.resetAuthRequests(); S.pendingPair = 'a';
  requests[0].resolve(reply({ token: 'old-token' })); await flush(); assert.equal(S.token, null);
  ctx.submitPair({ preventDefault: () => {} }); requests[1].resolve(reply({ token: 'current-token' })); await flush();
  assert.equal(S.token, 'current-token'); assert.equal(node('pair-submit').disabled, false);
  requests[2].resolve(reply({ sessions: [] })); await flush();
});

function pollingHarness(honorAbort) {
  const h = harness(), { ctx, S, timers, requests } = h;
  let now = 0, nextTimer = 0;
  ctx.setTimeout = (fn, ms) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + ms });
    return id;
  };
  ctx.clearTimeout = id => timers.delete(id);
  ctx.fetch = (path, options) => new Promise((resolve, reject) => {
    const request = { path, options, resolve, reject, at: now };
    requests.push(request);
    if (honorAbort) options.signal.addEventListener('abort', () => {
      reject(new Error('transport aborted'));
    }, { once: true });
  });
  const noop = () => {};
  Object.assign(ctx, { notePending: noop, updateTitle: noop, renderWorking: noop });
  S.inboxFeed = {}; S.home = 'inbox'; S.live = false;
  vm.runInContext(source.match(/  var SAFETY_MS =[^\n]+/)[0], ctx);
  vm.runInContext(['later', 'refreshAll', 'schedulePoll', 'loadSessions'].map(production).join('\n'), ctx);
  h.advance = async ms => {
    const end = now + ms;
    await flush();
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
    }
    now = end; await flush();
  };
  h.respondAfter = (request, ms, data) => ctx.setTimeout(() => request.resolve(reply(data)), ms);
  return h;
}

for (const honorAbort of [true, false]) {
  const transport = honorAbort ? 'abort-honoring' : 'abort-ignoring';
  for (const terminal of [false, true]) {
    test(`no SSE: four-second HTTP refreshes recover ${terminal ? 'terminal and answers' : 'list answers'} (${transport})`, async () => {
      const h = pollingHarness(honorAbort), { ctx, S, requests, node } = h;
      S.reachable = false; S.view = terminal ? 'pane' : 'list';
      S.pane = terminal ? 1 : null; S.tab = terminal ? 'term' : 'conv';
      const pending = { epoch: 'same', seq: 1, type: 'permission', decidable: true };
      const snapshot = { sessions: [{ id: 1, state: 'running', status: 'needs-input', pending }] };
      ctx.refreshAll(); ctx.schedulePoll();
      for (const request of [...requests]) h.respondAfter(request, 4000,
        request.path === '/api/sessions' ? snapshot : request.path.includes('/screen?') ? { lines: ['current terminal'] } : page(1));
      await h.advance(4000);
      if (terminal) assert.equal(node('screen').textContent, 'current terminal', 'a healthy screen must survive polling');
      assert.equal(S.reachable, true, 'a healthy snapshot must restore answer availability');
      assert.equal(requests.filter(r => r.path === '/api/sessions').length, 1, 'poll coalesces the session snapshot');
      assert.equal(requests[0].options.signal.aborted, false);
      if (terminal) {
        assert.equal(requests.filter(r => r.path.includes('/screen?')).length, 1);
      }
      ctx.pendingOf = () => S.sessions[0].pending; ctx.cardState = () => null;
      const answer = ctx.decide(1, 1, 'approve', null, 'same');
      const mutation = requests.at(-1);
      assert.match(mutation.path, /\/decide$/);
      mutation.resolve(reply({})); assert.equal(await answer, true);
      await h.advance(4000);
      assert.ok(requests.filter(r => r.path === '/api/sessions').length > 1, 'settled refresh allows later polls');
      if (terminal) assert.ok(requests.filter(r => r.path.includes('/screen?')).length > 1);
      ctx.resetAuthRequests(); await flush();
      assert.equal(S.httpRequests.size, 0);
    });
  }

  test(`coalesced refreshes retain auth/navigation cancellation (${transport})`, async () => {
    const h = pollingHarness(honorAbort), { ctx, S, requests, node } = h;
    S.pane = 1; S.tab = 'term';
    const oldSessions = ctx.loadSessions(), oldScreen = ctx.loadScreen();
    assert.equal(ctx.loadSessions(), oldSessions);
    assert.equal(ctx.loadScreen(), oldScreen);
    ctx.resetPaneRequests(); S.pane = 2; ctx.resetPaneRequests(); S.pane = 1;
    const newScreen = ctx.loadScreen();
    assert.equal(requests[1].options.signal.aborted, true);
    assert.equal(ctx.loadSessions(), oldSessions, 'session snapshots survive pane navigation');
    ctx.resetAuthRequests(); S.token = 'new';
    const newSessions = ctx.loadSessions();
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[2].options.signal.aborted, true);
    requests[3].resolve(reply({ sessions: [{ id: 42 }] })); await newSessions;
    const currentScreen = ctx.loadScreen();
    requests[4].resolve(reply({ lines: ['new screen'] })); await currentScreen;
    requests[0].resolve(reply({ sessions: [{ id: 99 }] }, 401));
    requests[1].resolve(reply({ lines: ['old screen'] }));
    requests[2].resolve(reply({ lines: ['intermediate screen'] }));
    await oldSessions; await oldScreen; await newScreen; await flush();
    assert.equal(S.token, 'new'); assert.equal(S.sessions[0].id, 42);
    assert.equal(node('screen').textContent, 'new screen');
    assert.equal(S.httpRequests.size, 0);
  });

  test(`polling does not extend refresh or mutation deadlines (${transport})`, async () => {
    const h = pollingHarness(honorAbort), { ctx, S, requests, status } = h;
    S.pane = 1; S.tab = 'term';
    ctx.refreshAll(); ctx.schedulePoll();
    const mutation = ctx.input({ text: 'hello' }, '');
    const inputRequest = requests.at(-1);
    await h.advance(14999);
    assert.equal(S.busy, true); assert.equal(inputRequest.options.signal.aborted, false);
    assert.equal(requests.filter(r => r.path === '/api/sessions').length, 1);
    assert.equal(requests.filter(r => r.path.includes('/screen?')).length, 1);
    await h.advance(1);
    assert.equal(await mutation, false); assert.equal(S.busy, false);
    assert.equal(inputRequest.options.signal.aborted, true);
    assert.ok(status.some(s => /may already have reached/.test(s)));
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[2].options.signal.aborted, true);
    await h.advance(2500);
    assert.ok(requests.filter(r => r.path === '/api/sessions').length > 1, 'snapshot recovers after deadline');
    assert.ok(requests.filter(r => r.path.includes('/screen?')).length > 1, 'screen recovers after deadline');
    S.reachable = true;
    ctx.pendingOf = () => ({ epoch: 'same', seq: 1, type: 'permission', decidable: true });
    ctx.cardState = () => null;
    const decision = ctx.decide(1, 1, 'approve', null, 'same');
    const decisionRequest = requests.at(-1);
    await h.advance(14999);
    assert.equal(S.busy, true); assert.equal(decisionRequest.options.signal.aborted, false);
    await h.advance(1);
    assert.equal(await decision, false); assert.equal(S.busy, false);
    assert.equal(decisionRequest.options.signal.aborted, true);
    assert.ok(status.filter(s => /may already have reached/.test(s)).length >= 2);
    ctx.resetAuthRequests(); await flush();
    assert.equal(S.httpRequests.size, 0);
  });
}

function dictationHarness(honorAbort) {
  const h = pollingHarness(honorAbort), { ctx, S } = h;
  S.pane = 1;
  Object.assign(ctx, { Uint8Array, Int16Array, DataView, clearInterval: () => {}, micBlocked: () => null });
  vm.runInContext(source.match(/  var DICTATE_MAX_SECS =[^\n]+/)[0], ctx);
  const deadline = source.match(/  var DICTATE_REQUEST_MS =[^\n]+/);
  if (deadline) vm.runInContext(deadline[0], ctx);
  vm.runInContext(source.match(/  var D =[^\n]+/)[0], ctx);
  vm.runInContext(['releaseMic', 'cancelDictation', 'stopDictation', 'upload'].map(production).join('\n'), ctx);
  h.record = (then = null) => {
    ctx.D.state = 'recording'; ctx.D.pane = S.pane; ctx.D.then = then;
    ctx.D.request = ctx.beginRequest('dictate');
    ctx.D.chunks = [new Int16Array([1, 2])]; ctx.D.samples = 2;
    ctx.D.node = { port: { postMessage: () => {} }, disconnect: () => {} };
  };
  h.upload = (then = null) => { h.record(then); ctx.D.state = 'transcribing'; ctx.upload(); };
  return h;
}

for (const honorAbort of [true, false]) {
  const transport = honorAbort ? 'abort-honoring' : 'abort-ignoring';
  test(`dictation survives 15 seconds and sends a valid late transcript once (${transport})`, async () => {
    const h = dictationHarness(honorAbort), { ctx, requests, node } = h;
    h.upload('send');
    await h.advance(180000);
    assert.equal(requests[0].options.signal.aborted, false);
    assert.equal(ctx.D.state, 'transcribing');
    requests[0].resolve(reply({ text: 'transcript' })); await flush();
    assert.equal(ctx.D.state, 'idle'); assert.equal(node('text').value, 'transcript');
    assert.equal(requests.filter(r => r.path.endsWith('/input')).length, 1);
    requests[1].resolve(reply({})); await flush();
    assert.equal(node('text').value, '');
    await h.advance(10000);
    assert.equal(requests.filter(r => r.path.endsWith('/input')).length, 1);
  });

  test(`dictation deadline is bounded and late success cannot send (${transport})`, async () => {
    const h = dictationHarness(honorAbort), { ctx, requests, node, status } = h;
    h.upload('send'); await h.advance(189999);
    assert.equal(ctx.D.state, 'transcribing');
    await h.advance(1);
    assert.equal(ctx.D.state, 'idle'); assert.equal(requests[0].options.signal.aborted, true);
    assert.match(status.at(-1), /timed out/);
    requests[0].resolve(reply({ text: 'too late' })); await flush();
    assert.equal(node('text').value, ''); assert.equal(requests.length, 1);
  });

  for (const logout of [false, true]) {
    test(`dictation ignores stale success/error/JSON after ${logout ? 'logout' : 'A → B → A'} and keeps newer recorder (${transport})`, async () => {
      for (const outcome of ['success', 'error', 'json']) {
        const h = dictationHarness(honorAbort), { ctx, S, requests, node, status } = h;
        h.upload('send');
        let json;
        if (outcome === 'json') {
          requests[0].resolve({ ...reply({}), json: () => new Promise(resolve => { json = resolve; }) }); await flush();
        }
        if (logout) { ctx.cancelDictation(); ctx.resetAuthRequests(); S.token = 'new'; }
        else { ctx.openPane(2); ctx.openPane(1); }
        h.record(); node('text').value = 'new composer';
        const before = status.length;
        if (outcome === 'json') json({ text: 'old' });
        else requests[0].resolve(reply(outcome === 'error' ? { error: 'old error' } : { text: 'old' }, outcome === 'error' ? 500 : 200));
        await flush();
        assert.equal(node('text').value, 'new composer'); assert.equal(ctx.D.state, 'recording');
        assert.equal(ctx.D.samples, 2); assert.equal(status.length, before);
        assert.equal(requests.filter(r => r.path.endsWith('/input')).length, 0);
        assert.equal(requests[0].options.signal.aborted, true);
      }
    });
  }
}

test('cancelled flush callback cannot upload or release a newer recorder', async () => {
  const h = dictationHarness(false), { ctx, requests } = h;
  h.record(); ctx.stopDictation('send');
  const oldFinish = ctx.D.flushed;
  ctx.cancelDictation(); h.record();
  oldFinish(); await h.advance(1000);
  assert.equal(requests.length, 0); assert.equal(ctx.D.state, 'recording'); assert.equal(ctx.D.samples, 2);
});

test('insert-and-send retains transcript and visible uncertain delivery without retry', async () => {
  const h = dictationHarness(false), { ctx, requests, node, status } = h;
  h.upload('send'); requests[0].resolve(reply({ text: 'keep this' })); await flush();
  await h.advance(15000);
  assert.equal(node('text').value, 'keep this'); assert.equal(ctx.S.busy, false);
  assert.match(status.at(-1), /may already have reached/);
  requests[1].resolve(reply({})); await flush();
  assert.equal(node('text').value, 'keep this'); assert.equal(requests.length, 2);
});

test('production microphone lifecycle owns its request and ignores queued messages from an older worklet', async () => {
  const h = dictationHarness(false), { ctx, requests, node, status } = h;
  const noop = () => {};
  ctx.window.AudioContext = class {
    audioWorklet = { addModule: () => Promise.resolve() };
    createMediaStreamSource() { return { connect: noop, disconnect: noop }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
  ctx.AudioWorkletNode = class {
    port = { postMessage: noop };
    connect() {}
    disconnect() {}
  };
  ctx.navigator = { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: noop }] }) } };
  ctx.setInterval = () => 1;
  vm.runInContext(['startDictation', 'onPcm', 'micError'].map(production).join('\n'), ctx);
  ctx.startDictation(); await flush();
  assert.equal(ctx.D.state, 'recording');
  assert.equal(ctx.D.request, ctx.S.requests.dictate);
  const oldMessage = ctx.D.node.port.onmessage;
  oldMessage({ data: new Int16Array([7, 8]) }); ctx.stopDictation('send');
  const oldFinish = ctx.D.flushed;
  ctx.cancelDictation(); ctx.startDictation(); await flush();
  const message = ctx.D.node.port.onmessage;
  message({ data: new Int16Array([1, 2]) }); ctx.stopDictation(null);
  oldMessage({ data: new Int16Array([3]) }); oldMessage({ data: { done: true } }); oldFinish();
  assert.equal(requests.length, 0); assert.equal(ctx.D.samples, 2);
  message({ data: { done: true } }); message({ data: { done: true } });
  assert.equal(requests.length, 1);
  assert.deepEqual([...requests[0].options.body], [1, 0, 2, 0]);
  node('text').value = 'existing'; requests[0].resolve(reply({ text: 'transcript' })); await flush();
  assert.equal(ctx.D.state, 'idle'); assert.equal(node('text').value, 'existing transcript');
  assert.match(status.at(-1), /Edit the text/);
  assert.equal(requests.length, 1, 'edit mode never sends automatically');
  await h.advance(1000); assert.equal(requests.length, 1);
});

test('stale upload callbacks cannot reset a newer transcription even if API cancellation is ignored', async () => {
  for (const fails of [false, true]) {
    const h = dictationHarness(false), { ctx, node, status } = h, uploads = [];
    ctx.api = () => new Promise((resolve, reject) => uploads.push({ resolve, reject }));
    h.upload('send'); ctx.cancelDictation(); h.upload(null);
    node('text').value = 'current'; const before = status.length;
    if (fails) uploads[0].reject(new Error('old failure')); else uploads[0].resolve({ text: 'old' });
    await flush();
    assert.equal(ctx.D.state, 'transcribing'); assert.equal(node('text').value, 'current');
    assert.equal(status.length, before); assert.equal(uploads.length, 2);
    uploads[1].resolve({ text: 'new' }); await flush();
    assert.equal(ctx.D.state, 'idle'); assert.equal(node('text').value, 'current new');
  }
});

// A minimal DOM: enough structure to run the shipped feed renderer and read what it produced.
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.dataset = {}; this.style = {}; this.own = ''; this.hiddenFlag = null;
    this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: (name, on) => { if (name === 'hidden') this.hiddenFlag = !!on; } }; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  replaceChildren(...next) { this.children = next; }
  replaceWith(next) { const at = this.parent.children.indexOf(this); if (at >= 0) this.parent.children[at] = next; next.parent = this.parent; }
  set textContent(value) { this.own = String(value); this.children = []; }
  get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
  setAttribute() {}
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
function renderingHarness(entries) {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new FakeNode(id)); return nodes.get(id); };
  const noop = () => {};
  const S = { pane: 1, view: 'pane', sessions: [{ id: 1, state: 'running', status: 'idle', kind: 'opencode' }], entries, epoch: 'e', shown: 0, tailSteps: null, tailNode: null, pending: null, expanded: {}, turns: {}, timers: {} };
  const ctx = {
    S, $, Date, Math, Number, String, Array, document: { hidden: true, createElement: tag => new FakeNode(tag), createElementNS: (_, tag) => new FakeNode(tag), createTextNode: text => { const n = new FakeNode('#text'); n.own = text; return n; } },
    setTimeout: noop, clearTimeout: noop, cardState: () => '', later: noop, markdown: () => new FakeNode('md'),
  };
  vm.createContext(ctx);
  vm.runInContext(source.match(/  var ICONS = \{[\s\S]*?\n  \};/)[0], ctx);
  vm.runInContext(source.match(/  var CONVERSATION =[^\n]+/)[0], ctx);
  vm.runInContext(['el', 'icon', 'button', 'clock', 'duration', 'plural', 'session', 'hasConversation', 'renderFeed', 'renderWorking', 'safeEntry', 'entryNode', 'finishTurn', 'stepGroup', 'stepRow', 'stepWords', 'stepCategory', 'turnSummary', 'permissionWords'].map(production).join('\n'), ctx);
  return { ctx, S, $ };
}

test('an OpenCode feed of only turn_end and status renders a turn row and no blank pane', () => {
  const at = Date.UTC(2026, 9, 16, 22, 45);
  const { ctx, $ } = renderingHarness([{ seq: 1, type: 'turn_end', outcome: 'done', duration_ms: 62000, at }, { seq: 2, type: 'status', status: 'finished', at }]);
  ctx.renderFeed(true);
  const feed = $('feed');
  assert.equal(feed.children.length, 1, 'the compatibility status after a turn summary stays folded into it');
  assert.match(feed.textContent, /Turn finished/);
  assert.match(feed.textContent, /1m 02s/);
  assert.equal($('feed-empty').hiddenFlag, false, 'no messages were reported, so the empty state with View as terminal shows');
});

test('a feed with a reply hides the empty state and keeps the turn row', () => {
  const at = Date.UTC(2026, 9, 16, 22, 45);
  const { ctx, $ } = renderingHarness([{ seq: 1, type: 'reply', text: 'done', at }, { seq: 2, type: 'turn_end', outcome: 'done', duration_ms: 0, at }]);
  ctx.renderFeed(true);
  assert.equal($('feed-empty').hiddenFlag, true);
  assert.match($('feed').textContent, /Turn finished/);
});

function tierHarness(tier) {
  const h = harness(), { ctx, S } = h;
  S.me = tier ? { tier } : {}; S.features = {}; S.tab = 'conv'; S.pane = 7;
  for (const pattern of [/  var TIERS =[^\n]+/, /  var TIER_WHERE =[^\n]+/, /  var COMMANDS = \{[\s\S]*?\n  \};/]) vm.runInContext(source.match(pattern)[0], ctx);
  vm.runInContext(['tier', 'atLeast', 'tierNote', 'missing', 'menuActions', 'menuNote', 'menuNotice', 'lifecycle', 'closePane', 'loadChanges', 'loadPr', 'wantsTerminal', 'hasConversation'].map(production).join('\n'), ctx);
  vm.runInContext(source.match(/  var CONVERSATION =[^\n]+/)[0], ctx);
  Object.assign(ctx, { renderChanges: () => {}, loadSessions: () => {} });
  return h;
}
const ids = actions => actions.map(a => a.id);
const livePane = { id: 7, state: 'running', kind: 'claude', resumable: true };

test('manage-only menu rows exist only for a manage device, and lower tiers get a tier note', () => {
  const manage = ['rename', 'respawn', 'sleep', 'close'];
  for (const [tier, drive, manageRows] of [['observe', false, false], ['drive', true, false], ['manage', true, true], [undefined, true, false]]) {
    const { ctx } = tierHarness(tier), got = ids(ctx.menuActions(livePane, ctx.tier(), false));
    for (const id of manage) assert.equal(got.includes(id), manageRows, `${tier}: ${id}`);
    for (const id of ['interrupt', 'ctrl-c', 'commands', 'keys']) assert.equal(got.includes(id), drive, `${tier}: ${id}`);
    assert.ok(got.includes('terminal') && got.includes('copy'), `${tier}: read-only rows stay`);
    if (tier === 'manage') assert.equal(ctx.tierNote(), '');
    else assert.match(ctx.tierNote(), /paired as (drive|observe).*Settings ▸ Phone & remote access ▸ Paired devices on the computer/);
  }
  const { ctx } = tierHarness('manage');
  assert.ok(ids(ctx.menuActions({ ...livePane, state: 'sleeping' }, 'manage', false)).includes('wake'));
  assert.ok(!ids(ctx.menuActions({ ...livePane, kind: 'custom' }, 'manage', false)).includes('commands'), 'a shell has no slash commands');
});

test('a lifecycle call below the manage tier sends nothing and names the tier and where to change it', async () => {
  const { ctx, status } = tierHarness('drive'), calls = [];
  ctx.api = (...args) => { calls.push(args); return Promise.resolve({}); };
  assert.equal(await ctx.closePane(7), false);
  assert.equal(calls.length, 0);
  assert.match(status.at(-1), /paired as drive: close needs manage.*Paired devices/);
});

test('close sends the pane id as a string in confirm', async () => {
  const { ctx } = tierHarness('manage'), calls = [];
  ctx.api = (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve({}); };
  assert.equal(await ctx.closePane(7), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ method: 'POST', path: '/api/sessions/7/close', body: { confirm: '7' } }]);
});

test('a computer without the changes and PR routes hides them instead of failing', async () => {
  const { ctx, S, status } = tierHarness('drive');
  ctx.api = () => Promise.reject(Object.assign(new Error('Request failed with status 404'), { status: 404 }));
  await ctx.loadChanges(); await flush();
  assert.equal(S.features.changes, false); assert.equal(S.features.pr, false); assert.equal(S.pr, null);
  assert.ok(!S.changesError);
  assert.equal(status.length, 0);
  assert.equal(await ctx.loadChanges(), undefined, 'later loads skip the missing route');
  ctx.api = () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
  const next = tierHarness('drive'); next.ctx.api = ctx.api;
  await next.ctx.loadChanges(); await flush();
  assert.equal(next.S.features.changes, undefined); assert.equal(next.S.changesError, 'boom');
});

test('a pane opens on its screen when it has nothing to read or waits on a generic input card', () => {
  const { ctx } = tierHarness('drive');
  const reply = [{ type: 'reply' }], turnOnly = [{ type: 'turn_end' }, { type: 'status' }];
  assert.equal(ctx.wantsTerminal({ kind: 'custom' }, reply, null), true, 'shell');
  assert.equal(ctx.wantsTerminal({ kind: 'opencode' }, turnOnly, null), true, 'only markers');
  assert.equal(ctx.wantsTerminal({ kind: 'claude' }, [], null), true, 'failed before any hook');
  assert.equal(ctx.wantsTerminal({ kind: 'claude' }, reply, { type: 'input' }), true, 'generic input card');
  assert.equal(ctx.wantsTerminal({ kind: 'claude' }, reply, { type: 'permission' }), false);
  assert.equal(ctx.wantsTerminal({ kind: 'claude' }, reply, null), false);
});

test('a new pane request never carries auto_approve, whatever the form holds', async () => {
  const { ctx, S } = tierHarness('manage'), calls = [];
  vm.runInContext(['spawnPayload', 'submitSpawn'].map(production).join('\n'), ctx);
  Object.assign(ctx, { renderSpawn: () => {}, closeSheet: () => {}, toast: () => {}, openPane: () => {} });
  ctx.api = (method, path, body) => { calls.push({ method, path, body: JSON.parse(JSON.stringify(body)) }); return Promise.resolve({ id: 462 }); };
  S.spawn = { opts: {}, form: {}, busy: false, error: '' };
  const form = { kind: 'claude', workspace: '/w', model: ' opus ', effort: '', profile: 3, worktree: '', prompt: 'hi', auto_approve: true, autoApprove: true, approval: 'auto' };
  assert.equal(await ctx.submitSpawn(form), true);
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, '/api/sessions');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['effort', 'kind', 'model', 'profile', 'prompt', 'workspace', 'worktree']);
  assert.deepEqual(calls[0].body, { kind: 'claude', workspace: '/w', model: 'opus', effort: null, profile: 3, worktree: null, prompt: 'hi' });
});

test('a device below manage cannot start a pane', async () => {
  const { ctx, S } = tierHarness('drive'), calls = [];
  vm.runInContext(['spawnPayload', 'submitSpawn'].map(production).join('\n'), ctx);
  ctx.renderSpawn = () => {}; ctx.api = (...a) => { calls.push(a); return Promise.resolve({}); };
  S.spawn = { opts: {}, form: {}, busy: false, error: '' };
  assert.equal(await ctx.submitSpawn({ kind: 'claude', workspace: '/w' }), false);
  assert.equal(calls.length, 0); assert.match(S.spawn.error, /paired as drive.*needs manage/);
});

test('a computer without the workspace routes hides each section and still shows the rest', async () => {
  const { ctx, S } = tierHarness('drive'), seen = [];
  vm.runInContext(['wsGet', 'loadWorkspace', 'beginRequest'].map(production).join('\n'), ctx);
  vm.runInContext(source.match(/  var WORKSPACE_KEY =[^\n]+/)[0], ctx);
  Object.assign(ctx, { stored: () => null, workspaces: () => [{ name: 'W', path: '/w' }], renderList: () => {}, store: () => {} });
  S.ws = { loaded: false, list: [], path: null, errors: {} }; S.requests = {}; S.view = 'pane';
  ctx.api = (method, path) => { seen.push(path); return /prs|workspaces$/.test(path) ? Promise.reject(Object.assign(new Error('x'), { status: 404 })) : Promise.resolve(/tasks/.test(path) ? [{ id: 1 }] : { today: { cost_usd: 1 }, limits: [] }); };
  await ctx.loadWorkspace(); await flush();
  assert.equal(S.features.workspaces, false); assert.equal(S.features.prs, false);
  assert.equal(S.ws.loaded, true); assert.equal(S.ws.tasks.length, 1); assert.equal(S.ws.usage.today.cost_usd, 1);
  assert.equal(S.ws.path, '/w', 'the workspace list falls back to the panes already known');
});

// A recording stand-in for the DOM helpers: every element keeps its class, text and children.
function fakeDom() {
  const make = (tag, cls, text) => ({ tag, cls: cls || '', text: text == null ? '' : String(text), children: [], dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; }, setAttribute() {} });
  const texts = n => [n.text, ...n.children.map(texts)].filter(Boolean).join(' ');
  const find = (n, label) => [n, ...n.children.flatMap(c => find(c, label))].filter(x => x.text === label);
  return { make, texts, find, el: make, button: (cls, text, onClick) => Object.assign(make('button', cls, text), { onClick }) };
}
function changesHarness(tier, features = {}) {
  const h = tierHarness(tier), dom = fakeDom();
  vm.runInContext(['renderChangeActions', 'changeRoute', 'pushChanges', 'commitChanges', 'checksText', 'subtitleParts', 'contextPercent', 'shortModel', 'kindName'].map(production).join('\n'), h.ctx);
  Object.assign(h.ctx, { el: dom.el, button: dom.button, renderChanges: () => {}, loadChanges: () => {}, kindName: k => k, toast: v => h.status.push(v) });
  Object.assign(h.S, { features, pushArmed: false });
  return { ...h, dom };
}
const dirty = { branch: 'b', upstream: 'origin/b', ahead: 2, behind: 0, files: [{ path: 'a.rs', status: 'M' }] };

test('Commit and Push appear only for a manage device, and only when the routes exist', () => {
  for (const [tier, shown] of [['observe', false], ['drive', false], [undefined, false], ['manage', true]]) {
    const { ctx, dom } = changesHarness(tier), root = dom.make('div');
    ctx.renderChangeActions(root, dirty, dirty.files);
    assert.equal(root.children.length > 0, shown, `${tier}`);
    if (shown) assert.match(dom.texts(root), /Commit….*Push · 2 ahead/);
  }
  const hidden = changesHarness('manage', { commit: false, push: false }), root = hidden.dom.make('div');
  hidden.ctx.renderChangeActions(root, dirty, dirty.files);
  assert.equal(root.children.length, 0, 'both routes 404 → no empty action row');
  const clean = changesHarness('manage'), root2 = clean.dom.make('div');
  clean.ctx.renderChangeActions(root2, { ...dirty, ahead: 0, files: [] }, []);
  assert.equal(root2.children.length, 0, 'nothing to commit and nothing ahead');
});

test('Push asks for an in-page confirmation before sending anything', async () => {
  const { ctx, S, dom } = changesHarness('manage'), calls = [];
  ctx.api = (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve({ ok: true, summary: 'pushed 2 commits' }); };
  const root = dom.make('div');
  ctx.renderChangeActions(root, dirty, dirty.files);
  dom.find(root, 'Push · 2 ahead')[0].onClick();
  assert.equal(S.pushArmed, true); assert.equal(calls.length, 0, 'the first tap only arms');
  const armed = dom.make('div'); ctx.renderChangeActions(armed, dirty, dirty.files);
  assert.match(dom.texts(armed), /Push b to origin\/b\?.*Cancel.*Push now/);
  await ctx.pushChanges(); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].path, '/api/sessions/7/push');
  assert.equal(S.pushArmed, false);
});

test('commit sends the message with null paths by default and the exact list when chosen', async () => {
  const { ctx, status } = changesHarness('manage'), calls = [];
  ctx.api = (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve({ sha: 'abcdef1234567', summary: 's' }); };
  assert.equal(await ctx.commitChanges('fix it', null), true);
  assert.equal(await ctx.commitChanges('fix it', ['a.rs', 'b.rs']), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { method: 'POST', path: '/api/sessions/7/commit', body: { message: 'fix it', paths: null } },
    { method: 'POST', path: '/api/sessions/7/commit', body: { message: 'fix it', paths: ['a.rs', 'b.rs'] } },
  ]);
  assert.equal(status.at(-1), 'Committed abcdef1');
});

test('commit and push failures show the daemon text, and a 404 hides the feature', async () => {
  const { ctx, S, status } = changesHarness('manage');
  ctx.api = () => Promise.reject(Object.assign(new Error('commit message is 0 characters: expected 1 to 500'), { status: 400 }));
  await assert.rejects(ctx.commitChanges('', null), /expected 1 to 500/);
  assert.equal(status.at(-1), 'commit message is 0 characters: expected 1 to 500');
  ctx.api = () => Promise.reject(Object.assign(new Error('push rejected: non-fast-forward'), { status: 409 }));
  assert.equal(await ctx.pushChanges(), false);
  assert.equal(status.at(-1), 'push rejected: non-fast-forward');
  assert.equal(S.features.push, undefined);
  ctx.api = () => Promise.reject(Object.assign(new Error('Request failed with status 404'), { status: 404 }));
  assert.equal(await ctx.pushChanges(), false);
  assert.equal(S.features.push, false);
  await assert.rejects(ctx.commitChanges('x', null), /can't commit from a phone/);
  assert.equal(S.features.commit, false);
});

test('absent fields render nothing: null effort, version, model, context and null PR check counts', () => {
  const { ctx } = changesHarness('manage');
  const bare = ctx.subtitleParts({ kind: 'claude', effort: null, started_at: null, provider_version: null, model: null, context: null });
  assert.deepEqual([...bare.map(p => p.text)], ['claude']);
  const full = ctx.subtitleParts({ kind: 'claude', provider_version: '2.1.302', model: 'claude-opus-5-5', effort: 'high', context: { percent: 41.6 } });
  assert.deepEqual([...full.map(p => p.text)], ['claude 2.1.302', 'opus-5-5', 'high', 'ctx 42%']);
  assert.equal(ctx.checksText({ passed: null, failed: null, pending: null, summary: 'passing' }), 'passing');
  assert.equal(ctx.checksText({ passed: null, failed: null, pending: null }), '');
  assert.equal(ctx.checksText({ passed: 5, failed: 0, pending: 2 }), '5 passed · 2 pending');
  for (const text of [ctx.checksText({ passed: null, failed: null, pending: null, summary: 'x' }), ...full.map(p => p.text)]) assert.ok(!/null|undefined/.test(text));
});

test('usage with no plan windows shows only today’s cost by provider, with no meters', () => {
  const { ctx, S } = changesHarness('manage'), dom = fakeDom();
  vm.runInContext(['renderWorkspace', 'sectionHead', 'meter', 'money'].map(production).join('\n'), ctx);
  vm.runInContext(source.match(/  var USAGE_WARN =[^\n]+/)[0], ctx);
  Object.assign(ctx, { el: dom.el, icon: () => dom.make('svg'), kindName: k => k, safeUrl: () => '', session: () => null, openPane() {}, openWorkspacePicker() {} });
  S.features = { workspaces: false, prs: false, tasks: false };
  const render = usage => { S.ws = { loaded: true, list: [], path: null, errors: {}, usage }; const root = dom.make('div'); ctx.renderWorkspace(root); return root; };
  const root = render({ today: { cost_usd: 7.4, by_provider: [{ kind: 'claude', cost_usd: 5.1 }] }, limits: [] });
  assert.match(dom.texts(root), /Usage today \$7\.40 claude \$5\.10/);
  const meters = n => n.cls.includes('meter') ? 1 : n.children.reduce((a, c) => a + meters(c), 0);
  assert.equal(meters(root), 0);
  const empty = render({ today: { cost_usd: 0, by_provider: [] }, limits: [] });
  assert.match(dom.texts(empty), /No usage today/);
  assert.equal(meters(render({ today: { cost_usd: 1, by_provider: [] }, limits: [{ kind: 'claude', window: '5h', percent: 57 }] })), 1, 'a real window still gets its meter');
});

test('the capped-list header travels with the array', async () => {
  const { ctx, S } = harness();
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, headers: { get: name => name === 'x-houston-truncated' ? '100' : null }, json: () => Promise.resolve([{ id: 1 }]) });
  const list = await ctx.api('GET', '/api/tasks?workspace=/w');
  assert.equal(list.truncated, 100); assert.equal(list.length, 1);
  ctx.fetch = () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve([{ id: 1 }]) });
  assert.equal((await ctx.api('GET', '/api/tasks?workspace=/w')).truncated, undefined);
  assert.ok(S);
});

test('decision cards follow the daemon’s decidable flag, never the provider', () => {
  assert.ok(!/kind\s*[!=]==?\s*["']claude["']|provider\s*[!=]==?\s*["']claude["']/.test(source), 'no provider == claude gate in app.js');
  const { ctx } = changesHarness('manage');
  vm.runInContext(['undecidableNote'].map(production).join('\n'), ctx);
  for (const kind of ['claude', 'codex', 'opencode']) {
    assert.equal(ctx.undecidableNote({ type: 'permission' }, { kind }).includes('tap'), true);
    assert.equal(ctx.undecidableNote({ type: 'input' }, { kind }), 'It did not report what it is asking. Read the terminal and answer with the keys or a message.');
  }
  const lists = vm.runInContext(source.match(/  var COMMANDS = \{[\s\S]*?\n  \};/)[0] + ';COMMANDS', ctx);
  assert.deepEqual(Object.keys(lists).sort(), ['claude', 'codex', 'opencode'], 'only providers with verified commands list any');
});
