import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import * as HoustonPreviewBrowserHost from "./previewBrowserHost.ts";

const USERNS = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

const read = (input: {
  readonly restriction?: string;
  readonly profile?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) =>
  HoustonPreviewBrowserHost.hostSetup.pipe(
    Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
    Effect.provideService(HostProcess.Environment, input.env ?? { PATH: "" }),
    Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(path === USERNS ? (input.restriction ?? "0") : ""),
          exists: (path) =>
            Effect.succeed(
              path === PreviewBrowserHost.APPARMOR_PROFILE_PATH && input.profile === true,
            ),
        }),
      ),
    ),
  );

describe("preview browser host setup", () => {
  it.effect("reports the setup command when the restriction file blocks the sandbox", () =>
    Effect.gen(function* () {
      const status = yield* read({ restriction: "1\n", profile: false });
      expect(status).toEqual({ blocked: true, setupCommand: "sudo houston browser setup" });
    }),
  );

  it.effect("is unblocked when the restriction file does not block the sandbox", () =>
    Effect.gen(function* () {
      const status = yield* read({ restriction: "0\n", profile: false });
      expect(status).toEqual({ blocked: false, setupCommand: "" });
    }),
  );

  it.effect("is unblocked once the AppArmor profile exists", () =>
    Effect.gen(function* () {
      const status = yield* read({ restriction: "1\n", profile: true });
      expect(status).toEqual({ blocked: false, setupCommand: "" });
    }),
  );

  it.effect("is unblocked when the sandbox is deliberately disabled", () =>
    Effect.gen(function* () {
      const status = yield* read({
        restriction: "1\n",
        profile: false,
        env: { PATH: "", HOUSTON_SERVER_BROWSER_SANDBOX: "0" },
      });
      expect(status).toEqual({ blocked: false, setupCommand: "" });
    }),
  );

  it.effect("is unblocked off Linux", () =>
    Effect.gen(function* () {
      const status = yield* read({ restriction: "1\n", profile: false, platform: "darwin" });
      expect(status).toEqual({ blocked: false, setupCommand: "" });
    }),
  );
});
