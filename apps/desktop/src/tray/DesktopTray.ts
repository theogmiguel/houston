import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopState from "../app/DesktopState.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as QuickComposer from "../quickComposer/QuickComposer.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { type TrayAction, TrayHost } from "./TrayHost.ts";

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly initialize: Effect.Effect<void>;
  }
>()("@houston-app/desktop/tray/DesktopTray") {}

const { logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const trayHost = yield* TrayHost;
  const quickComposer = yield* QuickComposer.QuickComposer;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopState = yield* DesktopState.DesktopState;
  const context = yield* Effect.context<
    | TrayHost
    | QuickComposer.QuickComposer
    | DesktopWindow.DesktopWindow
    | ElectronApp.ElectronApp
    | DesktopState.DesktopState
  >();
  const runFork = Effect.runForkWith(context);

  const handleAction = Effect.fn("desktop.tray.handleAction")(function* (action: TrayAction) {
    if (action.type === "quit") {
      yield* desktopWindow.showMain.pipe(Effect.ignoreCause);
      yield* electronApp.quit;
      return;
    }
    if (yield* Ref.get(desktopState.quitting)) return;
    if (action.type === "open") {
      yield* desktopWindow.showMain;
      return;
    }
    if (action.type === "new-thread") {
      yield* quickComposer.open;
      return;
    }
    yield* desktopWindow.showMain;
    yield* desktopWindow.dispatchThreadFocus(action.threadKey);
  });

  const handle = (action: TrayAction) =>
    handleAction(action).pipe(
      Effect.catchCause((cause) => logTrayWarning("tray action failed", { action, cause })),
    );

  const unsubscribe = trayHost.onAction((action) => {
    runFork(handle(action));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  return DesktopTray.of({
    initialize: Effect.gen(function* () {
      yield* trayHost.initialize;
      yield* quickComposer.initialize;
    }),
  });
});

export const layer = Layer.effect(DesktopTray, make);
