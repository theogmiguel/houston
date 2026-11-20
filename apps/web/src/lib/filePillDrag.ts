import type { HostBridge } from "@houston-app/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

export interface FilePillDragSource {
  readonly path: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
}

export interface FilePillDragEvent {
  preventDefault(): void;
}

export interface FilePillDragHandlers {
  readonly draggable: true;
  readonly onDragStart: (event: FilePillDragEvent) => void;
}

type FileDragBridge = Pick<HostBridge, "startFileDrag">;

function hostFileDragBridge(): FileDragBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.hostBridge;
  return bridge === undefined || typeof bridge.startFileDrag !== "function" ? undefined : bridge;
}

function reportFileDragFailure(error: unknown): void {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "The file could not be dragged.";
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Unable to drag file",
      description: message,
    }),
  );
}

/** Native file drags only exist in the desktop host; a browser keeps its default drag. */
export function filePillDragHandlers(
  source: FilePillDragSource,
  options: {
    readonly bridge?: FileDragBridge | undefined;
    readonly reportError?: ((message: string) => void) | undefined;
  } = {},
): FilePillDragHandlers | undefined {
  const path = source.path;
  const workspaceRoot = source.workspaceRoot?.trim();
  const bridge = options.bridge ?? hostFileDragBridge();
  if (
    bridge === undefined ||
    path === null ||
    path === undefined ||
    path.length === 0 ||
    workspaceRoot === undefined ||
    workspaceRoot.length === 0
  ) {
    return undefined;
  }
  return {
    draggable: true,
    onDragStart: (event) => {
      event.preventDefault();
      void bridge.startFileDrag({ path, workspaceRoot }).catch((error: unknown) => {
        if (options.reportError !== undefined) {
          options.reportError(error instanceof Error ? error.message : String(error));
          return;
        }
        reportFileDragFailure(error);
      });
    },
  };
}
