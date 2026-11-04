// @effect-diagnostics nodeBuiltinImport:off -- the helper is a native binary spawned through Node before the app is ready.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DesktopV1CleanupReportSchema, type DesktopV1CleanupReport } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const BINARY_NAME = "houston-v1-cleanup";
// The helper bounds each `claude mcp remove` at 15 s; several providers may still need this.
const RUN_TIMEOUT_MS = 60_000;
const MAX_REPORT_BYTES = 1024 * 1024;

const { logWarning } = makeComponentLogger("desktop-v1-cleanup");

export class DesktopV1CleanupBinaryNotFoundError extends Schema.TaggedError<DesktopV1CleanupBinaryNotFoundError>()(
  "DesktopV1CleanupBinaryNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The Houston 1 cleanup helper was not found; looked for ${this.paths.map((path) => `"${path}"`).join(", ")}.`;
  }
}

export class DesktopV1CleanupRunError extends Schema.TaggedError<DesktopV1CleanupRunError>()(
  "DesktopV1CleanupRunError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
    stderr: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const exit = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    const detail = this.stderr.trim() || (this.cause instanceof Error ? this.cause.message : "");
    return `The Houston 1 cleanup helper at "${this.binaryPath}"${exit} failed${detail ? `: ${detail}` : "."}`;
  }
}

export class DesktopV1CleanupReportParseError extends Schema.TaggedError<DesktopV1CleanupReportParseError>()(
  "DesktopV1CleanupReportParseError",
  { binaryPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The Houston 1 cleanup helper at "${this.binaryPath}" did not return a valid report: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

export type DesktopV1CleanupError =
  | DesktopV1CleanupBinaryNotFoundError
  | DesktopV1CleanupRunError
  | DesktopV1CleanupReportParseError;

const isBinaryNotFoundError = Schema.is(DesktopV1CleanupBinaryNotFoundError);
const isRunError = Schema.is(DesktopV1CleanupRunError);
const isReportParseError = Schema.is(DesktopV1CleanupReportParseError);
const decodeReport = Schema.decodeSync(Schema.fromJsonString(DesktopV1CleanupReportSchema));

export interface DesktopV1CleanupRunner {
  run(
    binaryPath: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface DesktopV1CleanupBinaryInput {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appRoot: string;
  readonly platform: NodeJS.Platform;
}

/** Packaged builds carry the helper in resources; development uses the crate's target dir. */
export function v1CleanupBinaryCandidates(input: DesktopV1CleanupBinaryInput): readonly string[] {
  const name = input.platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
  if (input.isPackaged) return [NodePath.join(input.resourcesPath, name)];
  const crateDir = NodePath.join(input.appRoot, "apps/desktop/native/houston-v1-cleanup");
  return [
    NodePath.join(crateDir, "target", "release", name),
    NodePath.join(crateDir, "target", "debug", name),
  ];
}

export function resolveV1CleanupBinary(
  input: DesktopV1CleanupBinaryInput & {
    readonly exists: (path: string) => boolean;
  },
): string {
  const candidates = v1CleanupBinaryCandidates(input);
  const found = candidates.find(input.exists);
  if (found === undefined) {
    throw new DesktopV1CleanupBinaryNotFoundError({ paths: [...candidates] });
  }
  return found;
}

export function v1CleanupArguments(input: {
  readonly homeDirectory: string;
  readonly channel: Option.Option<string>;
}): readonly string[] {
  return Option.match(input.channel, {
    onNone: () => ["--home", input.homeDirectory],
    onSome: (channel) => ["--home", input.homeDirectory, "--channel", channel],
  });
}

export function parseV1CleanupReport(binaryPath: string, stdout: string): DesktopV1CleanupReport {
  try {
    return decodeReport(stdout.trim());
  } catch (cause) {
    throw new DesktopV1CleanupReportParseError({ binaryPath, cause });
  }
}

export async function runV1Cleanup(input: {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly runner: DesktopV1CleanupRunner;
}): Promise<DesktopV1CleanupReport> {
  let result: { readonly stdout: string; readonly stderr: string };
  try {
    result = await input.runner.run(input.binaryPath, input.args);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    throw new DesktopV1CleanupRunError({
      binaryPath: input.binaryPath,
      ...(typeof error.code === "number" ? { exitCode: error.code } : {}),
      stderr: error.stderr ?? "",
      cause,
    });
  }
  return parseV1CleanupReport(input.binaryPath, result.stdout);
}

export const nodeV1CleanupRunner: DesktopV1CleanupRunner = {
  run: (binaryPath, args) =>
    new Promise((resolve, reject) => {
      NodeChildProcess.execFile(
        binaryPath,
        [...args],
        { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_REPORT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(Object.assign(error, { stderr }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    }),
};

export class DesktopV1Cleanup extends Context.Service<
  DesktopV1Cleanup,
  {
    readonly getReport: Effect.Effect<Option.Option<DesktopV1CleanupReport>, DesktopV1CleanupError>;
  }
>()("@houston-app/desktop/app/DesktopV1Cleanup") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const cached = yield* Ref.make<Option.Option<Option.Option<DesktopV1CleanupReport>>>(
    Option.none(),
  );
  const mutex = yield* Semaphore.make(1);

  const loadReport = Effect.gen(function* () {
    // A development run must not edit the developer's real agent configs.
    if (!environment.isPackaged) {
      return Option.none<DesktopV1CleanupReport>();
    }
    const binaryPath = yield* Effect.try({
      try: () =>
        resolveV1CleanupBinary({
          isPackaged: environment.isPackaged,
          resourcesPath: environment.resourcesPath,
          appRoot: environment.appRoot,
          platform: environment.platform,
          exists: (path) => {
            try {
              return NodeFS.statSync(path).isFile();
            } catch {
              return false;
            }
          },
        }),
      catch: (cause) =>
        isBinaryNotFoundError(cause)
          ? cause
          : new DesktopV1CleanupBinaryNotFoundError({ paths: [] }),
    });
    const report = yield* Effect.tryPromise({
      try: () =>
        runV1Cleanup({
          binaryPath,
          args: v1CleanupArguments({
            homeDirectory: environment.homeDirectory,
            channel: environment.channel,
          }),
          runner: nodeV1CleanupRunner,
        }),
      catch: (cause) =>
        isRunError(cause) || isReportParseError(cause)
          ? cause
          : new DesktopV1CleanupRunError({
              binaryPath,
              stderr: "",
              cause,
            }),
    });
    return Option.some(report);
  }).pipe(Effect.withSpan("desktop.v1Cleanup.loadReport"));

  const getReport = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(cached);
      if (Option.isSome(current)) return current.value;
      const value = yield* loadReport;
      yield* Ref.set(cached, Option.some(value));
      return value;
    }),
  );

  yield* Effect.forkScoped(
    getReport.pipe(
      Effect.catchCause((cause) =>
        logWarning("Houston 1 cleanup did not run", {
          message: Cause.pretty(cause),
        }),
      ),
      Effect.asVoid,
    ),
  );

  return DesktopV1Cleanup.of({
    getReport: getReport.pipe(Effect.withSpan("desktop.v1Cleanup.getReport")),
  });
});

export const layer = Layer.effect(DesktopV1Cleanup, make);
