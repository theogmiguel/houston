import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

if (process.platform !== 'linux') throw Error('native exit fixture requires Linux WebKitGTK');
const [appPath, coreDir, mode, repo] = process.argv.slice(2);
if (!appPath || !coreDir || !repo || !['close-crashed', 'close-wedged', 'close-healthy', 'quit-crashed', 'stop-crashed'].includes(mode))
  throw Error('usage: scripts/test-native-exit.sh DEBUG_APP FRESH_CORE_BIN_DIR MODE REPO_ROOT');
if (!process.env.DISPLAY || process.env.HOUSTON_EXIT_TEST_DISPLAY !== process.env.DISPLAY)
  throw Error('set DISPLAY and HOUSTON_EXIT_TEST_DISPLAY to the same isolated test display');
for (const path of [appPath, join(coreDir, 'houston-core'), join(coreDir, 'houston-supervisor')])
  if (!existsSync(resolve(path))) throw Error(`missing supplied binary: ${path}`);
const source = readFileSync(join(repo, 'core/houston-protocol/src/lib.rs'), 'utf8');
const constant = name => Number(source.match(new RegExp(`pub const ${name}: u32 = (\\d+);`))?.[1]) || (() => { throw Error(`missing ${name}`); })();
const protocol = constant('PROTOCOL_VERSION'), manageVersion = constant('MANAGE_VERSION');
const root = mkdtempSync(join(tmpdir(), 'houston-native-exit-'));
const home = join(root, 'home');
const channel = `exit-selftest-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const state = join(home, `.houston-${channel}`);
for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'workspace']) mkdirSync(join(root, name), { mode: 0o700 });
const inherited = { ...process.env };
for (const name of Object.keys(inherited))
  if (name.startsWith('HOUSTON_') || name.startsWith('TR_')) delete inherited[name];
const env = { ...inherited, HOME: home, USERPROFILE: home, SHELL: '/bin/bash',
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'),
  HOUSTON_CHANNEL: channel, HOUSTON_DAEMON_BIN_DIR: resolve(coreDir),
  HOUSTON_SAFE_MODE: '1', HOUSTON_DISABLE_AUTO_RESTORE: '1',
  HOUSTON_WATCHDOG: mode === 'close-wedged' ? '1' : '0',
  HOUSTON_EXIT_SELFTEST: mode, HOUSTON_EXIT_SELFTEST_DIR: root, GDK_BACKEND: 'x11' };
for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CARGO_HOME', 'RUSTUP_HOME',
  'HOUSTON_SESSION', 'HOUSTON_PARENT_SESSION', 'HOUSTON_MCP_TOKEN', 'HOUSTON_MCP_URL',
  'WAYLAND_DISPLAY', 'GNOME_KEYRING_CONTROL', 'DBUS_STARTER_ADDRESS', 'DBUS_STARTER_BUS_TYPE', 'TR_BROWSER_SELFTEST', 'HOUSTON_WATCHDOG_SELFTEST']) delete env[name];
console.log(JSON.stringify({ root, channel, mode }));
const log = openSync(join(root, 'app.log'), 'w', 0o600);
const app = Bun.spawn([resolve(appPath), '--channel', channel], { env, cwd: join(root, 'workspace'), stdout: log, stderr: log });
let exitCode, daemon, daemonIdentity, socket, cleanupError;
const ownedProcesses = [];
app.exited.then(code => { exitCode = code; });
const pause = ms => new Promise(r => setTimeout(r, ms));
const deadline = async (description, test, seconds = 15) => {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    if (existsSync(join(root, 'failed'))) throw Error(readFileSync(join(root, 'failed'), 'utf8'));
    if (await test()) return;
    await pause(50);
  }
  throw Error(`timeout: ${description}`);
};
const identity = pid => {
  try {
    const tail = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
    return tail[0] === 'Z' ? null : tail[19];
  } catch { return null; }
};
const discover = () => JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8'));
const manage = async verb => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/manage`, {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manage_version: manageVersion, verb }), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw Error(`/manage ${verb} refused: ${JSON.stringify(body)}`);
  return body;
};
const evidence = {};
try {
  await deadline('native fixture ready', () => {
    if (exitCode !== undefined) throw Error(`client exited before ready: ${exitCode}`);
    return existsSync(join(root, 'ready'));
  }, 60);
  daemon = discover();
  if (!Number.isInteger(daemon.pid) || daemon.pid <= 1) throw Error('invalid channel daemon pid');
  daemonIdentity = identity(daemon.pid);
  if (!daemonIdentity) throw Error('channel daemon not alive');
  const supervisor = JSON.parse(readFileSync(join(state, 'supervisor.json'), 'utf8'));
  if (!Number.isInteger(supervisor.pid) || supervisor.pid <= 1 || !identity(supervisor.pid))
    throw Error('private supervisor identity unavailable');
  const parent = Number(readFileSync(`/proc/${daemon.pid}/stat`, 'utf8').split(') ').pop().split(' ')[1]);
  if (parent !== supervisor.pid) throw Error('daemon is not owned by the private supervisor');
  ownedProcesses.push({ role: 'supervisor', pid: supervisor.pid, start: identity(supervisor.pid) });
  evidence.app_pid = app.pid; evidence.daemon_pid = daemon.pid;
  const before = await manage('daemon_status');
  if (before.pid !== daemon.pid) throw Error('daemon status identity mismatch');
  const controls = [], outputs = new Map();
  socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
  socket.binaryType = 'arraybuffer';
  let socketError;
  socket.onmessage = event => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'error') socketError = JSON.stringify(msg);
      controls.push(msg);
      if (controls.length > 256) controls.shift();
    } else {
      const bytes = new Uint8Array(event.data);
      if (bytes.length >= 13 && bytes[0] === 1) {
        const id = new DataView(bytes.buffer).getUint32(1);
        outputs.set(id, ((outputs.get(id) || '') + new TextDecoder().decode(bytes.subarray(13))).slice(-65536));
      }
    }
  };
  socket.onerror = () => { socketError = 'fixture websocket failed'; };
  await deadline('fixture websocket open', () => socket.readyState === WebSocket.OPEN);
  const send = value => socket.send(JSON.stringify(value));
  const control = async type => {
    let result;
    await deadline(type, () => {
      if (socketError) throw Error(socketError);
      const index = controls.findIndex(m => m.type === type);
      if (index >= 0) result = controls.splice(index, 1)[0];
      return result !== undefined;
    });
    return result;
  };
  send({ type: 'hello', token: daemon.token, protocol });
  await control('hello_ok');
  send({ type: 'workspace_add', path: join(root, 'workspace') });
  await control('workspace_list');
  send({ type: 'session_create', agent: 'shell', project_dir: join(root, 'workspace'),
    cols: 80, rows: 24, shell_integration: false });
  const session = (await control('session_created')).info.id;
  evidence.session = session;
  send({ type: 'session_attach', session, replay_bytes: 65536 });
  await control('scrollback');
  const stdin = text => {
    const input = new TextEncoder().encode(text);
    const frame = new Uint8Array(5 + input.length); frame[0] = 2;
    new DataView(frame.buffer).setUint32(1, session); frame.set(input, 5); socket.send(frame);
  };
  const echo = async label => {
    const suffix = randomUUID(), marker = `native-${label}-${suffix}`;
    outputs.set(session, '');
    // The input never contains the contiguous marker, so terminal input echo cannot satisfy this oracle.
    stdin(`printf '%s%s\\n' 'native-' '${label}-${suffix}'\n`);
    await deadline(`real PTY output ${label}`, () => (outputs.get(session) || '').includes(marker));
    return marker;
  };
  evidence.before_echo = await echo('before');
  const pidMarker = randomUUID();
  stdin(`printf '%s%s:%s\\n' 'native-pid-' '${pidMarker}' "$$"\n`);
  let shellPid;
  await deadline('fixture shell process identity', () => {
    shellPid = Number((outputs.get(session) || '').match(new RegExp(`native-pid-${pidMarker}:([0-9]+)`))?.[1]);
    return Number.isInteger(shellPid) && shellPid > 1;
  });
  const shellStart = identity(shellPid);
  if (!shellStart) throw Error('fixture shell disappeared before the native action');
  ownedProcesses.push({ role: 'shell', pid: shellPid, start: shellStart });
  evidence.owned_processes = ownedProcesses;
  writeFileSync(join(root, 'go'), 'fixture ready');
  await deadline('native exit action', () => existsSync(join(root, 'action')), mode === 'close-wedged' ? 45 : 15);
  if (mode === 'close-wedged') {
    if (!existsSync(join(root, 'hang-observed'))) throw Error('no watchdog hang detection evidence');
  } else if (mode !== 'close-healthy' && !existsSync(join(root, 'crash-observed'))) throw Error('no actual renderer death evidence');
  if (mode === 'close-healthy') {
    await deadline('native healthy hide', () => existsSync(join(root, 'hidden')));
    await pause(2000);
    if (exitCode !== undefined) throw Error(`healthy client exited: ${exitCode}`);
    evidence.client_hidden_and_alive = true;
  } else {
    await deadline('exact client child exit', () => exitCode !== undefined, mode === 'stop-crashed' ? 30 : 8);
    if (exitCode !== 0) throw Error(`native client exit code ${exitCode}`);
    evidence.client_exit_code = exitCode;
  }
  if (mode === 'stop-crashed') {
    if (!existsSync(join(root, 'confirmation'))) throw Error('no actual GTK confirmation response');
    await deadline('stopped owned daemon', () => identity(daemon.pid) !== daemonIdentity, 10);
    await deadline('stopped fixture shell and supervisor', () =>
      ownedProcesses.every(p => identity(p.pid) !== p.start), 10);
    if (existsSync(join(state, 'daemon.json')) && identity(discover().pid))
      throw Error('a replacement daemon still owns the private channel');
    evidence.daemon_stopped = true;
  } else {
    const after = discover();
    if (after.pid !== daemon.pid || after.token !== daemon.token || identity(daemon.pid) !== daemonIdentity)
      throw Error('daemon generation changed after client action');
    send({ type: 'session_list' });
    const sessions = (await control('session_list')).sessions;
    if (!sessions.some(s => s.id === session && s.state === 'running')) throw Error('same PTY session not running');
    evidence.after_echo = await echo('after');
    const status = await manage('daemon_status');
    if (status.pid !== daemon.pid || !status.live_sessions.ids.includes(session)) throw Error('manage lost same fixture session');
    evidence.daemon_and_session_survived = true;
  }
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL'; evidence.error = String(error); process.exitCode = 1;
} finally {
  socket?.close();
  // Cleanup is never success evidence: only the exact child handle may be killed.
  if (exitCode === undefined) { app.kill('SIGKILL'); await app.exited; }
  try {
    // Clean whichever generation the private channel currently records.
    if (existsSync(join(state, 'daemon.json'))) {
      daemon = discover(); daemonIdentity = identity(daemon.pid);
    }
    if (daemon && daemonIdentity && identity(daemon.pid) === daemonIdentity) {
      await manage('daemon_shutdown');
      // Ignore fixture failure markers while cleaning the owned daemon.
      const end = Date.now() + 10000;
      while (identity(daemon.pid) === daemonIdentity && Date.now() < end) await pause(50);
      if (identity(daemon.pid) === daemonIdentity) throw Error('owned daemon remained alive after /manage cleanup');
    }
    const end = Date.now() + 10000;
    while (ownedProcesses.some(p => identity(p.pid) === p.start) && Date.now() < end) await pause(50);
    const survivors = ownedProcesses.filter(p => identity(p.pid) === p.start);
    if (survivors.length) throw Error(`owned fixture processes survived cleanup: ${JSON.stringify(survivors)}`);
  } catch (error) { cleanupError = String(error); process.exitCode = 1; }
  closeSync(log);
  if (cleanupError) evidence.result = 'FAIL';
  evidence.cleanup_error = cleanupError ?? null;
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`Artifacts retained at ${root}`);
}
