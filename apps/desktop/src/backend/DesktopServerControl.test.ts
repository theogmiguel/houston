import { assert, describe, it } from "@effect/vitest";
import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
  DesktopBackendInstance,
} from "./DesktopBackendManager.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopServerControl from "./DesktopServerControl.ts";
import * as DesktopServerStatus from "./DesktopServerStatus.ts";

const READY_STATUS: DesktopLocalServerStatus = {
  state: "ready",
  origin: "http://127.0.0.1:3773",
  port: 3773,
  pid: 4243,
  attached: false,
  baseDir: "/houston/v2",
};

const ATTACHED_STATUS: DesktopLocalServerStatus = {
  ...READY_STATUS,
  pid: 4242,
  attached: true,
};

interface Harness {
  readonly instance: DesktopBackendInstance;
  readonly published: DesktopLocalServerStatus[];
  readonly counters: { invalidations: number; restarts: number };
}

function harness(input: {
  readonly snapshot: DesktopBackendSnapshot;
  readonly readyAfterRestart: boolean;
  readonly failure?: { readonly reason: string; readonly output: string };
}): Harness {
  const published: DesktopLocalServerStatus[] = [];
  const counters = { invalidations: 0, restarts: 0 };
  let ready = input.snapshot.ready;

  const instance: DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Local environment"),
    start: Effect.void,
    stop: () => Effect.void,
    restart: Effect.sync(() => {
      counters.restarts += 1;
      ready = input.readyAfterRestart;
    }),
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(input.snapshot),
    waitForReady: () => Effect.succeed(ready),
    lastStartupFailure: Effect.succeed(Option.fromNullishOr(input.failure)),
  };

  return { instance, published, counters };
}

function layerFor(input: { readonly harness: Harness; readonly status: DesktopLocalServerStatus }) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/houston-home",
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        DesktopConfig.layerTest({ HOUSTON_HOME: "/houston-home" }),
      ),
    ),
  );

  const poolService: DesktopBackendPool.DesktopBackendPool["Service"] = {
    get: () => Effect.succeedSome(input.harness.instance),
    list: Effect.succeed([input.harness.instance]),
    primary: Effect.succeed(input.harness.instance),
    register: () => Effect.die("unexpected register"),
    unregister: () => Effect.die("unexpected unregister"),
  };
  const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, poolService);

  const statusService: DesktopServerStatus.DesktopServerStatus["Service"] = {
    get: Effect.succeedSome(input.status),
    publish: (status) =>
      Effect.sync(() => {
        if (status !== null) input.harness.published.push(status);
      }),
    starting: (location) =>
      Effect.sync(() => {
        input.harness.published.push({
          state: "starting",
          baseDir: location.baseDir,
          ...(location.logPath === undefined ? {} : { logPath: location.logPath }),
        });
      }),
    fail: (failure) =>
      Effect.sync(() => {
        input.harness.published.push({
          state: "error",
          error: failure.error,
          baseDir: failure.baseDir,
          ...(failure.logPath === undefined ? {} : { logPath: failure.logPath }),
        });
      }),
  };
  const layerStatus = Layer.succeed(DesktopServerStatus.DesktopServerStatus, statusService);

  const authService: DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth["Service"] = {
    getBearerToken: Effect.die("unexpected getBearerToken"),
    invalidate: Effect.sync(() => {
      input.harness.counters.invalidations += 1;
    }),
  };
  const layerAuth = Layer.succeed(
    DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth,
    authService,
  );

  return DesktopServerControl.layer.pipe(
    Layer.provideMerge(layerPool),
    Layer.provideMerge(layerStatus),
    Layer.provideMerge(layerAuth),
    Layer.provideMerge(layerEnvironment),
  );
}

const attachedSnapshot: DesktopBackendSnapshot = {
  desiredRunning: false,
  ready: true,
  activePid: Option.some(4242),
  restartAttempt: 0,
  restartScheduled: false,
  attached: true,
};

const ownedSnapshot: DesktopBackendSnapshot = {
  desiredRunning: true,
  ready: true,
  activePid: Option.some(4242),
  restartAttempt: 0,
  restartScheduled: false,
  attached: false,
};

describe("DesktopServerControl", () => {
  it.effect("refuses to restart a server the app attached to", () => {
    const test = harness({ snapshot: attachedSnapshot, readyAfterRestart: true });
    return Effect.gen(function* () {
      const control = yield* DesktopServerControl.DesktopServerControl;
      const error = yield* control.restart.pipe(Effect.flip);
      assert.include(error.message, "does not own");
      assert.deepStrictEqual(test.published, [], "the attached server's status is untouched");
      assert.strictEqual(test.counters.restarts, 0, "no restart is attempted");
      assert.strictEqual(test.counters.invalidations, 0);
    }).pipe(Effect.provide(layerFor({ harness: test, status: ATTACHED_STATUS })));
  });

  it.effect("restarts the app's own server and clears the cached bearer", () => {
    const test = harness({
      snapshot: { ...ownedSnapshot, ready: false, activePid: Option.none() },
      readyAfterRestart: true,
    });
    return Effect.gen(function* () {
      const control = yield* DesktopServerControl.DesktopServerControl;
      const status = yield* control.restart;
      assert.deepStrictEqual(status, READY_STATUS);
      assert.deepStrictEqual(
        test.published.map((entry) => entry.state),
        ["starting"],
        "the banner sees the restart start",
      );
      assert.strictEqual(test.counters.restarts, 1);
      assert.strictEqual(test.counters.invalidations, 1);
    }).pipe(Effect.provide(layerFor({ harness: test, status: READY_STATUS })));
  });

  it.effect("reports the host's reason when the replacement does not become ready", () => {
    const test = harness({
      snapshot: { ...ownedSnapshot, ready: false, activePid: Option.none() },
      readyAfterRestart: false,
      failure: { reason: "The server exited during startup.", output: "boom" },
    });
    return Effect.gen(function* () {
      const control = yield* DesktopServerControl.DesktopServerControl;
      const error = yield* control.restart.pipe(Effect.flip);
      assert.strictEqual(error.message, "The server exited during startup.");
      const failed = test.published.at(-1);
      assert.strictEqual(failed?.state, "error");
      assert.strictEqual(failed?.error, "The server exited during startup.");
    }).pipe(Effect.provide(layerFor({ harness: test, status: READY_STATUS })));
  });
});
