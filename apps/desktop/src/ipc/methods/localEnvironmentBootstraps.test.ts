import { assert, describe, it } from "@effect/vitest";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@houston-app/contracts";
import * as Option from "effect/Option";

import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../../backend/DesktopBackendManager.ts";
import {
  localEnvironmentBootstrapEntries,
  type LocalEnvironmentBootstrapSource,
} from "./localEnvironmentBootstraps.ts";

function config(overrides: Partial<DesktopBackendStartConfig> = {}): DesktopBackendStartConfig {
  return {
    executablePath: "/usr/bin/node",
    entryPath: "/app/server.mjs",
    cwd: "/app",
    args: [],
    env: {},
    extendEnv: true,
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      houstonHome: "/home/user/.houston/v2",
      host: "",
      desktopBootstrapToken: "launch-token",
      desktopBootstrapSecret: "s".repeat(64),
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "fd3",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    captureOutput: false,
    preflightFailure: Option.none(),
    ...overrides,
  };
}

function snapshot(overrides: Partial<DesktopBackendSnapshot> = {}): DesktopBackendSnapshot {
  return {
    desiredRunning: true,
    ready: true,
    activePid: Option.some(4242),
    restartAttempt: 0,
    restartScheduled: false,
    attached: false,
    ...overrides,
  };
}

function source(
  overrides: Partial<LocalEnvironmentBootstrapSource> = {},
): LocalEnvironmentBootstrapSource {
  return {
    id: PRIMARY_LOCAL_ENVIRONMENT_ID,
    label: "Local environment",
    runningDistro: null,
    config: Option.some(config()),
    snapshot: snapshot(),
    currentBootstrapToken: "current-token",
    ...overrides,
  };
}

describe("localEnvironmentBootstrapEntries", () => {
  it("names the ready server's origin with the current token", () => {
    assert.deepStrictEqual(localEnvironmentBootstrapEntries([source()]), [
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: "Local environment",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        bootstrapToken: "current-token",
      },
    ]);
  });

  it("publishes no primary bootstrap while its server is starting or dead", () => {
    assert.deepStrictEqual(
      localEnvironmentBootstrapEntries([source({ snapshot: snapshot({ ready: false }) })]),
      [],
    );
  });

  it("keeps a secondary entry without an origin while it restarts", () => {
    assert.deepStrictEqual(
      localEnvironmentBootstrapEntries([
        source({
          id: "wsl:Ubuntu",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          snapshot: snapshot({ ready: false }),
        }),
      ]),
      [
        {
          id: "wsl:Ubuntu",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ],
    );
  });

  it("uses the launch token when the backend has no rotating secret", () => {
    const launchToken = config();
    const { desktopBootstrapSecret: _secret, ...bootstrap } = launchToken.bootstrap;
    assert.deepStrictEqual(
      localEnvironmentBootstrapEntries([
        source({
          config: Option.some({
            ...launchToken,
            bootstrap: { ...bootstrap, desktopBootstrapToken: "launch-token" },
          }),
        }),
      ])[0]?.bootstrapToken,
      "launch-token",
    );
  });

  it("omits a primary that has no configuration", () => {
    assert.deepStrictEqual(
      localEnvironmentBootstrapEntries([source({ config: Option.none() })]),
      [],
    );
  });
});
