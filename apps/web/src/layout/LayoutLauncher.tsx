import { useAtomValue } from "@effect/atom-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import {
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SquareDashedIcon,
  SquareTerminalIcon,
  TabletSmartphoneIcon,
  ListChecksIcon,
} from "lucide-react";

import { useBrowserDefaults } from "../browser/browserDefaults";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import {
  LayoutLauncherGroup,
  LayoutLauncherList,
  LayoutLauncherRow,
  LayoutLauncherFrame,
} from "../components/ui/layout-launcher";
import { shortcutLabelForCommand } from "../keybindings";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useScratchProject } from "../hooks/useScratchProject";
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  findLayoutSurfaceTabs,
  findLayoutTab,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutPageContent,
} from "./layoutModel";
import { useLayoutPane } from "./layoutPaneContext";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { runInNewLayoutTab, useLayoutStore } from "./layoutStore";
import { useOpenLayoutPage } from "./pageNavigation";
import { requestLayoutSurfacePlacement } from "./surfaceSync";
import { useThreadSurfaceOpeners, type LauncherSurfaceKind } from "./useThreadSurfaceOpeners";

const SURFACES: ReadonlyArray<{
  kind: LauncherSurfaceKind;
  label: string;
  icon: typeof GitCompareIcon;
}> = [
  { kind: "diff", label: "Changes", icon: GitCompareIcon },
  { kind: "files", label: "Files", icon: FolderIcon },
  { kind: "browser", label: "Browser", icon: GlobeIcon },
  { kind: "terminal", label: "Terminal", icon: SquareTerminalIcon },
  { kind: "pull-request", label: "Pull request", icon: PullRequestGlyph.pullRequest },
  { kind: "pull-requests", label: "Linked pull requests", icon: PullRequestGlyph.link },
  { kind: "device", label: "Device", icon: TabletSmartphoneIcon },
  { kind: "side-chat", label: "Side chat", icon: MessageSquareTextIcon },
];

/** The app-wide command that already opens a surface, where one exists. */
const SURFACE_COMMANDS: Partial<Record<LauncherSurfaceKind, "diff.toggle" | "terminal.toggle">> = {
  diff: "diff.toggle",
  terminal: "terminal.toggle",
};

/** Kinds whose open is a store change the layout sync answers at once; the rest finish later. */
const IMMEDIATE_SURFACES: ReadonlySet<LauncherSurfaceKind> = new Set([
  "diff",
  "files",
  "terminal",
  "pull-request",
  "pull-requests",
  "device",
]);

/**
 * What a launcher tab offers: start a thread in a project or without one (the tab turns into its
 * chat), open a surface of the thread the tab was opened from (the tab turns into it), or open a
 * page. An empty workspace shows the same launcher with no tab to replace.
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
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const openPage = useOpenLayoutPage();
  const focusedWorkspaceId = useLayoutStore((state) => state.layout.focusedWorkspaceId);
  const contextRef = context === null ? null : chatTargetThreadRef(context);
  const ranked = sortScopedProjectsForSidebar(
    projects.filter((project) => project.archivedAt == null),
    threads,
    "updated_at",
  );
  const scratchEnvironment = scratchEnvironmentId(contextRef?.environmentId ?? null);

  const start = (action: () => Promise<unknown>) =>
    void (tabId === null ? action() : runInNewLayoutTab(action, { replaceTabId: tabId }));
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
        {ranked.map((project) => (
          <LayoutLauncherRow
            key={`${project.environmentId}:${project.id}`}
            icon={<PlusIcon aria-hidden className="size-4" />}
            label={project.title}
            onSelect={() =>
              start(() => handleNewThread(scopeProjectRef(project.environmentId, project.id)))
            }
          />
        ))}
        <LayoutLauncherRow
          icon={<SquareDashedIcon aria-hidden className="size-4" />}
          label="No project"
          {...(scratchEnvironment === null
            ? { disabledReason: "No connected environment offers a scratch folder." }
            : {})}
          onSelect={() => {
            if (scratchEnvironment !== null) start(() => startScratchThread(scratchEnvironment));
          }}
        />
        {contextRef === null ? null : (
          <LauncherSurfaces threadRef={contextRef} tabId={tabId} paneId={paneId} />
        )}
        <LayoutLauncherGroup>Open a page</LayoutLauncherGroup>
        <LayoutLauncherRow
          icon={<PullRequestGlyph.pullRequest aria-hidden className="size-4" />}
          label="Pull requests"
          onSelect={() => showPage("pull-requests")}
        />
        <LayoutLauncherRow
          icon={<ListChecksIcon aria-hidden className="size-4" />}
          label="Tasks"
          onSelect={() => showPage("tasks")}
        />
      </LayoutLauncherList>
    </LayoutLauncherFrame>
  );
}

/** The surfaces of the thread the launcher was opened from. */
function LauncherSurfaces({
  threadRef,
  tabId,
  paneId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string | null;
  readonly paneId: string | null;
}) {
  const openers = useThreadSurfaceOpeners(threadRef);
  const profiles = useBrowserDefaults().profiles;
  const focusedWorkspaceId = useLayoutStore((state) => state.layout.focusedWorkspaceId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const show = (kind: LauncherSurfaceKind, browserProfileId?: string) => {
    requestLayoutSurfacePlacement(
      threadRef,
      tabId !== null && paneId !== null
        ? { kind: "pane", paneId, replaceTabId: tabId }
        : { kind: "workspace", workspaceId: focusedWorkspaceId },
    );
    openers.open(kind, browserProfileId);
    if (!IMMEDIATE_SURFACES.has(kind)) return;
    // A surface that already had a tab is focused instead of placed, which leaves the launcher.
    const store = useLayoutStore.getState();
    if (kind === "terminal") {
      const terminal = findLayoutSurfaceTabs(store.layout, threadRef).find(
        ({ tab }) =>
          tab.content.kind === "surface" && tab.content.surfaceId === THREAD_TERMINAL_SURFACE_ID,
      );
      if (terminal) store.focusTab(terminal.tab.id);
    }
    if (tabId !== null && findLayoutTab(store.layout, (tab) => tab.id === tabId)) {
      store.closeTab(tabId);
    }
  };

  return (
    <>
      <LayoutLauncherGroup>Open beside this thread</LayoutLauncherGroup>
      {SURFACES.map(({ kind, label, icon: Icon }) => {
        const { available, reason } = openers.surfaces[kind];
        return (
          <LayoutLauncherRow
            key={kind}
            icon={<Icon aria-hidden className="size-4" />}
            label={label}
            shortcut={shortcutLabelForCommand(keybindings, SURFACE_COMMANDS[kind] ?? null)}
            {...(available ? {} : { disabledReason: reason })}
            onSelect={() => show(kind)}
          />
        );
      })}
      {openers.surfaces.browser.available && profiles.length > 1
        ? profiles.map((profile) => (
            <LayoutLauncherRow
              key={profile.id}
              icon={<GlobeIcon aria-hidden className="size-4" />}
              label={`Browser in ${profile.name}`}
              onSelect={() => show("browser", profile.id)}
            />
          ))
        : null}
    </>
  );
}
