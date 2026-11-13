import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { beginThreadDragAt, endThreadDrag, type TabDragSource } from "../../threads/threadDrag";
import { WORKSPACE_SPRING_LOAD_MS } from "../../threads/workspaceDrop";
import { buildLayout } from "../../layout/layoutFixtures";
import { cancelLayoutDrag } from "../../layout/layoutDrag";
import { useLayoutStore } from "../../layout/layoutStore";
import { beginLayoutTabDrag } from "../../layout/layoutTabDrag";
import { act, fakeTimers, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarNewWorkspaceDropZone } from "./SidebarNewWorkspaceDropZone";
import { SidebarWorkspaceGroup } from "./ThreadSidebar";
import type { SidebarWorkspaceSection } from "./sidebarWorkspaceSections";
import { useDragAutoScroll } from "./useDragAutoScroll";

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
  useServerConfigs: () => new Map(),
}));

function thread(id: string): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: `Thread ${id}`,
    branch: null,
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

type Drop = (source: unknown, workspaceId: string) => void;

function section(workspaceId: string, name: string): SidebarWorkspaceSection {
  return {
    workspaceId,
    name,
    pinned: false,
    hidden: false,
    empty: false,
    threads: [],
    needsYouThreads: [],
  };
}

function Group({
  workspaceId,
  threads = [],
  collapsed = false,
  open = false,
  onDrop,
}: {
  workspaceId: string;
  threads?: ReadonlyArray<EnvironmentThreadShell>;
  collapsed?: boolean;
  open?: boolean;
  onDrop: Drop;
}) {
  return (
    <SidebarWorkspaceGroup
      section={{ ...section(workspaceId, workspaceId), threads, empty: threads.length === 0 }}
      query=""
      open={open}
      collapsed={collapsed}
      onToggleCollapsed={() => {}}
      previousWorkspaceId={null}
      nextWorkspaceId={null}
      hiddenWorkspaces={[]}
      focusedThreadKey={null}
      providerEntriesByEnvironment={new Map()}
      projectTitleOf={() => "Houston"}
      nowIso="2026-01-01T00:00:00.000Z"
      selection={clearThreadSelection()}
      runningSubagents={new Map()}
      dragging={null}
      reorder={{ drag: null, begin: () => {} }}
      onOpenThread={() => {}}
      onSelectThread={() => {}}
      onCloseThread={() => {}}
      onHoldThread={() => {}}
      onPickHoldTime={async () => null}
      onDropOnWorkspace={onDrop}
      onCreateWorkspace={() => {}}
      onRenameThread={() => {}}
      onSetAutoClose={() => {}}
      workspaceMoveFor={() => undefined}
      handleNewThread={async () => null}
    />
  );
}

function Rail({
  onDrop,
  onDropNew,
  groups,
}: {
  onDrop: Drop;
  onDropNew: (source: unknown) => void;
  groups: ReadonlyArray<{
    id: string;
    threads?: EnvironmentThreadShell[];
    collapsed?: boolean;
    open?: boolean;
  }>;
}) {
  return (
    <TooltipProvider delay={0}>
      <div style={{ width: 260 }}>
        {groups.map((group) => (
          <Group key={group.id} workspaceId={group.id} onDrop={onDrop} {...group} />
        ))}
        <SidebarNewWorkspaceDropZone onDrop={onDropNew} />
      </div>
    </TooltipProvider>
  );
}

const sectionOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-workspace-key="${id}"]`)!;
const headingOf = (container: HTMLElement, id: string) =>
  sectionOf(container, id).querySelector<HTMLElement>("[data-workspace-heading]")!;
const newZone = () => document.querySelector<HTMLElement>("[data-new-workspace-drop]");
const centre = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

function firePointer(type: string, point: { x: number; y: number }, pointerId = 1) {
  window.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      button: 0,
      clientX: point.x,
      clientY: point.y,
    }),
  );
}
const press = (key: string) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

const cardSource = (workspaceId: string | null) => ({
  workspaceId,
  threadId: "t1",
  environmentId: "env-1",
  projectId: "p1",
  title: "Fix the build",
});

/** Ends a drag a test leaves running and puts the layout back. */
const cleanUp = () => ({
  [Symbol.dispose]: () => {
    endThreadDrag();
    cancelLayoutDrag();
    useLayoutStore.getState().reset();
  },
});

/** Starts a tab drag for tab `a` of a two-workspace layout and moves the pointer to `point`. */
async function dragTabTo(point: { x: number; y: number }) {
  const from = { x: 5, y: 5 };
  beginLayoutTabDrag(
    { button: 0, pointerType: "mouse", pointerId: 3, clientX: from.x, clientY: from.y } as never,
    "a",
  );
  await act(() => firePointer("pointermove", point, 3));
}

function seedLayout() {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a", "b"]]], [[["c"]]]]));
}

describe("dropping a sidebar card on a workspace", () => {
  it("case 1 and 15: takes the drop anywhere in the section, collapsed or not", async () => {
    using _cleanup = cleanUp();
    const onDrop = vi.fn();
    await using screen = await render(
      <Rail
        onDrop={onDrop}
        onDropNew={() => {}}
        groups={[
          { id: "ws-a", threads: [thread("x")] },
          { id: "ws-b", collapsed: true },
        ]}
      />,
    );
    const body = sectionOf(screen.container, "ws-a").querySelector("[data-workspace-guide]")!;
    await act(() => beginThreadDragAt(cardSource("ws-c"), centre(body), 1));
    expect(sectionOf(screen.container, "ws-a").hasAttribute("data-drop-over")).toBe(true);
    await act(() => firePointer("pointerup", centre(body)));
    expect(onDrop).toHaveBeenCalledWith(cardSource("ws-c"), "ws-a");

    onDrop.mockClear();
    await act(() =>
      beginThreadDragAt(cardSource("ws-c"), centre(headingOf(screen.container, "ws-b")), 1),
    );
    await act(() => firePointer("pointerup", centre(headingOf(screen.container, "ws-b"))));
    expect(onDrop).toHaveBeenCalledWith(cardSource("ws-c"), "ws-b");
  });

  it("case 2: its own workspace shows no highlight and takes no drop", async () => {
    using _cleanup = cleanUp();
    const onDrop = vi.fn();
    await using screen = await render(
      <Rail onDrop={onDrop} onDropNew={() => {}} groups={[{ id: "ws-a" }]} />,
      { router: false },
    );
    const heading = headingOf(screen.container, "ws-a");
    await act(() => beginThreadDragAt(cardSource("ws-a"), centre(heading), 1));
    expect(sectionOf(screen.container, "ws-a").hasAttribute("data-drop-over")).toBe(false);
    await act(() => firePointer("pointerup", centre(heading)));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("case 17: Escape, or a release outside every target, changes nothing", async () => {
    using _cleanup = cleanUp();
    const onDrop = vi.fn();
    const onDropNew = vi.fn();
    await using screen = await render(
      <Rail onDrop={onDrop} onDropNew={onDropNew} groups={[{ id: "ws-a" }]} />,
      { router: false },
    );
    const heading = headingOf(screen.container, "ws-a");
    await act(() => beginThreadDragAt(cardSource("ws-c"), centre(heading), 1));
    await act(() => press("Escape"));
    await act(() => firePointer("pointerup", centre(heading)));
    expect(onDrop).not.toHaveBeenCalled();
    expect(newZone()).toBeNull();

    await act(() => beginThreadDragAt(cardSource("ws-c"), { x: 900, y: 900 }, 1));
    await act(() => firePointer("pointerup", { x: 900, y: 900 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onDropNew).not.toHaveBeenCalled();
  });
});

describe("the new workspace zone", () => {
  it("case 5: appears only during a drag and takes a card dropped on it", async () => {
    using _cleanup = cleanUp();
    const onDropNew = vi.fn();
    await using _screen = await render(
      <Rail onDrop={() => {}} onDropNew={onDropNew} groups={[{ id: "ws-a" }]} />,
      { router: false },
    );
    expect(newZone()).toBeNull();
    await act(() => beginThreadDragAt(cardSource("ws-a"), { x: 900, y: 900 }, 1));
    const zone = newZone()!;
    expect(zone).not.toBeNull();
    await act(() => firePointer("pointermove", centre(zone)));
    expect(zone.hasAttribute("data-drop-over")).toBe(true);
    await act(() => firePointer("pointerup", centre(zone)));
    expect(onDropNew).toHaveBeenCalledWith(cardSource("ws-a"));
    expect(newZone()).toBeNull();
  });
});

describe("dragging a layout tab to the sidebar", () => {
  const tabSource = (workspaceId: string): TabDragSource => ({
    tabId: "a",
    workspaceId,
    thread: { environmentId: "local", threadId: "a" },
    title: null,
  });

  it("case 6: dropping on another workspace hands the tab to the sidebar", async () => {
    using _cleanup = cleanUp();
    seedLayout();
    const onDrop = vi.fn();
    await using screen = await render(
      <Rail onDrop={onDrop} onDropNew={() => {}} groups={[{ id: "w0" }, { id: "w1" }]} />,
      { router: false },
    );
    const heading = headingOf(screen.container, "w1");
    await dragTabTo(centre(heading));
    expect(sectionOf(screen.container, "w1").hasAttribute("data-drop-over")).toBe(true);
    await act(() => firePointer("pointerup", centre(heading), 3));
    expect(onDrop).toHaveBeenCalledWith(tabSource("w0"), "w1");
  });

  it("case 7: its own workspace shows no highlight and takes no drop", async () => {
    using _cleanup = cleanUp();
    seedLayout();
    const onDrop = vi.fn();
    await using screen = await render(
      <Rail onDrop={onDrop} onDropNew={() => {}} groups={[{ id: "w0" }, { id: "w1" }]} />,
      { router: false },
    );
    const heading = headingOf(screen.container, "w0");
    await dragTabTo(centre(heading));
    expect(sectionOf(screen.container, "w0").hasAttribute("data-drop-over")).toBe(false);
    await act(() => firePointer("pointerup", centre(heading), 3));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("case 9 and 11: the new workspace zone takes a tab, even the last one of its workspace", async () => {
    using _cleanup = cleanUp();
    useLayoutStore.getState().reset();
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    const onDropNew = vi.fn();
    await using _screen = await render(
      <Rail onDrop={() => {}} onDropNew={onDropNew} groups={[{ id: "w0" }]} />,
      { router: false },
    );
    await dragTabTo({ x: 900, y: 900 });
    const zone = newZone()!;
    await act(() => firePointer("pointermove", centre(zone), 3));
    await act(() => firePointer("pointerup", centre(zone), 3));
    expect(onDropNew).toHaveBeenCalledWith(tabSource("w0"));
  });

  it("case 17: Escape cancels a tab drag over a workspace", async () => {
    using _cleanup = cleanUp();
    seedLayout();
    const onDrop = vi.fn();
    await using screen = await render(
      <Rail onDrop={onDrop} onDropNew={() => {}} groups={[{ id: "w0" }, { id: "w1" }]} />,
      { router: false },
    );
    const heading = headingOf(screen.container, "w1");
    await dragTabTo(centre(heading));
    await act(() => press("Escape"));
    await act(() => firePointer("pointerup", centre(heading), 3));
    expect(onDrop).not.toHaveBeenCalled();
    expect(newZone()).toBeNull();
  });
});

describe("spring-loaded workspace headings", () => {
  const focused = () => useLayoutStore.getState().layout.focusedWorkspaceId;

  it("case 8: resting a dragged card on a heading shows that workspace after the delay", async () => {
    using _cleanup = cleanUp();
    seedLayout();
    await using screen = await render(
      <Rail
        onDrop={() => {}}
        onDropNew={() => {}}
        groups={[{ id: "w0", open: true }, { id: "w1" }]}
      />,
      { router: false },
    );
    using _timers = fakeTimers();
    const heading = headingOf(screen.container, "w1");
    await act(() => beginThreadDragAt(cardSource("w0"), centre(heading), 1));
    await act(() => vi.advanceTimersByTime(WORKSPACE_SPRING_LOAD_MS - 1));
    expect(focused()).toBe("w0");
    await act(() => vi.advanceTimersByTime(1));
    expect(focused()).toBe("w1");
  });

  it("case 8: a dragged tab switches the workspace only if it rests on the heading for the whole delay", async () => {
    using _cleanup = cleanUp();
    seedLayout();
    await using screen = await render(
      <Rail
        onDrop={() => {}}
        onDropNew={() => {}}
        groups={[{ id: "w0", open: true }, { id: "w1" }]}
      />,
      { router: false },
    );
    using _timers = fakeTimers();
    const heading = headingOf(screen.container, "w1");
    await dragTabTo(centre(heading));
    await act(() => vi.advanceTimersByTime(WORKSPACE_SPRING_LOAD_MS - 1));
    await act(() => firePointer("pointermove", { x: 900, y: 900 }, 3));
    await act(() => vi.advanceTimersByTime(WORKSPACE_SPRING_LOAD_MS * 2));
    expect(focused()).toBe("w0");
    await act(() => firePointer("pointermove", centre(heading), 3));
    await act(() => vi.advanceTimersByTime(WORKSPACE_SPRING_LOAD_MS));
    expect(focused()).toBe("w1");
  });
});

describe("sidebar auto-scroll", () => {
  function ScrollHost() {
    const ref = useRef<HTMLDivElement | null>(null);
    useDragAutoScroll(ref);
    return (
      <div data-scroller="" style={{ height: 200, width: 200, overflowY: "auto" }}>
        <div ref={ref} style={{ height: 1000 }} />
      </div>
    );
  }

  it("case 16: scrolls the list while the pointer rests near its bottom edge, and stops away from it", async () => {
    using _cleanup = cleanUp();
    await using screen = await render(<ScrollHost />, { router: false });
    using _timers = fakeTimers();
    const scroller = screen.container.querySelector<HTMLElement>("[data-scroller]")!;
    const rect = scroller.getBoundingClientRect();
    await act(() =>
      beginThreadDragAt(cardSource("ws-a"), { x: rect.left + 50, y: rect.bottom - 4 }, 1),
    );
    await act(() => vi.advanceTimersByTime(100));
    expect(scroller.scrollTop).toBeGreaterThan(0);
    await act(() => firePointer("pointermove", { x: rect.left + 50, y: rect.top + 100 }));
    const resting = scroller.scrollTop;
    await act(() => vi.advanceTimersByTime(100));
    expect(scroller.scrollTop).toBe(resting);
  });
});
