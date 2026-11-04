// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@houston-app/shared/AgentScope";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  classifyScope,
  isSameLiveProcess,
  make,
  ownedAgentSlice,
  parseProcStat,
  selectLeftoverVictims,
  type ProcessStat,
  type ScopeState,
} from "./agentScope.ts";

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });
});

const stat = (ppid: number, session: number, startTime: number, state = "S"): ProcessStat => ({
  state,
  ppid,
  session,
  startTime,
});

describe("parseProcStat", () => {
  it("reads the fields after a comm containing spaces and parentheses", () => {
    expect(
      parseProcStat("123 (my agent (v2)) S 1 123 456 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 99"),
    ).toEqual({ state: "S", ppid: 1, session: 456, startTime: 99 });
  });

  it("rejects a line whose comm is unterminated", () => {
    expect(parseProcStat("123 agent S 1 123 456")).toBeUndefined();
  });
});

describe("selectLeftoverVictims", () => {
  const table = new Map<number, ProcessStat>([
    [100, stat(1, 100, 10)],
    [101, stat(100, 100, 11)],
    [102, stat(101, 100, 12)],
    [200, stat(100, 200, 13)],
    [201, stat(200, 200, 14)],
    [300, stat(1, 100, 15)],
    [400, stat(999, 400, 16)],
  ]);

  it("keeps the provider and the descendants still in its session", () => {
    expect(selectLeftoverVictims(100, table)).toEqual([100, 101, 102]);
  });

  it("leaves a setsid subtree alone", () => {
    const victims = selectLeftoverVictims(100, table);
    expect(victims).not.toContain(200);
    expect(victims).not.toContain(201);
  });

  it("leaves a reparented nohup child alone", () => {
    expect(selectLeftoverVictims(100, table)).not.toContain(300);
  });

  it("returns nothing when the provider is already gone", () => {
    expect(selectLeftoverVictims(999, table)).toEqual([]);
  });

  it("does not follow a parent cycle", () => {
    const cyclic = new Map<number, ProcessStat>([
      [100, stat(1, 100, 10)],
      [101, stat(102, 100, 11)],
      [102, stat(101, 100, 12)],
    ]);
    expect(selectLeftoverVictims(100, cyclic)).toEqual([100]);
  });
});

describe("isSameLiveProcess", () => {
  it("accepts the same live process", () => {
    expect(isSameLiveProcess(stat(1, 1, 10), stat(1, 1, 10))).toBe(true);
  });

  it("rejects a pid reused by another process", () => {
    expect(isSameLiveProcess(stat(1, 1, 10), stat(1, 1, 11))).toBe(false);
  });

  it("rejects a process that vanished", () => {
    expect(isSameLiveProcess(stat(1, 1, 10), undefined)).toBe(false);
  });

  it("rejects a zombie that already exited", () => {
    expect(isSameLiveProcess(stat(1, 1, 10), stat(1, 1, 10, "Z"))).toBe(false);
  });
});

interface FakeUnit {
  activeState: string;
  result: string;
  controlGroup?: string;
  mainPid?: number;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
    readonly procRoot: string;
  }) => Effect.Effect<A, E>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes.
  {
    oomPolicy = true,
    stopFails = false,
    survivesSignal = [],
  }: {
    readonly oomPolicy?: boolean;
    readonly stopFails?: boolean;
    readonly survivesSignal?: ReadonlyArray<number>;
  } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "houston-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent", "kill"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const procRoot = NodePath.join(bin, "proc");
    NodeFS.mkdirSync(procRoot, { recursive: true });
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const remap = (filePath: string) =>
      filePath.startsWith("/proc/")
        ? NodePath.join(procRoot, filePath.slice("/proc/".length))
        : filePath.replace("/sys/fs/cgroup", cgroupRoot);
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          calls.push(args);
          if (args[0] === "-TERM" || args[0] === "-KILL") {
            for (const pid of args.slice(1)) {
              if (!survivesSignal.includes(Number(pid))) {
                NodeFS.rmSync(NodePath.join(procRoot, pid, "stat"), { force: true });
              }
            }
            return output("");
          }
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\nMainPID=0\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n` +
                  `ControlGroup=${state.controlGroup ?? ""}\nMainPID=${state.mainPid ?? 0}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (filePath, encoding) =>
          fileSystem.readFileString(remap(filePath), encoding),
        readDirectory: (filePath) => fileSystem.readDirectory(remap(filePath)),
        writeFileString: (filePath, data, options) =>
          fileSystem.writeFileString(remap(filePath), data, options),
      }),
    );
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* body({ scope, units, calls, stateDir, cgroupRoot, procRoot }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "houston-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it, with the agent itself gone. */
const exitedAgent = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  { populated, oomKills }: { readonly populated: boolean; readonly oomKills: number | undefined },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  if (oomKills !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(cgroupRoot, controlGroup, "memory.events"),
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  units.set(unit, { activeState: "active", result: "success", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
const signalsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((args) => args[0] === "-TERM" || args[0] === "-KILL");

/** Writes a /proc/<pid>/stat line with the fields the selection reads. */
const writeProcess = (
  procRoot: string,
  pid: number,
  {
    ppid,
    session,
    startTime,
    state = "S",
  }: {
    readonly ppid: number;
    readonly session: number;
    readonly startTime: number;
    readonly state?: string;
  },
) => {
  const directory = NodePath.join(procRoot, String(pid));
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(directory, "stat"),
    `${pid} (agent) ${state} ${ppid} ${ppid} ${session} 0 0 0 0 0 0 0 0 0 0 0 0 0 20 0 ${startTime}\n`,
  );
};

const writeCgroup = (cgroupRoot: string, controlGroup: string, pids: ReadonlyArray<number>) => {
  const directory = NodePath.join(cgroupRoot, controlGroup.replace(/^\//, ""));
  NodeFS.mkdirSync(directory, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, "cgroup.procs"), pids.map(String).join("\n"));
};
const launchCodex = (scope: Effect.Success<typeof make>, threadId: string) =>
  makeCodexAppServerSpawnCommand({ command: "agent", args: ["app-server"], threadId }).pipe(
    Effect.provideService(AgentScope, scope),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((command) => {
      assert(ChildProcess.isStandardCommand(command));
      return command;
    }),
  );

describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps shared Codex scopes running without attributing their OOM to the launch thread",
    () =>
      withFakeSystemd(({ scope, units, calls }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(agent.args).toContain("--property=OOMPolicy=stop");
          units.set(unitOf(agent), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(true);

          const codex = yield* launchCodex(scope, "a");
          expect(codex.args).toContain("--property=OOMPolicy=continue");
          expect(codex.args).not.toContain("--property=OOMPolicy=stop");
          expect(codex.args).toContain("--property=TimeoutStopSec=10s");
          expect(codex.args).toContain("--collect");
          units.set(unitOf(codex), { activeState: "active", result: "success" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          units.set(unitOf(codex), { activeState: "failed", result: "oom-kill" });
          expect(yield* scope.oomKilled("a")).toBe(false);
          expect(
            calls.filter(([, verb, unit]) => verb === "show" && unit === unitOf(codex)),
          ).toEqual([]);
        }),
      ),
  );

  it.effect.each([{ oomPolicy: true }, { oomPolicy: false }])(
    "Force stop kills a thread's own scope but never a shared Codex scope (OOM policy $oomPolicy)",
    ({ oomPolicy }) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
            const codex = yield* launchCodex(scope, "b");
            exitedAgent(units, cgroupRoot, unitOf(codex), { populated: true, oomKills: 0 });

            expect(yield* scope.kill("a")).toBe(true);
            expect(
              NodeFS.readFileSync(NodePath.join(cgroupRoot, unitOf(agent), "cgroup.kill"), "utf8"),
            ).toBe("1");
            expect(yield* scope.kill("b")).toBe(false);
            expect(NodeFS.existsSync(NodePath.join(cgroupRoot, unitOf(codex), "cgroup.kill"))).toBe(
              false,
            );
            expect(calls.filter(([, verb]) => verb === "kill")).toEqual([]);
          }),
        { oomPolicy },
      ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );

  it.effect("delegates every agent scope so rootless containers can manage their cgroups", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const codex = yield* launchCodex(scope, "a");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        for (const launch of [agent, codex, terminal]) {
          expect(launch.args).toContain("--property=Delegate=yes");
        }
      }),
    ),
  );

  it.effect("caps agent memory and yields CPU, disk, and tasks to the server", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const setProperties = calls.filter(([, verb]) => verb === "set-property");
        expect(setProperties).toEqual([
          [
            "--user",
            "set-property",
            "--runtime",
            "app-houston-agents.slice",
            expect.stringMatching(/^MemoryHigh=\d+$/),
            expect.stringMatching(/^MemoryMax=\d+$/),
          ],
          [
            "--user",
            "set-property",
            "--runtime",
            "app-houston.slice",
            "CPUWeight=10",
            "IOWeight=10",
            "TasksMax=25%",
          ],
        ]);
      }),
    ),
  );

  it.effect("stops a previous server's agent session and leaves detached work running", () =>
    withFakeSystemd(({ scope, units, calls, stateDir, cgroupRoot, procRoot }) =>
      Effect.gen(function* () {
        const slice = "/app-houston-agents-test.slice";
        const unit = "houston-claude-abcd1234.scope";
        units.set(ownedAgentSlice(stateDir), {
          activeState: "active",
          result: "success",
          controlGroup: slice,
        });
        units.set(unit, {
          activeState: "active",
          result: "success",
          controlGroup: `${slice}/${unit}`,
          mainPid: 100,
        });
        writeCgroup(cgroupRoot, slice, []);
        NodeFS.writeFileSync(NodePath.join(cgroupRoot, slice, "cgroup.events"), "populated 1\n");
        writeCgroup(cgroupRoot, `${slice}/${unit}`, [100, 101, 102, 200, 201, 300]);
        writeProcess(procRoot, 100, { ppid: 1, session: 100, startTime: 10 });
        writeProcess(procRoot, 101, { ppid: 100, session: 100, startTime: 11 });
        writeProcess(procRoot, 102, { ppid: 101, session: 100, startTime: 12 });
        // A setsid app, its own child, and a nohup job reparented out of the tree.
        writeProcess(procRoot, 200, { ppid: 100, session: 200, startTime: 13 });
        writeProcess(procRoot, 201, { ppid: 200, session: 200, startTime: 14 });
        writeProcess(procRoot, 300, { ppid: 1, session: 100, startTime: 15 });

        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });

        expect(signalsOf(calls)).toEqual([["-TERM", "100", "101", "102"]]);
        expect(stopsOf(calls)).toEqual([]);
        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
        for (const pid of [200, 201, 300]) {
          expect(NodeFS.existsSync(NodePath.join(procRoot, String(pid), "stat"))).toBe(true);
        }
        for (const pid of [100, 101, 102]) {
          expect(NodeFS.existsSync(NodePath.join(procRoot, String(pid), "stat"))).toBe(false);
        }

        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        expect(sliceOf(terminal)).toBe("app-houston-agents.slice");
        expect(signalsOf(calls)).toHaveLength(1);
      }),
    ),
  );

  it.effect("leaves a leftover scope alone when its provider already exited", () =>
    withFakeSystemd(({ scope, units, calls, stateDir, cgroupRoot, procRoot }) =>
      Effect.gen(function* () {
        const slice = "/app-houston-agents-test.slice";
        const unit = "houston-claude-abcd1234.scope";
        units.set(ownedAgentSlice(stateDir), {
          activeState: "active",
          result: "success",
          controlGroup: slice,
        });
        units.set(unit, {
          activeState: "active",
          result: "success",
          controlGroup: `${slice}/${unit}`,
          mainPid: 0,
        });
        writeCgroup(cgroupRoot, slice, []);
        NodeFS.writeFileSync(NodePath.join(cgroupRoot, slice, "cgroup.events"), "populated 1\n");
        writeCgroup(cgroupRoot, `${slice}/${unit}`, [200]);
        writeProcess(procRoot, 200, { ppid: 1, session: 200, startTime: 13 });

        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });

        expect(signalsOf(calls)).toEqual([]);
        expect(NodeFS.existsSync(NodePath.join(procRoot, "200", "stat"))).toBe(true);
      }),
    ),
  );

  it.live("force-kills a provider that ignores SIGTERM", () =>
    withFakeSystemd(
      ({ scope, units, calls, stateDir, cgroupRoot, procRoot }) =>
        Effect.gen(function* () {
          const slice = "/app-houston-agents-test.slice";
          const unit = "houston-claude-abcd1234.scope";
          units.set(ownedAgentSlice(stateDir), {
            activeState: "active",
            result: "success",
            controlGroup: slice,
          });
          units.set(unit, {
            activeState: "active",
            result: "success",
            controlGroup: `${slice}/${unit}`,
            mainPid: 100,
          });
          writeCgroup(cgroupRoot, slice, []);
          NodeFS.writeFileSync(NodePath.join(cgroupRoot, slice, "cgroup.events"), "populated 1\n");
          writeCgroup(cgroupRoot, `${slice}/${unit}`, [100]);
          writeProcess(procRoot, 100, { ppid: 1, session: 100, startTime: 10 });

          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });

          expect(signalsOf(calls)).toEqual([
            ["-TERM", "100"],
            ["-KILL", "100"],
          ]);
        }),
      { survivesSignal: [100] },
    ),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect.each([true, false])(
    "cleans up an OOM exit without losing its diagnosis (OOMPolicy=%s)",
    (oomPolicy) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const unit = unitOf(agent);
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: undefined });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toEqual(
              oomPolicy ? [] : [["--user", "stop", "--no-block", unit]],
            );

            // The kernel records the kill before systemd records the OOM result.
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toHaveLength(oomPolicy ? 0 : 2);

            if (oomPolicy) {
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              expect(yield* scope.oomKilled("a")).toBe(true);
              units.delete(unit);
              expect(yield* scope.oomKilled("a")).toBe(true);
            }
          }),
        { oomPolicy },
      ),
  );

  it.effect("reports failed daemon cleanup without failing session teardown", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(signalsOf(calls)).toEqual([]);
        expect(stopsOf(calls)).toEqual([]);
      }),
    ),
  );
});
