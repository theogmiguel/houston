import { isTabDragSource, type WorkspaceDragSource } from "./threadDrag";

/** The drop target that asks for a workspace to be created around what was dropped. */
export const NEW_WORKSPACE_DROP = "new-workspace" as const;

/**
 * How long a drag rests on a workspace heading before that workspace becomes the visible one, so
 * the drop can name a pane. Long enough that sweeping over headings in transit does not switch
 * them, short enough that resting on one feels answered.
 */
export const WORKSPACE_SPRING_LOAD_MS = 600;

/**
 * Height of the blank strip a drag keeps at the end of the workspace list, so a long list still
 * ends in a target the pointer can rest on; matches the `min-h-24` of the zone's recipe.
 */
export const NEW_WORKSPACE_ZONE_MIN_PX = 96;

/** Pointer distance from the sidebar list's top or bottom edge where a drag starts scrolling it. */
export const DRAG_AUTO_SCROLL_BAND_PX = 40;

/** Fastest scroll step per animation frame, reached with the pointer on the edge itself. */
export const DRAG_AUTO_SCROLL_MAX_STEP_PX = 16;

/** What a drop on a workspace (or the new-workspace zone) asks the window to do. */
export type WorkspaceDropOperation =
  | { readonly kind: "none" }
  | {
      readonly kind: "move-thread";
      readonly thread: { readonly environmentId: string; readonly threadId: string };
      readonly title: string | null;
      readonly target: string;
    }
  | { readonly kind: "move-tab"; readonly tabId: string; readonly target: string };

/**
 * The operation a drop calls: a card or a server chat's tab moves its thread through the same
 * move the thread menu uses; a draft, terminal or page tab has no thread and moves as a tab.
 * Dropping on the workspace a source already sits in does nothing.
 */
export function resolveWorkspaceDrop(
  source: WorkspaceDragSource,
  target: string,
): WorkspaceDropOperation {
  if (target !== NEW_WORKSPACE_DROP && (source.workspaceId ?? null) === target) {
    return { kind: "none" };
  }
  if (isTabDragSource(source)) {
    return source.thread === null
      ? { kind: "move-tab", tabId: source.tabId, target }
      : { kind: "move-thread", thread: source.thread, title: source.title, target };
  }
  return {
    kind: "move-thread",
    thread: { environmentId: source.environmentId, threadId: source.threadId },
    title: source.title ?? null,
    target,
  };
}

/**
 * Whether a sidebar card can be dragged on its own: a child follows its parent, an archived thread
 * is not listed and a side thread belongs to its source.
 */
export function isThreadDraggable(
  thread: {
    readonly archivedAt: string | null;
    readonly side?: unknown;
    readonly lineage: {
      readonly relationshipToParent?: string | null;
      readonly sideChat?: boolean | undefined;
    };
  },
  membership: { readonly parentThreadId: string | null } | undefined,
): boolean {
  if ((thread.archivedAt ?? null) !== null) return false;
  if (thread.side !== undefined || thread.lineage.sideChat === true) return false;
  if (membership?.parentThreadId != null) return false;
  return thread.lineage.relationshipToParent !== "subagent";
}

/**
 * Pixels to scroll this frame for a pointer at `pointerY` over a list spanning `rect`: zero away
 * from the edges, growing to the maximum on the edge, negative near the top.
 */
export function dragAutoScrollStep(
  pointerY: number,
  rect: { readonly top: number; readonly bottom: number },
): number {
  const fromTop = pointerY - rect.top;
  const fromBottom = rect.bottom - pointerY;
  if (fromTop < 0 || fromBottom < 0) return 0;
  if (fromTop < DRAG_AUTO_SCROLL_BAND_PX) {
    return -Math.ceil(
      ((DRAG_AUTO_SCROLL_BAND_PX - fromTop) / DRAG_AUTO_SCROLL_BAND_PX) *
        DRAG_AUTO_SCROLL_MAX_STEP_PX,
    );
  }
  if (fromBottom < DRAG_AUTO_SCROLL_BAND_PX) {
    return Math.ceil(
      ((DRAG_AUTO_SCROLL_BAND_PX - fromBottom) / DRAG_AUTO_SCROLL_BAND_PX) *
        DRAG_AUTO_SCROLL_MAX_STEP_PX,
    );
  }
  return 0;
}
