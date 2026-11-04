import type { DesktopLocalServerStatus } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

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
  }
>()("@houston-app/desktop/backend/DesktopServerStatus") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const state = yield* Ref.make<Option.Option<DesktopLocalServerStatus>>(Option.none());

  return DesktopServerStatus.of({
    get: Ref.get(state),
    publish: Effect.fn("desktop.serverStatus.publish")(function* (status) {
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
    }),
  });
});

export const layer = Layer.effect(DesktopServerStatus, make);
