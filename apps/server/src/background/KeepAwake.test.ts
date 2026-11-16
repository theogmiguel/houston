import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as Sink from "effect/Sink";

import * as KeepAwake from "./KeepAwake.ts";

type Transition = "held" | "released";

const makeTransitions = Queue.unbounded<Transition>();

const trackedHold = (transitions: Queue.Queue<Transition>) =>
  Effect.acquireRelease(Queue.offer(transitions, "held"), () =>
    Queue.offer(transitions, "released"),
  ).pipe(Effect.andThen(Effect.never), Effect.scoped);

describe("KeepAwake.inhibitorCommand", () => {
  it("holds a systemd idle/sleep lock that ends with the server on Linux", () => {
    const command = KeepAwake.inhibitorCommand("linux", 4242);
    expect(command?.command).toBe("systemd-inhibit");
    expect(command?.args).toContain("--what=idle:sleep");
    expect(command?.args).toContain("--pid=4242");
  });

  it("waits on the server process from a thread execution state on Windows", () => {
    const command = KeepAwake.inhibitorCommand("win32", 4242);
    expect(command?.command).toBe("powershell.exe");
    expect(command?.args.at(-1)).toContain("SetThreadExecutionState");
    expect(command?.args.at(-1)).toContain("Wait-Process -Id 4242");
  });

  it("has no inhibitor for a platform Houston does not support", () => {
    expect(KeepAwake.inhibitorCommand("darwin", 1)).toBeUndefined();
    expect(KeepAwake.inhibitorCommand("freebsd", 1)).toBeUndefined();
  });
});

describe("KeepAwake.holdWhen", () => {
  it.effect("holds while enabled and a run is active, and releases after the grace", () =>
    Effect.gen(function* () {
      const transitions = yield* makeTransitions;
      const enabled = yield* Queue.unbounded<boolean>();
      const active = yield* Queue.unbounded<boolean>();
      yield* KeepAwake.holdWhen({
        enabled: Stream.fromQueue(enabled),
        active: Stream.fromQueue(active),
        hold: trackedHold(transitions),
        grace: "60 seconds",
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(enabled, true);
      yield* Queue.offer(active, false);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);

      yield* Queue.offer(active, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(active, false);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Queue.take(transitions)).toBe("released");
    }),
  );

  it.effect("never holds while the setting is off", () =>
    Effect.gen(function* () {
      const transitions = yield* makeTransitions;
      const enabled = yield* Queue.unbounded<boolean>();
      const active = yield* Queue.unbounded<boolean>();
      yield* KeepAwake.holdWhen({
        enabled: Stream.fromQueue(enabled),
        active: Stream.fromQueue(active),
        hold: trackedHold(transitions),
        grace: "60 seconds",
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(enabled, false);
      yield* Queue.offer(active, true);
      yield* TestClock.adjust("120 seconds");
      expect(yield* Queue.size(transitions)).toBe(0);
    }),
  );

  it.effect("releases at once when the setting is turned off during a run", () =>
    Effect.gen(function* () {
      const transitions = yield* makeTransitions;
      const enabled = yield* Queue.unbounded<boolean>();
      const active = yield* Queue.unbounded<boolean>();
      yield* KeepAwake.holdWhen({
        enabled: Stream.fromQueue(enabled),
        active: Stream.fromQueue(active),
        hold: trackedHold(transitions),
        grace: "60 seconds",
      }).pipe(Effect.forkScoped);

      yield* Queue.offer(enabled, true);
      yield* Queue.offer(active, true);
      expect(yield* Queue.take(transitions)).toBe("held");

      yield* Queue.offer(enabled, false);
      expect(yield* Queue.take(transitions)).toBe("released");
    }),
  );
});

describe("KeepAwake.holdInhibitor", () => {
  const makeFakeSpawner = (log: Queue.Queue<string>) =>
    ChildProcessSpawner.make((command) => {
      const { command: name, args } = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      return Effect.acquireRelease(
        Queue.offer(log, `spawn ${name} ${args.join(" ")}`).pipe(
          Effect.as(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(77),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        ),
        () => Queue.offer(log, "killed"),
      );
    });

  it.effect("spawns the command and kills it when interrupted", () =>
    Effect.gen(function* () {
      const log = yield* Queue.unbounded<string>();
      const fiber = yield* KeepAwake.holdInhibitor(makeFakeSpawner(log), {
        command: "inhibit-tool",
        args: ["--flag"],
      }).pipe(Effect.forkScoped);

      expect(yield* Queue.take(log)).toBe("spawn inhibit-tool --flag");
      expect(yield* Queue.size(log)).toBe(0);
      yield* Fiber.interrupt(fiber);
      expect(yield* Queue.take(log)).toBe("killed");
    }),
  );

  it.effect("fails naming the command and exit code when the inhibitor exits on its own", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(78),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(3)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const error = yield* KeepAwake.holdInhibitor(spawner, {
        command: "inhibit-tool",
        args: [],
      }).pipe(Effect.flip);
      expect(error.message).toContain("inhibit-tool");
      expect(error.message).toContain("3");
    }),
  );
});
