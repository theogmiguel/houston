// Which workspace each thread with an open chat tab belongs to, read from stored layouts. Used by
// the migration that introduces thread membership.
export interface StoredWorkspaceTabs {
  readonly id: string;
  readonly columns: ReadonlyArray<{
    readonly panes: ReadonlyArray<{
      readonly tabs: ReadonlyArray<{ readonly content: unknown }>;
    }>;
  }>;
}

export interface TabMembership {
  readonly environmentId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const chatRefOf = (content: unknown): { environmentId: string; threadId: string } | null => {
  if (!isRecord(content) || content.kind !== "chat" || !isRecord(content.target)) return null;
  if (content.target.kind !== "server" || !isRecord(content.target.threadRef)) return null;
  const { environmentId, threadId } = content.target.threadRef;
  return typeof environmentId === "string" && typeof threadId === "string"
    ? { environmentId, threadId }
    : null;
};

/**
 * One membership per thread that has a chat tab. A thread with tabs in several workspaces goes to
 * `focusedWorkspaceId` when that workspace holds one, else to the first workspace (in the given
 * order) that does.
 */
export const membershipsFromTabs = (
  workspaces: ReadonlyArray<StoredWorkspaceTabs>,
  focusedWorkspaceId?: string,
): ReadonlyArray<TabMembership> => {
  const holders = new Map<
    string,
    { ref: { environmentId: string; threadId: string }; in: string[] }
  >();
  for (const workspace of workspaces) {
    for (const column of workspace.columns ?? []) {
      for (const pane of column.panes ?? []) {
        for (const tab of pane.tabs ?? []) {
          const ref = chatRefOf(tab.content);
          if (ref === null) continue;
          const key = `${ref.environmentId}\u0000${ref.threadId}`;
          const entry = holders.get(key) ?? { ref, in: [] };
          if (!entry.in.includes(workspace.id)) entry.in.push(workspace.id);
          holders.set(key, entry);
        }
      }
    }
  }
  return [...holders.values()].map(({ ref, in: ids }) => ({
    ...ref,
    workspaceId:
      focusedWorkspaceId !== undefined && ids.includes(focusedWorkspaceId)
        ? focusedWorkspaceId
        : ids[0]!,
  }));
};
