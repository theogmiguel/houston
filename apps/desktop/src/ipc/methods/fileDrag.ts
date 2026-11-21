import { DesktopFileDragInputSchema } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  resolveWorkspaceFileForDrag,
  WorkspaceFileDragError,
} from "../../files/workspaceFileDrag.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export class FileDragStartError extends Schema.TaggedError<FileDragStartError>()(
  "FileDragStartError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to start dragging "${this.path}".`;
  }
}

const firstExistingIcon = Effect.fn("desktop.ipc.fileDrag.firstExistingIcon")(function* (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): Effect.fn.Return<string | null, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of environment.resolveResourcePathCandidates("icon.png")) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return null;
});

export const startFileDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.START_FILE_DRAG_CHANNEL,
  payload: DesktopFileDragInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.fileDrag.startFileDrag")(function* (input, event) {
    const filePath = yield* Effect.tryPromise({
      try: () => resolveWorkspaceFileForDrag(input),
      catch: (cause) =>
        cause instanceof WorkspaceFileDragError
          ? cause
          : new WorkspaceFileDragError(
              input.path,
              "missing",
              `Cannot drag "${input.path}": ${String(cause)}.`,
            ),
    });
    const contents = event === undefined ? undefined : Electron.webContents.fromId(event.sender.id);
    if (contents === undefined || contents.isDestroyed()) {
      return yield* new FileDragStartError({
        path: input.path,
        cause: new Error("The window that started the drag is gone."),
      });
    }
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const icon = yield* firstExistingIcon(environment);
    if (icon === null) {
      return yield* new FileDragStartError({
        path: input.path,
        cause: new Error("The desktop icon is missing."),
      });
    }
    yield* Effect.try({
      try: () => contents.startDrag({ file: filePath, icon }),
      catch: (cause) => new FileDragStartError({ path: input.path, cause }),
    });
  }),
});
