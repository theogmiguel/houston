import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as KeepAwake from "./KeepAwake.ts";
import {
  createProject,
  freshState,
  makeKit,
  makeRepository,
  runKit,
  Runner,
  seedNightShift,
  Store,
  type Spawned,
} from "./nightShift.testkit.ts";

const keepAwake = (platform: NodeJS.Platform, spawns: Array<Spawned>, failure?: string) =>
  KeepAwake.layer.pipe(
    Layer.provide(
      Layer.succeed(KeepAwake.KeepAwakeSpawner, (command, args) => {
        if (failure !== undefined) throw new Error(failure);
        const child: Spawned = { command, args, stdinClosed: false, killed: false, stubborn: false };
        spawns.push(child);
        return {
          closeStdin: () => {
            child.stdinClosed = true;
          },
          kill: () => {
            child.killed = true;
          },
          alive: () => !child.killed && (child.stubborn || !child.stdinClosed),
        };
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
  );

const service = KeepAwake.NightShiftKeepAwake;

describe("night shift keep-awake", () => {
  it.effect("keep-awake is held for the run and released on settle and exit", () =>
    Effect.gen(function* () {
      // Linux: systemd-inhibit holds idle and sleep until its stdin closes.
      const linux: Array<Spawned> = [];
      yield* Effect.gen(function* () {
        const held = yield* service;
        assert.equal(yield* held.take(7), "held");
        assert.equal(yield* held.take(7), "held", "one child per run");
        assert.lengthOf(linux, 1);
        assert.equal(linux[0]!.command, "systemd-inhibit");
        assert.deepEqual(linux[0]!.args, [
          "--what=idle:sleep",
          "--who=Houston",
          "--why=Night shift run 7",
          "--mode=block",
          "cat",
        ]);
        // Settle closes stdin; a child that exits is not killed.
        yield* held.release(7);
        assert.isTrue(linux[0]!.stdinClosed);
        assert.isFalse(linux[0]!.killed);

        // A child still alive 5 seconds after its stdin closed is killed.
        yield* held.take(8);
        linux[1]!.stubborn = true;
        const releasing = yield* Effect.forkChild(held.release(8));
        yield* TestClock.adjust("4900 millis");
        assert.isTrue(linux[1]!.stdinClosed);
        assert.isFalse(linux[1]!.killed);
        yield* TestClock.adjust("200 millis");
        yield* Fiber.join(releasing);
        assert.isTrue(linux[1]!.killed);
      }).pipe(Effect.provide(keepAwake("linux", linux)));

      // Windows: a PowerShell child holds SetThreadExecutionState while it reads stdin.
      const windows: Array<Spawned> = [];
      yield* Effect.gen(function* () {
        const held = yield* service;
        assert.equal(yield* held.take(9), "held");
        assert.equal(windows[0]!.command, "powershell.exe");
        assert.deepEqual(windows[0]!.args.slice(0, 4), [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
        ]);
        const script = windows[0]!.args[4]!;
        assert.include(script, "SetThreadExecutionState");
        assert.include(script, "0x80000001");
        assert.include(script, "[Console]::In.ReadToEnd()");
      }).pipe(Effect.provide(keepAwake("win32", windows)));

      // Disposing the server's scope closes every pipe it holds.
      const exiting: Array<Spawned> = [];
      yield* Effect.gen(function* () {
        const held = yield* service;
        yield* held.take(10);
        assert.isFalse(exiting[0]!.stdinClosed);
      }).pipe(Effect.provide(keepAwake("linux", exiting)));
      assert.isTrue(exiting[0]!.stdinClosed);
      assert.isTrue(exiting[0]!.killed);

      // A child that cannot start is a warning; another platform is unsupported.
      const unavailable = yield* Effect.gen(function* () {
        return yield* (yield* service).take(11);
      }).pipe(Effect.provide(keepAwake("linux", [], "spawn systemd-inhibit ENOENT")));
      assert.equal(unavailable, "unavailable: spawn systemd-inhibit ENOENT");
      const darwin = yield* Effect.gen(function* () {
        return yield* (yield* service).take(12);
      }).pipe(Effect.provide(keepAwake("darwin", [])));
      assert.match(darwin, /^unavailable: /);

      // The run records inhibit_unavailable and continues.
      const state = freshState();
      state.spawnFailure = "spawn systemd-inhibit ENOENT";
      const kit = yield* makeKit("keep-awake", {}, state);
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const fixture = makeRepository("keep-awake", { kind: "bare" });
          const projectId = yield* createProject("keep-awake", fixture.root);
          yield* seedNightShift(projectId);
          const night = yield* Runner.HoustonNightShiftRunner;
          const started = yield* night.start({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 60,
            operation: "runNow",
          });
          const store = yield* Store.HoustonNightShiftStore;
          const run = (yield* store.getRun(started.runId))!;
          assert.equal(run.phase, "running");
          assert.equal(run.keepAwake, "unavailable: spawn systemd-inhibit ENOENT");
          const warning = run.preflight.find((item) => item.id === "inhibit_unavailable");
          assert.equal(warning?.status, "warn");
          assert.include(warning?.detail ?? "", "spawn systemd-inhibit ENOENT");
        }),
      );
    }),
  );
});
