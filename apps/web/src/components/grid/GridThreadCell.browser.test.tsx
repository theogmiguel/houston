import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { GridRecord } from "../../grid/gridStore";
import { threadLeaf, type ThreadNode } from "../../grid/tree";
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
    onClose?: () => void;
  },
) {
  return render(
    <GridThreadCell
      node={node}
      grid={grid(tree)}
      focused
      availableThreads={options?.availableThreads ?? []}
      providerEntries={new Map()}
      onFocus={() => {}}
      onClose={options?.onClose ?? (() => {})}
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
