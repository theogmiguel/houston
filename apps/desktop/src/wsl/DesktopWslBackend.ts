import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as NetService from "@houston-app/shared/Net";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerControl from "../backend/DesktopServerControl.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslServerAttachment from "./DesktopWslServerAttachment.ts";
import { wslPrimarySelected, WSL_SERVER_START_ENABLED } from "./wslServerSupport.ts";

export const WSL_INSTANCE_ID_PREFIX = "wsl:";
const WSL_DEFAULT_DISTRO_ID = `${WSL_INSTANCE_ID_PREFIX}default`;
const MAX_TCP_PORT = 65_535;

export class DesktopWslBackend extends Context.Service<
  DesktopWslBackend,
  {
    readonly reconcile: Effect.Effect<void>;
    readonly lastPreflightError: Effect.Effect<Option.Option<string>>;
    readonly applyWslBackendEnabled: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError>;
    readonly applyWslOnly: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError>;
    readonly applyWslDistro: (
      distro: string | null,
    ) => Effect.Effect<void, DesktopAppSettings.DesktopSettingsWriteError>;
  }
>()("@houston-app/desktop/wsl/DesktopWslBackend") {}

const { logInfo: logWslBackendInfo, logWarning: logWslBackendWarning } =
  DesktopObservability.makeComponentLogger("desktop-wsl-backend");

const resolveTargetInstanceId = (distro: string | null): DesktopBackendPool.BackendInstanceId =>
  DesktopBackendPool.BackendInstanceId(
    distro === null ? WSL_DEFAULT_DISTRO_ID : `${WSL_INSTANCE_ID_PREFIX}${distro}`,
  );

const isWslInstanceId = (id: DesktopBackendPool.BackendInstanceId): boolean =>
  id.startsWith(WSL_INSTANCE_ID_PREFIX);

const buildLabel = (distro: string | null): string =>
  distro === null ? "WSL (default distro)" : `WSL (${distro})`;

// WSL auto-forwards loopback ports, so only IPv4 loopback availability matters.
const scanForWslPort = Effect.fn("desktop.wslBackend.scanForWslPort")(function* (
  startPort: number,
): Effect.fn.Return<number, NetService.NetError, NetService.NetService> {
  const net = yield* NetService.NetService;
  for (let port = startPort; port <= MAX_TCP_PORT; port += 1) {
    if (yield* net.canListenOnHost(port, "127.0.0.1")) {
      return port;
    }
  }
  return yield* new NetService.NetError({
    message: `No loopback port available for WSL backend between ${startPort} and ${MAX_TCP_PORT}.`,
  });
});

export const layer = Layer.effect(
  DesktopWslBackend,
  Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const serverControl = yield* DesktopServerControl.DesktopServerControl;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const wslServerAttachment = yield* DesktopWslServerAttachment.DesktopWslServerAttachment;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const net = yield* NetService.NetService;
    // Serialize bootstrap and IPC reconciles so concurrent reads cannot register competing WSL instances.
    const reconcileMutex = yield* Semaphore.make(1);

    const preflightErrorRef = yield* Ref.make(Option.none<string>());
    const ownershipRefusedRef = yield* Ref.make(
      Option.none<DesktopBackendPool.BackendInstanceId>(),
    );

    const findExistingWslInstance = pool.list.pipe(
      Effect.map((instances) => instances.find((instance) => isWslInstanceId(instance.id))),
      Effect.map(Option.fromNullishOr),
    );

    const stopExisting = (id: DesktopBackendPool.BackendInstanceId) =>
      pool.unregister(id).pipe(
        Effect.catchTags({
          DesktopBackendPoolCannotUnregisterPrimaryError: (cause) =>
            logWslBackendWarning("refusing to unregister primary as wsl instance", {
              id,
              error: cause.message,
            }),
        }),
      );

    const startNew = Effect.fn("desktop.wslBackend.startNew")(function* (input: {
      readonly distro: string | null;
    }) {
      const primaryConfig = yield* serverExposure.backendConfig;
      const port = yield* scanForWslPort(primaryConfig.port + 1).pipe(
        Effect.provideService(NetService.NetService, net),
        Effect.asSome,
        Effect.catch((error) =>
          logWslBackendWarning("could not allocate port for WSL backend", {
            error: error.message,
          }).pipe(Effect.as(Option.none<number>())),
        ),
      );

      if (Option.isNone(port)) {
        return;
      }
      const allocatedPort = port.value;

      const targetId = resolveTargetInstanceId(input.distro);
      yield* logWslBackendInfo("registering WSL backend with pool", {
        id: targetId,
        port: allocatedPort,
        distro: input.distro ?? null,
      });

      const instance = yield* pool
        .register({
          id: targetId,
          label: Effect.succeed(buildLabel(input.distro)),
          configResolve: configuration.resolveWsl({ port: allocatedPort, distro: input.distro }),
          onPreflightFailed: (failure) =>
            Ref.set(preflightErrorRef, Option.some(failure.reason)).pipe(Effect.as(false)),
          // A server that outlived the desktop still owns this distro's state. Attaching keeps
          // it running; refusing reports the reason instead of looping against its lock.
          attachBeforeSpawn: () =>
            wslServerAttachment
              .resolve({ distro: input.distro })
              .pipe(
                Effect.map((result) =>
                  result._tag === "Attached" ? Option.some(result.attachment) : Option.none(),
                ),
              ),
          onStateDirOwned: Effect.fn("desktop.wslBackend.onStateDirOwned")(function* () {
            const result = yield* wslServerAttachment.resolve({ distro: input.distro });
            if (result._tag === "Attached") {
              return { _tag: "Attached", attachment: result.attachment } as const;
            }
            yield* Ref.set(ownershipRefusedRef, Option.some(targetId));
            const reason =
              result._tag === "NoRecord"
                ? `The Houston state directory in ${DesktopWslServerAttachment.describeWslDistro(input.distro)} is owned by another process, but no server runtime record was found at ${result.recordPath}. Houston will not start another server there. Stop that server or pair with it, then reopen Houston.`
                : result.reason;
            return { _tag: "Unavailable", reason } as const;
          }),
          onAttached: (attachment) =>
            logWslBackendInfo("attached to a running WSL server", {
              pid: attachment.pid,
              origin: attachment.httpBaseUrl.origin,
              distro: input.distro ?? null,
            }),
          onStartupFailure: (failure) =>
            Ref.set(preflightErrorRef, Option.some(failure.reason)).pipe(Effect.asVoid),
          onReady: () =>
            Ref.set(ownershipRefusedRef, Option.none()).pipe(
              Effect.andThen(Ref.set(preflightErrorRef, Option.none())),
            ),
        })
        .pipe(
          Effect.asSome,
          Effect.catch((error) =>
            logWslBackendWarning("WSL backend already registered, skipping start", {
              id: targetId,
              error: error.message,
            }).pipe(Effect.as(Option.none<DesktopBackendPool.DesktopBackendInstance>())),
          ),
        );

      yield* Option.match(instance, {
        onNone: () => Effect.void,
        onSome: (registered) => registered.start,
      });
    });

    const reconcileBody = Effect.gen(function* () {
      const settings = yield* appSettings.get;
      if (!settings.localEnvironmentEnabled) return;
      const available = yield* wslEnvironment.isAvailable;
      const existing = yield* findExistingWslInstance;
      const existingId = Option.map(existing, (instance) => instance.id);

      // In wsl-only mode WSL is already primary; do not start a second backend on the same distro.
      const shouldRun =
        WSL_SERVER_START_ENABLED && settings.wslBackendEnabled && available && !settings.wslOnly;
      const targetId = shouldRun
        ? Option.some(resolveTargetInstanceId(settings.wslDistro))
        : Option.none<DesktopBackendPool.BackendInstanceId>();

      if (Option.isNone(targetId) && Option.isNone(existingId)) {
        return;
      }
      if (
        Option.isSome(targetId) &&
        Option.isSome(existing) &&
        targetId.value === existing.value.id
      ) {
        const existingInstance = existing.value;
        const snapshot = yield* existingInstance.snapshot;
        const isIdle =
          !snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled;
        if (isIdle) {
          const refused = yield* Ref.get(ownershipRefusedRef);
          if (Option.isSome(refused) && refused.value === existingInstance.id) return;
          yield* logWslBackendInfo("retrying idle WSL backend", { id: existingInstance.id });
          yield* Ref.set(preflightErrorRef, Option.none());
          yield* existingInstance.start;
        }
        return;
      }

      yield* Ref.set(preflightErrorRef, Option.none());
      yield* Ref.set(ownershipRefusedRef, Option.none());

      if (Option.isSome(existingId)) {
        yield* logWslBackendInfo("tearing down WSL backend", { id: existingId.value });
        yield* stopExisting(existingId.value);
      }

      if (Option.isSome(targetId)) {
        // Pre-warm WSL so readiness cannot race its cold start.
        yield* wslEnvironment.preWarm(settings.wslDistro);
        yield* startNew({ distro: settings.wslDistro });
      }
    });

    const reconcile = reconcileMutex
      .withPermits(1)(reconcileBody)
      .pipe(
        Effect.catchCause((cause) =>
          logWslBackendWarning("reconcile failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.withSpan("desktop.wslBackend.reconcile"),
      );

    const restartPrimary = serverControl.restart.pipe(
      Effect.asVoid,
      Effect.catchTags({
        DesktopServerRestartError: (error) =>
          logWslBackendWarning("could not restart the primary backend after a WSL setting change", {
            error: error.message,
          }),
      }),
    );

    // Persisting and applying share the reconcile mutex so a concurrent toggle cannot
    // compare against settings another toggle already replaced.
    const applySettingsChange = (
      update: Effect.Effect<
        DesktopAppSettings.DesktopSettingsChange,
        DesktopAppSettings.DesktopSettingsWriteError
      >,
    ) =>
      reconcileMutex.withPermits(1)(
        Effect.gen(function* () {
          const before = yield* appSettings.get;
          const change = yield* update;
          if (!change.changed) return;

          const after = change.settings;
          const available = yield* wslEnvironment.isAvailable;
          const beforeUsesWsl = wslPrimarySelected({
            wslBackendEnabled: before.wslBackendEnabled,
            wslOnly: before.wslOnly,
            available,
          });
          const afterUsesWsl = wslPrimarySelected({
            wslBackendEnabled: after.wslBackendEnabled,
            wslOnly: after.wslOnly,
            available,
          });
          const primaryNeedsRestart =
            beforeUsesWsl !== afterUsesWsl ||
            (afterUsesWsl && before.wslDistro !== after.wslDistro);

          // The WSL server holding a distro must release it before the primary claims it,
          // and the primary must leave a distro before the secondary starts there.
          if (afterUsesWsl) {
            yield* reconcileBody;
            if (primaryNeedsRestart) yield* restartPrimary;
          } else {
            if (primaryNeedsRestart) yield* restartPrimary;
            yield* reconcileBody;
          }
        }),
      );

    return DesktopWslBackend.of({
      reconcile,
      lastPreflightError: Ref.get(preflightErrorRef),
      applyWslBackendEnabled: Effect.fn("DesktopWslBackend.applyWslBackendEnabled")(
        function* (enabled) {
          yield* applySettingsChange(appSettings.setWslBackendEnabled(enabled));
        },
      ),
      applyWslOnly: Effect.fn("DesktopWslBackend.applyWslOnly")(function* (enabled) {
        yield* applySettingsChange(appSettings.setWslOnly(enabled));
      }),
      applyWslDistro: Effect.fn("DesktopWslBackend.applyWslDistro")(function* (distro) {
        yield* applySettingsChange(appSettings.setWslDistro(distro));
      }),
    });
  }),
);
