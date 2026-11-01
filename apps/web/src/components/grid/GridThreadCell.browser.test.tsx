import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { GridRecord } from "../../grid/gridStore";
import type { ThreadDragHandleProps, ThreadDropTargetProps } from "../../grid/threadDrag";
import { threadLeaf, type Side, type ThreadNode } from "../../grid/tree";
import { render } from "../../../test/render";
import { GridThreadCell } from "./GridThreadCell";

const state = vi.hoisted(() => ({
  draftSession: null as unknown,
  archivedSnapshots: [] as unknown[],
  archiveThread: vi.fn(),
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: state.archivedSnapshots ?? [],
    error: null,
    isLoading: false,
    refresh: () => {},
  }),
}));

vi.mock("../ChatView", () => ({
  default: () => (
    <div data-testid="chat-view">
      <div data-testid="editor" contentEditable suppressContentEditableWarning />
    </div>
  ),
}));

vi.mock("../sidebar/SidebarThreadRow", () => ({
  SidebarProviderStack: () => null,
}));

vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => ({
    id: "thread-a",
    title: "Alpha thread",
    environmentId: "env-1",
    projectId: "project-1",
    archivedAt: null,
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
    providerInstanceHistory: [],
    runtime: null,
  }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ archiveThread: state.archiveThread }),
}));

vi.mock("../../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
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

vi.mock("../../grid/gridStore", () => ({
  MAX_GRID_THREADS: 6,
  useGridStore: (selector: (store: { setDraftId: () => void }) => unknown) =>
    selector({ setDraftId: () => {} }),
}));

vi.mock("../Sidebar.logic", () => ({
  resolveThreadStatusPill: () => null,
  resolveSidebarStatusGlyphState: () => "idle",
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
    dragging?: boolean;
    dropIndicator?: Side | null;
    dragHandleProps?: ThreadDragHandleProps;
    dropTargetProps?: ThreadDropTargetProps;
    swapTargets?: ReadonlyArray<{ threadId: string; title: string }>;
    onSwapWith?: (threadId: string) => void;
  },
) {
  return render(
    <GridThreadCell
      node={node}
      grid={grid(tree)}
      focused
      maximized={options?.maximized ?? false}
      availableThreads={options?.availableThreads ?? []}
      providerEntries={new Map()}
      onFocus={() => {}}
      onClose={options?.onClose ?? (() => {})}
      onArchiveClose={options?.onArchiveClose}
      onMaximize={options?.onMaximize}
      dragging={options?.dragging ?? false}
      dropIndicator={options?.dropIndicator ?? null}
      {...(options?.dragHandleProps === undefined
        ? {}
        : { dragHandleProps: options.dragHandleProps })}
      {...(options?.dropTargetProps === undefined
        ? {}
        : { dropTargetProps: options.dropTargetProps })}
      swapTargets={options?.swapTargets ?? []}
      {...(options?.onSwapWith === undefined ? {} : { onSwapWith: options.onSwapWith })}
      onSplit={() => {}}
      onOpenThread={() => {}}
    />,
    { router: false },
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

function surfaceColors(container: HTMLElement): { strip: string; body: string } {
  const cell = container.querySelector("[data-grid-cell]");
  const strip = container.querySelector("[data-pane-label]");
  if (cell === null || strip === null) throw new Error("grid cell or pane label missing");
  return {
    strip: getComputedStyle(strip).backgroundColor,
    body: getComputedStyle(cell).backgroundColor,
  };
}

function expectMatchingSurface(container: HTMLElement) {
  const root = document.documentElement;
  root.classList.remove("dark");
  try {
    expect(surfaceColors(container).strip).toBe(surfaceColors(container).body);
    root.classList.add("dark");
    expect(surfaceColors(container).strip).toBe(surfaceColors(container).body);
  } finally {
    root.classList.remove("dark");
  }
}

describe("GridThreadCell surfaces", () => {
  it("draws a new thread's pane label on the cell surface", async () => {
    state.draftSession = { id: "draft-1" };
    await using screen = await renderCell({
      kind: "thread",
      threadId: "thread-a",
      id: "p1",
      draftId: "draft-1",
    });

    expect(screen.container.textContent).toContain("New thread");
    expectMatchingSurface(screen.container);
  });

  it("draws an existing thread's pane label on the same cell surface", async () => {
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
    expectMatchingSurface(screen.container);
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
    await userEvent.click(screen.getByRole("button", { name: "Archive thread" }));
    expect(state.archiveThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-a" }),
      expect.objectContaining({ onArchived: onClose }),
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
    await userEvent.click(screen.getByRole("button", { name: "Split cell right" }));
    const items = [...document.querySelectorAll('[data-slot="menu-item"]')].map(
      (item) => item.textContent ?? "",
    );
    expect(items).not.toContain("Seventh thread");
    expect(items).toContain("This grid holds six threads");
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

  it("drops the label when the cell is shown alone", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      { maximized: true, onMaximize: () => {} },
    );

    expect(screen.container.querySelector("[data-pane-label]")).toBeNull();
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
    await userEvent.click(screen.getByRole("button", { name: "Archive thread" }));
    expect(onArchiveClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("GridThreadCell move", () => {
  it("drags by the pane label and marks the drop side", async () => {
    state.draftSession = null;
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        dragging: true,
        dropIndicator: "right",
        dragHandleProps: { draggable: true, onDragStart: () => {}, onDragEnd: () => {} },
        dropTargetProps: { onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} },
      },
    );

    const cell = screen.container.querySelector("[data-grid-cell]");
    const label = screen.container.querySelector("[data-pane-label]");
    if (cell === null || label === null) throw new Error("grid cell or pane label missing");
    expect(cell.getAttribute("data-dragging")).toBe("true");
    expect(label.getAttribute("draggable")).toBe("true");
    expect(screen.container.querySelector('[data-drop-indicator="right"]')).not.toBeNull();
  });

  it("offers a keyboard swap with every other cell", async () => {
    state.draftSession = null;
    const onSwapWith = vi.fn();
    await using screen = await renderCell(
      { kind: "thread", threadId: "thread-a", id: "p1" },
      twoThreadTree(),
      {
        dragHandleProps: { draggable: true, onDragStart: () => {}, onDragEnd: () => {} },
        dropTargetProps: { onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {} },
        swapTargets: [{ threadId: "thread-b", title: "Beta thread" }],
        onSwapWith,
      },
    );

    await userEvent.hover(screen.container.querySelector("[data-grid-cell]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: "Move cell" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Swap with Beta thread" }));

    expect(onSwapWith).toHaveBeenCalledWith("thread-b");
  });
});
