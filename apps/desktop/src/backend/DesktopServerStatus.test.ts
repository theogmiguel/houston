import { assert, describe, it } from "@effect/vitest";
import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopServerStatus from "./DesktopServerStatus.ts";

const LOCATION = { baseDir: "/houston/v2", logPath: "/houston/v2/userdata/logs/server-child.log" };
const sent: DesktopLocalServerStatus[] = [];

const layerWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
  sendAll: (channel: string, status: DesktopLocalServerStatus) =>
    Effect.sync(() => {
      assert.strictEqual(channel, IpcChannels.SERVER_STATUS_CHANGED_CHANNEL);
      sent.push(status);
    }),
} as unknown as ElectronWindow.ElectronWindow["Service"]);

const withStatus = <A, E>(effect: Effect.Effect<A, E, DesktopServerStatus.DesktopServerStatus>) =>
  effect.pipe(Effect.provide(DesktopServerStatus.layer.pipe(Layer.provide(layerWindow))));

describe("DesktopServerStatus", () => {
  it.effect("reports starting, then error, then ready", () =>
    Effect.gen(function* () {
      const status = yield* DesktopServerStatus.DesktopServerStatus;

      yield* status.starting(LOCATION);
      assert.deepStrictEqual(Option.getOrThrow(yield* status.get), {
        state: "starting",
        ...LOCATION,
      });

      yield* status.fail({ ...LOCATION, error: "The server exited." });
      assert.deepStrictEqual(Option.getOrThrow(yield* status.get), {
        state: "error",
        error: "The server exited.",
        ...LOCATION,
      });

      yield* status.publish({ state: "ready", origin: "http://127.0.0.1:3773", ...LOCATION });
      assert.deepStrictEqual(Option.getOrThrow(yield* status.get), {
        state: "ready",
        origin: "http://127.0.0.1:3773",
        ...LOCATION,
      });
    }).pipe(withStatus),
  );

  it.effect("keeps a recorded failure visible while an automatic retry starts", () =>
    Effect.gen(function* () {
      const status = yield* DesktopServerStatus.DesktopServerStatus;
      yield* status.fail({ ...LOCATION, error: "The server exited." });
      yield* status.starting(LOCATION);
      assert.strictEqual(Option.getOrThrow(yield* status.get).state, "error");
    }).pipe(withStatus),
  );

  it.effect("clears a recorded failure for a manual restart", () =>
    Effect.gen(function* () {
      const status = yield* DesktopServerStatus.DesktopServerStatus;
      yield* status.fail({ ...LOCATION, error: "The server exited." });
      yield* status.starting({ ...LOCATION, force: true });
      assert.strictEqual(Option.getOrThrow(yield* status.get).state, "starting");
    }).pipe(withStatus),
  );

  it.effect("sends every non-null status to the app's windows", () =>
    Effect.gen(function* () {
      const status = yield* DesktopServerStatus.DesktopServerStatus;
      sent.length = 0;
      yield* status.starting(LOCATION);
      yield* status.publish({ state: "ready", ...LOCATION });
      yield* status.publish(null);
      assert.deepStrictEqual(
        sent.map((entry) => entry.state),
        ["starting", "ready"],
      );
    }).pipe(withStatus),
  );
});
