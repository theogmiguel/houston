import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@houston-app/contracts";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import {
  BACKEND_QUIT_STOP_TIMEOUT,
  type DesktopBackendAttachment,
  type DesktopBackendStartConfig,
  makeBackendInstance,
  PRIMARY_INSTANCE_ID,
  readinessPollDelay,
  restartRefusalReason,
} from "./DesktopBackendManager.ts";

const readyServer = {
  attached: false,
  desiredRunning: true,
  ready: true,
  active: true,
} as const;

describe("restartRefusalReason", () => {
  it("allows a restart of the app's own ready server", () => {
    assert.isTrue(Option.isNone(restartRefusalReason(readyServer)));
  });

  it("refuses an attached server the app does not own", () => {
    const reason = restartRefusalReason({ ...readyServer, attached: true });
    assert.isTrue(Option.isSome(reason));
    if (Option.isSome(reason)) {
      assert.include(reason.value, "does not own");
      assert.include(reason.value, "Quit that server yourself");
    }
  });

  it("refuses while a start is in flight so it never kills a booting server", () => {
    const reason = restartRefusalReason({ ...readyServer, ready: false });
    assert.isTrue(Option.isSome(reason));
    if (Option.isSome(reason)) {
      assert.include(reason.value, "already in progress");
    }
  });

  it("allows a restart after a crash when no run is active", () => {
    assert.isTrue(
      Option.isNone(
        restartRefusalReason({
          ...readyServer,
          ready: false,
          active: false,
        }),
      ),
    );
  });
});

describe("readinessPollDelay", () => {
  it("polls at least 20 times in the first second then backs off", () => {
    let elapsed = Duration.zero;
    let probes = 0;
    while (Duration.toMillis(elapsed) < 1_000) {
      elapsed = Duration.sum(elapsed, readinessPollDelay(elapsed));
      probes += 1;
    }

    assert.isAtLeast(probes, 20);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(2))), 100);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(5))), 250);
    assert.equal(Duration.toMillis(readinessPollDelay(Duration.seconds(170))), 250);
  });
});

describe("BACKEND_QUIT_STOP_TIMEOUT", () => {
  it("leaves room for the force kill after the SIGTERM grace", () => {
    // The spawner sends SIGTERM and waits a 5 s grace before SIGKILL; quit must outwait both.
    assert.isAtLeast(Duration.toMillis(BACKEND_QUIT_STOP_TIMEOUT), 6_000);
  });
});

const startConfig = (port: number): DesktopBackendStartConfig => ({
  executablePath: "/usr/bin/node",
  entryPath: "/opt/houston/server/bin.mjs",
  cwd: "/opt/houston/server",
  args: [],
  env: {},
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port,
    houstonHome: "/home/user/.houston-dev",
    host: "127.0.0.1",
    desktopBootstrapToken: "launch-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL(`http://127.0.0.1:${port}`),
  captureOutput: false,
  preflightFailure: Option.none(),
});

const runningServer: DesktopBackendAttachment = {
  config: startConfig(3773),
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  pid: 4242,
  warning: Option.none(),
};

/** A spawned server that finds the state directory owned and exits, as the real one does. */
const ownedStateDirSpawner = (spawned: Ref.Ref<number>) =>
  ChildProcessSpawner.make(() =>
    Ref.update(spawned, (count) => count + 1).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(9001),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(SERVER_EXIT_CODE_STATE_DIR_OWNED)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );

const hostServices = (spawned: Ref.Ref<number>) =>
  Layer.mergeAll(
    FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ownedStateDirSpawner(spawned)),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.never),
    ),
    Layer.succeed(
      DesktopObservability.DesktopBackendOutputLogFactory,
      DesktopObservability.DesktopBackendOutputLogFactory.of({
        forInstance: () =>
          Effect.succeed({
            beginSession: () => Effect.void,
            writeOutputChunk: () => Effect.void,
            persistFailureSnapshot: () => Effect.void,
            persistFailure: () => Effect.void,
            discardSession: Effect.void,
          }),
      }),
    ),
    Layer.succeed(
      DesktopTelemetryPublisher.DesktopTelemetryPublisher,
      DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: () => Effect.void,
        updateRequests: Stream.empty,
        updateCommits: Stream.empty,
        updateCancellations: Stream.empty,
      }),
    ),
    Layer.succeed(
      DesktopBrowserHost.DesktopBrowserHost,
      DesktopBrowserHost.DesktopBrowserHost.of({
        events: Stream.empty,
        handleCommandLine: () => Effect.void,
        attach: () => undefined,
        detach: () => undefined,
        setShown: () => undefined,
        humanStartedDownload: () => false,
        placeDownload: () => false,
        pointers: Stream.empty,
        painting: Stream.empty,
      }),
    ),
    DesktopWslEnvironment.layerTest(),
  );

/** Starts the primary instance with a healthy server already running, found either before or after a spawn. */
const launchWithRunningServer = (foundBeforeSpawn: boolean) =>
  Effect.gen(function* () {
    const spawned = yield* Ref.make(0);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (event: string) => Ref.update(events, (all) => [...all, event]);
    const attached = yield* Deferred.make<void>();
    const instance = yield* makeBackendInstance({
      id: PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Local environment"),
      configResolve: Effect.succeed(startConfig(3774)),
      onStarting: () => record("starting"),
      onReady: (httpBaseUrl, pid) => record(`ready ${httpBaseUrl.origin} pid=${pid}`),
      onStateDirOwned: () => record("stateDirOwned").pipe(Effect.as(Option.some(runningServer))),
      attachBeforeSpawn: () =>
        record("attachBeforeSpawn").pipe(
          Effect.as(foundBeforeSpawn ? Option.some(runningServer) : Option.none()),
        ),
      onAttached: (attachment) =>
        record(`attached pid=${attachment.pid}`).pipe(
          Effect.andThen(Deferred.succeed(attached, undefined)),
        ),
    }).pipe(Effect.provide(hostServices(spawned)));

    yield* instance.start;
    yield* Deferred.await(attached);
    return {
      instance,
      spawned: yield* Ref.get(spawned),
      events: yield* Ref.get(events),
      snapshot: yield* instance.snapshot,
      config: yield* instance.currentConfig,
      startAgain: instance.start.pipe(Effect.andThen(Ref.get(spawned))),
    };
  });

describe("makeBackendInstance with a server already running", () => {
  it.effect("attaches before spawning, so no second server is started", () =>
    Effect.gen(function* () {
      const launch = yield* launchWithRunningServer(true);

      assert.equal(launch.spawned, 0);
      assert.deepStrictEqual(launch.events, [
        "starting",
        "attachBeforeSpawn",
        "ready http://127.0.0.1:3773 pid=4242",
        "attached pid=4242",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("ends in the state the ownership-lock exit reaches after a spawn", () =>
    Effect.gen(function* () {
      const early = yield* launchWithRunningServer(true);
      const late = yield* launchWithRunningServer(false);

      assert.equal(late.spawned, 1);
      assert.deepStrictEqual(late.events, [
        "starting",
        "attachBeforeSpawn",
        "stateDirOwned",
        "ready http://127.0.0.1:3773 pid=4242",
        "attached pid=4242",
      ]);
      assert.deepStrictEqual(early.snapshot, late.snapshot);
      assert.deepStrictEqual(early.snapshot, {
        desiredRunning: false,
        ready: true,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
        attached: true,
      });
      assert.deepStrictEqual(early.config, Option.some(runningServer.config));
      assert.deepStrictEqual(late.config, Option.some(runningServer.config));
    }).pipe(Effect.scoped),
  );

  it.effect("never spawns or restarts once attached, as the exit path does", () =>
    Effect.gen(function* () {
      const launch = yield* launchWithRunningServer(true);

      assert.equal(yield* launch.startAgain, 0);
      const refused = yield* launch.instance.restart.pipe(Effect.flip);
      assert.include(refused.reason, "does not own");
      assert.isFalse((yield* launch.instance.snapshot).restartScheduled);
    }).pipe(Effect.scoped),
  );
});
