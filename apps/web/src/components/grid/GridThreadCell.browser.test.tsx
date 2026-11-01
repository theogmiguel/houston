import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import type { GridRecord } from "../../grid/gridStore";
import { threadLeaf, type ThreadNode } from "../../grid/tree";
import { render } from "../../../test/render";
import { GridThreadCell } from "./GridThreadCell";

const state = vi.hoisted(() => ({
  draftSession: null as unknown,
}));

vi.mock("../ChatView", () => ({
  default: () => <div data-testid="chat-view" />,
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
  useThreadActions: () => ({ archiveThread: vi.fn() }),
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

async function renderCell(node: ThreadNode, tree?: GridRecord["tree"]) {
  return render(
    <GridThreadCell
      node={node}
      grid={grid(tree)}
      focused
      availableThreads={[]}
      providerEntries={new Map()}
      onFocus={() => {}}
      onClose={() => {}}
      onSplit={() => {}}
      onOpenThread={() => {}}
    />,
    { router: false },
  );
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
});
