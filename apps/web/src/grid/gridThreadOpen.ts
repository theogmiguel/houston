import { containsThread, type LayoutNode } from "./tree";

export type GridThreadOpen =
  | { readonly kind: "navigate" }
  | { readonly kind: "focus" }
  | { readonly kind: "replace"; readonly cellThreadId: string }
  | { readonly kind: "add" };

/**
 * Where a grid opens a thread: one already on it gets focus; one opened from a cell (a subagent,
 * its parent) replaces that cell, so peeking never grows the grid; anything else joins the grid
 * if it is in the grid's workspace, else opens on its own page.
 */
export function resolveGridThreadOpen(input: {
  readonly tree: LayoutNode | null;
  readonly gridEnvironmentId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly fromThreadId: string | null;
  readonly inWorkspace: boolean;
}): GridThreadOpen {
  if (input.environmentId !== input.gridEnvironmentId) return { kind: "navigate" };
  if (containsThread(input.tree, input.threadId)) return { kind: "focus" };
  if (input.fromThreadId !== null && containsThread(input.tree, input.fromThreadId)) {
    return { kind: "replace", cellThreadId: input.fromThreadId };
  }
  return input.inWorkspace ? { kind: "add" } : { kind: "navigate" };
}
