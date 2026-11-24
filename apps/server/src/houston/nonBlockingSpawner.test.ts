// @effect-diagnostics nodeBuiltinImport:off - the spawner's checks are node:fs/promises calls, which the test spies on.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as NonBlockingSpawner from "./nonBlockingSpawner.ts";

vi.mock("node:fs/promises", { spy: true });

const hostPath = process.env.PATH;
const awkwardArgs = ["%s\\n", "-n", "--", "a b", `it's "quoted"`, "$HOME", "; exit 3", "", "A=b"];

/** A native spawner that records each command it is handed, then runs it. */
const recordingNative = (received: Array<ChildProcess.StandardCommand>) => {
  const record = (command: ChildProcess.Command): void => {
    if (command._tag === "StandardCommand") received.push(command);
    else [command.left, command.right].forEach(record);
  };
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (native) =>
      ChildProcessSpawner.make((command) => {
        record(command);
        return native.spawn(command);
      }),
    ),
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

const wrapping = (
  native: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>,
  supportsEnvChdir: Effect.Effect<boolean> = Effect.succeed(true),
  checks: NonBlockingSpawner.Checks = NonBlockingSpawner.makeChecks(),
) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    NonBlockingSpawner.makeWith({ supportsEnvChdir, checks }),
  ).pipe(Layer.provide(native));

// `access` under this root never returns, as on a mount that stopped answering.
const HUNG = "/houston-hung";
const hangUnderHungRoot = () =>
  vi
    .spyOn(NodeFSP, "access")
    .mockImplementation((path, mode) =>
      String(path).startsWith(HUNG)
        ? new Promise<void>(() => {})
        : NodeFS.promises.access(path, mode),
    );
const hungCalls = (spy: ReturnType<typeof hangUnderHungRoot>) =>
  spy.mock.calls.filter(([path]) => String(path).startsWith(HUNG)).length;

/** What a caller sees of a command: its output, or the error of a spawn that failed. */
const outcome = (command: ChildProcess.Command) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(command)).pipe(
    Effect.match({
      onSuccess: (output) => ({ output }),
      onFailure: (error) => ({ reason: error.reason._tag, message: error.message }),
    }),
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("nonBlockingSpawner", () => {
  it.live("hands the native spawner `env -C <cwd> --` and no cwd for a working directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const received: Array<ChildProcess.StandardCommand> = [];
      const env = { PATH: hostPath, A: "1" };
      const output = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.string(
          ChildProcess.make("printf", awkwardArgs, { cwd: directory, env, detached: false }),
        ),
      ).pipe(Effect.provide(wrapping(recordingNative(received))));

      expect(received).toHaveLength(1);
      const [handed] = received;
      expect(handed?.command).toBe("/usr/bin/env");
      expect(handed?.args).toEqual(["-C", directory, "--", "printf", ...awkwardArgs]);
      expect(handed?.options.cwd).toBeUndefined();
      expect(handed?.options.shell).toBeUndefined();
      expect(handed?.options.env).toEqual(env);
      expect(handed?.options.detached).toBe(false);
      expect(output).toBe(
        ["-n", "--", "a b", `it's "quoted"`, "$HOME", "; exit 3", "", "A=b", ""].join("\n"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("gives Node spawns `env -C` and no cwd on Linux, and the native cwd elsewhere", () =>
    Effect.gen(function* () {
      expect(yield* NonBlockingSpawner.inChildDirectory("git", ["log", "a b"], "/work")).toEqual({
        command: "/usr/bin/env",
        args: ["-C", "/work", "--", "git", "log", "a b"],
        cwd: undefined,
      });
      expect(
        yield* NonBlockingSpawner.inChildDirectory("git", ["log"], "/work").pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
      ).toEqual({ command: "git", args: ["log"], cwd: "/work" });
    }),
  );

  it.live("searches PATH in the child for a spawn without a working directory", () =>
    Effect.gen(function* () {
      const received: Array<ChildProcess.StandardCommand> = [];
      const env = { PATH: hostPath };
      const output = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        spawner.string(ChildProcess.make("printf", ["%s", "a b"], { env })),
      ).pipe(Effect.provide(wrapping(recordingNative(received))));

      expect(output).toBe("a b");
      expect(received.map(({ command, args, options }) => [command, args, options])).toEqual([
        ["/usr/bin/env", ["--", "printf", "%s", "a b"], { env }],
      ]);
    }),
  );

  it.effect("fails a spawn into a hung directory after the limit, and others still spawn", () =>
    Effect.gen(function* () {
      using access = hangUnderHungRoot();
      const fileSystem = yield* FileSystem.FileSystem;
      const healthy = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const received: Array<ChildProcess.StandardCommand> = [];
      const spawner = wrapping(recordingNative(received));
      const exitCode = (cwd: string) =>
        ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
          spawner.exitCode(ChildProcess.make("true", [], { cwd })),
        ).pipe(Effect.provide(spawner));

      // Two hung projects take both slots; a third spawn waits, never past the limit.
      const first = yield* Effect.forkChild(Effect.flip(exitCode(`${HUNG}/a`)));
      const again = yield* Effect.forkChild(Effect.flip(exitCode(`${HUNG}/a`)));
      const second = yield* Effect.forkChild(Effect.flip(exitCode(`${HUNG}/b`)));
      const third = yield* Effect.forkChild(exitCode(healthy));
      yield* TestClock.adjust("1 millis");
      expect(hungCalls(access)).toBe(2);
      expect(third.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust(NonBlockingSpawner.CHECK_TIMEOUT);
      const limit = Duration.format(NonBlockingSpawner.CHECK_TIMEOUT);
      for (const [fiber, directory, waited] of [
        [first, `${HUNG}/a`, limit],
        [second, `${HUNG}/b`, limit],
        [again, `${HUNG}/a`, Duration.format(Duration.zero)],
      ] as const) {
        const error = yield* Fiber.join(fiber);
        expect(error.reason._tag).toBe("TimedOut");
        expect(error.message).toContain(
          `${directory} did not answer a file-system check within the ${limit} limit (this spawn waited ${waited}`,
        );
        expect(error.message).toContain("true was not started");
      }
      expect(yield* Fiber.join(third)).toBe(0);
      expect(received.map(({ args }) => args)).toEqual([["-C", healthy, "--", "true"]]);

      // The hung directory fails at once, without another call or slot.
      const later = yield* Effect.flip(exitCode(`${HUNG}/a`));
      expect(later.message).toContain(`(this spawn waited ${Duration.format(Duration.zero)}`);
      expect(hungCalls(access)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("passes the cwd to the native spawner, and says why once, when env lacks -C", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const received: Array<ChildProcess.StandardCommand> = [];
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => messages.push(message));
      const command = ChildProcess.make("pwd", ["-P"], { cwd: directory });
      const output = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        Effect.all([spawner.string(command), spawner.string(command)]),
      ).pipe(
        Effect.provide(
          wrapping(recordingNative(received), Effect.succeed(false)).pipe(
            Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
          ),
        ),
      );

      expect(output).toEqual([`${directory}\n`, `${directory}\n`]);
      expect(received).toEqual([command, command]);
      expect(messages.flat()).toEqual([
        "Processes enter their working directory in the server: /usr/bin/env does not take -C",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("starts the command itself under the pid the caller is given", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const [pid, printed] = yield* ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-c", "echo $$; cat /proc/$$/comm"], { cwd: directory }),
          );
          const text = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
          return [Number(handle.pid), text] as const;
        }),
      ).pipe(Effect.scoped, Effect.provide(wrapping(NodeServices.layer)));

      expect(printed).toBe(`${pid}\nsh\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("checks a hung directory again once its call returns", () =>
    Effect.gen(function* () {
      const late: Array<{ answer: () => void; answered: Promise<void> }> = [];
      let answering = false;
      using _access = vi.spyOn(NodeFSP, "access").mockImplementation(() => {
        if (answering) return Promise.resolve();
        let answer = () => {};
        const answered = new Promise<void>((resolve) => (answer = resolve));
        late.push({ answer, answered });
        return answered;
      });
      const checks = NonBlockingSpawner.makeChecks();
      const timedOut = () =>
        PlatformError.systemError({ _tag: "TimedOut", module: "test", method: "check" });
      const check = Effect.result(
        checks.run(`${HUNG}/a`, `${HUNG}/a`, NodeFS.constants.F_OK, timedOut),
      );

      const first = yield* Effect.forkChild(check);
      yield* TestClock.adjust(NonBlockingSpawner.CHECK_TIMEOUT);
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: "Failure" });
      answering = true;
      expect(yield* check).toMatchObject({ _tag: "Failure" });
      expect(late).toHaveLength(1);

      const hungCall = late[0];
      hungCall?.answer();
      // Past the checks' own handlers on the same answer.
      yield* Effect.promise(async () => {
        await hungCall?.answered;
        for (let tick = 0; tick < 3; tick++) await Promise.resolve();
      });
      expect(yield* check).toMatchObject({ _tag: "Success" });
    }),
  );

  it.effect("a check interrupted at any point leaves its healthy directory checkable", () =>
    Effect.gen(function* () {
      using _access = vi.spyOn(NodeFSP, "access").mockImplementation(() => Promise.resolve());
      const timedOut = () =>
        PlatformError.systemError({ _tag: "TimedOut", module: "test", method: "check" });
      const stuck: Array<number> = [];
      let point = 0;
      for (let reached = true; reached; point++) {
        reached = false;
        const checks = NonBlockingSpawner.makeChecks();
        const check = checks.run("/healthy", "/healthy", NodeFS.constants.F_OK, timedOut);
        // Yields just before one operation, with the check's fiber interrupted there.
        const native = new Scheduler.MixedScheduler();
        let checking: Fiber.Fiber<unknown, unknown> | undefined;
        let operations = 0;
        const interrupting: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => native.makeDispatcher(),
          shouldYield: (fiber) => {
            checking ??= fiber;
            if (operations++ !== point) return false;
            reached = true;
            checking.interruptUnsafe();
            return true;
          },
        };
        const interrupted = yield* check.pipe(
          Effect.provideService(Scheduler.Scheduler, interrupting),
          Effect.forkChild,
        );
        yield* Fiber.await(interrupted);
        const later = yield* Effect.forkChild(check);
        for (let turn = 0; turn < 3; turn++) yield* TestClock.adjust("1 millis");
        if (later.pollUnsafe()?._tag !== "Success") stuck.push(point);
        yield* Fiber.interrupt(later);
      }
      // Every operation of the check was a point, its file-system call included.
      expect(point).toBeGreaterThan(10);
      expect(stuck).toEqual([]);
    }),
  );

  it.effect.each([
    { slot: "free", busy: false },
    { slot: "handed over by a check that ended", busy: true },
  ])("callers interrupted at any point give back the slot they took: $slot", ({ busy }) =>
    Effect.gen(function* () {
      let answers: Array<() => void> = [];
      let answering = true;
      using _access = vi
        .spyOn(NodeFSP, "access")
        .mockImplementation((path) =>
          answering || path === "/healthy"
            ? Promise.resolve()
            : new Promise<void>((resolve) => answers.push(resolve)),
        );
      const timedOut = () =>
        PlatformError.systemError({ _tag: "TimedOut", module: "test", method: "check" });
      const turns = Effect.gen(function* () {
        for (let turn = 0; turn < 3; turn++) yield* TestClock.adjust("1 millis");
      });
      const stuck: Array<number> = [];
      let point = 0;
      for (let reached = true; reached; point++) {
        reached = false;
        const checks = NonBlockingSpawner.makeChecks();
        const run = (path: string) => checks.run(path, path, NodeFS.constants.F_OK, timedOut);
        // As many callers as there are slots, so one leak each would take them all.
        for (let caller = 0; caller < NonBlockingSpawner.CHECK_LIMIT; caller++) {
          answering = !busy;
          if (busy) {
            for (let held = 0; held < NonBlockingSpawner.CHECK_LIMIT; held++) {
              yield* Effect.forkChild(run(`/held/${held}`));
            }
            yield* turns;
          }
          const native = new Scheduler.MixedScheduler();
          let checking: Fiber.Fiber<unknown, unknown> | undefined;
          let operations = 0;
          const interrupting: Scheduler.Scheduler = {
            executionMode: "async",
            makeDispatcher: () => native.makeDispatcher(),
            shouldYield: (fiber) => {
              checking ??= fiber;
              if (operations++ !== point) return false;
              reached = true;
              checking.interruptUnsafe();
              return true;
            },
          };
          const interrupted = yield* run("/healthy").pipe(
            Effect.provideService(Scheduler.Scheduler, interrupting),
            Effect.forkChild,
          );
          yield* turns;
          answering = true;
          for (const answer of answers) answer();
          answers = [];
          yield* Fiber.await(interrupted);
          yield* turns;
        }
        const later = yield* Effect.forkChild(run("/healthy"));
        yield* turns;
        if (later.pollUnsafe()?._tag !== "Success") stuck.push(point);
        yield* Fiber.interrupt(later);
      }
      expect(point).toBeGreaterThan(10);
      expect(stuck).toEqual([]);
    }),
  );

  it.effect("an interrupted check does not clear the mark of a newer one that hung", () =>
    Effect.gen(function* () {
      const answers: Array<() => void> = [];
      using _access = vi
        .spyOn(NodeFSP, "access")
        .mockImplementation(() => new Promise<void>((resolve) => answers.push(resolve)));
      const checks = NonBlockingSpawner.makeChecks();
      const check = checks
        .run(`${HUNG}/a`, `${HUNG}/a`, NodeFS.constants.F_OK, (waited) =>
          PlatformError.systemError({
            _tag: "TimedOut",
            module: "test",
            method: "check",
            description: Duration.format(waited),
          }),
        )
        .pipe(Effect.flip);
      const answer = (index: number) =>
        Effect.promise(async () => {
          answers[index]?.();
          for (let tick = 0; tick < 5; tick++) await Promise.resolve();
        });

      const older = yield* Effect.forkChild(check);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.interrupt(older);
      const newer = yield* Effect.forkChild(check);
      yield* TestClock.adjust(NonBlockingSpawner.CHECK_TIMEOUT);
      yield* Fiber.join(newer);
      expect(answers).toHaveLength(2);

      yield* answer(0);
      const marked = yield* Effect.forkChild(check);
      yield* TestClock.adjust("1 millis");
      expect(answers).toHaveLength(2);
      expect((yield* Fiber.join(marked)).message).toContain(Duration.format(Duration.zero));

      // The newer check clears the mark it set.
      yield* answer(1);
      const again = yield* Effect.forkChild(check);
      yield* TestClock.adjust("1 millis");
      expect(answers).toHaveLength(3);
      yield* Fiber.interrupt(again);
    }),
  );

  it.live("gives callers what the native spawner gives them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      for (const [file, mode] of [
        ["stale/tool", 0o644],
        ["fresh/tool", 0o755],
        // GNU env reads a lone `-` as -i and `NAME=value` as an assignment, even after `--`.
        ["fresh/-", 0o755],
        ["fresh/launch=stable", 0o755],
      ] as const) {
        yield* fileSystem.makeDirectory(`${root}/${file.slice(0, file.lastIndexOf("/"))}`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(`${root}/${file}`, `#!/bin/sh\necho ${file} "$@"\n`);
        yield* fileSystem.chmod(`${root}/${file}`, mode);
      }
      const PATH = `${root}/stale:${root}/fresh`;

      const commands = {
        "enters the cwd": ChildProcess.make("pwd", ["-P"], { cwd: root }),
        "keeps argv": ChildProcess.make("printf", awkwardArgs, { cwd: root }),
        "keeps the environment": ChildProcess.make("env", [], {
          cwd: root,
          env: { PATH: hostPath, A: "1", "BASH_FUNC_x%%": "() {  echo exported\n}" },
        }),
        "skips a non-executable PATH entry": ChildProcess.make("tool", [], {
          cwd: root,
          env: { PATH },
        }),
        "searches PATH without a cwd": ChildProcess.make("tool", ["a b"], { env: { PATH } }),
        "a missing command": ChildProcess.make("houston-missing-command", ["--version"]),
        "searches PATH relative to the cwd": ChildProcess.make("tool", [], {
          cwd: root,
          env: { PATH: "fresh" },
        }),
        "a command named -": ChildProcess.make("-", [], { cwd: root, env: { PATH } }),
        "a command containing =": ChildProcess.make("launch=stable", [], {
          cwd: root,
          env: { PATH },
        }),
        "shell mode": ChildProcess.make('pwd -P; echo "$0" "a  b"', [], { cwd: root, shell: true }),
        "a pipeline": ChildProcess.make("printf", ["a\\nb\\n"], { cwd: root }).pipe(
          ChildProcess.pipeTo(ChildProcess.make("tail", ["-n", "1"], { cwd: root })),
        ),
        "a missing command in a cwd": ChildProcess.make("houston-missing-command", [], {
          cwd: root,
        }),
        "a non-executable command": ChildProcess.make("tool", [], {
          cwd: root,
          env: { PATH: `${root}/stale` },
        }),
        "a missing explicit path": ChildProcess.make("./missing", [], { cwd: root }),
        "a non-executable explicit path": ChildProcess.make(`${root}/stale/tool`, [], {
          cwd: root,
        }),
        "a missing cwd": ChildProcess.make("true", [], { cwd: `${root}/missing` }),
        "a cwd through a missing directory": ChildProcess.make("true", [], {
          cwd: `${root}/missing/..`,
        }),
      };
      for (const [name, command] of Object.entries(commands)) {
        const native = yield* outcome(command).pipe(Effect.provide(NodeServices.layer));
        const wrapped = yield* outcome(command).pipe(Effect.provide(wrapping(NodeServices.layer)));
        expect(wrapped, name).toEqual(native);
      }
      // The error names the directory, as the native spawner's does.
      expect(
        yield* outcome(commands["a missing cwd"]).pipe(
          Effect.provide(wrapping(NodeServices.layer)),
        ),
      ).toMatchObject({ reason: "NotFound", message: expect.stringContaining(`${root}/missing`) });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("checks at most two paths at once, however many directories hang", () =>
    Effect.gen(function* () {
      const allArrived = yield* Deferred.make<void>();
      let arrivals = 0;
      // Each spawn resolves its cwd, then starts its check within microtasks.
      const arrivalPath = Layer.effect(
        Path.Path,
        Effect.map(Path.Path, (path) => ({
          ...path,
          resolve: (...segments: ReadonlyArray<string>) => {
            if (++arrivals === 3) setImmediate(() => Deferred.doneUnsafe(allArrived, Effect.void));
            return path.resolve(...segments);
          },
        })),
      );
      const hung: Array<() => void> = [];
      let releasing = false;
      let running = 0;
      let mostRunning = 0;
      using _access = vi.spyOn(NodeFSP, "access").mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            mostRunning = Math.max(mostRunning, ++running);
            const fail = () => {
              running--;
              reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
            };
            if (releasing) fail();
            else hung.push(fail);
          }),
      );
      const spawns = yield* Effect.forEach(
        ["a", "b", "c"],
        (name) =>
          ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
            spawner.exitCode(ChildProcess.make("true", [], { cwd: `/houston-hung/${name}` })),
          ).pipe(Effect.flip),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provide(
          wrapping(
            Layer.mergeAll(NodeServices.layer, arrivalPath.pipe(Layer.provide(NodeServices.layer))),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(allArrived);
      expect(mostRunning).toBe(2);
      releasing = true;
      for (const fail of hung.splice(0)) fail();
      const errors = yield* Fiber.join(spawns);
      expect(mostRunning).toBe(2);
      expect(errors.map((error) => error.reason._tag)).toEqual([
        "NotFound",
        "NotFound",
        "NotFound",
      ]);
    }),
  );
});
