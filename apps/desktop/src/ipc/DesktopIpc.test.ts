import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as DesktopIpc from "./DesktopIpc.ts";
import * as IpcChannels from "./channels.ts";

function fakeIpcMain() {
  const invokeHandlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const syncHandlers = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
  const ipcMain: DesktopIpc.DesktopIpcMain = {
    removeHandler: (channel) => invokeHandlers.delete(channel),
    handle: (channel, listener) => invokeHandlers.set(channel, listener),
    removeAllListeners: (channel) => syncHandlers.delete(channel),
    on: (channel, listener) => syncHandlers.set(channel, listener),
  };
  return {
    ipcMain,
    invoke: (channel: string) => invokeHandlers.get(channel)!({ sender: { id: 1 } }, undefined),
    sendSync: (channel: string) => {
      const event: DesktopIpc.DesktopIpcSyncEvent = { returnValue: undefined };
      syncHandlers.get(channel)!(event);
      return event.returnValue;
    },
  };
}

function recordingTracer() {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const ended = () =>
    spans.flatMap((span) =>
      span.status._tag === "Ended"
        ? [{ name: span.name, channel: span.attributes.get("channel"), exit: span.status.exit }]
        : [],
    );
  return { tracer, ended };
}

const invokeMethod = (channel: string, fail: boolean) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: Schema.Undefined,
    result: Schema.String,
    handler: Effect.fn("test.invokeHandler")(function* () {
      if (fail) return yield* Effect.die(new Error("host state unavailable"));
      return "ok";
    }),
  });

const syncMethod = (channel: string, fail: boolean) =>
  DesktopIpc.makeSyncIpcMethod({
    channel,
    result: Schema.String,
    handler: Effect.fn("test.syncHandler")(function* () {
      if (fail) return yield* Effect.die(new Error("host state unavailable"));
      return "ok";
    }),
  });

describe("DesktopIpc tracing", () => {
  it.effect("records no span for a successful call on a polled channel", () => {
    const { tracer, ended } = recordingTracer();
    const host = fakeIpcMain();
    const ipc = DesktopIpc.make(host.ipcMain);
    return Effect.gen(function* () {
      yield* ipc.handleSync(
        syncMethod(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL, false),
      );
      yield* ipc.handle(invokeMethod(IpcChannels.GET_SERVER_STATUS_CHANNEL, false));
      const registrationSpans = ended().length;

      expect(host.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL)).toBe("ok");
      expect(
        yield* Effect.promise(async () => host.invoke(IpcChannels.GET_SERVER_STATUS_CHANNEL)),
      ).toBe("ok");

      expect(ended().slice(registrationSpans)).toEqual([]);
    }).pipe(Effect.withTracer(tracer), Effect.scoped);
  });

  it.effect("records a failed call on a polled channel as one failed span", () => {
    const { tracer, ended } = recordingTracer();
    const host = fakeIpcMain();
    const ipc = DesktopIpc.make(host.ipcMain);
    return Effect.gen(function* () {
      yield* ipc.handleSync(syncMethod(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL, true));
      yield* ipc.handle(invokeMethod(IpcChannels.GET_SERVER_STATUS_CHANNEL, true));
      const registrationSpans = ended().length;

      expect(() => host.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL)).toThrow();
      yield* Effect.promise(async () =>
        expect(host.invoke(IpcChannels.GET_SERVER_STATUS_CHANNEL)).rejects.toThrow(),
      );

      const calls = ended().slice(registrationSpans);
      expect(calls.map(({ name, channel }) => ({ name, channel }))).toEqual([
        {
          name: "desktop.ipc.invokeSync",
          channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
        },
        { name: "desktop.ipc.invoke", channel: IpcChannels.GET_SERVER_STATUS_CHANNEL },
      ]);
      expect(calls.every(({ exit }) => Exit.isFailure(exit))).toBe(true);
    }).pipe(Effect.withTracer(tracer), Effect.scoped);
  });

  it.effect("still traces every call on other channels", () => {
    const { tracer, ended } = recordingTracer();
    const host = fakeIpcMain();
    const ipc = DesktopIpc.make(host.ipcMain);
    return Effect.gen(function* () {
      yield* ipc.handle(invokeMethod(IpcChannels.RESTART_SERVER_CHANNEL, false));
      const registrationSpans = ended().length;

      yield* Effect.promise(async () => host.invoke(IpcChannels.RESTART_SERVER_CHANNEL));

      expect(
        ended()
          .slice(registrationSpans)
          .map(({ name }) => name),
      ).toEqual(["desktop.ipc.invoke", "desktop.ipc.method", "test.invokeHandler"]);
    }).pipe(Effect.withTracer(tracer), Effect.scoped);
  });
});
