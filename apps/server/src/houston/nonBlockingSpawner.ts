// @effect-diagnostics nodeBuiltinImport:off - execvp's X_OK test has no Effect FileSystem equivalent.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CommandLine from "effect/process/CommandLine";

const ENV = "/usr/bin/env";

// libuv's _PATH_DEFPATH, searched when the child environment has no PATH.
const DEFAULT_PATH = "/usr/bin:/bin";

// A local disk answers access() in microseconds and a slow but live network mount in
// seconds; a directory silent for longer is treated as hung and its spawn fails.
export const CHECK_TIMEOUT = Duration.seconds(10);

// File-system checks in flight at once, hung ones included, of libuv's four pool threads.
// Two stay free of spawn checks; other file-system calls on the same mount can still take them.
export const CHECK_LIMIT = 2;

let envChdirSupport: Promise<boolean> | undefined;

/** Whether `/usr/bin/env` takes `-C` (GNU coreutils 8.28 and later; BusyBox does not). Probed once. */
export const supportsEnvChdir = Effect.promise(
  () =>
    (envChdirSupport ??= new Promise((resolve) =>
      // No cwd and absolute paths only, so the probe itself cannot wait on a mount.
      NodeChildProcess.execFile(ENV, ["-C", "/", "--", "/bin/sh", "-c", ":"], (error) =>
        resolve(error === null),
      ),
    )),
);

/** `env [-C <cwd>] -- <command>`, which execs the command: argv, env, stdio and pid are its own. */
// Undefined when env would read the command as `NAME=value` or `-`, which `--` does not stop.
export function envTrampoline<Arg>(
  command: string,
  args: ReadonlyArray<Arg>,
  cwd: string | undefined,
): { readonly command: string; readonly args: Array<Arg | string> } | undefined {
  if (command === "" || command === "-" || command.includes("=")) return undefined;
  return {
    command: ENV,
    args: [...(cwd === undefined ? [] : ["-C", cwd]), "--", command, ...args],
  };
}

/** For Node spawns outside the Effect spawner: on Linux, a launch that enters `cwd` in the child. */
export const inChildDirectory = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const trampoline =
    (yield* HostProcess.Platform) === "linux" && (yield* supportsEnvChdir)
      ? envTrampoline(command, args, cwd)
      : undefined;
  return trampoline === undefined
    ? { command, args: [...args], cwd: cwd as string | undefined }
    : { command: trampoline.command, args: trampoline.args, cwd: undefined };
});

/** A check's errno error, undefined when it passes, or "unchecked" while every slot is hung. */
type CheckResult = NodeJS.ErrnoException | undefined | "unchecked";

// One check per directory at a time; one hung past CHECK_TIMEOUT fails its directory at once
// until the call returns. A hung call keeps its thread and its count against CHECK_LIMIT;
// when every slot is hung, spawns go on unchecked and the child reports what fails.
export const makeChecks = () => {
  let inFlight = 0;
  let hung = 0;
  const waiters = new Set<() => boolean>();
  const hungDirectories = new Set<string>();
  const pending = new Map<string, Deferred.Deferred<void>>();

  const wake = () => {
    for (const waiter of waiters) if (waiter()) waiters.delete(waiter);
  };

  const acquire = Effect.callback<"slot" | "unchecked">((resume) => {
    const attempt = () => {
      if (inFlight < CHECK_LIMIT) {
        inFlight++;
        resume(Effect.succeed("slot"));
        return true;
      }
      if (hung >= inFlight) {
        resume(Effect.succeed("unchecked"));
        return true;
      }
      return false;
    };
    if (attempt()) return;
    waiters.add(attempt);
    return Effect.sync(() => waiters.delete(attempt));
  });

  const run = Effect.fnUntraced(function* (
    directory: string,
    path: string,
    mode: number,
    timedOut: (waited: Duration.Duration) => PlatformError.PlatformError,
  ) {
    // Interruptible only where it waits, so an entry in `pending` always reaches its release.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        for (let previous = pending.get(directory); previous; previous = pending.get(directory)) {
          yield* restore(Deferred.await(previous));
        }
        if (hungDirectories.has(directory)) return yield* timedOut(Duration.zero);
        const done = Deferred.makeUnsafe<void>();
        pending.set(directory, done);
        const release = Effect.sync(() => {
          if (pending.get(directory) === done) pending.delete(directory);
          Deferred.doneUnsafe(done, Effect.void);
        });
        return yield* Effect.gen(function* () {
          const slot = yield* restore(acquire);
          if (slot === "unchecked") return slot as CheckResult;
          let abandoned = false;
          let marked = false;
          let settled: { readonly value: CheckResult } | undefined;
          const call = NodeFSP.access(path, mode).then(
            () => undefined,
            (error: NodeJS.ErrnoException) => error,
          );
          void call.then((value) => {
            settled = { value };
            inFlight--;
            if (abandoned) hung--;
            // An interrupted check sets no mark, and must not clear a newer check's.
            if (marked) hungDirectories.delete(directory);
            wake();
          });
          // A call that answered as the limit expired is not hung: nothing would clear the mark.
          const abandon = (directoryHangs: boolean) =>
            Effect.sync(() => {
              if (settled !== undefined) return;
              abandoned = true;
              hung++;
              marked = directoryHangs;
              if (marked) hungDirectories.add(directory);
              wake();
            });
          const result = yield* restore(
            Effect.promise(() => call).pipe(Effect.timeoutOption(CHECK_TIMEOUT)),
          ).pipe(Effect.onInterrupt(() => abandon(false)));
          if (result._tag === "Some") return result.value as CheckResult;
          if (settled !== undefined) return settled.value;
          yield* abandon(true);
          return yield* timedOut(CHECK_TIMEOUT);
        }).pipe(Effect.ensuring(release));
      }),
    );
  });

  return { run };
};

export type Checks = ReturnType<typeof makeChecks>;

const sharedChecks = makeChecks();

// The error a spawn gets when a directory it must check does not answer.
const checkTimedOut = (command: string, directory: string) => (waited: Duration.Duration) =>
  PlatformError.systemError({
    _tag: "TimedOut",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: directory,
    description:
      `${directory} did not answer a file-system check within the ` +
      `${Duration.format(CHECK_TIMEOUT)} limit (this spawn waited ${Duration.format(waited)}` +
      `${Duration.isZero(waited) ? ", an earlier check is still waiting" : ""}); ` +
      `${command} was not started`,
  });

// The PATH the child searches, from the environment the native spawner gives it.
const childPath = ({ env, extendEnv }: ChildProcess.CommandOptions) => {
  if (env === undefined) return process.env.PATH;
  if (!Object.hasOwn(env, "PATH")) return extendEnv === true ? process.env.PATH : undefined;
  const value = env.PATH;
  return value === undefined || !Redacted.isRedacted(value) ? value : Redacted.value(value);
};

// The spawn error the native spawner reports when execvp fails with `code`.
const spawnFailure = (command: ChildProcess.StandardCommand, code: "ENOENT" | "EACCES") => {
  const syscall = `spawn ${command.command}`;
  return PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : "PermissionDenied",
    module: "ChildProcess",
    method: "spawn",
    pathOrDescriptor: CommandLine.display([command.command, ...command.args], { format: "posix" }),
    syscall,
    cause: Object.assign(new Error(`${syscall} ${code}`), {
      errno: code === "ENOENT" ? -2 : -13,
      code,
      syscall,
      path: command.command,
      spawnargs: command.args.map((arg) => (Redacted.isRedacted(arg) ? "<redacted>" : arg)),
    }),
  });
};

// The error of the `FileSystem.access(cwd)` the native spawner runs before it spawns.
const cwdFailure = (cwd: string, cause: NodeJS.ErrnoException) =>
  PlatformError.systemError({
    _tag:
      cause.code === "ENOENT"
        ? "NotFound"
        : cause.code === "EACCES" || cause.code === "EPERM"
          ? "PermissionDenied"
          : cause.code === "ENOTDIR" || cause.code === "ELOOP"
            ? "BadResource"
            : "Unknown",
    module: "FileSystem",
    method: "access",
    pathOrDescriptor: cwd,
    syscall: cause.syscall,
    cause,
  });

/** The spawner's bounded check of `cwd`, for a launch that enters it in its child itself. */
export const checkWorkingDirectory = (cwd: string, command: string) =>
  sharedChecks
    .run(cwd, cwd, NodeFS.constants.F_OK, checkTimedOut(command, cwd))
    .pipe(
      Effect.flatMap((error) =>
        error === undefined || error === "unchecked" ? Effect.void : cwdFailure(cwd, error),
      ),
    );

// Fails as a native spawn does for a missing (ENOENT) or non-executable (EACCES) command:
// callers read that error to tell a CLI that is not installed from one that failed.
const findExecutable = Effect.fnUntraced(function* (
  checks: Checks,
  command: ChildProcess.StandardCommand,
  cwd: string | undefined,
) {
  // Joined as text: the kernel resolves `..` after a symlink differently from a normalized path.
  const fromCwd = (path: string) =>
    cwd === undefined || path.startsWith("/") ? path : `${cwd}/${path}`;
  const candidates = command.command.includes("/")
    ? [fromCwd(command.command)]
    : (childPath(command.options) ?? DEFAULT_PATH)
        .split(":")
        .map((entry) => `${fromCwd(entry || ".")}/${command.command}`);
  let denied = false;
  for (const candidate of candidates) {
    const directory = candidate.slice(0, candidate.lastIndexOf("/")) || "/";
    const error = yield* checks.run(
      directory,
      candidate,
      NodeFS.constants.X_OK,
      checkTimedOut(command.command, directory),
    );
    // Any other errno, or no free slot, is left for `env` to report through its exit code.
    if (error === undefined || error === "unchecked") return;
    if (error.code !== "ENOENT" && error.code !== "EACCES") return;
    denied ||= error.code === "EACCES";
  }
  return yield* spawnFailure(command, denied ? "EACCES" : "ENOENT");
});

// libuv's spawn waits on the main thread until the forked child has run chdir(cwd), searched
// PATH and exec'd, so a hung mount freezes the server. On Linux the child does both via env.
export const makeWith = Effect.fnUntraced(function* (options: {
  readonly supportsEnvChdir: Effect.Effect<boolean>;
  readonly checks?: Checks | undefined;
}) {
  const native = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((yield* HostProcess.Platform) !== "linux") return native;
  if (!(yield* options.supportsEnvChdir)) {
    yield* Effect.logWarning(
      "Processes enter their working directory in the server: /usr/bin/env does not take -C",
    );
    return native;
  }
  const path = yield* Path.Path;
  const checks = options.checks ?? sharedChecks;

  const prepareStandard = Effect.fnUntraced(function* (input: ChildProcess.StandardCommand) {
    const { cwd: givenCwd, shell, ...rest } = input.options;
    // The native spawner rejects a shell command with arguments, and a NUL, itself.
    if ((shell && input.args.length > 0) || input.command.includes("\0")) return input;
    // Node's shell mode on Unix, spelled out so the trampoline can run it.
    const command = shell
      ? ChildProcess.make(typeof shell === "string" ? shell : "/bin/sh", ["-c", input.command])
      : input;
    // Checked as given and entered resolved, as the native spawner does.
    const cwd = givenCwd === undefined ? undefined : path.resolve(givenCwd);
    const trampoline = envTrampoline(command.command, command.args, cwd);
    if (trampoline === undefined) return input;
    const started = ChildProcess.make(trampoline.command, trampoline.args, rest);
    if (givenCwd !== undefined && cwd !== undefined) {
      const error = yield* checks.run(
        cwd,
        givenCwd,
        NodeFS.constants.F_OK,
        checkTimedOut(command.command, cwd),
      );
      if (error === "unchecked") return started;
      if (error !== undefined) return yield* cwdFailure(givenCwd, error);
    }
    yield* findExecutable(checks, ChildProcess.make(command.command, command.args, rest), cwd);
    return started;
  });

  const prepare = (
    command: ChildProcess.Command,
  ): Effect.Effect<ChildProcess.Command, PlatformError.PlatformError> =>
    command._tag === "StandardCommand"
      ? prepareStandard(command)
      : Effect.map(Effect.all([prepare(command.left), prepare(command.right)]), ([left, right]) =>
          ChildProcess.pipeTo(left, right, command.options),
        );

  return ChildProcessSpawner.make(
    Effect.fn("NonBlockingSpawner.spawn")(function* (command) {
      return yield* native.spawn(yield* prepare(command));
    }),
  );
});

/** Replaces the provided `ChildProcessSpawner` with one that never hands libuv a cwd on Linux. */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  makeWith({ supportsEnvChdir }),
);
