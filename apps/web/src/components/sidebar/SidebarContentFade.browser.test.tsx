import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { render } from "../../../test/render";
import { endThreadDrag } from "../../threads/threadDrag";
import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  type LayoutState,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import { createLayoutWorkspaceNamed, listLayoutWorkspaces } from "../../layout/layoutWorkspaces";
import { setThreadMemberships } from "../../layout/threadMembership";
import { Sidebar, SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadSidebar } from "./ThreadSidebar";

const fixtures = vi.hoisted(() => ({
  projects: [
    {
      id: "project-1",
      environmentId: "env-1",
      title: "Houston",
      workspaceRoot: "/work/houston",
      archivedAt: null,
    },
    {
      id: "project-2",
      environmentId: "env-1",
      title: "notes",
      workspaceRoot: "/work/notes",
      archivedAt: null,
    },
  ],
  threads: [] as unknown[],
  actions: {
    settleThread: vi.fn(),
    unsettleThread: vi.fn(),
    snoozeThread: vi.fn(),
    unsnoozeThread: vi.fn(),
    setThreadAutoSettle: vi.fn(),
  },
}));

vi.mock(import("./sidebarProviderEntries"), async (original) => ({
  ...(await original()),
  sidebarProviderEntriesAtom: { providerEntriesProbe: true } as never,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: { readonly providerEntriesProbe?: true }) =>
    atom?.providerEntriesProbe === true ? new Map() : []) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));

// Every closed thread here is loaded, so the server holds no older ones.
vi.mock(import("../../state/olderSettledShelf"), async (original) => ({
  ...(await original()),
  useOlderSettledShelf: (() => ({
    environments: new Map(),
    visibleCount: 0,
    pages: new Map(),
    grow: () => {},
    isListed: () => true,
    unloadedCount: () => 0,
    loading: false,
    failed: false,
    retry: () => {},
  })) as never,
  useOlderSettledShelfGrowth: () => {},
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  useProjects: () => fixtures.projects as never,
  useQuietThreadShells: () => fixtures.threads as never,
}));

vi.mock(import("./SidebarChrome"), async (original) => ({
  ...(await original()),
  SidebarChromeHeader: (() => <></>) as never,
  SidebarChromeFooter: (() => (
    <SidebarFooter className="mt-auto">
      <div className="h-8 text-xs">footer</div>
    </SidebarFooter>
  )) as never,
}));

vi.mock(import("./SidebarUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarUpdateArchitectureWarning: () => <></>,
}));
vi.mock(import("./SidebarUpdatesButton"), async (original) => ({
  ...(await original()),
  SidebarUpdatesButton: (() => null) as never,
}));

vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () =>
    fixtures.projects.map((project) => ({
      ...project,
      projectKey: `env-1:${project.id}`,
      displayName: project.title,
      memberProjects: [project],
      memberProjectRefs: [],
      pinned: false,
      archived: false,
    })) as never,
}));

vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: async () => true }));

vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: () => fixtures.actions as never,
}));

function liveThread(id: string, projectId = "project-1", title = id): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId,
    title,
    branch: "main",
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: id,
      sideChat: false,
    },
  } as unknown as EnvironmentThreadShell;
}

function chat(id: string): LayoutTabContent {
  return {
    kind: "chat",
    target: {
      kind: "server",
      threadRef: scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(id)),
    },
  };
}

/** One named workspace per entry, each holding chat tabs for its threads. */
function layoutOf(
  spec: ReadonlyArray<{ name: string; chats: ReadonlyArray<string> }>,
): LayoutState {
  let state = createLayoutState();
  for (const entry of spec) {
    state = createLayoutWorkspaceNamed(state, entry.name).state;
    for (const id of entry.chats) state = openLayoutTab(state, chat(id));
  }
  return normalizeLayout(state);
}

function RailHarness() {
  return (
    <TooltipProvider delay={0}>
      <SidebarProvider>
        <Sidebar collapsible="none" className="h-screen w-[264px]">
          <ThreadSidebar />
        </Sidebar>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function seed(spec: Parameters<typeof layoutOf>[0], threads: EnvironmentThreadShell[]): Disposable {
  localStorage.clear();
  fixtures.threads = threads;
  const layout = layoutOf(spec);
  useLayoutStore.setState({ layout });
  setThreadMemberships(
    spec.flatMap((entry) =>
      entry.chats.map((threadId) => ({
        environmentId: "env-1",
        threadId,
        workspaceId: listLayoutWorkspaces(layout).find(
          (workspace) => workspace.name === entry.name,
        )!.id,
        parentThreadId: null,
      })),
    ),
    true,
  );
  return {
    [Symbol.dispose]: () => {
      setThreadMemberships([], false);
      localStorage.clear();
      endThreadDrag();
      vi.restoreAllMocks();
      useLayoutStore.getState().reset();
    },
  };
}

describe("sidebar list bottom edge", () => {
  it.each(["dark", "light"] as const)(
    "fades the list into the sidebar colour above the footer and scrolls the last row clear (%s)",
    async (scheme) => {
      document.documentElement.classList.toggle("dark", scheme === "dark");
      await page.viewport(400, 520);
      const ids = Array.from({ length: 14 }, (_, i) => `t${i}`);
      using _seed = seed(
        [
          { name: "Research", chats: ids.slice(0, 7) },
          { name: "Review", chats: ids.slice(7) },
        ],
        ids.map((id) => liveThread(id, "project-1", `Thread ${id}`)),
      );
      await using screen = await render(<RailHarness />);
      await vi.waitFor(() =>
        expect(screen.container.querySelectorAll("[data-thread-key]").length).toBe(14),
      );
      const viewport = screen.container.querySelector<HTMLElement>(
        "[data-slot=scroll-area-viewport]",
      )!;
      const fade = screen.container.querySelector<HTMLElement>("[data-slot=sidebar-content-fade]")!;
      const fadeStyle = getComputedStyle(fade);
      expect(fadeStyle.pointerEvents).toBe("none");
      expect(fadeStyle.height).toBe("24px");
      expect(fadeStyle.backgroundImage).toContain("linear-gradient");
      const footer = screen.container.querySelector<HTMLElement>("[data-sidebar=footer]")!;
      expect(fade.getBoundingClientRect().bottom).toBeCloseTo(
        footer.getBoundingClientRect().top,
        0,
      );

      // A keyboard-focused row must not switch the fade off.
      screen.container.querySelector<HTMLElement>("[data-thread-key] button")?.focus();
      expect(getComputedStyle(fade).backgroundImage).toContain("linear-gradient");

      viewport.scrollTop = viewport.scrollHeight;
      await vi.waitFor(() => {
        const rows = [...screen.container.querySelectorAll<HTMLElement>("[data-thread-key]")];
        expect(rows.at(-1)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          fade.getBoundingClientRect().top,
        );
      });
    },
  );
});
