import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { useGridStore, type GridRecord } from "../../grid/gridStore";
import { threadLeaf, type Side, type SplitSide, type ThreadNode } from "../../grid/tree";
import { render } from "../../../test/render";
import { GridThreadCell } from "./GridThreadCell";

const state = vi.hoisted(() => ({
  draftSession: null as unknown,
  pill: null as unknown,
  archivedSnapshots: [] as unknown[],
  archiveThread: vi.fn(),
  pendingQuestion: false,
  banner: false,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: state.archivedSnapshots ?? [],
    error: null,
    isLoading: false,
    refresh: () => {},
  }),
}));

// The composer's DOM contract, composed rather than the real ChatComposer: the grid only
// targets its data attributes, and the real question panel renders inside the drawer.
vi.mock("../ChatView", async () => {
  const [{ ComposerPendingUserInputPanel }, { ComposerBanner }, contracts] = await Promise.all([
    import("../chat/ComposerPendingUserInputPanel"),
    import("../chat/ComposerBanner"),
    import("@houston-app/contracts"),
  ]);
  const environmentId = contracts.EnvironmentId.make("env-1");
  const threadId = contracts.ThreadId.make("thread-a");
  const prompt = {
    requestId: contracts.RuntimeRequestId.make("question-layout"),
    createdAt: "2026-01-01T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "question-layout",
        header: "Fixture",
        question: "Should this fixture prefer strict schemas or UI flexibility?",
        options: [
          { label: "Strict schemas (Recommended)", description: "Prefer strict schemas" },
          { label: "UI flexibility", description: "Prefer UI flexibility" },
        ],
        multiSelect: false,
      },
    ],
  };
  const noop = () => {};
  return {
    default: (props: { shortcutsAtWindow?: boolean; visitActive?: boolean }) => (
      <div
        data-testid="chat-view"
        data-chat-composer-surface="true"
        data-shortcuts-at-window={props.shortcutsAtWindow === true ? "true" : undefined}
        data-visit-active={props.visitActive === true ? "true" : undefined}
      >
        {state.banner ? (
          <div data-composer-banner-shelf="true">
            <ComposerBanner.Root inCard="notice" data-testid="notice">
              Usage limits
            </ComposerBanner.Root>
          </div>
        ) : null}
        {state.pendingQuestion ? (
          <ComposerBanner.Root data-chat-composer-top-drawer="true" inCard="drawer">
            <ComposerPendingUserInputPanel
              pendingUserInputs={[prompt]}
              cwd={undefined}
              threadRef={{ environmentId, threadId }}
              respondingRequestIds={[]}
              answers={{}}
              questionIndex={0}
              onToggleOption={noop}
              onAdvance={noop}
              onDismiss={noop}
            />
          </ComposerBanner.Root>
        ) : null}
        <div data-chat-composer-body="true">
          <div data-testid="editor" contentEditable suppressContentEditableWarning />
          <p data-thread-find-text="true">A long answer that must stay readable in every pane.</p>
        </div>
        <div data-chat-composer-footer="true">
          <button type="button">Submit</button>
        </div>
      </div>
    ),
  };
});

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <p>{text}</p>,
}));

vi.mock("../sidebar/SidebarThreadRow", () => ({
  SidebarProviderStack: () => null,
}));

const shell = {
  id: "thread-a",
  title: "Alpha thread",
  environmentId: "env-1",
  projectId: "project-1",
  archivedAt: null,
  settledOverride: null,
  snoozedUntil: null,
  autoSettleDisabledAt: null,
  titleRegeneration: null,
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
  providerInstanceHistory: [],
  runtime: null,
};

vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => shell,
  readThreadShell: () => shell,
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));

vi.mock("../../hooks/useThreadActions", () => ({
  canTurnThreadIntoProject: () => false,
  useThreadActions: () => ({
    archiveThread: state.archiveThread,
    threadSnoozePresets: () => [],
    markThreadUnread: () => {},
    confirmAndDeleteThread: () => {},
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

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      confirmThreadDelete: false,
      confirmThreadArchive: false,
      timestampFormat: "12-hour",
    }),
}));

vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  clearComposerDraftsEnvironment: () => {},
  useComposerDraftStore: (
    selector: (store: {
      getDraftSession: () => unknown;
      getPromotedDraftRedirect: () => unknown;
    }) => unknown,
  ) =>
    selector({
      getDraftSession: () => state.draftSession,
      getPromotedDraftRedirect: () => null,
    }),
}));

vi.mock("../Sidebar.logic", () => ({
  resolveThreadStatusPill: () => state.pill,
}));

function grid(tree: GridRecord["tree"] = { kind: "thread", threadId: "thread-a", id: "p1" }) {
  return {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree,
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  } satisfies GridRecord;
}

async function renderCell(
  node: ThreadNode,
  tree?: GridRecord["tree"],
  options?: {
    availableThreads?: ReadonlyArray<{ threadId: string; title: string }>;
    maximized?: boolean;
    onClose?: () => void;
    onArchiveClose?: () => void;
    onMaximize?: () => void;
    focused?: boolean;
    dragging?: boolean;
    dropIndicator?: Side | null;
    onDragHandlePointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
    swapTargets?: ReadonlyArray<{ threadId: string; title: string }>;
    onSwapWith?: (threadId: string) => void;
    onOpenGrid?: (gridId: string) => void;
    onSplit?: (side: SplitSide, threadId: string) => void;
    onNewThread?: (side: SplitSide) => void;
    container?: HTMLElement;
  },
) {
  return render(
    <GridThreadCell
      node={node}
      grid={grid(tree)}
      focused={options?.focused ?? true}
      maximized={options?.maximized ?? false}
      availableThreads={options?.availableThreads ?? []}
      providerEntries={new Map()}
      onFocus={() => {}}
      onClose={options?.onClose ?? (() => {})}
      onArchiveClose={options?.onArchiveClose}
      onMaximize={options?.onMaximize}
      dragging={options?.dragging ?? false}
      dropIndicator={options?.dropIndicator ?? null}
      {...(options?.onDragHandlePointerDown === undefined
        ? {}
        : { onDragHandlePointerDown: options.onDragHandlePointerDown })}
      swapTargets={options?.swapTargets ?? []}
      {...(options?.onSwapWith === undefined ? {} : { onSwapWith: options.onSwapWith })}
      {...(options?.onOpenGrid === undefined ? {} : { onOpenGrid: options.onOpenGrid })}
      onSplit={options?.onSplit ?? (() => {})}
      onNewThread={options?.onNewThread}
      onOpenThread={() => {}}
    />,
    options?.container === undefined
      ? { router: false }
      : { router: false, container: options.container },
  );
}

function twoThreadTree(): GridRecord["tree"] {
  return {
    kind: "split",
    dir: "row",
    children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
    weights: [50, 50],
  };
}

function paneHeadColor(): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = "var(--pane-head)";
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

function expectPaneHeadSurface(container: HTMLElement) {
  const strip = container.querySelector("[data-pane-label]");
  if (strip === null) throw new Error("pane label missing");
  const root = document.documentElement;
  const style = getComputedStyle(strip);
  expect(style.borderRadius).toBe("7px");
  expect(style.height).toBe("26px");
  root.classList.remove("dark");
  try {
    expect(style.backgroundColor).toBe(paneHeadColor());
    root.classList.add("dark");
    expect(getComputedStyle(strip).backgroundColor).toBe(paneHeadColor());
  } finally {
    root.classList.remove("dark");
  }
}

describe("GridThreadCell surfaces", () => {
  it("draws a new thread's pane label on the pane head surface", async () => {
    state.draftSession = { id: "draft-1" };
    await using screen = await renderCell({
      kind: "thread",
      threadId: "thread-a",
      id: "p1",
      draftId: "draft-1",
    });

    expect(screen.container.textContent).toContain("New thread");
    expectPaneHeadSurface(screen.container);
  });

  it("draws an existing thread's pane label on the pane head surface", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      {
        kind: "split",
        dir: "row",
        children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
        weights: [50, 50],
      },
    );

    expect(screen.container.textContent).toContain("Alpha thread");
    expectPaneHeadSurface(screen.container);
  });
  it("closes a cell whose thread was archived in another surface", async () => {
    state.draftSession = null;
    state.archivedSnapshots = [
      { environmentId: "env-1", snapshot: { threads: [{ id: "thread-a" }] } },
    ];
    const onClose = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onClose },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onClose).toHaveBeenCalled();
    state.archivedSnapshots = [];
  });

  it("focuses the composer when a draft cell opens in the grid", async () => {
    state.draftSession = { id: "draft-1" };
    await using screen = await renderCell({
      kind: "thread",
      threadId: "thread-a",
      id: "p1",
      draftId: "draft-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.activeElement).toBe(screen.container.querySelector("[data-testid=editor]"));
  });

  it("closes a cell once its thread is archived", async () => {
    state.draftSession = null;
    state.archiveThread.mockImplementation(
      (_ref: unknown, options?: { onArchived?: () => void }) => {
        options?.onArchived?.();
        return Promise.resolve({ _tag: "Success" });
      },
    );
    const onClose = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onClose },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Archive thread" }));
    expect(state.archiveThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-a" }),
      expect.objectContaining({ onArchived: expect.any(Function) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("offers only a new thread for a split when the grid already holds six", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p0" },
      {
        kind: "split",
        dir: "row",
        children: [
          threadLeaf("thread-a", "p0"),
          threadLeaf("thread-b", "p1"),
          threadLeaf("thread-c", "p2"),
          threadLeaf("thread-d", "p3"),
          threadLeaf("thread-e", "p4"),
          threadLeaf("thread-f", "p5"),
        ],
        weights: [100 / 6, 100 / 6, 100 / 6, 100 / 6, 100 / 6, 100 / 6],
      },
      { availableThreads: [{ threadId: "thread-g", title: "Seventh thread" }] },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Split right" }));
    await expect
      .element(page.getByRole("menuitem", { name: "This grid holds six threads" }))
      .toBeVisible();
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent ?? "",
    );
    expect(items).not.toContain("Seventh thread");
    expect(items).toContain("This grid holds six threads");
  });

  it("splits right or down from the more actions menu", async () => {
    state.draftSession = null;
    const onSplit = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        availableThreads: [{ threadId: "thread-b", title: "Beta thread" }],
        onSplit,
      },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await expect.element(page.getByRole("menuitem", { name: "Split right" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Split down" })).toBeVisible();
    await userEvent.hover(page.getByRole("menuitem", { name: "Split right" }));
    const pick = page.getByRole("menuitem", { name: "Beta thread" });
    await expect.element(pick).toBeVisible();
    await userEvent.click(pick);
    expect(onSplit).toHaveBeenCalledWith("right", "thread-b");
  });

  it("moves the cell's thread to another grid of its project", async () => {
    state.draftSession = null;
    useGridStore.setState({ grids: [], threadOrigins: {}, closedCells: {} });
    const store = useGridStore.getState();
    store.createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey: "env-1:project-1",
      id: "g-1",
      name: "Review",
      now: "2026-01-01T00:00:00Z",
    });
    store.createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey: "env-1:project-1",
      id: "grid-b",
      name: "Archive",
      now: "2026-01-02T00:00:00Z",
    });
    store.addThread("g-1", "thread-a");
    const onOpenGrid = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onOpenGrid },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Move to grid" }));
    await expect.element(page.getByRole("menuitem", { name: "Archive" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "New grid" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "Archive" }));
    expect(onOpenGrid).toHaveBeenCalledExactlyOnceWith("grid-b");
    const grids = useGridStore.getState().grids;
    expect(grids.find((grid) => grid.id === "g-1")?.tree).toBeNull();
    expect(grids.find((grid) => grid.id === "grid-b")?.tree).toMatchObject({
      kind: "thread",
      threadId: "thread-a",
    });
  });

  it("labels the actions more, maximize, close and shows the shared thread menu", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        availableThreads: [{ threadId: "thread-b", title: "Beta thread" }],
        onMaximize: vi.fn(),
        swapTargets: [{ threadId: "thread-b", title: "Beta thread" }],
        onSwapWith: vi.fn(),
        onOpenGrid: vi.fn(),
      },
    );

    const label = screen.container.querySelector("[data-pane-label]") as HTMLElement;
    const actions = [...label.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(actions).toEqual(["More cell actions", "Maximize cell", "Close thread"]);
    expect(label.querySelector('[aria-label="Split cell"]')).toBeNull();

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await expect.element(page.getByRole("menuitem", { name: "Archive thread" })).toBeVisible();
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    const entries = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map(
      (entry) => (entry.getAttribute("role") === "separator" ? "---" : entry.textContent?.trim()),
    );
    expect(entries).toEqual([
      "Split right",
      "Split down",
      "---",
      "Move to…",
      "Move to grid",
      "Close thread",
      "Hold",
      "---",
      "Rename thread",
      "Regenerate title",
      "Mark unread",
      "Auto-close behavior",
      "---",
      "Copy",
      "Project settings",
      "---",
      "Archive thread",
      "Delete",
    ]);
    expect(menu.textContent).not.toMatch(/Pin thread|Unpin thread/);
  });

  it("grows the label actions to their own width over the whole reveal", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onMaximize: vi.fn() },
    );

    const actions = screen.container
      .querySelector('[aria-label="More cell actions"]')
      ?.closest("div") as HTMLElement;
    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await vi.waitFor(() => expect(actions.getAnimations().length).toBeGreaterThan(0));
    const transitions = actions.getAnimations() as CSSTransition[];
    for (const transition of transitions) transition.pause();
    const reveal = transitions[0]!;
    const duration = Number(reveal.effect?.getTiming().duration);
    for (const transition of transitions) transition.currentTime = duration / 2;
    const midWidth = actions.getBoundingClientRect().width;
    for (const transition of transitions) transition.finish();
    const finalWidth = actions.getBoundingClientRect().width;

    expect(finalWidth).toBeGreaterThan(0);
    // Halfway through, the strip is still opening rather than already at full width.
    expect(midWidth).toBeGreaterThan(0);
    expect(midWidth).toBeLessThan(finalWidth * 0.95);
  });

  it("splits down from the same menu", async () => {
    state.draftSession = null;
    const onSplit = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        availableThreads: [{ threadId: "thread-b", title: "Beta thread" }],
        onSplit,
      },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Split down" }));
    const pick = page.getByRole("menuitem", { name: "Beta thread" });
    await expect.element(pick).toBeVisible();
    await userEvent.click(pick);
    expect(onSplit).toHaveBeenCalledWith("bottom", "thread-b");
  });
});

describe("GridThreadCell maximize", () => {
  it("maximizes from the pane label", async () => {
    state.draftSession = null;
    const onMaximize = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onMaximize },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Maximize cell" }));
    expect(onMaximize).toHaveBeenCalledTimes(1);
  });

  it("drops the label when the cell is shown alone and offers the way back", async () => {
    state.draftSession = null;
    const onMaximize = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { maximized: true, onMaximize },
    );

    expect(screen.container.querySelector("[data-pane-label]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore cell" }));
    expect(onMaximize).toHaveBeenCalledTimes(1);
  });
});

describe("GridThreadCell archive", () => {
  it("closes an archived cell without offering it for reopen", async () => {
    state.draftSession = null;
    state.archiveThread.mockImplementation(
      (_ref: unknown, options?: { onArchived?: () => void }) => {
        options?.onArchived?.();
        return Promise.resolve({ _tag: "Success" });
      },
    );
    const onClose = vi.fn();
    const onArchiveClose = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { onClose, onArchiveClose },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Archive thread" }));
    expect(onArchiveClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("GridThreadCell move", () => {
  it("drags by the pane label and marks the drop side", async () => {
    state.draftSession = null;
    const onDragHandlePointerDown = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        dragging: true,
        dropIndicator: "right",
        onDragHandlePointerDown,
      },
    );

    const cell = screen.container.querySelector("[data-grid-cell]");
    const label = screen.container.querySelector("[data-pane-label]");
    if (cell === null || label === null) throw new Error("grid cell or pane label missing");
    expect(cell.getAttribute("data-dragging")).toBe("true");
    expect(screen.container.querySelector('[data-drop-indicator="right"]')).not.toBeNull();
    label.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
    );
    expect(onDragHandlePointerDown).toHaveBeenCalledTimes(1);
  });

  it("offers a keyboard swap with every other cell", async () => {
    state.draftSession = null;
    const onSwapWith = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        swapTargets: [{ threadId: "thread-b", title: "Beta thread" }],
        onSwapWith,
      },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "More cell actions" }));
    await userEvent.hover(page.getByRole("menuitem", { name: "Move to…" }));
    const swap = page.getByRole("menuitem", { name: "Swap with Beta thread" });
    await expect.element(swap).toBeVisible();
    await userEvent.click(swap);

    expect(onSwapWith).toHaveBeenCalledWith("thread-b");
  });
});

describe("GridThreadCell status mark", () => {
  it("draws the shared needs glyph in the pane label, not a plain dot", async () => {
    state.draftSession = null;
    state.pill = { label: "Needs you", state: "needs" };
    try {
      await using screen = await renderCell(
        { kind: "thread", threadId: "thread-a", id: "p1" },
        twoThreadTree(),
      );

      const label = screen.container.querySelector("[data-pane-label]");
      const mark = label?.querySelector('[role="img"][aria-label="Needs you"]');
      const outline = mark?.querySelector("path");
      expect(mark).not.toBeNull();
      expect(outline).not.toBeNull();
      expect(getComputedStyle(outline!).fill).toBe("none");
      expect(getComputedStyle(outline!).stroke).not.toBe("none");
      expect(label?.querySelector(".rounded-full")).toBeNull();
    } finally {
      state.pill = null;
    }
  });

  it("draws the shared running glyph in the pane label", async () => {
    state.draftSession = null;
    state.pill = { label: "Running", state: "running" };
    try {
      await using screen = await renderCell(
        { kind: "thread", threadId: "thread-a", id: "p1" },
        twoThreadTree(),
      );

      const label = screen.container.querySelector("[data-pane-label]");
      expect(label?.querySelector('[role="img"][aria-label="Running"]')).not.toBeNull();
      expect(label?.querySelectorAll("[data-streaming-dot]")).toHaveLength(8);
    } finally {
      state.pill = null;
    }
  });
});

describe("GridThreadCell keyboard", () => {
  it("closes the overflow menu on Escape and returns focus to its trigger", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { swapTargets: [{ threadId: "thread-b", title: "Beta thread" }], onSwapWith: () => {} },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    const trigger = screen.container.querySelector<HTMLElement>(
      'button[aria-label="More cell actions"]',
    );
    if (trigger === null) throw new Error("more actions trigger missing");
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menuitem", { name: "Archive thread" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitem", { name: "Archive thread" }))
      .not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("GridThreadCell pending question", () => {
  beforeEach(() => {
    state.pendingQuestion = false;
    state.banner = false;
  });

  it("stacks a composer notice above a full-width answer field at compact width", async () => {
    state.draftSession = null;
    state.banner = true;
    const container = document.createElement("div");
    container.style.width = "520px";
    container.style.height = "600px";
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      undefined,
      { container },
    );

    const cell = screen.container.querySelector<HTMLElement>("[data-grid-cell]");
    if (cell === null) throw new Error("grid cell missing");
    await vi.waitFor(() => expect(cell.dataset.density).toBe("compact"));
    const surface = screen.container.querySelector<HTMLElement>(
      '[data-chat-composer-surface="true"]',
    );
    const notice = screen.container.querySelector<HTMLElement>('[data-testid="notice"]');
    const body = screen.container.querySelector<HTMLElement>("[data-chat-composer-body]");
    if (surface === null || notice === null || body === null) {
      throw new Error("composer fixture incomplete");
    }

    const surfaceWidth = surface.getBoundingClientRect().width;
    expect(getComputedStyle(surface).display).toBe("block");
    expect(notice.getBoundingClientRect().width).toBeGreaterThanOrEqual(surfaceWidth - 1);
    expect(Math.abs(body.getBoundingClientRect().width - surfaceWidth)).toBeLessThanOrEqual(1);
  });

  it("stacks the question above a full-width answer field at compact width", async () => {
    state.draftSession = null;
    state.pendingQuestion = true;
    const container = document.createElement("div");
    container.style.width = "520px";
    container.style.height = "600px";
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      undefined,
      { container },
    );

    const cell = screen.container.querySelector<HTMLElement>("[data-grid-cell]");
    if (cell === null) throw new Error("grid cell missing");
    await vi.waitFor(() => expect(cell.dataset.density).toBe("compact"));

    const surface = screen.container.querySelector<HTMLElement>(
      '[data-chat-composer-surface="true"]',
    );
    const drawer = screen.container.querySelector<HTMLElement>("[data-chat-composer-top-drawer]");
    const body = screen.container.querySelector<HTMLElement>("[data-chat-composer-body]");
    const editor = screen.container.querySelector<HTMLElement>('[data-testid="editor"]');
    const footer = screen.container.querySelector<HTMLElement>("[data-chat-composer-footer]");
    if (
      surface === null ||
      drawer === null ||
      body === null ||
      editor === null ||
      footer === null
    ) {
      throw new Error("composer fixture incomplete");
    }

    const width = (element: HTMLElement) => element.getBoundingClientRect().width;
    const surfaceWidth = width(surface);
    expect(getComputedStyle(surface).display).toBe("block");
    expect(drawer.textContent).toContain("Should this fixture prefer strict schemas");
    // The drawer and the answer field share the card's full content width; the footer follows.
    expect(width(drawer)).toBeGreaterThanOrEqual(surfaceWidth - 1);
    expect(Math.abs(width(body) - surfaceWidth)).toBeLessThanOrEqual(1);
    expect(width(editor)).toBeGreaterThanOrEqual(surfaceWidth * 0.9);
    expect(Math.abs(width(footer) - surfaceWidth)).toBeLessThanOrEqual(1);

    const options = [...drawer.querySelectorAll<HTMLElement>("button[aria-pressed]")];
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.getBoundingClientRect().width).toBeGreaterThan(150);
      expect(option.getBoundingClientRect().height).toBeGreaterThan(0);
    }
  });
});

describe("GridThreadCell timeline", () => {
  it.each([
    { width: 360, height: 600, density: "glance" },
    { width: 520, height: 600, density: "compact" },
  ])("keeps the whole answer readable in a $density pane", async ({ width, height, density }) => {
    state.draftSession = null;
    const container = document.createElement("div");
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      undefined,
      { container },
    );

    const cell = screen.container.querySelector<HTMLElement>("[data-grid-cell]");
    if (cell === null) throw new Error("grid cell missing");
    await vi.waitFor(() => expect(cell.dataset.density).toBe(density));

    const text = screen.container.querySelector<HTMLElement>("[data-thread-find-text]");
    if (text === null) throw new Error("answer text missing");
    expect(getComputedStyle(text).webkitLineClamp).toBe("none");
  });
});

describe("GridThreadCell shortcut scope", () => {
  it("gives only the focused cell the window shortcuts and the read gate", async () => {
    state.draftSession = null;
    await using focused = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
    );
    const focusedView = focused.container.querySelector('[data-testid="chat-view"]');
    expect(focusedView?.getAttribute("data-shortcuts-at-window")).toBe("true");
    expect(focusedView?.getAttribute("data-visit-active")).toBe("true");

    await using unfocused = await renderCell(
      { kind: "thread", threadId: "thread-b", id: "p2" },
      twoThreadTree(),
      { focused: false },
    );
    const unfocusedView = unfocused.container.querySelector('[data-testid="chat-view"]');
    expect(unfocusedView?.getAttribute("data-shortcuts-at-window")).toBeNull();
    expect(unfocusedView?.getAttribute("data-visit-active")).toBeNull();
  });
});
