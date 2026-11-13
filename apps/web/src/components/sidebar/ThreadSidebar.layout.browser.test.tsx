import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { act, render } from "../../../test/render";
import { beginThreadDragAt, endThreadDrag } from "../../threads/threadDrag";
import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  type LayoutState,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import { setThreadMemberships } from "../../layout/threadMembership";
import {
  createLayoutWorkspaceNamed,
  listLayoutWorkspaces,
  setLayoutWorkspaceHidden,
} from "../../layout/layoutWorkspaces";
import { configureMotion } from "../../motion/registry";
import { toastManager } from "../ui/toast";
import { NEW_WORKSPACE_ZONE_MIN_PX } from "../../threads/workspaceDrop";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadSidebar } from "./ThreadSidebar";

const moves = vi.hoisted(() => ({
  calls: [] as Array<{ thread: { threadId: string }; workspaceId: string }>,
  created: 0,
}));

vi.mock(import("../../layout/threadWorkspaceCommands"), async (original) => ({
  ...(await original()),
  createEmptyWorkspaceOnServer: (async () => {
    moves.created += 1;
    return { id: "ws-new", name: "Workspace 9" };
  }) as never,
  moveThreadToWorkspaceOnServer: (async (input: {
    thread: { threadId: string };
    workspaceId: string;
  }) => {
    moves.calls.push(input);
    return {
      membership: { ...input.thread, workspaceId: input.workspaceId, parentThreadId: null },
      previous: { workspaceId: null, paneId: null, index: null },
    };
  }) as never,
}));

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
    deleteThread: vi.fn(async (..._args: unknown[]) => ({ _tag: "Success", value: undefined })),
  },
  confirm: vi.fn(async (..._args: unknown[]) => true),
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
}));

vi.mock(import("./SidebarUpdatesButton"), async (original) => ({
  ...(await original()),
  SidebarUpdatesButton: (() => null) as never,
}));
vi.mock(import("./SidebarUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarUpdateArchitectureWarning: () => <></>,
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

vi.mock("../../confirmDialog", () => ({
  requestConfirmDialog: (...args: unknown[]) => fixtures.confirm(...args),
}));

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
        <ThreadSidebar />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * Seeds the layout and the memberships the server would report: each thread belongs to the
 * workspace holding its chat tab, and `members` adds threads that have no tab open.
 */
function seed(
  spec: Parameters<typeof layoutOf>[0],
  threads: EnvironmentThreadShell[],
  members: ReadonlyArray<readonly [threadId: string, workspaceName: string]> = [],
): Disposable {
  localStorage.clear();
  fixtures.threads = threads;
  moves.calls = [];
  moves.created = 0;
  const layout = layoutOf(spec);
  useLayoutStore.setState({ layout });
  const idOfWorkspace = (name: string) =>
    listLayoutWorkspaces(layout).find((workspace) => workspace.name === name)!.id;
  setThreadMemberships(
    [
      ...spec.flatMap((entry) =>
        entry.chats.map((threadId) => ({
          environmentId: "env-1",
          threadId,
          workspaceId: idOfWorkspace(entry.name),
          parentThreadId: null,
        })),
      ),
      ...members.map(([threadId, name]) => ({
        environmentId: "env-1",
        threadId,
        workspaceId: idOfWorkspace(name),
        parentThreadId: null,
      })),
    ],
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

const groupNames = (container: HTMLElement) =>
  [
    ...container.querySelectorAll<HTMLElement>("[data-workspace-heading] [data-workspace-name]"),
  ].map((element) => element.textContent);
const rowsIn = (container: HTMLElement, workspaceName: string) => {
  const heading = [...container.querySelectorAll<HTMLElement>("[data-workspace-name]")].find(
    (element) => element.textContent === workspaceName,
  );
  const root = heading?.closest<HTMLElement>("[data-workspace-key]");
  return [...(root?.querySelectorAll<HTMLElement>("[data-thread-key]") ?? [])].map((row) =>
    row.dataset.threadKey?.replace("env-1:", ""),
  );
};

describe("ThreadSidebar workspaces", () => {
  it("lists the layout's workspaces in order, each with the threads whose chat tab it holds", async () => {
    using _seed = seed(
      [
        { name: "Research", chats: ["t1", "t2"] },
        { name: "Review", chats: ["t3"] },
      ],
      [liveThread("t1"), liveThread("t2"), liveThread("t3")],
    );
    await using screen = await render(<RailHarness />);

    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Research", "Review"]));
    expect(rowsIn(screen.container, "Research")).toEqual(["t1", "t2"]);
    expect(rowsIn(screen.container, "Review")).toEqual(["t3"]);
  });

  it("lists one workspace alone", async () => {
    using _seed = seed([{ name: "Solo", chats: ["t1"] }], [liveThread("t1")]);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Solo"]));
  });

  it("holds the threads of two projects in one workspace, each row naming its project", async () => {
    using _seed = seed(
      [{ name: "Mixed", chats: ["t1", "t2"] }],
      [liveThread("t1", "project-1"), liveThread("t2", "project-2")],
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(rowsIn(screen.container, "Mixed")).toEqual(["t1", "t2"]));
    const projects = [...screen.container.querySelectorAll("[data-thread-project]")].map(
      (element) => element.textContent,
    );
    expect(projects).toEqual(["Houston", "notes"]);
  });

  it("lists an empty workspace with its empty state", async () => {
    using _seed = seed(
      [
        { name: "Full", chats: ["t1"] },
        { name: "Blank", chats: [] },
      ],
      [liveThread("t1")],
    );
    useLayoutStore.getState().focusWorkspace(useLayoutStore.getState().layout.workspaces[1]!.id);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toContain("Blank"));
    expect(screen.container.querySelector("[data-workspace-empty]")?.textContent).toContain(
      "No threads yet",
    );
  });

  it("lists a thread whose tabs are all closed under its workspace, and one with no membership nowhere", async () => {
    using _seed = seed(
      [
        { name: "First", chats: ["t1"] },
        { name: "Second", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2"), liveThread("closed"), liveThread("unplaced")],
      [["closed", "Second"]],
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(rowsIn(screen.container, "Second")).toEqual(["t2", "closed"]));
    expect(rowsIn(screen.container, "First")).toEqual(["t1"]);
    expect(screen.container.querySelector('[data-thread-key="env-1:unplaced"]')).toBeNull();
  });

  it("keeps a hidden workspace off the rail and lists it in the hidden menu", async () => {
    using _seed = seed(
      [
        { name: "Shown", chats: ["t1"] },
        { name: "Tucked", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2")],
    );
    const layout = useLayoutStore.getState().layout;
    const tucked = listLayoutWorkspaces(layout).find((workspace) => workspace.name === "Tucked")!;
    useLayoutStore.setState({ layout: setLayoutWorkspaceHidden(layout, tucked.id, true) });
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Shown"]));
    // The harness draws the rail unsized, so the search row's buttons overlap this one: click it directly.
    (page.getByRole("button", { name: "Hidden workspaces" }).element() as HTMLElement).click();
    await expect.element(page.getByRole("menuitem", { name: /Tucked/ })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: /Tucked/ }).element());
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Shown", "Tucked"]));
  });

  it("moves a thread's chat tab to another workspace when its row is dropped on that heading, leaving the user where they were", async () => {
    using _seed = seed(
      [
        { name: "From", chats: ["t1", "t2"] },
        { name: "To", chats: ["t3"] },
      ],
      [liveThread("t1"), liveThread("t2"), liveThread("t3")],
    );
    const before = useLayoutStore.getState().layout;
    const focusedBefore = before.focusedWorkspaceId;
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(rowsIn(screen.container, "From")).toEqual(["t1", "t2"]));

    const heading = [
      ...screen.container.querySelectorAll<HTMLElement>("[data-workspace-heading]"),
    ].find((element) => element.textContent?.startsWith("To"))!;
    const rect = heading.getBoundingClientRect();
    const source = {
      workspaceId: before.workspaces[0]!.id,
      threadId: "t1",
      environmentId: "env-1",
      projectId: "project-1",
    };
    await act(() =>
      beginThreadDragAt(
        source,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    await vi.waitFor(() => expect(moves.calls).toHaveLength(1));
    expect(moves.calls[0]).toMatchObject({
      thread: { threadId: "t1" },
      workspaceId: before.workspaces[1]!.id,
    });
    expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe(focusedBefore);
  });

  it("creates a workspace from the header with a name and lists it", async () => {
    using _seed = seed([{ name: "Existing", chats: ["t1"] }], [liveThread("t1")]);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Existing"]));

    await userEvent.click(screen.getByRole("button", { name: "View options" }).element());
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }).element());
    const input = screen.getByRole("textbox", { name: "New workspace name" });
    await userEvent.fill(input.element(), "Fresh");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Existing", "Fresh"]));
    const fresh = listLayoutWorkspaces(useLayoutStore.getState().layout).find(
      (workspace) => workspace.name === "Fresh",
    )!;
    expect(fresh.columns[0]?.panes[0]?.tabs[0]?.content.kind).toBe("launcher");
  });

  it("refuses an over-long new workspace name, naming the limit", async () => {
    using _seed = seed([{ name: "Existing", chats: ["t1"] }], [liveThread("t1")]);
    await using screen = await render(<RailHarness />);
    await userEvent.click(screen.getByRole("button", { name: "View options" }).element());
    await userEvent.click(page.getByRole("menuitem", { name: "New workspace" }).element());
    const input = screen.getByRole("textbox", { name: "New workspace name" });
    await userEvent.fill(input.element(), "x".repeat(500));
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(screen.container.querySelector("[role=alert]")?.textContent).toMatch(/\d+/);
    expect(groupNames(screen.container)).toEqual(["Existing"]);
  });

  const headingButton = (container: HTMLElement, name: string) =>
    [...container.querySelectorAll<HTMLElement>("[data-workspace-heading] button")].find(
      (element) => element.textContent?.startsWith(name),
    )!;

  // The row's hover actions overlay its trailing edge, so a click at the centre of a narrow rail
  // lands on them; the heading's context menu is opened from its leading edge instead.
  const openHeadingMenu = (heading: HTMLElement) => {
    const box = heading.getBoundingClientRect();
    heading.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + 8,
        clientY: box.top + box.height / 2,
      }),
    );
  };

  it("deletes a workspace and its threads after a confirmation that names it, the threads and the running ones", async () => {
    using _seed = seed(
      [
        { name: "Keep", chats: ["t1"] },
        { name: "Drop", chats: ["t2"] },
      ],
      [
        liveThread("t1"),
        {
          ...liveThread("t2"),
          runtime: { status: "running", activeRunId: null, lastError: null } as never,
        },
        liveThread("t3"),
      ],
      [["t3", "Drop"]],
    );
    fixtures.confirm.mockClear();
    fixtures.actions.deleteThread.mockClear();
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Keep", "Drop"]));

    openHeadingMenu(headingButton(screen.container, "Drop"));
    await userEvent.click(page.getByRole("menuitem", { name: /Delete workspace/ }).element());

    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Keep"]));
    expect(fixtures.confirm).toHaveBeenCalledWith(
      expect.stringContaining("“Drop” and its 2 threads? 1 thread is running"),
      { variant: "destructive", confirmLabel: "Delete workspace" },
    );
    expect(
      fixtures.actions.deleteThread.mock.calls.map(
        (call) => (call[0] as { threadId: string }).threadId,
      ),
    ).toEqual(["t2", "t3"]);
  });

  it("deletes an empty workspace without asking", async () => {
    using _seed = seed(
      [
        { name: "Keep", chats: ["t1"] },
        { name: "Blank", chats: [] },
      ],
      [liveThread("t1")],
    );
    fixtures.confirm.mockClear();
    fixtures.actions.deleteThread.mockClear();
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toContain("Blank"));

    openHeadingMenu(headingButton(screen.container, "Blank"));
    await userEvent.click(page.getByRole("menuitem", { name: /Delete workspace/ }).element());

    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Keep"]));
    expect(fixtures.confirm).not.toHaveBeenCalled();
    expect(fixtures.actions.deleteThread).not.toHaveBeenCalled();
  });

  it("keeps the workspace and names the thread and the workspace when a thread cannot be deleted", async () => {
    using _seed = seed(
      [
        { name: "Keep", chats: ["t1"] },
        { name: "Drop", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2", "project-1", "Stuck")],
    );
    fixtures.actions.deleteThread.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("worktree is busy")),
    } as never);
    const add = vi.spyOn(toastManager, "add");
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Keep", "Drop"]));

    openHeadingMenu(headingButton(screen.container, "Drop"));
    await userEvent.click(page.getByRole("menuitem", { name: /Delete workspace/ }).element());

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not delete workspace",
          description: expect.stringMatching(/“Stuck” \(t2\).*workspace “Drop”/),
        }),
      ),
    );
    expect(groupNames(screen.container)).toEqual(["Keep", "Drop"]);
  });

  it("refuses to delete the last workspace, naming it, and keeps it", async () => {
    using _seed = seed([{ name: "Keep", chats: ["t1"] }], [liveThread("t1")]);
    const add = vi.spyOn(toastManager, "add");
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Keep"]));

    openHeadingMenu(headingButton(screen.container, "Keep"));
    await userEvent.click(page.getByRole("menuitem", { name: /Delete workspace/ }).element());

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not delete workspace",
        description: expect.stringContaining("Keep"),
      }),
    );
    expect(groupNames(screen.container)).toEqual(["Keep"]);
  });

  it("renames a workspace from the rail", async () => {
    using _seed = seed([{ name: "Before", chats: ["t1"] }], [liveThread("t1")]);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Before"]));
    (
      screen.getByRole("button", { name: "Workspace actions for Before" }).element() as HTMLElement
    ).click();
    await userEvent.click(page.getByRole("menuitem", { name: /Rename workspace/ }).element());
    const input = screen.getByRole("textbox", { name: "Rename workspace Before" });
    await userEvent.fill(input.element(), "After");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["After"]));
  });

  it("reorders workspaces from the menu", async () => {
    using _seed = seed(
      [
        { name: "One", chats: ["t1"] },
        { name: "Two", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2")],
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["One", "Two"]));
    openHeadingMenu(
      [...screen.container.querySelectorAll<HTMLElement>("[data-workspace-heading] button")].find(
        (element) => element.textContent?.startsWith("Two"),
      )!,
    );
    await userEvent.click(page.getByRole("menuitem", { name: "Move workspace up" }).element());
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Two", "One"]));
  });

  it("keeps the rail inside a narrow sidebar with long names", async () => {
    using _seed = seed(
      [{ name: "A workspace with an extremely long name that cannot fit", chats: ["t1"] }],
      [
        liveThread(
          "t1",
          "project-1",
          "A thread title long enough to need truncation in any rail width at all",
        ),
      ],
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-thread-key]")).not.toBeNull(),
    );
    const viewport = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    viewport.style.width = "220px";
    const boundary = viewport.getBoundingClientRect().right + 1;
    for (const element of screen.container.querySelectorAll<HTMLElement>(
      "[data-thread-key], [data-workspace-heading]",
    )) {
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(boundary);
    }
  });

  it("turns the heading's transitions off when animations are off", async () => {
    using _seed = seed([{ name: "Calm", chats: ["t1"] }], [liveThread("t1")]);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["Calm"]));
    const more = screen.getByRole("button", { name: "Workspace actions for Calm" }).element();
    const duration = () => getComputedStyle(more.parentElement!).transitionDuration;
    try {
      configureMotion({ off: true });
      await vi.waitFor(() => expect(duration()).toBe("0s"));
    } finally {
      configureMotion({ off: false });
    }
  });
});

/** The list's own bottom padding (`pb-10` plus the content's `pb-6`) the zone stops short of. */
const BLANK_ZONE_BOTTOM_PADDING_PX = 64;

describe("ThreadSidebar new workspace drop zone", () => {
  const blank = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-new-workspace-drop]")!;
  const source = (workspaceId: string) => ({
    workspaceId,
    threadId: "t1",
    environmentId: "env-1",
    projectId: "project-1",
    title: "t1",
  });
  const centreOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const move = (point: { x: number; y: number }) => {
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  };

  it("adds no row during a drag; the blank area below the last workspace shows the highlight and label only under the pointer", async () => {
    using _seed = seed(
      [
        { name: "From", chats: ["t1"] },
        { name: "To", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2")],
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["From", "To"]));
    const sections = [...screen.container.querySelectorAll<HTMLElement>("[data-workspace-key]")];
    const lastBottom = sections.at(-1)!.getBoundingClientRect().bottom;
    const fromId = useLayoutStore.getState().layout.workspaces[0]!.id;

    await act(() => beginThreadDragAt(source(fromId), { x: 0, y: 0 }, 1));
    const zone = blank(screen.container);
    expect(zone.getBoundingClientRect().top).toBeGreaterThanOrEqual(lastBottom);
    expect(zone.getBoundingClientRect().height).toBeGreaterThanOrEqual(NEW_WORKSPACE_ZONE_MIN_PX);
    expect(zone.hasAttribute("data-drop-over")).toBe(false);
    expect(screen.container.textContent).not.toContain("New workspace");
    // A short list leaves blank space; the zone takes all of it, down to the list's padding.
    const view = zone
      .closest<HTMLElement>("[data-slot='scroll-area-viewport']")!
      .getBoundingClientRect();
    expect(view.bottom - zone.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      BLANK_ZONE_BOTTOM_PADDING_PX,
    );

    await act(() => move(centreOf(zone)));
    expect(zone.hasAttribute("data-drop-over")).toBe(true);
    expect(zone.textContent).toBe("New workspace");

    const heading = sections.at(-1)!.querySelector<HTMLElement>("[data-workspace-heading]")!;
    await act(() => move(centreOf(heading)));
    expect(zone.hasAttribute("data-drop-over")).toBe(false);
    expect(zone.textContent).toBe("");
  });

  it("drops on the blank area into a new workspace with the same toast as before", async () => {
    using _seed = seed(
      [
        { name: "From", chats: ["t1"] },
        { name: "To", chats: ["t2"] },
      ],
      [liveThread("t1"), liveThread("t2")],
    );
    const added: Array<{ title?: string }> = [];
    vi.spyOn(toastManager, "add").mockImplementation(((toast: { title?: string }) => {
      added.push(toast);
      return "id";
    }) as never);
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toEqual(["From", "To"]));
    const fromId = useLayoutStore.getState().layout.workspaces[0]!.id;

    await act(() => beginThreadDragAt(source(fromId), { x: 0, y: 0 }, 1));
    const point = centreOf(blank(screen.container));
    await act(() => move(point));
    await act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 1, clientX: point.x, clientY: point.y }),
      );
    });
    await vi.waitFor(() => expect(moves.calls).toHaveLength(1));
    expect(moves.created).toBe(1);
    expect(moves.calls[0]).toMatchObject({ thread: { threadId: "t1" }, workspaceId: "ws-new" });
    await vi.waitFor(() =>
      expect(added.map((toast) => toast.title)).toContain("Moved to “Workspace 9”"),
    );
  });

  it("keeps a blank strip after a list that fills the sidebar, reachable by scrolling", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `Space ${index}`);
    using _seed = seed(
      names.map((name, index) => ({ name, chats: [`c${index}`] })),
      names.map((_, index) => liveThread(`c${index}`)),
    );
    await using screen = await render(<RailHarness />);
    await vi.waitFor(() => expect(groupNames(screen.container)).toHaveLength(40));
    const fromId = useLayoutStore.getState().layout.workspaces[0]!.id;

    await act(() => beginThreadDragAt({ ...source(fromId), threadId: "c0" }, { x: 0, y: 0 }, 1));
    const zone = blank(screen.container);
    expect(zone.getBoundingClientRect().height).toBeGreaterThanOrEqual(NEW_WORKSPACE_ZONE_MIN_PX);
    zone.scrollIntoView({ block: "end" });
    const viewport = zone.closest<HTMLElement>("[data-slot='scroll-area-viewport']")!;
    const view = viewport.getBoundingClientRect();
    const rect = zone.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(view.top);
    expect(rect.top + NEW_WORKSPACE_ZONE_MIN_PX).toBeLessThanOrEqual(view.bottom);
  });
});
