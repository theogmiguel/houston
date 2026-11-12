import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import {
  ChartNoAxesColumnIcon,
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  PlusIcon,
  SettingsIcon,
  SquareTerminalIcon,
} from "lucide-react";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import {
  LayoutLauncherGroup,
  LayoutLauncherList,
  LayoutLauncherRow,
  LayoutLauncherFrame,
} from "../components/ui/layout-launcher";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useRightPanelStore } from "../rightPanelStore";
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { findLayoutTab, type LayoutPageContent } from "./layoutModel";
import { useLayoutPane } from "./layoutPaneContext";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { runInNewLayoutTab, useLayoutStore } from "./layoutStore";
import { useOpenLayoutPage } from "./pageNavigation";
import { requestLayoutSurfacePlacement } from "./surfaceSync";

type LauncherSurface = "diff" | "files" | "browser" | "terminal" | "pull-requests";

const SURFACES: ReadonlyArray<{
  kind: LauncherSurface;
  label: string;
  icon: typeof GitCompareIcon;
}> = [
  { kind: "diff", label: "Changes", icon: GitCompareIcon },
  { kind: "files", label: "Files", icon: FolderIcon },
  { kind: "browser", label: "Browser", icon: GlobeIcon },
  { kind: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { kind: "pull-requests", label: "Pull requests", icon: PullRequestGlyph.pullRequest },
];

function openSurface(threadRef: ScopedThreadRef, kind: LauncherSurface): void {
  const panels = useRightPanelStore.getState();
  switch (kind) {
    case "terminal":
      useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
      return;
    case "browser":
      panels.openBrowser(threadRef, null);
      return;
    default:
      panels.open(threadRef, kind);
  }
}

/**
 * What a launcher tab offers: start a thread in a project (the tab turns into its chat), open a
 * surface of the thread the tab was opened from (the tab turns into it), or open a page. An empty
 * workspace shows the same launcher with no tab to replace.
 */
export function LayoutLauncher({
  tabId,
  context,
}: {
  /** The launcher's tab, or null for an empty workspace. */
  readonly tabId: string | null;
  readonly context: ThreadRouteTarget | null;
}) {
  const { paneId } = useLayoutPane();
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const handleNewThread = useNewThreadHandler();
  const openPage = useOpenLayoutPage();
  const focusedWorkspaceId = useLayoutStore((state) => state.layout.focusedWorkspaceId);
  const contextRef = context === null ? null : chatTargetThreadRef(context);
  const ranked = sortScopedProjectsForSidebar(
    projects.filter((project) => project.archivedAt == null),
    threads,
    "updated_at",
  );

  const start = (action: () => Promise<unknown>) =>
    void (tabId === null ? action() : runInNewLayoutTab(action, { replaceTabId: tabId }));
  const showSurface = (kind: LauncherSurface) => {
    if (contextRef === null) return;
    requestLayoutSurfacePlacement(
      contextRef,
      tabId !== null && paneId !== null
        ? { kind: "pane", paneId, replaceTabId: tabId }
        : { kind: "workspace", workspaceId: focusedWorkspaceId },
    );
    openSurface(contextRef, kind);
    // A surface that already had a tab is focused instead of placed, which leaves the launcher.
    const store = useLayoutStore.getState();
    if (tabId !== null && findLayoutTab(store.layout, (tab) => tab.id === tabId)) {
      store.closeTab(tabId);
    }
  };
  const showPage = (kind: LayoutPageContent["kind"]) =>
    void openPage(
      kind,
      paneId !== null
        ? { kind: "pane", paneId }
        : { kind: "column", workspaceId: focusedWorkspaceId, index: 0 },
      tabId ?? undefined,
    );

  return (
    <LayoutLauncherFrame data-new-tab-launcher="">
      <LayoutLauncherList aria-label="New tab">
        <LayoutLauncherGroup>Start a thread in</LayoutLauncherGroup>
        {ranked.length === 0 ? (
          <LayoutLauncherRow
            icon={<PlusIcon aria-hidden className="size-4" />}
            label="No projects yet"
            disabledReason="Add a project first."
            onSelect={() => undefined}
          />
        ) : (
          ranked.map((project) => (
            <LayoutLauncherRow
              key={`${project.environmentId}:${project.id}`}
              icon={<PlusIcon aria-hidden className="size-4" />}
              label={project.title}
              onSelect={() =>
                start(() => handleNewThread(scopeProjectRef(project.environmentId, project.id)))
              }
            />
          ))
        )}
        {contextRef === null ? null : (
          <>
            <LayoutLauncherGroup>Open beside this thread</LayoutLauncherGroup>
            {SURFACES.map(({ kind, label, icon: Icon }) => (
              <LayoutLauncherRow
                key={kind}
                icon={<Icon aria-hidden className="size-4" />}
                label={label}
                onSelect={() => showSurface(kind)}
              />
            ))}
          </>
        )}
        <LayoutLauncherGroup>Open a page</LayoutLauncherGroup>
        <LayoutLauncherRow
          icon={<SettingsIcon aria-hidden className="size-4" />}
          label="Settings"
          onSelect={() => showPage("settings")}
        />
        <LayoutLauncherRow
          icon={<ChartNoAxesColumnIcon aria-hidden className="size-4" />}
          label="Usage"
          onSelect={() => showPage("usage")}
        />
        <LayoutLauncherRow
          icon={<PullRequestGlyph.pullRequest aria-hidden className="size-4" />}
          label="Pull requests"
          onSelect={() => showPage("pull-requests")}
        />
      </LayoutLauncherList>
    </LayoutLauncherFrame>
  );
}
