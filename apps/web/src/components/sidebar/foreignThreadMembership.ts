// The server assigns a workspace to the threads it hosts. A thread of another environment is
// hosted elsewhere, so this window asks the layout server to record its workspace once.
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { findLayoutTabByContent, type LayoutState } from "../../layout/layoutModel";
import type { ThreadMembershipState } from "../../layout/threadMembership";
import { isSidebarHiddenThread } from "../Sidebar.logic";

export interface ForeignThreadAssignment {
  readonly environmentId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

/**
 * The threads of other environments that have no workspace yet: each goes where its chat tab is
 * open, else to the first workspace. Nothing is planned before the first snapshot arrives, since
 * a thread the server already placed would look unplaced.
 */
export function planForeignThreadAssignments(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly memberships: ThreadMembershipState;
  readonly layout: LayoutState;
  readonly layoutEnvironmentId: string | null;
}): ReadonlyArray<ForeignThreadAssignment> {
  const { memberships, layout } = input;
  if (!memberships.loaded || input.layoutEnvironmentId === null) return [];
  const first = layout.workspaces[0];
  if (first === undefined) return [];
  const assignments: ForeignThreadAssignment[] = [];
  for (const thread of input.threads) {
    if (thread.environmentId === input.layoutEnvironmentId) continue;
    if (thread.deletedAt !== null || isSidebarHiddenThread(thread)) continue;
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    if (memberships.byThread.has(scopedThreadKey(ref))) continue;
    const tab = findLayoutTabByContent(layout, {
      kind: "chat",
      target: { kind: "server", threadRef: ref },
    });
    assignments.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      workspaceId: tab?.workspace.id ?? first.id,
    });
  }
  return assignments;
}
