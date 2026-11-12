import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { render } from "../../../test/render";
import { useLayoutStore } from "../../layout/layoutStore";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadSidebar } from "./ThreadSidebar";

const fixtures = vi.hoisted(() => ({
  project: {
    id: "project-1",
    environmentId: "env-1",
    title: "Houston",
    workspaceRoot: "/work/houston",
    archivedAt: null,
  },
  threads: [] as unknown[],
  groupsReady: true,
  listeners: new Set<() => void>(),
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
  useProjects: () => [fixtures.project] as never,
  useQuietThreadShells: () => fixtures.threads as never,
}));

vi.mock(import("./SidebarChrome"), async (original) => ({
  ...(await original()),
  SidebarChromeHeader: (() => <></>) as never,
}));

vi.mock(import("./SidebarUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarUpdatePill: () => <></>,
  SidebarUpdateArchitectureWarning: () => <></>,
}));

// Subscribed, so a test can deliver the project list after the first render, as a cold load does:
// the threads are known while the rail has no project section to draw their rows in.
vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () =>
    useSyncExternalStore(
      (listener) => {
        fixtures.listeners.add(listener);
        return () => fixtures.listeners.delete(listener);
      },
      () => fixtures.groupsReady,
    )
      ? ([
          {
            ...fixtures.project,
            projectKey: "env-1:project-1",
            displayName: "Houston",
            memberProjects: [fixtures.project],
            memberProjectRefs: [],
            pinned: false,
            archived: false,
          },
        ] as never)
      : ([] as never),
}));

vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: () => fixtures.actions as never,
}));

function shelfThread(overrides: Record<string, unknown>): EnvironmentThreadShell {
  return {
    environmentId: "env-1",
    projectId: "project-1",
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
      rootThreadId: overrides.id,
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function RailHarness() {
  return (
    <TooltipProvider delay={0}>
      <SidebarProvider>
        <ThreadSidebar />
      </SidebarProvider>
    </TooltipProvider>
  );
}

const ROW_COUNT = 24;

function setGroupsReady(ready: boolean) {
  fixtures.groupsReady = ready;
  for (const listener of fixtures.listeners) listener();
}

function rowThreads() {
  return Array.from({ length: ROW_COUNT }, (_, index) =>
    shelfThread({
      id: `thread-${index}`,
      title: `Thread ${index}`,
      branch: "feature/long-branch-name",
    }),
  );
}

function seedRows(): Disposable {
  localStorage.clear();
  useLayoutStore.getState().reset();
  fixtures.threads = rowThreads();
  fixtures.groupsReady = true;
  return { [Symbol.dispose]: () => localStorage.clear() };
}

/** Threads known, project list not yet delivered: the rail has no rows to draw them in. */
function seedColdRail(): Disposable {
  const seeded = seedRows();
  fixtures.groupsReady = false;
  return seeded;
}

const withinView = (row: HTMLElement, viewport: HTMLElement) => {
  const rect = row.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  return rect.top >= view.top && rect.bottom <= view.bottom;
};

describe("ThreadSidebar rail end", () => {
  it("scrolls far enough that the last row's second line clears the bottom fade", async () => {
    using _rows = seedRows();
    await using screen = await render(<RailHarness />);

    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("[data-thread-key]")).toHaveLength(ROW_COUNT),
    );
    const viewport = screen.container
      .querySelector("[data-thread-key]")!
      .closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    // The harness gives the rail the height of its content; bound it so it scrolls like the docked rail.
    viewport.style.height = "500px";
    viewport.style.flex = "none";
    viewport.scrollTop = viewport.scrollHeight;
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));

    const rows = screen.container.querySelectorAll<HTMLElement>("[data-thread-key]");
    const last = rows[rows.length - 1]!;
    const meta = last.querySelector<HTMLElement>("[data-thread-meta]")!;
    const view = viewport.getBoundingClientRect();
    const fadePx = 24;
    expect(meta.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.bottom - fadePx);
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(view.bottom - fadePx);
  });

  it("reveals the thread a cold load opened once its row arrives below the fold", async () => {
    using _rail = seedColdRail();
    await using screen = await render(<RailHarness />, {
      router: `/env-1/thread-${ROW_COUNT - 4}`,
    });
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    viewport.style.height = "500px";
    viewport.style.flex = "none";

    setGroupsReady(true);
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("[data-thread-key]")).toHaveLength(ROW_COUNT),
    );
    const open = screen.container.querySelector<HTMLElement>(
      `[data-thread-key$=":thread-${ROW_COUNT - 4}"]`,
    )!;
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    await vi.waitFor(() => expect(withinView(open, viewport)).toBe(true));
  });

  it("leaves the scroll where the user put it when the row arrives after they scrolled", async () => {
    using _rail = seedColdRail();
    await using screen = await render(<RailHarness />, {
      router: `/env-1/thread-${ROW_COUNT - 4}`,
    });
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    viewport.style.height = "500px";
    viewport.style.flex = "none";

    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true }));
    setGroupsReady(true);
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll("[data-thread-key]")).toHaveLength(ROW_COUNT),
    );
    expect(viewport.scrollTop).toBe(0);
  });
});
