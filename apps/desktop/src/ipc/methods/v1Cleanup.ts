import { DesktopV1CleanupReportSchema } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopV1Cleanup from "../../app/DesktopV1Cleanup.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getReport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_V1_CLEANUP_REPORT_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopV1CleanupReportSchema),
  handler: Effect.fn("desktop.ipc.v1Cleanup.getReport")(function* () {
    const cleanup = yield* DesktopV1Cleanup.DesktopV1Cleanup;
    return Option.getOrNull(yield* cleanup.getReport);
  }),
});
