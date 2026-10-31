import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";

import { type CliServerFlags, resolveServerConfig } from "../cli/config.ts";
import { deriveServerPaths } from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { HOUSTON_EXIT_CODE_REFUSED_LAUNCH, HostedLaunch, isHostedLaunch } from "./baseDir.ts";

const webFlags = (baseDir: Option.Option<string>): CliServerFlags => ({
  mode: Option.some("web"),
  port: Option.some(0),
  host: Option.none(),
  baseDir,
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.some(true),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.some(false),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
});

const withEnv = (env: Record<string, string>) =>
  Effect.provide(
    Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
  );

const exitCodeOf = (error: unknown) =>
  (error as { readonly [Runtime.errorExitCode]?: number })[Runtime.errorExitCode];

it.layer(NodeServices.layer)("houston base dir", (it) => {
  it.effect("every derived path lies under the base dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "houston-paths-" }),
        ".houston-dev",
        "v2",
      );
      const derived = yield* deriveServerPaths(base, undefined);

      expect(derived.dbPath).toBe(path.join(base, "userdata", "statev2.sqlite"));
      expect(derived.serverRuntimeStatePath).toBe(
        path.join(base, "userdata", "server-runtime.json"),
      );
      expect(path.join(derived.stateDir, "server-owner.sqlite")).toBe(
        path.join(base, "userdata", "server-owner.sqlite"),
      );
      for (const [name, value] of Object.entries(derived)) {
        const relative = path.relative(base, value);
        assert(
          relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative),
          `${name} = ${value} is not under ${base}`,
        );
      }
    }),
  );

  it.effect("a hosted base dir comes only from t3Home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "houston-home-" });

      // Hosted: the envelope's t3Home is the only source, and it may not be blank.
      for (const raw of [undefined, "", "   "]) {
        const error = yield* resolveBaseDir(raw).pipe(
          Effect.provideService(HostedLaunch, true),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.flip,
        );
        expect(exitCodeOf(error)).toBe(HOUSTON_EXIT_CODE_REFUSED_LAUNCH);
        expect(error.message).toContain("t3Home");
        expect(error.message.startsWith("houston: ")).toBe(true);
      }
      expect(yield* fs.exists(path.join(home, ".houston", "v2"))).toBe(false);

      // Unhosted: --base-dir then T3CODE_HOME then the desktop app's ~/.houston/v2.
      const flagDir = path.join(home, "b");
      const envDir = path.join(home, "h");
      const byFlag = yield* resolveServerConfig(webFlags(Option.some(flagDir)), Option.none()).pipe(
        withEnv({ T3CODE_HOME: envDir }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(byFlag.baseDir).toBe(flagDir);
      const byEnv = yield* resolveServerConfig(webFlags(Option.none()), Option.none()).pipe(
        withEnv({ T3CODE_HOME: envDir }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(byEnv.baseDir).toBe(envDir);
      const byDefault = yield* resolveBaseDir(undefined).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(byDefault).toBe(path.join(home, ".houston", "v2"));
    }),
  );

  it.effect("a launch is hosted exactly when a bootstrap envelope is named", () =>
    Effect.gen(function* () {
      const flags = webFlags(Option.none());
      expect(yield* isHostedLaunch(flags).pipe(withEnv({}))).toBe(false);
      expect(
        yield* isHostedLaunch({ ...flags, bootstrapFd: Option.some(3) }).pipe(withEnv({})),
      ).toBe(true);
      expect(yield* isHostedLaunch(flags).pipe(withEnv({ T3CODE_BOOTSTRAP_FD: "3" }))).toBe(true);
      // The base dir's name decides nothing.
      expect(yield* isHostedLaunch(webFlags(Option.some("/x/v2"))).pipe(withEnv({}))).toBe(false);
    }),
  );

  it.effect("a v1 channel dir is refused", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-" });

      for (const files of [["daemon.json"], ["daemon.lock"]]) {
        const channel = path.join(root, `channel-${files[0]}`);
        yield* fs.makeDirectory(channel, { recursive: true });
        for (const file of files) yield* fs.writeFileString(path.join(channel, file), "{}\n");
        const before = (yield* fs.readDirectory(channel)).toSorted();

        for (const hosted of [false, true]) {
          const error = yield* resolveBaseDir(channel).pipe(
            Effect.provideService(HostedLaunch, hosted),
            Effect.flip,
          );
          expect(exitCodeOf(error)).toBe(HOUSTON_EXIT_CODE_REFUSED_LAUNCH);
          expect(error.message).toContain(channel);
          expect(error.message).toContain(files[0]);
        }
        expect((yield* fs.readDirectory(channel)).toSorted()).toEqual(before);
      }

      const both = path.join(root, ".houston-dev");
      yield* fs.makeDirectory(both, { recursive: true });
      yield* fs.writeFileString(path.join(both, "daemon.json"), "{}\n");
      yield* fs.writeFileString(path.join(both, "daemon.lock"), "");
      expect(yield* resolveBaseDir(path.join(both, "v2"))).toBe(path.join(both, "v2"));
    }),
  );
});
