import type { HostBridge, ScopedThreadRef } from "@houston-app/contracts";
import { workspaceRelativeFilePath } from "@houston-app/shared/path";
import type { PointerEvent as ReactPointerEvent } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { beginLayoutSurfaceDrag } from "../layout/layoutTabDrag";
import {
  layoutSurfacePlacementForDestination,
  requestLayoutSurfacePlacement,
} from "../layout/surfaceSync";
import { fileSurfaceId, useRightPanelStore } from "../rightPanelStore";

export interface FilePillDragSource {
  readonly path: string | null | undefined;
  readonly workspaceRoot?: string | null | undefined;
  /** The thread whose right panel opens the file; without one there is no layout drop. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  /** The chip's label on the drag ghost. */
  readonly title?: string | undefined;
}

export interface FilePillDragEvent {
  preventDefault(): void;
}

export interface FilePillDragHandlers {
  readonly draggable: boolean;
  readonly onDragStart?: ((event: FilePillDragEvent) => void) | undefined;
  readonly onPointerDown?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
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

function nativeDragStarter(
  bridge: FileDragBridge | undefined,
  path: string,
  workspaceRoot: string,
  reportError: ((message: string) => void) | undefined,
): (() => void) | undefined {
  if (bridge === undefined) return undefined;
  return () => {
    void bridge.startFileDrag({ path, workspaceRoot }).catch((error: unknown) => {
      if (reportError !== undefined) {
        reportError(error instanceof Error ? error.message : String(error));
        return;
      }
      reportFileDragFailure(error);
    });
  };
}

/**
 * One gesture for a file chip: a pointer drag opens the file's surface where it is dropped, and
 * leaving the window hands the same drag to the OS file manager. Without a thread to open the
 * file in, the native HTML5 drag keeps its earlier behaviour.
 */
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
    path === null ||
    path === undefined ||
    path.length === 0 ||
    workspaceRoot === undefined ||
    workspaceRoot.length === 0
  ) {
    return undefined;
  }
  const startNative = nativeDragStarter(bridge, path, workspaceRoot, options.reportError);
  const threadRef = source.threadRef ?? null;
  if (threadRef === null) {
    if (startNative === undefined) return undefined;
    return {
      draggable: true,
      onDragStart: (event) => {
        event.preventDefault();
        startNative();
      },
    };
  }
  const layoutPath = workspaceRelativeFilePath(path, workspaceRoot) ?? path;
  const surfaceId = fileSurfaceId(layoutPath);
  return {
    // The pointer gesture owns the drag; a native HTML5 drag would cancel it.
    draggable: false,
    onPointerDown: (event) => {
      beginLayoutSurfaceDrag(
        event,
        {
          kind: "surface",
          threadRef,
          surfaceId,
          ...(source.title === undefined ? {} : { title: source.title }),
          open: (destination) => {
            requestLayoutSurfacePlacement(
              threadRef,
              layoutSurfacePlacementForDestination(destination),
            );
            useRightPanelStore.getState().openFile(threadRef, layoutPath);
          },
        },
        startNative === undefined ? {} : { onLeaveWindow: startNative },
      );
    },
  };
}
