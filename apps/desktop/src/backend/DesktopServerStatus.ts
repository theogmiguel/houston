import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

export interface DesktopServerStatusLocation {
  readonly baseDir: string;
  readonly logPath?: string;
}

/**
 * The host's view of its backend, including a server the app attached to
 * instead of starting. The renderer reads it through `getServerStatus` and
 * receives each change through `onServerStatus`.
 */
export class DesktopServerStatus extends Context.Service<
  DesktopServerStatus,
  {
    readonly get: Effect.Effect<Option.Option<DesktopLocalServerStatus>>;
    readonly publish: (status: DesktopLocalServerStatus | null) => Effect.Effect<void>;
    /**
     * Reports that a server start is under way. A recorded failure stays visible
     * while an automatic retry runs, so the banner names the reason; a manual
     * restart clears it with `force`.
     */
    readonly starting: (
      input: DesktopServerStatusLocation & { readonly force?: boolean },
    ) => Effect.Effect<void>;
    /** Reports the reason a start failed; it stays until a server becomes ready. */
    readonly fail: (
      input: DesktopServerStatusLocation & { readonly error: string },
    ) => Effect.Effect<void>;
  }
>()("@houston-app/desktop/backend/DesktopServerStatus") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const state = yield* Ref.make<Option.Option<DesktopLocalServerStatus>>(Option.none());

  const publish: DesktopServerStatus["Service"]["publish"] = Effect.fn(
    "desktop.serverStatus.publish",
  )(function* (status) {
    yield* Ref.set(state, Option.fromNullishOr(status));
    if (status !== null) {
      yield* electronWindow
        .sendAll(IpcChannels.SERVER_STATUS_CHANGED_CHANNEL, status)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to publish desktop server status", { cause }),
          ),
        );
    }
  });

  const location = (input: DesktopServerStatusLocation) => ({
    baseDir: input.baseDir,
    ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
  });

  return DesktopServerStatus.of({
    get: Ref.get(state),
    publish,
    starting: Effect.fn("desktop.serverStatus.starting")(function* (input) {
      if (!input.force) {
        const current = yield* Ref.get(state);
        if (Option.isSome(current) && current.value.state === "error") {
          return;
        }
      }
      yield* publish({ state: "starting", ...location(input) });
    }),
    fail: Effect.fn("desktop.serverStatus.fail")(function* (input) {
      yield* publish({ state: "error", error: input.error, ...location(input) });
    }),
  });
});

export const layer = Layer.effect(DesktopServerStatus, make);
