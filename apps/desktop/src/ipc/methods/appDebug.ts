// @effect-diagnostics preferSchemaOverJson:off - The record is already validated and bounded; the log stores its JSON line verbatim.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { buildAppDebugRecord } from "../../app/DesktopAppDebugLog.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const APP_DEBUG_FILE_NAME = "app-debug.ndjson";

const LogDebugPayload = Schema.Struct({
  source: Schema.String,
  message: Schema.String,
  payload: Schema.optionalKey(Schema.Unknown),
});

export const logDebug = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LOG_DEBUG_CHANNEL,
  payload: LogDebugPayload,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appDebug.logDebug")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // Debug records exist for development and named channels; a stable release
    // writes no app-debug log.
    if (!environment.isDevelopment && Option.isNone(environment.channel)) {
      return;
    }

    const record = buildAppDebugRecord(input.source, input.message, input.payload);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(environment.logDir, APP_DEBUG_FILE_NAME);
    const line = new TextEncoder().encode(`${JSON.stringify(record)}\n`);

    yield* fileSystem.makeDirectory(environment.logDir, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.writeFile(filePath, line, { flag: "a" }).pipe(Effect.ignore);
  }),
});
