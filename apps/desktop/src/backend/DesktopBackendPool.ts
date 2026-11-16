import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopServerAttachment from "./DesktopServerAttachment.ts";
import * as DesktopServerStatus from "./DesktopServerStatus.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const { logWarning: logBackendPoolWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-pool");

export type BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const BackendInstanceId = DesktopBackendManager.BackendInstanceId;
export const PRIMARY_INSTANCE_ID = DesktopBackendManager.PRIMARY_INSTANCE_ID;
export type DesktopBackendInstance = DesktopBackendManager.DesktopBackendInstance;
export type BackendInstanceSpec = DesktopBackendManager.BackendInstanceSpec;

/** The primary instance's output log, named by the server status banner on failure. */
export const primaryServerLogFilePath = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string => environment.path.join(environment.logDir, "server-child.log");

export class DesktopBackendPoolInstanceAlreadyRegisteredError extends Schema.TaggedError<DesktopBackendPoolInstanceAlreadyRegisteredError>()(
  "DesktopBackendPoolInstanceAlreadyRegisteredError",
  {
    id: Schema.String,
  },
) {
  override get message() {
    return `Backend instance "${this.id}" is already registered in the pool.`;
  }
}

export class DesktopBackendPoolCannotUnregisterPrimaryError extends Schema.TaggedError<DesktopBackendPoolCannotUnregisterPrimaryError>()(
  "DesktopBackendPoolCannotUnregisterPrimaryError",
  {},
) {
  override get message() {
    return "Refusing to unregister the primary backend from the pool.";
  }
}

export class DesktopBackendPool extends Context.Service<
  DesktopBackendPool,
  {
    readonly get: (id: BackendInstanceId) => Effect.Effect<Option.Option<DesktopBackendInstance>>;
    readonly list: Effect.Effect<readonly DesktopBackendInstance[]>;
    readonly primary: Effect.Effect<DesktopBackendInstance>;
    readonly register: (
      spec: BackendInstanceSpec,
    ) => Effect.Effect<DesktopBackendInstance, DesktopBackendPoolInstanceAlreadyRegisteredError>;
    readonly unregister: (
      id: BackendInstanceId,
    ) => Effect.Effect<void, DesktopBackendPoolCannotUnregisterPrimaryError>;
  }
>()("@houston-app/desktop/backend/DesktopBackendPool") {}

export type BackendInstanceFactoryRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBrowserHost.DesktopBrowserHost
  | DesktopWslEnvironment.DesktopWslEnvironment;

interface ActiveRegisteredInstance {
  readonly _tag: "Active";
  readonly instance: DesktopBackendInstance;
  readonly scope: Option.Option<Scope.Closeable>;
}

interface ClosingRegisteredInstance {
  readonly _tag: "Closing";
  readonly done: Deferred.Deferred<void>;
}

type RegisteredInstance = ActiveRegisteredInstance | ClosingRegisteredInstance;

type RegisterAction =
  | { readonly _tag: "Registered"; readonly instance: DesktopBackendInstance }
  | { readonly _tag: "Wait"; readonly done: Deferred.Deferred<void> };

type UnregisterAction =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Wait"; readonly done: Deferred.Deferred<void> }
  | { readonly _tag: "Close"; readonly entry: ActiveRegisteredInstance };

const serverAttachmentFailureMessage = (
  failure: DesktopServerAttachment.ServerAttachmentFailure,
): string => {
  switch (failure._tag) {
    case "NoRecord":
      return `No running server record was found at ${failure.recordPath}, so Houston cannot tell which server owns ${failure.stateDir}. Stop the other server or remove the stale record, then reopen Houston.`;
    case "Dead":
      return `The record at ${failure.recordPath} names pid ${failure.pid}, but that process is not running, and Houston cannot take over ${failure.stateDir} while the record is present. Stop or remove the stale server, then reopen Houston.`;
    case "Unhealthy":
      return `The server recorded at ${failure.recordPath} (pid ${failure.pid}, origin ${failure.origin}) does not answer its health endpoint, so Houston cannot use ${failure.stateDir}. Stop that server or fix its health, then reopen Houston.`;
    case "InvalidOrigin":
      return `The server recorded at ${failure.recordPath} (pid ${failure.pid}) has origin ${JSON.stringify(failure.origin)}, which is not an HTTP origin. Stop that server, then reopen Houston.`;
  }
};

export const layer = Layer.effect(
  DesktopBackendPool,
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const electronApp = yield* ElectronApp.ElectronApp;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const serverAttachment = yield* DesktopServerAttachment.DesktopServerAttachment;
    const serverStatus = yield* DesktopServerStatus.DesktopServerStatus;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const { primaryBackendStartup } = yield* DesktopState.DesktopState;
    // The primary instance's output log, which the status banner names on failure.
    const primaryServerLogPath = primaryServerLogFilePath(environment);
    // Parent instance scopes to the pool so shutdown runs stop finalizers before the OS kills backends.
    const layerScope = yield* Scope.Scope;
    const factoryContext = yield* Effect.context<BackendInstanceFactoryRequirements>();

    // Persist fatal Windows fallbacks; transient transport failures must preserve the user's WSL preference.
    const handlePrimaryPreflightFailure = Effect.fn("desktop.backendPool.primaryPreflightFailed")(
      function* (failure: DesktopBackendManager.PreflightFailure) {
        const { reason, fatal } = failure;
        if (!fatal) {
          yield* logBackendPoolWarning(
            "primary WSL preflight retry window exhausted; using Windows for this launch",
            { reason },
          );
          yield* electronDialog.showErrorBox(
            "WSL backend is still unavailable",
            `${reason}\n\nHouston will use the Windows backend for this launch and retry WSL the next time the app starts.`,
          );
          yield* appSettings.applyWslWindowsFallbackInMemory;
          return true;
        }

        yield* logBackendPoolWarning("primary WSL preflight failed; falling back to Windows", {
          reason,
        });
        yield* electronDialog.showErrorBox(
          "WSL backend couldn't start",
          `${reason}\n\nFalling back to the Windows backend so Houston can open. Re-enable the WSL backend from Settings > Sharing & access once the WSL distro is fixed.`,
        );
        // Clear wslOnly too so enabling WSL cannot restore a failed mode.
        // Keep the in-memory fallback if persistence fails.
        yield* appSettings.applyWslWindowsFallback.pipe(
          Effect.catch((error) =>
            logBackendPoolWarning(
              "failed to persist Windows fallback after WSL preflight failure",
              {
                error: error.message,
              },
            ).pipe(Effect.andThen(appSettings.applyWslWindowsFallbackInMemory)),
          ),
        );
        return true;
      },
    );

    const primary = yield* DesktopBackendManager.makeBackendInstance({
      id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
      // Resolve lazily: startup loads persisted settings after pool initialization.
      label: configuration.resolvePrimaryLabel,
      configResolve: configuration.resolvePrimary,
      onStarting: () =>
        serverStatus.starting({
          baseDir: environment.baseDir,
          logPath: primaryServerLogPath,
        }),
      // Absorb window errors so readiness can reset restartAttempt.
      onReady: Effect.fn("desktop.backendPool.onReady")(function* (httpBaseUrl, pid) {
        yield* serverStatus.publish({
          state: "ready",
          origin: httpBaseUrl.origin,
          port: Number(httpBaseUrl.port),
          ...(pid === null ? {} : { pid }),
          attached: false,
          baseDir: environment.baseDir,
          logPath: primaryServerLogPath,
        });
        // Only once the main window exists, so the recovery window never closes into nothing.
        yield* desktopWindow.handleBackendReady(httpBaseUrl).pipe(
          Effect.andThen(SubscriptionRef.set(primaryBackendStartup, { _tag: "Ready" })),
          Effect.catch((error) =>
            logBackendPoolWarning("failed to open main window after backend readiness", {
              error: error.message,
            }),
          ),
        );
      }),
      onStartupFailure: (failure) =>
        serverStatus
          .fail({
            baseDir: environment.baseDir,
            logPath: primaryServerLogPath,
            error: failure.reason,
          })
          .pipe(
            Effect.andThen(
              SubscriptionRef.set(primaryBackendStartup, { _tag: "Failing", ...failure }),
            ),
          ),
      onShutdown: () => desktopWindow.handleBackendNotReady,
      onPreflightFailed: handlePrimaryPreflightFailure,
      onStateDirOwned: Effect.fn("desktop.backendPool.onStateDirOwned")(function* () {
        const result = yield* serverAttachment.resolve;
        if (result._tag === "Attached") {
          yield* logBackendPoolWarning("attaching to a server that owns the state directory", {
            pid: result.server.pid,
            origin: result.server.origin,
            versionSkew: result.server.versionSkew,
          });
          return Option.some({
            config: result.config,
            httpBaseUrl: new URL(result.server.origin),
            pid: result.server.pid,
            warning: result.warning,
          } satisfies DesktopBackendManager.DesktopBackendAttachment);
        }
        yield* electronDialog.showErrorBox(
          "This Houston home is unavailable",
          serverAttachmentFailureMessage(result),
        );
        yield* electronApp.quit;
        return Option.none<DesktopBackendManager.DesktopBackendAttachment>();
      }),
      onAttached: (attachment) =>
        serverStatus.publish({
          state: "ready",
          origin: attachment.httpBaseUrl.origin,
          port: Number(attachment.httpBaseUrl.port),
          pid: attachment.pid,
          attached: true,
          baseDir: environment.baseDir,
          logPath: primaryServerLogPath,
          warning: Option.getOrNull(attachment.warning),
        }),
    });

    const instancesRef = yield* SynchronizedRef.make<
      ReadonlyMap<BackendInstanceId, RegisteredInstance>
    >(
      new Map([
        [
          DesktopBackendManager.PRIMARY_INSTANCE_ID,
          { _tag: "Active", instance: primary, scope: Option.none() },
        ],
      ]),
    );

    const register: DesktopBackendPool["Service"]["register"] = (spec) =>
      Effect.suspend(() =>
        SynchronizedRef.modifyEffect(
          instancesRef,
          (
            current,
          ): Effect.Effect<
            readonly [RegisterAction, ReadonlyMap<BackendInstanceId, RegisteredInstance>],
            DesktopBackendPoolInstanceAlreadyRegisteredError
          > => {
            const existing = current.get(spec.id);
            if (existing?._tag === "Active") {
              return Effect.fail(
                new DesktopBackendPoolInstanceAlreadyRegisteredError({ id: spec.id }),
              );
            }
            if (existing?._tag === "Closing") {
              return Effect.succeed([
                { _tag: "Wait", done: existing.done } as const,
                current,
              ] as const);
            }
            return Effect.gen(function* () {
              // Provide the child Scope last so the captured pool Scope cannot shadow it and orphan stop/restart finalizers.
              const instanceScope = yield* Scope.fork(layerScope, "sequential");
              const instance = yield* DesktopBackendManager.makeBackendInstance(spec).pipe(
                Scope.provide(instanceScope),
                Effect.provide(factoryContext),
              );
              const next = new Map(current);
              next.set(spec.id, {
                _tag: "Active",
                instance,
                scope: Option.some(instanceScope),
              });
              return [
                { _tag: "Registered", instance } as const,
                next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
              ] as const;
            });
          },
        ).pipe(
          Effect.flatMap((result) =>
            result._tag === "Registered"
              ? Effect.succeed(result.instance)
              : Deferred.await(result.done).pipe(Effect.andThen(register(spec))),
          ),
        ),
      );

    const unregister: DesktopBackendPool["Service"]["unregister"] = Effect.fn(
      "DesktopBackendPool.unregister",
    )(function* (id) {
      if (id === DesktopBackendManager.PRIMARY_INSTANCE_ID) {
        return yield* new DesktopBackendPoolCannotUnregisterPrimaryError();
      }
      const done = yield* Deferred.make<void>();
      const action = yield* SynchronizedRef.modifyEffect(
        instancesRef,
        (
          current,
        ): Effect.Effect<
          readonly [UnregisterAction, ReadonlyMap<BackendInstanceId, RegisteredInstance>]
        > => {
          const entry = current.get(id);
          if (entry === undefined) {
            return Effect.succeed([{ _tag: "Absent" } as const, current] as const);
          }
          if (entry._tag === "Closing") {
            return Effect.succeed([{ _tag: "Wait", done: entry.done } as const, current] as const);
          }
          const next = new Map(current);
          next.set(id, { _tag: "Closing", done });
          return Effect.succeed([
            { _tag: "Close", entry } as const,
            next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
          ] as const);
        },
      );

      if (action._tag === "Absent") return;
      if (action._tag === "Wait") {
        yield* Deferred.await(action.done);
        return;
      }

      const finish = SynchronizedRef.modifyEffect(instancesRef, (current) => {
        const closing = current.get(id);
        if (closing?._tag !== "Closing" || closing.done !== done) {
          return Effect.succeed([undefined, current] as const);
        }
        const next = new Map(current);
        next.delete(id);
        return Effect.succeed([
          undefined,
          next as ReadonlyMap<BackendInstanceId, RegisteredInstance>,
        ] as const);
      }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid);
      yield* Option.match(action.entry.scope, {
        onNone: () => Effect.void,
        onSome: (scope) => Scope.close(scope, Exit.void).pipe(Effect.ignore),
      }).pipe(Effect.ensuring(finish));
    });

    return DesktopBackendPool.of({
      get: Effect.fn("DesktopBackendPool.get")(function (id) {
        return SynchronizedRef.get(instancesRef).pipe(
          Effect.map((instances) => {
            const entry = instances.get(id);
            return entry?._tag === "Active" ? Option.some(entry.instance) : Option.none();
          }),
        );
      }),
      list: SynchronizedRef.get(instancesRef).pipe(
        Effect.map((instances) =>
          Array.from(instances.values()).flatMap((entry) =>
            entry._tag === "Active" ? [entry.instance] : [],
          ),
        ),
      ),
      primary: Effect.succeed(primary),
      register,
      unregister,
    });
  }),
);

export const layerTest = (
  instances: readonly DesktopBackendInstance[],
): Layer.Layer<DesktopBackendPool> =>
  Layer.effect(
    DesktopBackendPool,
    Effect.gen(function* () {
      if (instances.length === 0) {
        return yield* Effect.die("DesktopBackendPool.layerTest requires at least one instance");
      }
      const byId = new Map<BackendInstanceId, DesktopBackendInstance>(
        instances.map((instance) => [instance.id, instance] as const),
      );
      const primary = instances[0]!;
      return DesktopBackendPool.of({
        get: Effect.fn("DesktopBackendPool.get")(function (id) {
          return Effect.succeed(Option.fromNullishOr(byId.get(id)));
        }),
        list: Effect.succeed(Array.from(byId.values())),
        primary: Effect.succeed(primary),
        register: Effect.fn("DesktopBackendPool.register")(function () {
          return Effect.die("DesktopBackendPool.layerTest does not support register");
        }),
        unregister: Effect.fn("DesktopBackendPool.unregister")(function () {
          return Effect.die("DesktopBackendPool.layerTest does not support unregister");
        }),
      });
    }),
  );
