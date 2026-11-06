import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { render } from "../../../test/render";
import { useGridStore } from "../../grid/gridStore";
import { SETTLED_SHELF_EXPANDED_KEY, SNOOZED_SHELF_EXPANDED_KEY } from "../sidebar/shelfState";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { GridSidebar } from "./GridSidebar";

const fixtures = vi.hoisted(() => ({
  project: {
    id: "project-1",
    environmentId: "env-1",
    title: "Houston",
    workspaceRoot: "/work/houston",
    archivedAt: null,
  },
  threads: [] as unknown[],
  actions: {
    settleThread: vi.fn(),
    unsettleThread: vi.fn(),
    snoozeThread: vi.fn(),
    unsnoozeThread: vi.fn(),
    setThreadAutoSettle: vi.fn(),
  },
}));

vi.mock(import("../sidebar/sidebarProviderEntries"), async (original) => ({
  ...(await original()),
  sidebarProviderEntriesAtom: { providerEntriesProbe: true } as never,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: { readonly providerEntriesProbe?: true }) =>
    atom?.providerEntriesProbe === true ? new Map() : []) as never,
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

vi.mock(import("../sidebar/SidebarChrome"), async (original) => ({
  ...(await original()),
  SidebarChromeHeader: (() => <></>) as never,
}));

vi.mock(import("../sidebar/SidebarUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarUpdatePill: () => <></>,
  SidebarUpdateArchitectureWarning: () => <></>,
}));

vi.mock(import("../pullRequest/useOpenPullRequestCount"), () => ({
  useOpenPullRequestCount: () => 0,
}));

vi.mock(import("../../state/tasks"), async (original) => ({
  ...(await original()),
  useTaskYourTurnCount: () => 0,
}));

vi.mock(import("../../hooks/useSidebarProjectGroups"), () => ({
  useSidebarProjectGroups: () =>
    [
      {
        ...fixtures.project,
        projectKey: "env-1:project-1",
        displayName: "Houston",
        memberProjects: [fixtures.project],
        memberProjectRefs: [],
        pinned: false,
        archived: false,
      },
    ] as never,
}));

vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: () => fixtures.actions as never,
}));

const HELD_ID = "thread-held";
const CLOSED_ID = "thread-closed";

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

function seedShelves(): Disposable {
  localStorage.clear();
  localStorage.setItem(SNOOZED_SHELF_EXPANDED_KEY, "true");
  localStorage.setItem(SETTLED_SHELF_EXPANDED_KEY, "true");
  useGridStore.setState({ grids: [], threadOrigins: {} });
  for (const action of Object.values(fixtures.actions)) {
    action.mockReset();
    action.mockResolvedValue({ _tag: "Success", value: undefined });
  }
  fixtures.threads = [
    shelfThread({ id: HELD_ID, title: "Held thread", snoozedUntil: "2099-01-01T09:00:00.000Z" }),
    shelfThread({ id: CLOSED_ID, title: "Closed thread", settledOverride: "settled" }),
  ];
  return { [Symbol.dispose]: () => localStorage.clear() };
}

function RailHarness() {
  return (
    <TooltipProvider delay={0}>
      <SidebarProvider>
        <GridSidebar />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function shelfRow(container: HTMLElement, threadId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-thread-key$=":${threadId}"]`)!;
}

describe("GridSidebar shelf rows", () => {
  it("closes a held thread from its context menu", async () => {
    using _shelves = seedShelves();
    await using screen = await render(<RailHarness />);

    await userEvent.click(shelfRow(screen.container, HELD_ID), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Close thread" }).element());

    await vi.waitFor(() => expect(fixtures.actions.settleThread).toHaveBeenCalledTimes(1));
  });

  it("holds a closed thread from its context menu", async () => {
    using _shelves = seedShelves();
    await using screen = await render(<RailHarness />);

    await userEvent.click(shelfRow(screen.container, CLOSED_ID), { button: "right" });
    await userEvent.hover(page.getByRole("menuitem", { name: "Hold" }).element());
    await userEvent.click(
      page
        .getByRole("menuitem", { name: /\(.+\)$/ })
        .first()
        .element(),
    );

    await vi.waitFor(() => expect(fixtures.actions.snoozeThread).toHaveBeenCalledTimes(1));
  });

  it("changes a held thread's auto-close behavior from its context menu", async () => {
    using _shelves = seedShelves();
    await using screen = await render(<RailHarness />);

    await userEvent.click(shelfRow(screen.container, HELD_ID), { button: "right" });
    await userEvent.hover(page.getByRole("menuitem", { name: "Auto-close behavior" }).element());
    await userEvent.click(page.getByRole("menuitemradio", { name: "Disabled" }).element());

    await vi.waitFor(() =>
      expect(fixtures.actions.setThreadAutoSettle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadId: HELD_ID }),
        false,
      ),
    );
  });
});
