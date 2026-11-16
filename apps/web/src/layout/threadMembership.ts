// Which workspace each chat thread belongs to, as the server last reported it. An entry can name
// a thread this window has not loaded yet, and a thread can have no entry until the server assigns
// one; neither is drawn under a guessed workspace.
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { HoustonLayoutThreadMembership } from "@houston-app/contracts/houston/layoutWorkspaces";
import { create } from "zustand";

export interface ThreadMembershipEntry {
  readonly workspaceId: string;
  /** Set for a subagent child, which follows its parent and has no workspace choice of its own. */
  readonly parentThreadId: string | null;
}

export interface ThreadMembershipState {
  /** False until the first snapshot: no thread can be placed before it. */
  readonly loaded: boolean;
  readonly byThread: ReadonlyMap<string, ThreadMembershipEntry>;
  /** The workspaces at least one thread belongs to; they stay in the layout with no tab open. */
  readonly occupied: ReadonlySet<string>;
}

export const membershipKeyOf = (environmentId: string, threadId: string): string =>
  scopedThreadKey(scopeThreadRef(environmentId as never, threadId as never));

export const useThreadMembershipStore = create<ThreadMembershipState>(() => ({
  loaded: false,
  byThread: new Map(),
  occupied: new Set(),
}));

const sameEntries = (
  left: ReadonlyMap<string, ThreadMembershipEntry>,
  right: ReadonlyMap<string, ThreadMembershipEntry>,
): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, entry] of right) {
    const other = left.get(key);
    if (
      other === undefined ||
      other.workspaceId !== entry.workspaceId ||
      other.parentThreadId !== entry.parentThreadId
    ) {
      return false;
    }
  }
  return true;
};

/** Replaces what the store holds; an unchanged set keeps the same map so selectors stay quiet. */
export function setThreadMemberships(
  memberships: ReadonlyArray<HoustonLayoutThreadMembership>,
  loaded: boolean,
): void {
  const byThread = new Map<string, ThreadMembershipEntry>(
    memberships.map((row) => [
      membershipKeyOf(row.environmentId, row.threadId),
      { workspaceId: row.workspaceId, parentThreadId: row.parentThreadId },
    ]),
  );
  const state = useThreadMembershipStore.getState();
  if (state.loaded === loaded && sameEntries(state.byThread, byThread)) return;
  const unchanged = sameEntries(state.byThread, byThread);
  useThreadMembershipStore.setState({
    loaded,
    byThread: unchanged ? state.byThread : byThread,
    occupied: unchanged
      ? state.occupied
      : new Set([...byThread.values()].map((entry) => entry.workspaceId)),
  });
}

/** The workspace a thread belongs to, or null before the server has assigned one. */
export function workspaceOfThreadRef(
  environmentId: string,
  threadId: string,
  state: ThreadMembershipState = useThreadMembershipStore.getState(),
): string | null {
  return state.byThread.get(membershipKeyOf(environmentId, threadId))?.workspaceId ?? null;
}
