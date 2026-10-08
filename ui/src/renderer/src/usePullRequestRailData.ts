import { useMemo } from "react";
import { isLive } from "./houston/client";
import type { AgentKind, HoustonClient, SessionInfo } from "./houston/client";
import type { CheckAgentTarget } from "./components/prs/ChecksList";
import { useLinkedPullRequests } from "./useLinkedPullRequests";
import type { RailPrState } from "./components/git/railPrCache";
import { gridStorageKey, loadLayout, preorderSessions } from "./layout/tree";
import type { LayoutState, LayoutNode } from "./layout/tree";

type Sessions = ReadonlyMap<number, SessionInfo>;

function treeForGrid(
  workspace: string,
  gridId: string,
  layouts: ReadonlyMap<string, LayoutState>,
  warmLayouts: ReadonlyMap<string, LayoutState>,
): LayoutNode | null {
  const key = gridStorageKey(workspace, gridId);
  return layouts.get(key)?.tree ?? warmLayouts.get(key)?.tree ?? loadLayout(key).tree;
}

function checkAgentTargetsForTree(tree: LayoutNode | null, sessions: Sessions): CheckAgentTarget[] {
  const providerLabels: Partial<Record<AgentKind, string>> = {
    claude: "Claude",
    codex: "Codex",
    antigravity: "Antigravity",
    opencode: "OpenCode",
    cursor: "Cursor",
    grok: "Grok",
  };
  return preorderSessions(tree).flatMap((id) => {
    const session = sessions.get(id);
    const provider = session && providerLabels[session.agent];
    if (!session || !provider || !isLive(session.state)) return [];
    return [{
      session: id,
      provider,
      label: session.codename || session.title || `${provider} ${id}`,
      checkout: session.worktree?.path ?? session.project_dir,
    }];
  });
}

export function usePullRequestRailData(
  client: HoustonClient | null,
  sideWorkspace: string,
  currentTree: LayoutNode | null,
  activeGridId: (workspace: string) => string,
  layouts: ReadonlyMap<string, LayoutState>,
  warmLayouts: ReadonlyMap<string, LayoutState>,
  sessions: Sessions,
  railPrByDir: ReadonlyMap<string, RailPrState>,
) {
  const linkedGridTree = useMemo(
    () => sideWorkspace === "all"
      ? currentTree
      : treeForGrid(sideWorkspace, activeGridId(sideWorkspace), layouts, warmLayouts),
    [activeGridId, currentTree, layouts, sideWorkspace, warmLayouts],
  );
  const linkedGridPaneIds = useMemo(() => preorderSessions(linkedGridTree), [linkedGridTree]);
  const linkedPullRequests = useLinkedPullRequests(client, sessions, linkedGridPaneIds, railPrByDir);
  const checkAgentTargets = useMemo(() => {
    if (sideWorkspace === "all") return [];
    return checkAgentTargetsForTree(
      treeForGrid(sideWorkspace, activeGridId(sideWorkspace), layouts, warmLayouts),
      sessions,
    );
  }, [activeGridId, layouts, sessions, sideWorkspace, warmLayouts]);
  return { checkAgentTargets, linkedPullRequests };
}
