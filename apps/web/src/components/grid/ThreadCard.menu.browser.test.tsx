import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { ContextMenuItem } from "@houston-app/contracts";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import type { ThreadActionMenuId } from "../threadActionMenu.logic";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";
import { ProjectFilterContext, type ThreadProjectFilter } from "./ProjectFilterPicker";

const menu = vi.hoisted(() => ({
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
      position?: { x: number; y: number },
    ) => Promise<ThreadActionMenuId | null>
  >(),
  close: vi.fn(),
}));

vi.mock(import("../../localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readLocalApi: (() => {
      const api = actual.readLocalApi();
      return api === undefined
        ? undefined
        : {
            ...api,
            contextMenu: { show: menu.show, close: menu.close },
            dialogs: { ...api.dialogs, confirm: async () => false },
          };
    }) as never,
  };
});

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useAcknowledgeThreadWoke: () => () => {},
  canTurnThreadIntoProject: () => false,
  useThreadActions: () => ({
    archiveThread: async () => ({ _tag: "Success" }),
    markThreadUnread: () => {},
    renameThread: () => {},
    regenerateThreadTitle: () => {},
    copyThreadId: () => {},
    copyThreadPath: () => {},
    copyThreadBranch: () => {},
    copyThreadRef: () => {},
    findThread: () => {},
    openThreadProjectSettings: () => {},
    holdThread: () => {},
    closeThread: () => {},
    deleteThread: () => {},
    unsettleThread: () => {},
    unsnoozeThread: () => {},
    setThreadAutoSettle: () => {},
    turnThreadIntoProject: () => {},
  }),
}));

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Split drawer state from the thread store",
    branch: "houston/split-drawer-state",
    worktreePath: null,
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
    ...overrides,
  } as EnvironmentThreadShell;
}

function card(
  overrides: {
    onOpen?: () => void;
    onOpenGrid?: (gridId: string) => void;
    projectFilter?: ThreadProjectFilter;
  } = {},
) {
  const projectFilter = overrides.projectFilter;
  return (
    <ProjectFilterContext.Provider value={projectFilter === undefined ? null : () => projectFilter}>
      <TooltipProvider delay={60_000}>
        <ThreadCard
          gridId="grid-a"
          thread={thread()}
          query=""
          providerEntries={new Map()}
          nowIso="2026-01-01T00:00:00.000Z"
          focused={false}
          selected={false}
          dragging={false}
          workspaceTitle="Houston"
          timeLabel="9:00"
          onOpen={overrides.onOpen ?? (() => {})}
          onSelect={() => {}}
          onClose={() => {}}
          onHold={() => {}}
          onPickHoldTime={async () => null}
          onRename={() => {}}
          onSetAutoClose={() => {}}
          onDropOnThread={() => {}}
          onOpenGrid={overrides.onOpenGrid ?? (() => {})}
          handleNewThread={async () => null}
        />
      </TooltipProvider>
    </ProjectFilterContext.Provider>
  );
}

function menuItems(): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const call = menu.show.mock.calls.at(-1);
  if (call === undefined) throw new Error("The thread menu never opened.");
  return call[0];
}

function labels(items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>): string[] {
  return items.map((item) => item.label);
}

function resetMenu() {
  menu.show.mockReset().mockImplementation(() => new Promise(() => {}));
  menu.close.mockReset();
}

describe("ThreadCard thread menu", () => {
  it("opens the shared menu at the pointer on right-click", async () => {
    resetMenu();
    await using screen = await render(card());
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 240,
      }),
    );

    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    expect(menu.show.mock.calls[0]?.[1]).toEqual({ x: 120, y: 240 });
    expect(labels(menuItems())).toEqual(
      expect.arrayContaining([
        "New thread on houston/split-drawer-state",
        "Open in grid",
        "Move to grid",
        "Close thread",
        "Hold",
        "Rename thread",
        "Regenerate title",
        "Mark unread",
        "Auto-close behavior",
        "Copy",
        "Project settings",
        "Archive thread",
        "Delete",
      ]),
    );
  });

  it("opens the same menu below the actions button", async () => {
    resetMenu();
    await using screen = await render(card());
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    await userEvent.hover(row);
    const button = screen.getByRole("button", { name: /Thread actions for/ });
    await userEvent.click(button);

    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    const rect = button.element().getBoundingClientRect();
    expect(menu.show.mock.calls[0]?.[1]).toEqual({ x: rect.left, y: rect.bottom + 4 });
    expect(labels(menuItems())).not.toEqual([]);
  });

  it.each([
    { key: "F10", shiftKey: true },
    { key: "ContextMenu", shiftKey: false },
  ])("opens the same menu from the keyboard on $key", async ({ key, shiftKey }) => {
    resetMenu();
    await using screen = await render(card());
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    row.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));

    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    const rect = row.getBoundingClientRect();
    expect(menu.show.mock.calls[0]?.[1]).toEqual({ x: rect.left, y: rect.bottom + 4 });
    expect(labels(menuItems())).toEqual(
      expect.arrayContaining(["Open in grid", "Close thread", "Rename thread"]),
    );
  });

  it("never offers Pin or Unpin", async () => {
    resetMenu();
    await using screen = await render(card());
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 }),
    );

    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    expect(labels(menuItems())).not.toContain("Pin thread");
    expect(labels(menuItems())).not.toContain("Unpin thread");
    expect(menuItems().map((item) => item.id)).not.toContain("pin");
    expect(menuItems().map((item) => item.id)).not.toContain("unpin");
  });

  it("offers Filter by project only when the rail has a filter for the thread's project", async () => {
    resetMenu();
    await using without = await render(card());
    without.container
      .querySelector<HTMLElement>("[data-thread-key]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    expect(labels(menuItems())).not.toContain("Filter by Houston");

    resetMenu();
    await using withFilter = await render(
      card({ projectFilter: { label: "Houston", isActive: false, onToggle: () => {} } }),
    );
    withFilter.container
      .querySelector<HTMLElement>("[data-thread-key]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledOnce());
    expect(labels(menuItems())).toContain("Filter by Houston");
  });

  it("toggles the project filter when Filter by project is chosen, and offers Show all projects while it is on", async () => {
    resetMenu();
    menu.show.mockImplementation(async () => "filter-by-project");
    const onToggle = vi.fn();
    await using screen = await render(
      card({ projectFilter: { label: "Houston", isActive: true, onToggle } }),
    );
    screen.container
      .querySelector<HTMLElement>("[data-thread-key]")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(onToggle).toHaveBeenCalledOnce());
    expect(labels(menuItems())).toContain("Show all projects");
  });
});
