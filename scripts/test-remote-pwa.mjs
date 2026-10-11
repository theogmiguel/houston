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
    renderFeed: noop, renderCard: noop, renderQuickReplies: noop, renderLateLink: noop, renderChildren: noop, renderBar: noop, renderList: noop, renderTabs: noop,
    resetKeys: noop, toggleKeys: noop, grow: noop, show: noop, selectTab: noop, connect: noop, schedulePoll: noop, toBottom: noop, pinned: () => false,
    setReachable: value => { S.reachable = value; }, setDockStatus: value => status.push(value), updateSend: noop, later: noop, fitScreen: noop,
    session: () => ({ status: 'working' }), notice: value => status.push(value), toast: value => status.push(value), pendingFor: () => null,
    location: { hash: '' }, history: { replaceState: noop }, window: { scrollTo: noop }, el: () => node('element'), icon: noop,
    document: { hidden: false, querySelectorAll: () => [], createTextNode: noop }, $: node,
    unpair: () => { ctx.resetAuthRequests(); S.token = null; },
  };
  vm.createContext(ctx);
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
