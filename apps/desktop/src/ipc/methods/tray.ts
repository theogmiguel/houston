import type { DesktopTrayPayload } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as QuickComposer from "../../quickComposer/QuickComposer.ts";
import * as TrayHost from "../../tray/TrayHost.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const TrayConnection = Schema.Literals(["connecting", "ready", "reconnecting", "failed"]);
const TrayStatus = Schema.Literals(["running", "idle", "needsInput", "unknown", "done", "error"]);

const TraySession = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(512)),
  agent: Schema.String.check(Schema.isMaxLength(128)),
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  status: TrayStatus,
  needsInput: Schema.Boolean,
  workspace: Schema.String.check(Schema.isMaxLength(512)),
});

const TrayPayload = Schema.Struct({
  connection: TrayConnection,
  sessions: Schema.Array(TraySession).check(Schema.isMaxLength(500)),
});

const TrayState = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  keepInTray: Schema.Boolean,
  hidesOnClose: Schema.Boolean,
});

const QuickComposerShortcut = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  metaKey: Schema.Boolean,
  ctrlKey: Schema.Boolean,
  shiftKey: Schema.Boolean,
  altKey: Schema.Boolean,
  modKey: Schema.Boolean,
});

const QuickComposerStatus = Schema.Struct({
  enabled: Schema.Boolean,
  shortcut: Schema.NullOr(QuickComposerShortcut),
  registered: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});

const NotificationPayload = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(512)),
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  body: Schema.String.check(Schema.isMaxLength(8_000)),
});

const NotificationSupport = Schema.Struct({
  supported: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});

export const traySync = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRAY_SYNC_CHANNEL,
  payload: TrayPayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tray.sync")(function* (payload) {
    const trayHost = yield* TrayHost.TrayHost;
    yield* trayHost.sync(payload as DesktopTrayPayload);
  }),
});

export const trayState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRAY_STATE_CHANNEL,
  payload: Schema.Undefined,
  result: TrayState,
  handler: Effect.fn("desktop.ipc.tray.state")(function* () {
    const trayHost = yield* TrayHost.TrayHost;
    return yield* trayHost.state;
  }),
});

export const setKeepInTray = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRAY_SET_KEEP_IN_TRAY_CHANNEL,
  payload: Schema.Boolean,
  result: TrayState,
  handler: Effect.fn("desktop.ipc.tray.setKeepInTray")(function* (enabled) {
    const trayHost = yield* TrayHost.TrayHost;
    return yield* trayHost.setKeepInTray(enabled);
  }),
});

export const getQuickComposerStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_QUICK_COMPOSER_STATUS_CHANNEL,
  payload: Schema.Undefined,
  result: QuickComposerStatus,
  handler: Effect.fn("desktop.ipc.quickComposer.status")(function* () {
    const quickComposer = yield* QuickComposer.QuickComposer;
    return yield* quickComposer.status;
  }),
});

export const setQuickComposerShortcut = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_QUICK_COMPOSER_SHORTCUT_CHANNEL,
  payload: Schema.NullOr(QuickComposerShortcut),
  result: QuickComposerStatus,
  handler: Effect.fn("desktop.ipc.quickComposer.setShortcut")(function* (shortcut) {
    const quickComposer = yield* QuickComposer.QuickComposer;
    return yield* quickComposer.setShortcut(shortcut);
  }),
});

export const openQuickComposer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_QUICK_COMPOSER_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.open")(function* () {
    const quickComposer = yield* QuickComposer.QuickComposer;
    yield* quickComposer.open;
  }),
});

export const closeQuickComposer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLOSE_QUICK_COMPOSER_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.quickComposer.close")(function* () {
    const quickComposer = yield* QuickComposer.QuickComposer;
    yield* quickComposer.close;
  }),
});

export const notificationsSupported = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFICATIONS_SUPPORTED_CHANNEL,
  payload: Schema.Undefined,
  result: NotificationSupport,
  handler: Effect.fn("desktop.ipc.notifications.supported")(function* () {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.supported;
  }),
});

export const notifyThread = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFY_THREAD_CHANNEL,
  payload: NotificationPayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.notify")(function* (payload) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    yield* notifications.notify(payload);
  }),
});
