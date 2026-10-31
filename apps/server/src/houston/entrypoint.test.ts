// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - drives a real server process from outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

// Every server here runs from source with a temp HOME and USERPROFILE, a PATH holding only
// node and the OS tools, and sinks on 127.0.0.1 that this file owns.
const BIN = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const SERVER_DIR = NodePath.dirname(NodePath.dirname(BIN));
// oxlint-disable-next-line t3code/no-global-process-runtime -- picks the spawn and kill strategy for a real child process.
const IS_WINDOWS = process.platform === "win32";
// The server evaluates its whole module graph from source; a cold start takes about 10 s.
const READY_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 240_000;
const POLL_MS = 250;
const WINDOW_MS = 12 * 60 * 60 * 1000;

interface Server {
  readonly child: NodeChildProcess.ChildProcess;
  readonly output: Array<string>;
  readonly exit: Promise<number | null>;
}

const sandboxes: Array<string> = [];
const servers: Array<Server> = [];
const pids: Array<number> = [];
const sinks: Array<NodeNet.Server> = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The server spawns helpers of its own; kill each tree, never a name or a broadcast pid.
// On Linux the group outlives a leader that exited first, so it is signalled regardless.
function killTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (IS_WINDOWS) {
    if (!isAlive(pid)) return;
    NodeChildProcess.spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

const sleep = (ms: number) =>
  // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the server is another process on the real clock.
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number) {
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    if (await check()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

afterEach(async () => {
  for (const server of servers.splice(0)) killTree(server.child.pid);
  for (const pid of pids.splice(0)) killTree(pid);
  for (const sink of sinks.splice(0)) await new Promise((resolve) => sink.close(resolve));
  for (const dir of sandboxes.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function makeSandbox(): string {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-entry-")),
  );
  sandboxes.push(root);
  return root;
}

function sandboxEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const tmp = NodePath.join(root, "tmp");
  NodeFS.mkdirSync(tmp, { recursive: true });
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const env: NodeJS.ProcessEnv = {
    PATH: IS_WINDOWS
      ? [NodePath.dirname(process.execPath), NodePath.join(systemRoot, "System32")].join(";")
      : [NodePath.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: NodePath.join(root, ".config"),
    XDG_DATA_HOME: NodePath.join(root, ".local", "share"),
    XDG_STATE_HOME: NodePath.join(root, ".local", "state"),
    XDG_CACHE_HOME: NodePath.join(root, ".cache"),
    ...extra,
  };
  if (IS_WINDOWS) {
    env.SystemRoot = systemRoot;
    env.APPDATA = NodePath.join(root, "AppData", "Roaming");
    env.LOCALAPPDATA = NodePath.join(root, "AppData", "Local");
  }
  return env;
}

async function freePort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Non-secret, self-signed 127.0.0.1 certificate from `outboundHttp.test.ts`, valid until 2126;
// the relay tracer exports only to an https URL.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

async function startSink(
  options: { readonly tls?: boolean } = {},
): Promise<{ readonly url: string; readonly requests: Array<string> }> {
  const requests: Array<string> = [];
  const handler: NodeHttp.RequestListener = (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => response.writeHead(200).end("{}"));
  };
  const sink = options.tls
    ? NodeHttps.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler)
    : NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  sinks.push(sink);
  const scheme = options.tls ? "https" : "http";
  return {
    url: `${scheme}://127.0.0.1:${(sink.address() as NodeNet.AddressInfo).port}`,
    requests,
  };
}

function desktopToken(secret: string): string {
  // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- the server checks the credential against its own clock.
  const window = Math.floor(Date.now() / WINDOW_MS);
  return NodeCrypto.createHmac("sha256", secret)
    .update(`t3-desktop-bootstrap:${window}`)
    .digest("hex");
}

function envelope(port: number, t3Home: string | undefined, extra: Record<string, unknown> = {}) {
  const secret = `secret-${port}`;
  return {
    mode: "desktop",
    noBrowser: true,
    port,
    ...(t3Home === undefined ? {} : { t3Home }),
    host: "127.0.0.1",
    desktopBootstrapToken: desktopToken(secret),
    desktopBootstrapSecret: secret,
    shellEnvironmentPrepared: true,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...extra,
  };
}

function spawnServer(options: {
  readonly args?: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly envelope?: Record<string, unknown>;
  // false: the host names the envelope's fd through T3CODE_BOOTSTRAP_FD in `env` instead.
  readonly bootstrapFlag?: boolean;
}): Server {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      BIN,
      ...(options.args ?? []),
      ...(options.bootstrapFlag === false ? [] : ["--bootstrap-fd", "0"]),
    ],
    {
      cwd: SERVER_DIR,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group on Linux, so cleanup reaches the helpers it spawns.
      detached: !IS_WINDOWS,
      windowsHide: true,
    },
  );
  const output: Array<string> = [];
  child.stdout!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  if (options.envelope !== undefined) {
    child.stdin!.write(`${JSON.stringify(options.envelope)}\n`);
  }
  // The host closes stdin once the envelope is written.
  child.stdin!.end();
  const server = { child, output, exit };
  servers.push(server);
  return server;
}

const lines = (server: Server) => server.output.join("").split(/\r?\n/);

async function environmentStatus(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(3_000),
    });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return undefined;
  }
}

function exchangeCredential(port: number, credential: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Houston",
      client_device_type: "desktop",
    }).toString(),
  });
}

async function waitReady(server: Server, port: number): Promise<void> {
  let exited: number | null | undefined;
  void server.exit.then((code) => (exited = code));
  await waitFor(
    `the server on port ${port} to answer 200`,
    async () => {
      if (exited !== undefined) {
        throw new Error(`server exited with ${exited} before ready:\n${server.output.join("")}`);
      }
      return (await environmentStatus(port)) === 200;
    },
    READY_TIMEOUT_MS,
  );
}

async function exitCode(server: Server): Promise<number | null> {
  return Promise.race([
    server.exit,
    sleep(READY_TIMEOUT_MS).then(() => {
      throw new Error(`server did not exit:\n${server.output.join("")}`);
    }),
  ]);
}

// SIGTERM runs upstream's shutdown, including the analytics flush. Windows has no SIGTERM
// delivery to a console-less child, so there the process is terminated.
async function shutdown(server: Server): Promise<void> {
  if (IS_WINDOWS) {
    killTree(server.child.pid);
  } else {
    server.child.kill("SIGTERM");
  }
  await Promise.race([server.exit, sleep(30_000)]);
  killTree(server.child.pid);
}

const runtimeRecordPath = (base: string) => NodePath.join(base, "userdata", "server-runtime.json");
async function readRecord(base: string) {
  await waitFor("the runtime record", () => NodeFS.existsSync(runtimeRecordPath(base)), 10_000);
  return JSON.parse(NodeFS.readFileSync(runtimeRecordPath(base), "utf8")) as {
    readonly pid: number;
    readonly port: number;
    readonly origin: string;
  };
}

describe("houston server entrypoint", () => {
  it(
    "a run keeps v1 files and creates no .t3",
    async () => {
      const root = makeSandbox();
      const channel = NodePath.join(root, ".houston-dev");
      const base = NodePath.join(channel, "v2");
      NodeFS.mkdirSync(channel, { recursive: true });
      const daemonJson = Buffer.from('{"pid":12345,"port":7777}\n');
      NodeFS.writeFileSync(NodePath.join(channel, "daemon.json"), daemonJson);
      const port = await freePort();

      const server = spawnServer({ env: sandboxEnv(root), envelope: envelope(port, base) });
      await waitReady(server, port);
      expect(NodeFS.existsSync(NodePath.join(base, "userdata", "statev2.sqlite"))).toBe(true);
      expect((await readRecord(base)).pid).toBe(server.child.pid);
      expect(NodeFS.existsSync(NodePath.join(base, "userdata", "server-owner.sqlite"))).toBe(true);
      await shutdown(server);

      expect(NodeFS.readFileSync(NodePath.join(channel, "daemon.json")).equals(daemonJson)).toBe(
        true,
      );
      expect(NodeFS.readdirSync(channel).toSorted()).toEqual(["daemon.json", "v2"]);
      expect(NodeFS.existsSync(NodePath.join(root, ".t3"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a hosted start without t3Home exits 64",
    async () => {
      await Promise.all(
        ["", "   ", undefined].map(async (t3Home) => {
          const root = makeSandbox();
          const port = await freePort();
          const server = spawnServer({ env: sandboxEnv(root), envelope: envelope(port, t3Home) });
          expect(await exitCode(server), `t3Home ${JSON.stringify(t3Home)}`).toBe(64);
          expect(server.output.join("")).toContain("t3Home");
          expect(NodeFS.existsSync(NodePath.join(root, ".t3"))).toBe(false);
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a hosted override is ignored with one warning",
    async () => {
      // `warns` names the one ignored source; a blank source is not an override.
      const rows = [
        { name: "T3CODE_HOME", home: "x", warns: "T3CODE_HOME" },
        { name: "--base-dir", baseDir: "x", warns: "--base-dir" },
        { name: "T3CODE_BOOTSTRAP_FD", home: "x", envFd: true, warns: "T3CODE_HOME" },
        { name: "alone" },
        // Whitespace: the config provider reads an empty variable as unset.
        { name: "blank T3CODE_HOME", home: "   " },
        { name: "blank --base-dir", baseDir: "   " },
      ] as const satisfies ReadonlyArray<{
        readonly name: string;
        readonly home?: string;
        readonly baseDir?: string;
        readonly envFd?: boolean;
        readonly warns?: string;
      }>;
      await Promise.all(
        rows.map(async (row) => {
          const root = makeSandbox();
          const resolve = (value: string) =>
            value.trim() === "" ? value : NodePath.join(root, value);
          const base = NodePath.join(root, ".houston-dev", "v2");
          const port = await freePort();
          const server = spawnServer({
            args: "baseDir" in row ? ["--base-dir", resolve(row.baseDir)] : [],
            env: sandboxEnv(root, {
              ...("home" in row ? { T3CODE_HOME: resolve(row.home) } : {}),
              ...("envFd" in row ? { T3CODE_BOOTSTRAP_FD: "0" } : {}),
            }),
            envelope: envelope(port, base),
            bootstrapFlag: !("envFd" in row),
          });
          await waitReady(server, port);

          expect((await readRecord(base)).pid, row.name).toBe(server.child.pid);
          expect(NodeFS.existsSync(NodePath.join(root, "x")), row.name).toBe(false);
          const warnings = lines(server).filter((line) => line.includes("houston: ignoring"));
          if ("warns" in row) {
            expect(warnings, `${row.name}\n${server.output.join("")}`).toHaveLength(1);
            expect(warnings[0]).toContain(row.warns);
            expect(warnings[0]).toContain("t3Home");
          } else {
            expect(warnings, row.name).toEqual([]);
          }
          await shutdown(server);
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a v1 channel dir exits 64",
    async () => {
      await Promise.all(
        ["daemon.json", "daemon.lock"].map(async (file) => {
          const root = makeSandbox();
          const channel = NodePath.join(root, ".houston-dev");
          NodeFS.mkdirSync(channel, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(channel, file), "{}\n");
          const port = await freePort();

          const server = spawnServer({ env: sandboxEnv(root), envelope: envelope(port, channel) });
          expect(await exitCode(server)).toBe(64);
          expect(server.output.join("")).toContain(file);
          expect(NodeFS.readdirSync(channel)).toEqual([file]);
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "no analytics request reaches the sink",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const sink = await startSink();
      const port = await freePort();
      const server = spawnServer({
        env: sandboxEnv(root, {
          T3CODE_TELEMETRY_ENABLED: "true",
          T3CODE_POSTHOG_HOST: sink.url,
          T3CODE_POSTHOG_KEY: "phc_houston_test",
        }),
        envelope: envelope(port, base),
      });
      await waitReady(server, port);
      // Past upstream's 10-second background flush, then its shutdown flush.
      await sleep(12_000);
      await shutdown(server);
      await sleep(500);

      expect(sink.requests).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "no OTLP request reaches the sink",
    async () => {
      await Promise.all(
        [[], ["start"], ["serve"]].map(async (command) => {
          const root = makeSandbox();
          const base = NodePath.join(root, ".houston-dev", "v2");
          const sink = await startSink();
          NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(base, "userdata", "settings.json"),
            `${JSON.stringify({
              observability: {
                otlpTracesUrl: `${sink.url}/settings/v1/traces`,
                otlpMetricsUrl: `${sink.url}/settings/v1/metrics`,
                otlpLogsUrl: `${sink.url}/settings/v1/logs`,
              },
            })}\n`,
          );
          const port = await freePort();
          const server = spawnServer({
            args: command,
            env: sandboxEnv(root, {
              T3CODE_OTLP_TRACES_URL: `${sink.url}/env/v1/traces`,
              T3CODE_OTLP_METRICS_URL: `${sink.url}/env/v1/metrics`,
              T3CODE_OTLP_LOGS_URL: `${sink.url}/env/v1/logs`,
              T3CODE_OTLP_EXPORT_INTERVAL_MS: "500",
              OTEL_EXPORTER_OTLP_ENDPOINT: `${sink.url}/otel`,
              OTEL_METRIC_EXPORT_INTERVAL: "500",
              OTEL_BSP_SCHEDULE_DELAY: "500",
            }),
            envelope: envelope(port, base, {
              otlpTracesUrl: `${sink.url}/envelope/v1/traces`,
              otlpMetricsUrl: `${sink.url}/envelope/v1/metrics`,
              otlpLogsUrl: `${sink.url}/envelope/v1/logs`,
            }),
          });
          await waitReady(server, port);
          await sleep(3_000);
          await shutdown(server);
          await sleep(500);

          expect(sink.requests, `command ${command.join(" ") || "(default)"}`).toEqual([]);
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "no relay trace reaches the sink",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const sink = await startSink({ tls: true });
      const caFile = NodePath.join(root, "sink-ca.pem");
      NodeFS.writeFileSync(caFile, TEST_CERT);
      const port = await freePort();
      const hosted = envelope(port, base);
      const server = spawnServer({
        env: sandboxEnv(root, {
          NODE_EXTRA_CA_CERTS: caFile,
          T3CODE_TELEMETRY_ENABLED: "true",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: `${sink.url}/v1/traces`,
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "houston-test",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "houston-test-token",
        }),
        envelope: hosted,
      });
      await waitReady(server, port);
      // The environment descriptor and the token exchange both run under the relay tracer.
      await environmentStatus(port);
      await exchangeCredential(port, desktopToken(hosted.desktopBootstrapSecret));
      // Past the OTLP tracer's 5-second export interval, then its shutdown flush.
      await sleep(7_000);
      await shutdown(server);
      await sleep(500);

      expect(sink.requests).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a hosted trace file stays under the base dir",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const elsewhere = NodePath.join(root, "elsewhere");
      const port = await freePort();
      const server = spawnServer({
        env: sandboxEnv(root, {
          T3CODE_TRACE_FILE: NodePath.join(elsewhere, "server.trace.ndjson"),
        }),
        envelope: envelope(port, base),
      });
      await waitReady(server, port);
      await sleep(1_000);
      await shutdown(server);

      expect(NodeFS.existsSync(elsewhere)).toBe(false);
      expect(
        NodeFS.existsSync(NodePath.join(base, "userdata", "logs", "server.trace.ndjson")),
      ).toBe(true);
      const warnings = lines(server).filter((line) => line.includes("T3CODE_TRACE_FILE"));
      expect(warnings, server.output.join("")).toHaveLength(1);
      expect(warnings[0]).toContain("houston: ignoring");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a hosted start publishes its runtime record",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const port = await freePort();
      const server = spawnServer({ env: sandboxEnv(root), envelope: envelope(port, base) });
      await waitReady(server, port);

      const record = await readRecord(base);
      expect(record.pid).toBe(server.child.pid);
      expect(record.port).toBe(port);
      expect(record.origin).toBe(`http://127.0.0.1:${port}`);
      expect(await environmentStatus(port)).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the desktop credential exchanges for a bearer",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const port = await freePort();
      const hosted = envelope(port, base);
      const server = spawnServer({ env: sandboxEnv(root), envelope: hosted });
      await waitReady(server, port);

      const exchange = (credential: string) => exchangeCredential(port, credential);

      const accepted = await exchange(desktopToken(hosted.desktopBootstrapSecret));
      const body = (await accepted.json()) as { readonly access_token?: unknown };
      expect(accepted.status).toBe(200);
      expect(typeof body.access_token).toBe("string");
      expect((body.access_token as string).length).toBeGreaterThan(0);

      const refused = await exchange(desktopToken("another-secret"));
      const refusedBody = await refused.text();
      expect(refused.status).toBeGreaterThanOrEqual(300);
      expect(refusedBody).not.toContain("access_token");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a second server on the same base dir exits 78",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const firstPort = await freePort();
      const first = spawnServer({ env: sandboxEnv(root), envelope: envelope(firstPort, base) });
      await waitReady(first, firstPort);

      const secondPort = await freePort();
      const second = spawnServer({ env: sandboxEnv(root), envelope: envelope(secondPort, base) });
      expect(await exitCode(second)).toBe(78);
      expect((await readRecord(base)).pid).toBe(first.child.pid);
      expect(await environmentStatus(firstPort)).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a killed server's base dir starts again",
    async () => {
      const root = makeSandbox();
      const base = NodePath.join(root, ".houston-dev", "v2");
      const firstPort = await freePort();
      const first = spawnServer({ env: sandboxEnv(root), envelope: envelope(firstPort, base) });
      await waitReady(first, firstPort);
      // SIGKILL; on Windows Node delivers it as TerminateProcess.
      first.child.kill("SIGKILL");
      await first.exit;

      const nextPort = await freePort();
      const next = spawnServer({ env: sandboxEnv(root), envelope: envelope(nextPort, base) });
      await waitReady(next, nextPort);
      expect(await environmentStatus(nextPort)).toBe(200);
      // The killed server's record stays until the next one publishes its own at activation,
      // which follows the first 200.
      await waitFor(
        "the runtime record to name the restarted server",
        async () => (await readRecord(base).catch(() => undefined))?.pid === next.child.pid,
        READY_TIMEOUT_MS,
      );
    },
    TEST_TIMEOUT_MS,
  );

  // The launcher starts the server the way the host does (stdin envelope, output to a log,
  // its own session), reports its pid, and exits when told to.
  const LAUNCHER = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [bin, cwd, log, envelope] = process.argv.slice(1);
    const out = fs.openSync(log, "a");
    const child = spawn(process.execPath, [bin, "--bootstrap-fd", "0"], {
      cwd, stdio: ["pipe", out, out], detached: true, windowsHide: true,
    });
    child.stdin.end(envelope + "\\n");
    child.unref();
    process.stdout.write(child.pid + "\\n");
    process.stdin.once("data", () => process.exit(0));
  `;

  async function launchThroughLauncher(root: string, detached: boolean) {
    const base = NodePath.join(root, ".houston-dev", "v2");
    const port = await freePort();
    const launcher = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        LAUNCHER,
        BIN,
        SERVER_DIR,
        NodePath.join(root, "server.log"),
        JSON.stringify(envelope(port, base)),
      ],
      {
        env: sandboxEnv(root, detached ? { T3CODE_DESKTOP_DETACHED: "1" } : {}),
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      },
    );
    const launcherExit = new Promise((resolve) => launcher.on("exit", resolve));
    const serverPid = await new Promise<number>((resolve) =>
      launcher.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))),
    );
    expect(serverPid).toBeGreaterThan(0);
    pids.push(serverPid);
    const log = () => NodeFS.readFileSync(NodePath.join(root, "server.log"), "utf8");
    await waitFor(
      `the launched server on port ${port} to answer 200`,
      async () => {
        if (!isAlive(serverPid)) throw new Error(`server exited before ready:\n${log()}`);
        return (await environmentStatus(port)) === 200;
      },
      READY_TIMEOUT_MS,
    );
    launcher.stdin!.write("exit\n");
    await launcherExit;
    return { port, serverPid, log };
  }

  it(
    "a detached server outlives its launcher",
    async () => {
      const { port, serverPid, log } = await launchThroughLauncher(makeSandbox(), true);
      await sleep(6_000);
      expect(isAlive(serverPid), log()).toBe(true);
      expect(await environmentStatus(port)).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an undetached server follows its launcher on Linux",
    async () => {
      const { port, serverPid, log } = await launchThroughLauncher(makeSandbox(), false);
      if (IS_WINDOWS) {
        // Upstream's launcher-loss watch does not run on Windows.
        await sleep(6_000);
        expect(await environmentStatus(port)).toBe(200);
        return;
      }
      await waitFor("the undetached server to exit", () => !isAlive(serverPid), 6_000).catch(
        (error: Error) => {
          throw new Error(`${error.message}\n${log()}`);
        },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
