// @effect-diagnostics nodeBuiltinImport:off - the keep-awake child is a plain process on a pipe.
// Keeps the machine awake while a run is live with a child that holds the platform's inhibitor
// until its stdin closes: at settle, or when the server exits and the pipe closes with it.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface KeepAwakeChild {
  readonly closeStdin: () => void;
  readonly kill: () => void;
  readonly alive: () => boolean;
}

/** Starts the child; throws when it cannot start. Tests replace it. */
export type KeepAwakeSpawn = (command: string, args: ReadonlyArray<string>) => KeepAwakeChild;

const spawnChild: KeepAwakeSpawn = (command, args) => {
  const child = NodeChildProcess.spawn(command, [...args], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  if (child.pid === undefined) throw new Error(`${command} could not be started`);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  return {
    closeStdin: () => child.stdin?.end(),
    kill: () => {
      child.kill();
    },
    alive: () => !exited,
  };
};

export const KeepAwakeSpawner = Context.Reference<KeepAwakeSpawn>(
  "houston/houston/nightShift/KeepAwake/KeepAwakeSpawner",
  { defaultValue: () => spawnChild },
);

/** How long a released child has to exit after its stdin closes before it is killed. */
const RELEASE_GRACE_MS = 5_000;

const WINDOWS_SCRIPT = [
  "$signature = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
  "$power = Add-Type -MemberDefinition $signature -Name Power -Namespace HoustonNightShift -PassThru",
  "[void]$power::SetThreadExecutionState([uint32]'0x80000001')",
  "[void][Console]::In.ReadToEnd()",
].join("; ");

/** The child for `platform`, or null where keeping awake is not supported. */
export const keepAwakeCommand = (
  platform: NodeJS.Platform,
  runId: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } | null => {
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=Houston",
        `--why=Night shift run ${runId}`,
        "--mode=block",
        "cat",
      ],
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
    };
  }
  return null;
};

export class NightShiftKeepAwake extends Context.Service<
  NightShiftKeepAwake,
  {
    /** `held`, or `unavailable: <why>` when the child could not start; the run continues either way. */
    readonly take: (runId: number) => Effect.Effect<string>;
    /** Closes the child's stdin and kills it if it is still alive after 5 seconds. */
    readonly release: (runId: number) => Effect.Effect<void>;
  }
>()("houston/houston/nightShift/KeepAwake/NightShiftKeepAwake") {}

export const layer = Layer.effect(
  NightShiftKeepAwake,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const spawn = yield* KeepAwakeSpawner;
    const held = yield* Ref.make<ReadonlyMap<number, KeepAwakeChild>>(new Map());

    const release = Effect.fn("NightShiftKeepAwake.release")(function* (runId: number) {
      const child = (yield* Ref.get(held)).get(runId);
      if (child === undefined) return;
      yield* Ref.update(held, (current) => {
        const next = new Map(current);
        next.delete(runId);
        return next;
      });
      child.closeStdin();
      for (let waited = 0; waited < RELEASE_GRACE_MS && child.alive(); waited += 100) {
        yield* Effect.sleep("100 millis");
      }
      if (child.alive()) child.kill();
    });

    // A server exit closes every pipe, which releases each inhibitor.
    yield* Effect.addFinalizer(() =>
      Ref.get(held).pipe(
        Effect.map((children) => {
          for (const child of children.values()) {
            child.closeStdin();
            child.kill();
          }
        }),
      ),
    );

    return NightShiftKeepAwake.of({
      take: Effect.fn("NightShiftKeepAwake.take")(function* (runId) {
        if ((yield* Ref.get(held)).has(runId)) return "held";
        const command = keepAwakeCommand(platform, runId);
        if (command === null) return `unavailable: keeping ${platform} awake is not supported`;
        const started = yield* Effect.try({
          try: () => spawn(command.command, command.args),
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }).pipe(Effect.result);
        if (started._tag === "Failure") return `unavailable: ${started.failure}`;
        yield* Ref.update(held, (current) => new Map(current).set(runId, started.success));
        return "held";
      }),
      release,
    });
  }),
);
