// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@houston-app/shared/AgentScope";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { resolveCommandPath } from "@houston-app/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const WHITESPACE_RUN = /\s+/;

const AGENT_SLICE = "app-houston-agents.slice";
// Owns every agent slice and competes with the server's unit or scope under app.slice.
const AGENTS_PARENT_SLICE = "app-houston.slice";
// Low weights yield CPU and disk to the server under contention, where the user manager
// has those controllers: current systemd delegates cpu, rarely io. TasksMax keeps agents
// below logind's 33% per-user task limit, leaving forks for the server.
const AGENTS_PARENT_PROPERTIES = ["CPUWeight=10", "IOWeight=10", "TasksMax=25%"];

export function ownedAgentSlice(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-houston-agents-${hash}.slice`;
}

const GiB = 1024 ** 3;

/**
 * Agents together leave about 6 GB free before they are throttled and 4 GB
 * before the kernel kills one, so the server, sshd, and tailscaled keep
 * working. Small machines still give agents at least half of RAM before
 * throttling and three quarters before a kill.
 */
function agentSliceMemoryLimits(totalBytes: number) {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  readonly oomKills: number | undefined;
  readonly populated: boolean | undefined;
}

/** Pipes can close before systemd records oom-kill; stopping, empty or OOM-counted scopes remain pending. */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (
    state.activeState === "deactivating" ||
    (state.oomKills ?? 0) > 0 ||
    state.populated === false
  ) {
    return "stopping";
  }
  return "running";
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

export interface ProcessStat {
  readonly state: string;
  readonly ppid: number;
  readonly session: number;
  readonly startTime: number;
}

/** Parses /proc/<pid>/stat, whose comm field may contain spaces and parentheses. */
export function parseProcStat(text: string): ProcessStat | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text
    .slice(close + 2)
    .trim()
    .split(WHITESPACE_RUN);
  const state = fields[0] ?? "";
  const ppid = Number(fields[1]);
  const session = Number(fields[3]);
  const startTime = Number(fields[19]);
  if (
    state.length === 0 ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(session) ||
    !Number.isInteger(startTime)
  ) {
    return undefined;
  }
  return { state, ppid, session, startTime };
}

function descendsFrom(
  pid: number,
  root: number,
  processes: ReadonlyMap<number, ProcessStat>,
): boolean {
  const seen = new Set<number>();
  let current = processes.get(pid)?.ppid;
  while (current !== undefined && current !== root) {
    if (seen.has(current)) return false;
    seen.add(current);
    current = processes.get(current)?.ppid;
  }
  return current === root;
}

/**
 * The pids a leftover agent session may stop: its main process and the
 * descendants still in its session. A setsid child leads its own session, and a
 * process reparented out of the tree is no longer a descendant, so both survive.
 */
export function selectLeftoverVictims(
  mainPid: number,
  processes: ReadonlyMap<number, ProcessStat>,
): ReadonlyArray<number> {
  const main = processes.get(mainPid);
  if (main === undefined) return [];
  const descendants: Array<number> = [];
  for (const [pid, stat] of processes) {
    if (pid === mainPid || stat.session !== main.session) continue;
    if (descendsFrom(pid, mainPid, processes)) descendants.push(pid);
  }
  return [mainPid, ...descendants.sort((left, right) => left - right)];
}

/** A pid keeps its identity only while /proc reports the same start time and a live state. */
export function isSameLiveProcess(
  expected: { readonly startTime: number },
  current: ProcessStat | undefined,
): boolean {
  return current !== undefined && current.state !== "Z" && current.startTime === expected.startTime;
}

// systemd's default 90 s stop timeout would outlast our leftover-agent wait.
// Delegation lets rootless containers (Podman, kind) manage their own cgroups.
const SCOPE_OPTIONS = ["--property=TimeoutStopSec=10s", "--property=Delegate=yes"];
const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_TRACKED_THREADS = 500;
// A provider that handles SIGTERM exits well within two seconds; a stuck one is
// force-killed before the restarted server can resume the same session.
const LEFTOVER_STOP_GRACE_INTERVAL = "100 millis";
const LEFTOVER_STOP_GRACE_ATTEMPTS = 20;
// One signal is one syscall per pid; this only bounds a wedged kill(1).
const LEFTOVER_SIGNAL_TIMEOUT = "5 seconds";

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const ownedSlice = ownedAgentSlice(stateDir);
  const layerScope = yield* Effect.scope;

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  const readProcessStat = (pid: number) =>
    fileSystem.readFileString(path.join("/proc", String(pid), "stat")).pipe(
      Effect.map(parseProcStat),
      Effect.orElseSucceed(() => undefined),
    );

  const readSessionProcesses = Effect.fn("agentScope.readSessionProcesses")(function* (
    controlGroup: string,
  ) {
    const processes = new Map<number, ProcessStat>();
    for (const line of (yield* readCgroupFile(controlGroup, "cgroup.procs")).split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || processes.has(pid)) continue;
      const stat = yield* readProcessStat(pid);
      if (stat !== undefined) processes.set(pid, stat);
    }
    return processes;
  });

  const liveVictims = Effect.fn("agentScope.liveVictims")(function* (
    victims: ReadonlyArray<{ readonly pid: number; readonly startTime: number }>,
  ) {
    const live: Array<{ pid: number; startTime: number }> = [];
    for (const victim of victims) {
      const current = yield* readProcessStat(victim.pid);
      if (isSameLiveProcess(victim, current)) live.push(victim);
    }
    return live;
  });

  const signalVictims = (kill: string, signal: "TERM" | "KILL", pids: ReadonlyArray<number>) =>
    runner
      .run({
        command: kill,
        args: [`-${signal}`, ...pids.map(String)],
        timeout: LEFTOVER_SIGNAL_TIMEOUT,
      })
      .pipe(Effect.option);

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop each leftover provider session so two
  // copies never work in the same worktree, but leave what it detached
  // (setsid, nohup, daemons) running: that work is not the session.
  const stopLeftoverUnit = Effect.fn("agentScope.stopLeftoverUnit")(function* (input: {
    readonly systemctl: string;
    readonly kill: string;
    readonly controlGroup: string;
    readonly unit: string;
  }) {
    const shown = yield* run(input.systemctl, [
      "--user",
      "show",
      input.unit,
      "--property=ActiveState,MainPID",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return;
    const mainPid = Number(values.get("MainPID") ?? "");
    if (!Number.isInteger(mainPid) || mainPid <= 0) return;
    const processes = yield* readSessionProcesses(input.controlGroup);
    const selected = selectLeftoverVictims(mainPid, processes).flatMap((pid) => {
      const stat = processes.get(pid);
      return stat === undefined ? [] : [{ pid, startTime: stat.startTime }];
    });
    if (selected.length === 0) return;
    yield* Effect.logWarning("Stopping agents left by a previous server", {
      unit: input.unit,
      pids: selected.map((victim) => victim.pid),
    });
    const signalled = yield* liveVictims(selected);
    if (signalled.length === 0) return;
    const termed = yield* signalVictims(
      input.kill,
      "TERM",
      signalled.map((victim) => victim.pid),
    );
    if (termed._tag === "None" || termed.value.code !== 0) {
      yield* Effect.logWarning("Could not stop agents left by a previous server", {
        unit: input.unit,
        signal: "TERM",
        exitCode: termed._tag === "Some" ? termed.value.code : undefined,
        stderr: termed._tag === "Some" ? termed.value.stderr.trim() : undefined,
      });
    }
    let remaining = signalled;
    for (let attempt = 0; attempt < LEFTOVER_STOP_GRACE_ATTEMPTS; attempt++) {
      remaining = yield* liveVictims(remaining);
      if (remaining.length === 0) break;
      yield* Effect.sleep(LEFTOVER_STOP_GRACE_INTERVAL);
    }
    if (remaining.length === 0) return;
    const killed = yield* signalVictims(
      input.kill,
      "KILL",
      remaining.map((victim) => victim.pid),
    );
    if (killed._tag === "None" || killed.value.code !== 0) {
      yield* Effect.logWarning("Could not stop agents left by a previous server", {
        unit: input.unit,
        signal: "KILL",
        exitCode: killed._tag === "Some" ? killed.value.code : undefined,
        stderr: killed._tag === "Some" ? killed.value.stderr.trim() : undefined,
      });
    }
  });

  const stopLeftoverAgents = Effect.fn("agentScope.stopLeftoverAgents")(function* (input: {
    readonly systemctl: string;
    readonly kill: string;
  }) {
    const shown = yield* run(input.systemctl, [
      "--user",
      "show",
      ownedSlice,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None") return;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return;
    const controlGroup = values.get("ControlGroup") ?? "";
    if (controlGroup.length === 0) return;
    const events = yield* readCgroupFile(controlGroup, "cgroup.events");
    if (parseCgroupCounter(events, "populated") === 0) return;
    const entries = yield* fileSystem
      .readDirectory(path.join("/sys/fs/cgroup", controlGroup))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const unit of entries.filter((entry) => entry.endsWith(".scope")).sort()) {
      yield* stopLeftoverUnit({
        systemctl: input.systemctl,
        kill: input.kill,
        controlGroup: path.join(controlGroup, unit),
        unit,
      });
    }
  });

  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      const kill = yield* resolve("kill", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      if (kill === null) {
        yield* Effect.logWarning("Could not stop agents left by a previous server", {
          slice: ownedSlice,
          reason: "kill not found in PATH",
        });
      } else {
        yield* stopLeftoverAgents({ systemctl, kill });
      }
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Scopes take OOMPolicy from systemd 253; older managers still get scopes.
      const supportsOomPolicy = yield* probe([...SCOPE_OPTIONS, "--property=OOMPolicy=stop"]);
      if (!supportsOomPolicy && !(yield* probe(SCOPE_OPTIONS))) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const setProperties = Effect.fn("agentScope.setProperties")(function* (
        slice: string,
        properties: ReadonlyArray<string>,
      ) {
        const result = yield* run(systemctl, [
          "--user",
          "set-property",
          "--runtime",
          slice,
          ...properties,
        ]);
        if (result._tag === "None" || result.value.code !== 0) {
          yield* Effect.logWarning("Could not set resource limits on an agents slice", {
            slice,
            properties,
            stderr: result._tag === "Some" ? result.value.stderr.trim() : undefined,
          });
        }
      });
      const limits = agentSliceMemoryLimits(NodeOS.totalmem());
      yield* setProperties(AGENT_SLICE, [`MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`]);
      yield* setProperties(AGENTS_PARENT_SLICE, AGENTS_PARENT_PROPERTIES);
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        ...limits,
        oomPolicy: supportsOomPolicy,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        supportsOomPolicy,
      };
    }),
  );

  // `shared` scopes serve other threads too: tracked only for OOM diagnosis on old systemd.
  const scopeByThread = new Map<string, { unit: string; oomKilled: boolean; shared: boolean }>();

  const readScope = Effect.fn("agentScope.readScope")(function* (systemctl: string, unit: string) {
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      unit,
      "--property=LoadState,ActiveState,Result,ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return undefined;
    const values = parseKeyValues(shown.value.stdout);
    const controlGroup = values.get("ControlGroup") ?? "";
    const memoryEvents = controlGroup ? yield* readCgroupFile(controlGroup, "memory.events") : "";
    const cgroupEvents = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
    const populated = parseCgroupCounter(cgroupEvents, "populated");
    return {
      loadState: values.get("LoadState") ?? "",
      activeState: values.get("ActiveState") ?? "",
      result: values.get("Result") ?? "",
      oomKills: parseCgroupCounter(memoryEvents, "oom_kill"),
      populated: populated === undefined ? undefined : populated === 1,
    } satisfies ScopeState;
  });

  const clearFailed = Effect.fn("agentScope.clearFailed")(function* (
    systemctl: string,
    unit: string,
  ) {
    for (let attempt = 0; attempt < CLEAR_FAILED_ATTEMPTS; attempt++) {
      const state = yield* readScope(systemctl, unit);
      if (state === undefined) return;
      if (state.activeState === "failed") {
        yield* run(systemctl, ["--user", "reset-failed", unit]);
        return;
      }
      if (state.activeState !== "deactivating") return;
      yield* Effect.sleep(CLEAR_FAILED_INTERVAL);
    }
  });

  const forget = (systemctl: string, unit: string) =>
    clearFailed(systemctl, unit).pipe(Effect.forkIn(layerScope), Effect.asVoid);

  const evictOldest = Effect.fn("agentScope.evictOldest")(function* (systemctl: string) {
    const oldest = scopeByThread.entries().next();
    if (oldest.done === true) return;
    const [threadId, tracked] = oldest.value;
    const state = yield* readScope(systemctl, tracked.unit);
    if (scopeByThread.get(threadId) !== tracked) return;
    scopeByThread.delete(threadId);
    const status = state === undefined ? "running" : classifyScope(state);
    if (status === "running" || status === "stopping") {
      scopeByThread.set(threadId, tracked);
      return;
    }
    yield* forget(systemctl, tracked.unit);
  });

  const track = Effect.fn("agentScope.track")(function* (
    systemctl: string,
    threadId: string,
    unit: string | undefined,
    shared = false,
  ) {
    const previous = scopeByThread.get(threadId);
    scopeByThread.delete(threadId);
    if (unit !== undefined) scopeByThread.set(threadId, { unit, oomKilled: false, shared });
    if (previous !== undefined) yield* forget(systemctl, previous.unit);
    if (scopeByThread.size > MAX_TRACKED_THREADS) yield* evictOldest(systemctl);
  });

  const oomKilled: AgentScopeShape["oomKilled"] = Effect.fn("agentScope.oomKilled")(
    function* (threadId) {
      const tracked = scopeByThread.get(threadId);
      if (tracked === undefined) return false;
      if (tracked.oomKilled) return true;
      const scope = yield* systemd;
      if (scope === undefined) return false;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        const state = yield* readScope(scope.systemctl, tracked.unit);
        if (state === undefined) return false;
        const status = classifyScope(state);
        if (status === "running") return false;
        if (status === "stopping") {
          yield* Effect.sleep(STOPPING_POLL_INTERVAL);
          continue;
        }
        yield* forget(scope.systemctl, tracked.unit);
        if (status === "gone") return false;
        yield* Effect.logWarning("Agent scope was killed: out of memory", {
          threadId,
          unit: tracked.unit,
        });
        tracked.oomKilled = true;
        return true;
      }
      return false;
    },
  );

  const stop = Effect.fn("AgentScope.stop")(function* (unit: string) {
    if (!unit.startsWith("houston-") || !unit.endsWith(".scope")) return;
    const scope = yield* systemd;
    if (scope === undefined) return;
    const state = yield* readScope(scope.systemctl, unit);
    if (
      state === undefined ||
      state.loadState !== "loaded" ||
      state.activeState !== "active" ||
      state.result === "oom-kill" ||
      state.populated === false
    )
      return;
    // The kernel counts OOM kills before signaling the victim. Let OOMPolicy
    // record the result before a manual stop can overwrite it; an unreadable
    // counter cannot rule out that race. Older managers need us to stop it.
    if (scope.supportsOomPolicy && (state.oomKills === undefined || state.oomKills > 0)) return;
    const stopped = yield* run(scope.systemctl, ["--user", "stop", "--no-block", unit]);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop an exited agent's scope", {
        unit,
        exitCode: stopped._tag === "Some" ? stopped.value.code : undefined,
      });
    }
  });

  const kill: AgentScopeShape["kill"] = Effect.fn("AgentScope.kill")(function* (threadId) {
    const tracked = scopeByThread.get(threadId);
    if (tracked === undefined || tracked.shared) return false;
    const scope = yield* systemd;
    if (scope === undefined) return false;
    const shown = yield* run(scope.systemctl, [
      "--user",
      "show",
      tracked.unit,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return false;
    const values = parseKeyValues(shown.value.stdout);
    if (values.get("ActiveState") !== "active") return false;
    const controlGroup = values.get("ControlGroup") ?? "";
    // cgroup.kill (Linux 5.14+) kills the whole tree at once; systemd's kill is the fallback.
    const killedByCgroup =
      controlGroup.length > 0 &&
      (yield* fileSystem
        .writeFileString(path.join("/sys/fs/cgroup", controlGroup, "cgroup.kill"), "1")
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
    if (killedByCgroup) return true;
    const killed = yield* run(scope.systemctl, [
      "--user",
      "kill",
      "--signal=SIGKILL",
      tracked.unit,
    ]);
    return killed._tag === "Some" && killed.value.code === 0;
  });

  const clear: AgentScopeShape["clear"] = Effect.fn("agentScope.clear")(function* (threadId) {
    if (!scopeByThread.has(threadId)) return;
    const scope = yield* systemd;
    if (scope !== undefined) yield* track(scope.systemctl, threadId, undefined);
  });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
      shared,
    }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved, args });
      const unit = `houston-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      // A continuing shared scope cannot attribute a tool's OOM to one thread.
      // Clear the launch thread's previous scope instead.
      const continuing = shared === true && scope.supportsOomPolicy;
      const owned = threadId !== undefined && !continuing;
      if (threadId !== undefined)
        yield* track(scope.systemctl, threadId, owned ? unit : undefined, shared === true);
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        // Without an owning thread nothing reads the result, so let systemd
        // unload the unit even when it fails.
        options: [
          ...SCOPE_OPTIONS,
          ...(scope.supportsOomPolicy
            ? [`--property=OOMPolicy=${continuing ? "continue" : "stop"}`]
            : []),
          ...(owned ? [] : ["--collect"]),
        ],
      };
      return { ...agentScopeCommand({ command: resolved, args, scope: systemdScope }), unit };
    }),
    oomKilled,
    stop,
    kill,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
