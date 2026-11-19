import { assert, describe, it } from "@effect/vitest";
import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NetService from "@houston-app/shared/Net";

import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopServerControl from "../backend/DesktopServerControl.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "./DesktopWslEnvironment.ts";
import * as DesktopWslBackend from "./DesktopWslBackend.ts";
import * as DesktopWslServerAttachment from "./DesktopWslServerAttachment.ts";

const READY_STATUS: DesktopLocalServerStatus = {
  state: "ready",
  origin: "http://127.0.0.1:3773",
  port: 3773,
  pid: 4243,
  attached: false,
  baseDir: "/houston/v2",
};

const snapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(123),
  restartAttempt: 0,
  restartScheduled: false,
  attached: false,
};

function makeInstance(
  id: DesktopBackendPool.BackendInstanceId,
): DesktopBackendPool.DesktopBackendInstance {
  return {
    id,
    label: Effect.succeed(id),
    start: Effect.void,
    stop: () => Effect.void,
    restart: Effect.die("unexpected restart"),
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(true),
    lastStartupFailure: Effect.succeedNone,
  };
}

interface Harness {
  readonly instances: DesktopBackendPool.DesktopBackendInstance[];
  readonly counters: {
    restarts: number;
    registered: string[];
    unregistered: string[];
  };
}

function harness(existing: ReadonlyArray<DesktopBackendPool.BackendInstanceId> = []): Harness {
  const primary = makeInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID);
  const instances = [primary, ...existing.map((id) => makeInstance(id))];
  return {
    instances,
    counters: { restarts: 0, registered: [], unregistered: [] },
  };
}

const layerPool = (test: Harness) =>
  Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    get: (id) =>
      Effect.succeed(Option.fromNullishOr(test.instances.find((instance) => instance.id === id))),
    list: Effect.sync(() => [...test.instances] as const),
    primary: Effect.succeed(test.instances[0]!),
    register: (spec) =>
      Effect.sync(() => {
        test.counters.registered.push(spec.id);
        const instance = makeInstance(spec.id);
        test.instances.push(instance);
        return instance;
      }),
    unregister: (id) =>
      Effect.sync(() => {
        test.counters.unregistered.push(id);
        const index = test.instances.findIndex((instance) => instance.id === id);
        if (index >= 0) test.instances.splice(index, 1);
      }),
  } satisfies DesktopBackendPool.DesktopBackendPool["Service"]);

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

const layerNet = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
} satisfies NetService.NetService["Service"]);

const layerServerControl = (test: Harness) =>
  Layer.succeed(DesktopServerControl.DesktopServerControl, {
    restart: Effect.sync(() => {
      test.counters.restarts += 1;
      return READY_STATUS;
    }),
  } satisfies DesktopServerControl.DesktopServerControl["Service"]);

const layerFor = (input: {
  readonly test: Harness;
  readonly settings: DesktopAppSettings.DesktopSettings;
}) =>
  DesktopWslBackend.layer.pipe(
    Layer.provideMerge(layerPool(input.test)),
    Layer.provideMerge(layerBackendConfiguration),
    Layer.provideMerge(layerServerExposure),
    Layer.provideMerge(layerServerControl(input.test)),
    Layer.provideMerge(layerNet),
    Layer.provideMerge(DesktopAppSettings.layerTest(input.settings)),
    Layer.provideMerge(
      DesktopWslEnvironment.layerTest({
        isAvailable: true,
        distros: [
          { name: "Ubuntu", isDefault: true, version: 2 },
          { name: "Debian", isDefault: false, version: 2 },
        ],
      }),
    ),
    Layer.provideMerge(layerWslServerAttachment),
  );

const baseSettings: DesktopAppSettings.DesktopSettings = {
  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
  wslBackendEnabled: true,
  wslDistro: "Ubuntu",
};

describe("DesktopWslBackend settings changes", () => {
  it.effect("restarts the primary once and tears down the secondary when WSL-only turns on", () => {
    const test = harness([DesktopBackendPool.BackendInstanceId("wsl:Ubuntu")]);
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.applyWslOnly(true);

      assert.strictEqual(test.counters.restarts, 1);
      assert.deepStrictEqual(test.counters.unregistered, ["wsl:Ubuntu"]);
      assert.deepStrictEqual(test.counters.registered, []);
    }).pipe(Effect.provide(layerFor({ test, settings: baseSettings })));
  });

  it.effect("restarts the primary and registers the secondary when WSL-only turns off", () => {
    const test = harness();
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.applyWslOnly(false);

      assert.strictEqual(test.counters.restarts, 1);
      assert.deepStrictEqual(test.counters.unregistered, []);
      assert.deepStrictEqual(test.counters.registered, ["wsl:Ubuntu"]);
    }).pipe(Effect.provide(layerFor({ test, settings: { ...baseSettings, wslOnly: true } })));
  });

  it.effect("does nothing when WSL-only already has the requested value", () => {
    const test = harness();
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.applyWslOnly(false);

      assert.strictEqual(test.counters.restarts, 0);
      assert.deepStrictEqual(test.counters.unregistered, []);
      assert.deepStrictEqual(test.counters.registered, []);
    }).pipe(Effect.provide(layerFor({ test, settings: baseSettings })));
  });

  it.effect("reconciles the secondary onto the new distro without restarting the primary", () => {
    const test = harness([DesktopBackendPool.BackendInstanceId("wsl:Ubuntu")]);
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.applyWslDistro("Debian");

      assert.strictEqual(test.counters.restarts, 0);
      assert.deepStrictEqual(test.counters.unregistered, ["wsl:Ubuntu"]);
      assert.deepStrictEqual(test.counters.registered, ["wsl:Debian"]);
    }).pipe(Effect.provide(layerFor({ test, settings: baseSettings })));
  });

  it.effect("restarts the primary when the distro changes under WSL-only", () => {
    const test = harness();
    return Effect.gen(function* () {
      const backend = yield* DesktopWslBackend.DesktopWslBackend;
      yield* backend.applyWslDistro("Debian");

      assert.strictEqual(test.counters.restarts, 1);
      assert.deepStrictEqual(test.counters.registered, []);
    }).pipe(Effect.provide(layerFor({ test, settings: { ...baseSettings, wslOnly: true } })));
  });

  it.effect(
    "restarts the primary back to Windows when WSL-only is disabled with the backend",
    () => {
      const test = harness();
      return Effect.gen(function* () {
        const backend = yield* DesktopWslBackend.DesktopWslBackend;
        yield* backend.applyWslBackendEnabled(false);

        assert.strictEqual(test.counters.restarts, 1);
        assert.deepStrictEqual(test.counters.unregistered, []);
        assert.deepStrictEqual(test.counters.registered, []);
      }).pipe(Effect.provide(layerFor({ test, settings: { ...baseSettings, wslOnly: true } })));
    },
  );
});
