import { containsThread, type LayoutNode } from "@houston-app/shared/grid/tree";

export type GridThreadOpen =
  | { readonly kind: "navigate" }
  | { readonly kind: "focus" }
  | { readonly kind: "replace"; readonly cellThreadId: string }
  | { readonly kind: "add" };

/** `peek` follows a related thread (a subagent, its parent); `join` adds one, like a resume. */
export type ThreadOpenIntent = "peek" | "join";

// Shown threads get focus; a peek from a cell replaces it, so peeking never grows the grid;
// a join gets its own cell while there is room, even before its shell is listed; anything else
// joins if it is in the grid's workspace, else opens on its own page.
export function resolveGridThreadOpen(input: {
  readonly tree: LayoutNode | null;
  readonly gridEnvironmentId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly fromThreadId: string | null;
  readonly inWorkspace: boolean;
  readonly intent: ThreadOpenIntent;
  readonly hasRoom: boolean;
}): GridThreadOpen {
  if (input.environmentId !== input.gridEnvironmentId) return { kind: "navigate" };
  if (containsThread(input.tree, input.threadId)) return { kind: "focus" };
  if (input.intent === "join") return input.hasRoom ? { kind: "add" } : { kind: "navigate" };
  if (input.fromThreadId !== null && containsThread(input.tree, input.fromThreadId)) {
    return { kind: "replace", cellThreadId: input.fromThreadId };
  }
  return input.inWorkspace ? { kind: "add" } : { kind: "navigate" };
}
