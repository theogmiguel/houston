import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { GridRecord } from "../../grid/gridStore";
import { type ThreadNode, threadLeaf } from "../../grid/tree";
import { GridThreadCell } from "./GridThreadCell";

const state = vi.hoisted(() => ({
  draftSession: null as unknown,
  promoted: null as unknown,
  setDraftId: vi.fn(),
}));

vi.mock("../ChatView", () => ({
  default: (props: {
    threadId: string;
    environmentId: string;
    routeKind: string;
    draftId?: string;
    embedded?: boolean;
  }) => (
    <div
      data-testid="chat-view"
      data-thread-id={props.threadId}
      data-environment-id={props.environmentId}
      data-route-kind={props.routeKind}
      data-draft-id={props.draftId}
      data-embedded={props.embedded === true ? "true" : "false"}
    />
  ),
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
  useComposerDraftStore: (
    selector: (store: {
      getDraftSession: () => unknown;
      getPromotedDraftRedirect: () => unknown;
    }) => unknown,
  ) =>
    selector({
      getDraftSession: () => state.draftSession,
      getPromotedDraftRedirect: () => state.promoted,
    }),
}));

vi.mock("../../grid/gridStore", () => ({
  useGridStore: (selector: (store: { setDraftId: typeof state.setDraftId }) => unknown) =>
    selector({ setDraftId: state.setDraftId }),
}));

vi.mock("../Sidebar.logic", () => ({
  resolveThreadStatusPill: () => null,
  resolveSidebarStatusGlyphState: () => "idle",
}));

function grid(): GridRecord {
  return {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: { kind: "thread", threadId: "thread-a", id: "p1" },
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function render(node: ThreadNode) {
  return renderToStaticMarkup(
    <GridThreadCell
      node={node}
      grid={grid()}
      focused
      availableThreads={[]}
      providerEntries={new Map()}
      onFocus={() => {}}
      onClose={() => {}}
      onSplit={() => {}}
      onOpenThread={() => {}}
    />,
  );
}

describe("GridThreadCell", () => {
  it("renders the thread view for its own thread inside an embedded cell", () => {
    state.draftSession = null;
    const html = render({ kind: "thread", threadId: "thread-a", id: "p1" });
    expect(html).not.toContain("data-pane-label");
    expect(html).not.toContain("<header");
    expect(html).toContain('data-testid="chat-view"');
    expect(html).toContain('data-thread-id="thread-a"');
    expect(html).toContain('data-environment-id="env-1"');
    expect(html).toContain('data-route-kind="server"');
    expect(html).toContain('data-embedded="true"');
    expect(html).toContain('data-focused="true"');
  });

  it("draws the floating label only when the grid holds more than one thread", () => {
    state.draftSession = null;
    const html = renderToStaticMarkup(
      <GridThreadCell
        node={{ kind: "thread", threadId: "thread-a", id: "p1" }}
        grid={{
          ...grid(),
          tree: {
            kind: "split",
            dir: "row",
            children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
            weights: [50, 50],
          },
        }}
        focused
        availableThreads={[]}
        providerEntries={new Map()}
        onFocus={() => {}}
        onClose={() => {}}
        onSplit={() => {}}
        onOpenThread={() => {}}
      />,
    );
    expect(html).toContain("data-pane-label");
    expect(html).toContain("Alpha thread");
    expect(html).toContain("Archive thread");
    expect(html).toContain("Close cell");
  });

  it("renders a client-side draft in the cell that still carries it", () => {
    state.draftSession = { id: "draft-1" };
    const html = render({
      kind: "thread",
      threadId: "thread-a",
      id: "p1",
      draftId: "draft-1",
    });
    expect(html).toContain('data-route-kind="draft"');
    expect(html).toContain('data-draft-id="draft-1"');
  });
});
