import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopServerStatus from "./DesktopServerStatus.ts";

export class DesktopServerRestartError extends Schema.TaggedError<DesktopServerRestartError>()(
  "DesktopServerRestartError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The local server's lifecycle commands the renderer can issue. A server the
 * app attached to is never stopped: the app does not own it.
 */
export class DesktopServerControl extends Context.Service<
  DesktopServerControl,
  {
    readonly restart: Effect.Effect<DesktopLocalServerStatus, DesktopServerRestartError>;
  }
>()("@houston-app/desktop/backend/DesktopServerControl") {}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const serverStatus = yield* DesktopServerStatus.DesktopServerStatus;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const logPath = DesktopBackendPool.primaryServerLogFilePath(environment);

  const restart = Effect.gen(function* () {
    const primary = yield* pool.primary;
    const snapshot = yield* primary.snapshot;
    if (snapshot.attached) {
      return yield* new DesktopServerRestartError({
        reason:
          "This Houston server was already running when the app opened, so the app does not own it and never stops it. Quit that server yourself, then reopen Houston.",
      });
    }

    yield* serverStatus.starting({
      baseDir: environment.baseDir,
      logPath,
      force: true,
    });
    // The old server issued the cached bearer; the replacement must exchange anew.
    yield* localAuth.invalidate;
    yield* primary.restart.pipe(
      Effect.mapError((error) => new DesktopServerRestartError({ reason: error.reason })),
    );

    const ready = yield* primary.waitForReady(
      DesktopBackendManager.DEFAULT_BACKEND_READINESS_TIMEOUT,
    );
    if (!ready) {
      const failure = yield* primary.lastStartupFailure;
      const reason = Option.match(failure, {
        onNone: () =>
          `The local server did not become ready within ${Duration.toSeconds(DesktopBackendManager.DEFAULT_BACKEND_READINESS_TIMEOUT)} seconds.`,
        onSome: (value) => value.reason,
      });
      yield* serverStatus.fail({
        baseDir: environment.baseDir,
        logPath,
        error: reason,
      });
      return yield* new DesktopServerRestartError({ reason });
    }

    return yield* Effect.fromOption(
      yield* serverStatus.get,
      () =>
        new DesktopServerRestartError({
          reason: "The local server reported ready but published no status.",
        }),
    );
  }).pipe(Effect.withSpan("desktop.serverControl.restart"));

  return DesktopServerControl.of({ restart });
});

export const layer = Layer.effect(DesktopServerControl, make);
