import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { DesktopWslState } from "@houston-app/contracts";
import * as NetService from "@houston-app/shared/Net";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerControl from "../backend/DesktopServerControl.ts";
import type {
  BackendInstanceSpec,
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";
import * as DesktopWslServerAttachment from "./DesktopWslServerAttachment.ts";
import { getWslState } from "../ipc/methods/wsl.ts";

function makeStubInstance(input: {
  readonly id: DesktopBackendPool.BackendInstanceId;
  readonly label: string;
  readonly snapshot: DesktopBackendSnapshot;
  readonly start?: Effect.Effect<void>;
}): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: input.id,
    label: Effect.succeed(input.label),
    start: input.start ?? Effect.void,
    stop: () => Effect.void,
    restart: Effect.die("unexpected restart"),
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
    lastStartupFailure: Effect.succeedNone,
  };
}

const primarySnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
  attached: false,
};

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerBackendConfiguration = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.die("unexpected currentBootstrapToken"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const layerWslServerAttachment = Layer.succeed(
  DesktopWslServerAttachment.DesktopWslServerAttachment,
  DesktopWslServerAttachment.DesktopWslServerAttachment.of({
    resolve: () =>
      Effect.succeed({
        _tag: "NoRecord",
        recordPath: "/home/ubuntu/.houston/v2/userdata/server-runtime.json",
      }),
  }),
);

const layerServerControl = Layer.succeed(DesktopServerControl.DesktopServerControl, {
  restart: Effect.die("unexpected restart"),
} satisfies DesktopServerControl.DesktopServerControl["Service"]);

const layerEnvironment = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "win32",
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const layerNet = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
} satisfies NetService.NetService["Service"]);

describe("DesktopWslBackend", () => {
  it.effect("never registers a server inside a distro", () => {
    let registerCount = 0;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.succeed([primary]),
      primary: Effect.succeed(primary),
      register: () =>
        Effect.sync(() => {
          registerCount += 1;
        }).pipe(Effect.andThen(Effect.die("the WSL backend must not start"))),
      unregister: () => Effect.void,
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      yield* backend.reconcile;

      assert.equal(registerCount, 0);
      assert.deepEqual(yield* backend.lastPreflightError, Option.none());
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layerTest({ startEnabled: false }).pipe(
          Layer.provideMerge(layerPool),
          Layer.provideMerge(layerBackendConfiguration),
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(layerServerControl),
          Layer.provideMerge(layerNet),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
          Layer.provideMerge(layerWslServerAttachment),
        ),
      ),
    );
  });

  it.effect("reports a WSL startup failure through getWslState and clears it when ready", () => {
    let capturedSpec: BackendInstanceSpec | null = null;
    const primary = makeStubInstance({
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: "Windows",
      snapshot: primarySnapshot,
    });
    const wslInstance = makeStubInstance({
      id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
      label: "WSL (Ubuntu)",
      snapshot: {
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
        attached: false,
      },
    });
    const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
      get: (id) =>
        Effect.succeed(
          id === DesktopBackendPool.PRIMARY_INSTANCE_ID
            ? Option.some(primary)
            : id === wslInstance.id
              ? Option.some(wslInstance)
              : Option.none<DesktopBackendPool.DesktopBackendInstance>(),
        ),
      list: Effect.succeed([primary]),
      primary: Effect.succeed(primary),
      register: (spec) =>
        Effect.sync(() => {
          capturedSpec = spec;
          return wslInstance;
        }),
      unregister: () => Effect.void,
    } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;

      yield* backend.reconcile;
      assert.isTrue(capturedSpec !== null);
      if (capturedSpec === null) return;
      const spec = capturedSpec;

      yield* spec.onStarting?.() ?? Effect.void;
      yield* (
        spec.onStartupFailure?.({
          reason: "The Houston state directory in Ubuntu is owned by PID 4242 in distro Ubuntu.",
          output: "",
        }) ?? Effect.void
      );

      const failed = (yield* getWslState.handler(undefined)) as DesktopWslState;
      assert.equal(failed.backendStatus.phase, "failed");
      assert.include(
        failed.backendStatus.reason ?? "",
        "The Houston state directory in Ubuntu is owned by PID 4242 in distro Ubuntu.",
      );

      yield* spec.onReady?.(new URL("http://127.0.0.1:41773"), 4242) ?? Effect.void;

      const ready = (yield* getWslState.handler(undefined)) as DesktopWslState;
      assert.equal(ready.backendStatus.phase, "ready");
      assert.isNull(ready.backendStatus.reason);
    }).pipe(
      Effect.provide(
        DesktopWslBackend.layerTest().pipe(
          Layer.provideMerge(layerPool),
          Layer.provideMerge(layerBackendConfiguration),
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(layerServerControl),
          Layer.provideMerge(layerNet),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              wslBackendEnabled: true,
              wslDistro: "Ubuntu",
              wslOnly: false,
            }),
          ),
          Layer.provideMerge(
            DesktopWslEnvironment.layerTest({
              isAvailable: true,
              distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
            }),
          ),
          Layer.provideMerge(layerWslServerAttachment),
        ),
      ),
    );
  });
});
