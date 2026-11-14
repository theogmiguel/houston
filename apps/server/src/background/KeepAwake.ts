import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

// Bridges the gap between back-to-back runs so a queue of runs does not let the machine
// doze between them; one minute is shorter than the shortest common idle-sleep timeout.
const RELEASE_GRACE = Duration.seconds(60);

// Retry pacing for reads, the event subscription and the inhibitor process. The cap keeps a
// host without an inhibitor (for example no logind) from warning every few seconds.
const RETRY_BASE = Duration.seconds(5);
const RETRY_CAP = Duration.minutes(10);

const SUPPORTED_PLATFORMS = ["linux", "win32"] as const;

export interface InhibitorCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The command that holds a sleep inhibitor until it exits. Each one also exits when the server
 * process does, so a crashed server cannot leave an inhibitor behind.
 */
export function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
): InhibitorCommand | undefined {
  switch (platform) {
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=Houston",
          "--why=Agents are working",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread until Wait-Process returns.
          `$t = Add-Type -Name Power -Namespace Houston -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${serverPid}`,
        ],
      };
    default:
      return undefined;
  }
}

export class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { command: Schema.String, exitCode: Schema.Number },
) {
  override get message(): string {
    return `Sleep inhibitor '${this.command}' exited with code ${this.exitCode}; it must keep running until released`;
  }
}

/** Runs the inhibitor until interrupted, which stops its process; fails if it exits by itself. */
export const holdInhibitor = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: InhibitorCommand,
) =>
  spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        detached: false,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.tap((child) =>
        Effect.logInfo("keep-awake holding sleep inhibitor", { pid: Number(child.pid) }),
      ),
      Effect.tap(() =>
        Effect.addFinalizer(() => Effect.logInfo("keep-awake released sleep inhibitor")),
      ),
      Effect.flatMap((child) => child.exitCode),
      Effect.flatMap((exitCode) =>
        Effect.fail(
          new KeepAwakeInhibitorExited({
            command: command.command,
            exitCode: Number(exitCode),
          }),
        ),
      ),
      Effect.scoped,
    );

/** Reports true while `active` is true and for `grace` after it turns false. */
const withGrace = <E, R>(
  active: Stream.Stream<boolean, E, R>,
  grace: Duration.Input = RELEASE_GRACE,
): Stream.Stream<boolean, E, R> =>
  active.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on ? Stream.succeed(true) : Stream.fromEffect(Effect.as(Effect.sleep(grace), false)),
    ),
    Stream.changes,
  );

/**
 * Runs `hold` while the setting is enabled and a run is active (or was within `grace`).
 * Disabling the setting releases at once. `hold` runs until interrupted.
 */
export const holdWhen = Effect.fn("KeepAwake.holdWhen")(function* <E1, R1, E2, R2>(input: {
  readonly enabled: Stream.Stream<boolean, E1, R1>;
  readonly active: Stream.Stream<boolean, E2, R2>;
  readonly hold: Effect.Effect<void>;
  readonly grace?: Duration.Input;
}) {
  return yield* Stream.zipLatestWith(
    input.enabled,
    withGrace(input.active, input.grace),
    (enabled, active) => enabled && active,
  ).pipe(
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.fromEffect(input.hold) : Stream.empty)),
    Stream.runDrain,
  );
});

const backoff = Schedule.exponential(RETRY_BASE).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, RETRY_CAP))),
);

const retryWithBackoff =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(message, { cause })),
      Effect.retry(backoff),
    );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const command = inhibitorCommand(platform, process.pid);
    if (command === undefined) {
      yield* Effect.logInfo(
        `keep-awake is unavailable on platform '${platform}'; supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}`,
      );
      return;
    }
    const settings = yield* ServerSettings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const hasActiveRun = sql<{ readonly active: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
      ) AS active
    `.pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      retryWithBackoff("keep-awake could not read active runs"),
    );

    // The cursor is read before the snapshot so a run changing in between is replayed, not missed.
    const active = Stream.unwrap(
      events.latestApplicationSequence.pipe(
        retryWithBackoff("keep-awake could not read the event cursor"),
        Effect.map((afterSequence) =>
          Stream.concat(
            Stream.succeed(undefined),
            events
              .streamApplicationEvents({ afterSequence })
              .pipe(
                Stream.filter(
                  (stored) =>
                    "event" in stored &&
                    (stored.event.type === "run.created" || stored.event.type === "run.updated"),
                ),
              ),
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => hasActiveRun),
      // A failed subscription resubscribes, which re-reads the cursor and the snapshot.
      Stream.tapCause((cause) =>
        Effect.logWarning("keep-awake run event stream failed", { cause }),
      ),
      Stream.retry(backoff),
    );

    const enabled = Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        const current = yield* settings.getSettings.pipe(
          Effect.map((value) => value.keepAwakeWhileAgentsWork),
          Effect.orElseSucceed(() => false),
        );
        return Stream.concat(
          Stream.succeed(current),
          Stream.map(changes, (value) => value.keepAwakeWhileAgentsWork),
        );
      }),
    );

    const hold = holdInhibitor(spawner, command).pipe(
      retryWithBackoff("keep-awake sleep inhibitor stopped"),
      Effect.ignore,
    );

    yield* forkParked(
      holdWhen({ enabled, active, hold }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause })),
      ),
    );
  }),
);
