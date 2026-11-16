import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type { WindowsPathProbe } from "../shell/WindowsServerPath.ts";
import { resolvePrimaryStartConfig } from "./DesktopBackendConfiguration.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

const environmentFor = (
  platform: NodeJS.Platform,
  backendCwd: string,
): DesktopEnvironment.DesktopEnvironment["Service"] =>
  ({
    platform,
    backendCwd,
    baseDir: String.raw`C:\Users\u\.houston-dev\v2`,
    isPackaged: false,
    compileCachePath: String.raw`C:\app\compileCache.cjs`,
    backendEntryPath: String.raw`C:\app\server.mjs`,
  }) as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

const serverExposure = {
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
} as unknown as DesktopServerExposure.DesktopServerExposure["Service"];

const probeFor = (paths: ReadonlyArray<string>): WindowsPathProbe => {
  const present = new Set(paths);
  return {
    isFile: (path) => present.has(path),
    exists: (path) => present.has(path),
  };
};

const baseInput = {
  bootstrapToken: "token",
  bootstrapSecret: "secret",
  observabilitySettings: {
    otlpTracesUrl: Option.none(),
    otlpMetricsUrl: Option.none(),
    otlpLogsUrl: Option.none(),
  },
  resourceMonitorPath: Option.none(),
  cliPath: Option.none(),
  shellEnvironmentPrepared: true,
} as const;

const resolve = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  inheritedEnv: Readonly<Record<string, string | undefined>>,
  probe: WindowsPathProbe,
) =>
  resolvePrimaryStartConfig({
    ...baseInput,
    inheritedEnv,
    windowsPathProbe: probe,
  }).pipe(
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
  );

describe("resolvePrimaryStartConfig", () => {
  it.effect("prepares the Windows PATH when the rule is certain", () =>
    Effect.gen(function* () {
      const config = yield* resolve(
        environmentFor("win32", String.raw`C:\app`),
        { Path: String.raw`C:\tools`, PATHEXT: ".EXE" },
        probeFor([String.raw`C:\tools\node.exe`]),
      );

      assert.isTrue(config.bootstrap.shellEnvironmentPrepared);
      assert.equal(config.env.PATH, String.raw`C:\tools`);
      assert.isUndefined(config.env.Path);
    }),
  );

  it.effect("leaves the server probe when the rule refuses", () =>
    Effect.gen(function* () {
      const config = yield* resolve(
        environmentFor("win32", String.raw`C:\app`),
        { Path: String.raw`C:\tools`, PATHEXT: ".EXE" },
        probeFor([String.raw`C:\tools\node.exe`, String.raw`C:\app\pwsh.exe`]),
      );

      assert.isFalse(config.bootstrap.shellEnvironmentPrepared);
      assert.isUndefined(config.env.PATH);
      assert.isUndefined(config.env.Path);
    }),
  );

  it.effect("keeps the host's own discovery off Windows", () =>
    Effect.gen(function* () {
      const config = yield* resolve(
        environmentFor("linux", "/app"),
        { PATH: "/usr/bin", PATHEXT: ".EXE" },
        probeFor([String.raw`C:\tools\node.exe`]),
      );

      assert.isTrue(config.bootstrap.shellEnvironmentPrepared);
      assert.isUndefined(config.env.PATH);
    }),
  );

  // A server told the shell environment is prepared skips its own PATH probe, so the
  // channel that delivers the desktop's discovered environment must come with the claim.
  it.effect("opens the channel that delivers the prepared shell environment", () =>
    Effect.gen(function* () {
      const config = yield* resolve(
        environmentFor("linux", "/app"),
        { PATH: "/usr/bin" },
        probeFor([]),
      );

      assert.isTrue(config.bootstrap.shellEnvironmentPrepared);
      assert.strictEqual(config.bootstrap.desktopTelemetryFd, 4);
      assert.strictEqual(config.bootstrap.desktopTelemetryControlFd, 5);
    }),
  );
});
