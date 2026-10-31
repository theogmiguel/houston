import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

/** `EX_USAGE`: the launch itself is wrong, so a supervisor must not retry it unchanged. */
export const HOUSTON_EXIT_CODE_REFUSED_LAUNCH = 64;

// A v1 daemon writes both at the root of its channel directory.
const V1_CHANNEL_FILES = ["daemon.json", "daemon.lock"] as const;

export class HoustonLaunchRefusedError extends Schema.TaggedError<HoustonLaunchRefusedError>()(
  "HoustonLaunchRefusedError",
  { reason: Schema.String, expected: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = HOUSTON_EXIT_CODE_REFUSED_LAUNCH;

  override get message(): string {
    return `houston: ${this.reason}; expected ${this.expected}`;
  }
}

/** True for a server launched with a bootstrap envelope: while it resolves its config, and while it runs. */
export const HostedLaunch = Context.Reference<boolean>("houston/HostedLaunch", {
  defaultValue: () => false,
});

const nonBlank = (value: Option.Option<string>) =>
  Option.isSome(value) && value.value.trim().length > 0;

// Hides one variable from the active provider and leaves every other lookup unchanged.
const withoutVariable = (provider: ConfigProvider.ConfigProvider, name: string) =>
  ConfigProvider.make((path) =>
    path.length === 1 && path[0] === name
      ? Effect.void.pipe(Effect.as(undefined))
      : provider.load(path),
  );

/** A host launches the server with a bootstrap envelope, by flag or environment. */
export const isHostedLaunch = Effect.fn("houston.isHostedLaunch")(function* (flags: {
  readonly bootstrapFd: Option.Option<number>;
}) {
  const envBootstrapFd = yield* Config.Int("T3CODE_BOOTSTRAP_FD").pipe(Config.option);
  return Option.isSome(flags.bootstrapFd) || Option.isSome(envBootstrapFd);
});

/** Hosted, the envelope's `t3Home` is the only base dir; its overrides and `T3CODE_TRACE_FILE` are ignored. */
export const withHostedBaseDir = Effect.fn("houston.withHostedBaseDir")(function* <
  Flags extends {
    readonly baseDir: Option.Option<string>;
    readonly bootstrapFd: Option.Option<number>;
  },
  A,
  E,
  R,
>(flags: Flags, resolve: (flags: Flags) => Effect.Effect<A, E, R>) {
  if (!(yield* isHostedLaunch(flags))) return yield* resolve(flags);
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const ignored = [
    ...(nonBlank(flags.baseDir) ? ["--base-dir"] : []),
    ...(nonBlank(envHome) ? ["T3CODE_HOME"] : []),
  ];
  if (ignored.length > 0) {
    yield* Effect.sync(() =>
      process.stderr.write(
        `houston: ignoring ${ignored.join(" and ")} for a hosted server; its base dir comes from the envelope's t3Home\n`,
      ),
    );
  }
  // The trace file then stays at its default under the base dir.
  const envTraceFile = yield* Config.String("T3CODE_TRACE_FILE").pipe(Config.option);
  if (nonBlank(envTraceFile)) {
    yield* Effect.sync(() =>
      process.stderr.write(
        "houston: ignoring T3CODE_TRACE_FILE for a hosted server; its trace file stays under the envelope's t3Home\n",
      ),
    );
  }
  const provider = yield* ConfigProvider.ConfigProvider;
  const hidden = withoutVariable(withoutVariable(provider, "T3CODE_HOME"), "T3CODE_TRACE_FILE");
  return yield* resolve({ ...flags, baseDir: Option.none() }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, hidden),
    Effect.provideService(HostedLaunch, true),
  );
});

/** A hosted server has no fallback directory: the desktop app's `~/.houston/v2` belongs to another install. */
export const refuseHostedDefault = Effect.gen(function* () {
  if (!(yield* HostedLaunch)) return;
  return yield* new HoustonLaunchRefusedError({
    reason: "the bootstrap envelope's t3Home is missing or blank",
    expected: "a non-blank t3Home naming <channel dir>/v2",
  });
});

/** A v1 channel directory holds the daemon's own state; the v2 server lives in its `v2`. */
export const refuseV1ChannelDir = Effect.fn("houston.refuseV1ChannelDir")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of V1_CHANNEL_FILES) {
    if (yield* fs.exists(path.join(baseDir, file)).pipe(Effect.orElseSucceed(() => false))) {
      return yield* new HoustonLaunchRefusedError({
        reason: `base dir ${baseDir} holds ${file}, so it is a v1 channel directory`,
        expected: `a base dir of its own, such as ${path.join(baseDir, "v2")}`,
      });
    }
  }
  return baseDir;
});
