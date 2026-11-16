import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@houston-app/shared/HostProcess";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const NOTIFICATION_TITLE_MAX_CHARS = 200;
const NOTIFICATION_BODY_MAX_CHARS = 2_000;
const LIVE_NOTIFICATION_CAP = 256;

export interface ThreadNotificationPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface ThreadNotificationSupport {
  readonly supported: boolean;
  readonly reason: string | null;
}

export class DesktopNotificationError extends Schema.TaggedError<DesktopNotificationError>()(
  "DesktopNotificationError",
  {
    operation: Schema.Literals(["show", "unsupported"]),
    threadKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.operation === "unsupported") {
      return `Could not show a notification for thread ${JSON.stringify(this.threadKey)}: this computer has no notification service.`;
    }
    return `Could not show a notification for thread ${JSON.stringify(this.threadKey)}: ${
      this.cause instanceof Error ? this.cause.message : String(this.cause)
    }`;
  }
}

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly supported: Effect.Effect<ThreadNotificationSupport>;
    readonly notify: (
      payload: ThreadNotificationPayload,
    ) => Effect.Effect<void, DesktopNotificationError>;
  }
>()("@houston-app/desktop/notifications/DesktopNotifications") {}

const { logWarning: logNotificationWarning } = makeComponentLogger("desktop-notifications");

function boundedChars(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join("");
}

function notificationBody(text: string, platform: NodeJS.Platform): string {
  const body = boundedChars(text, NOTIFICATION_BODY_MAX_CHARS);
  return platform === "linux"
    ? body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    : body;
}

/** @public */
export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const platform = yield* HostProcess.Platform;
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runFork = Effect.runForkWith(context);
  const live = new Map<string, Electron.Notification>();

  const supported = Effect.sync((): ThreadNotificationSupport =>
    Electron.Notification.isSupported()
      ? { supported: true, reason: null }
      : {
          supported: false,
          reason: "no notification service is running for this desktop session",
        },
  );

  const forget = (threadKey: string, notification: Electron.Notification) => {
    if (live.get(threadKey) === notification) live.delete(threadKey);
  };

  const notify = Effect.fn("desktop.notifications.notify")(function* (
    payload: ThreadNotificationPayload,
  ) {
    if (!Electron.Notification.isSupported()) {
      return yield* new DesktopNotificationError({
        operation: "unsupported",
        threadKey: payload.id,
        cause: new Error("Electron reports no notification service"),
      });
    }
    const previous = live.get(payload.id);
    if (previous !== undefined) {
      live.delete(payload.id);
      yield* Effect.try({ try: () => previous.close(), catch: () => undefined }).pipe(
        Effect.ignore,
      );
    }
    while (live.size >= LIVE_NOTIFICATION_CAP) {
      const oldestKey = live.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = live.get(oldestKey);
      live.delete(oldestKey);
      if (oldest !== undefined) {
        yield* Effect.try({ try: () => oldest.close(), catch: () => undefined }).pipe(
          Effect.ignore,
        );
      }
    }

    const notification = yield* Effect.try({
      try: () =>
        new Electron.Notification({
          title: boundedChars(payload.title, NOTIFICATION_TITLE_MAX_CHARS),
          body: notificationBody(payload.body, platform),
          silent: true,
        }),
      catch: (cause) =>
        new DesktopNotificationError({ operation: "show", threadKey: payload.id, cause }),
    });
    notification.on("click", () => {
      forget(payload.id, notification);
      runFork(
        Effect.gen(function* () {
          yield* desktopWindow.showMain;
          yield* desktopWindow.dispatchThreadNotificationFocus(payload.id);
        }).pipe(
          Effect.catchCause((cause) =>
            logNotificationWarning("notification focus failed", { threadKey: payload.id, cause }),
          ),
        ),
      );
    });
    notification.on("close", () => {
      forget(payload.id, notification);
    });
    notification.on("failed", (_event, error) => {
      forget(payload.id, notification);
      runFork(
        logNotificationWarning("notification failed", {
          threadKey: payload.id,
          message: error,
        }),
      );
    });
    live.set(payload.id, notification);
    yield* Effect.try({
      try: () => notification.show(),
      catch: (cause) =>
        new DesktopNotificationError({ operation: "show", threadKey: payload.id, cause }),
    }).pipe(Effect.tapError(() => Effect.sync(() => live.delete(payload.id))));
  });

  return DesktopNotifications.of({ supported, notify });
});

export const layer = Layer.effect(DesktopNotifications, make);
