import {
  PortForward,
  PortForwardStartInput,
  PortForwardStopInput,
} from "@houston-app/contracts/houston/portForwarding";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPortForwarding from "../../portForwarding/DesktopPortForwarding.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const startPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_PORT_FORWARD_CHANNEL,
  payload: PortForwardStartInput,
  result: PortForward,
  handler: Effect.fn("desktop.ipc.portForwarding.start")(function* (input) {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    return yield* forwarding.start(input);
  }),
});

export const stopPortForward = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_PORT_FORWARD_CHANNEL,
  payload: PortForwardStopInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.portForwarding.stop")(function* (input) {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    yield* forwarding.stop(input);
  }),
});

export const listPortForwards = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_PORT_FORWARDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(PortForward),
  handler: Effect.fn("desktop.ipc.portForwarding.list")(function* () {
    const forwarding = yield* DesktopPortForwarding.DesktopPortForwarding;
    return yield* forwarding.list;
  }),
});
