import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { clearThreadSelection } from "../../threads/sidebarModel";
import { beginThreadDragAt, endThreadDrag } from "../../threads/threadDrag";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  type LayoutState,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";
import {
  createLayoutWorkspaceNamed,
  listLayoutWorkspaces,
  WORKSPACE_NAME_MAX_CHARS,
} from "../../layout/layoutWorkspaces";
import { act, render, type Screen } from "../../../test/render";
import { SidebarOptionsMenu } from "../ui/sidebar-sections";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarWorkspaceGroup } from "./ThreadSidebar";
import type { SidebarWorkspaceSection } from "./sidebarWorkspaceSections";

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

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Split drawer state from the thread store",
    branch: "houston/split-drawer-state",
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
      rootThreadId: "thread-a",
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

/** A chat tab for a thread of the test environment. */
function chat(id: string): LayoutTabContent {
  return {
    kind: "chat",
    target: {
      kind: "server",
      threadRef: scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make(id)),
    },
  };
}

/** A layout with one named workspace per entry, each holding the given chats. */
function layoutOf(
  spec: ReadonlyArray<{ name: string; chats: ReadonlyArray<string> }>,
): LayoutState {
  let state = createLayoutState();
  spec.forEach((entry, index) => {
    if (index > 0) state = createLayoutWorkspaceNamed(state, entry.name).state;
    else state = createLayoutWorkspaceNamed(state, entry.name).state;
    for (const id of entry.chats) state = openLayoutTab(state, chat(id));
  });
  return normalizeLayout(state);
}

function workspace(overrides: Partial<SidebarWorkspaceSection> = {}): SidebarWorkspaceSection {
  return {
    workspaceId: "ws-a",
    name: "v2 rebuild",
    pinned: false,
    hidden: false,
    empty: false,
    threads: [],
    needsYouThreads: [],
    ...overrides,
  };
}

function group(
  value: SidebarWorkspaceSection,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  overrides: {
    open?: boolean;
    collapsed?: boolean;
    focusedThreadKey?: string | null;
    previousWorkspaceId?: string | null;
    nextWorkspaceId?: string | null;
    onToggleCollapsed?: () => void;
    onOpenThread?: (thread: EnvironmentThreadShell) => void;
    onDropOnWorkspace?: (source: unknown, workspaceId: string) => void;
    onCreateWorkspace?: () => void;
  } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <SidebarWorkspaceGroup
        section={{ ...value, threads, empty: value.empty || threads.length === 0 }}
        query=""
        open={overrides.open ?? false}
        collapsed={overrides.collapsed ?? false}
        onToggleCollapsed={overrides.onToggleCollapsed ?? (() => {})}
        previousWorkspaceId={overrides.previousWorkspaceId ?? null}
        nextWorkspaceId={overrides.nextWorkspaceId ?? null}
        hiddenWorkspaces={[]}
        focusedThreadKey={overrides.focusedThreadKey ?? null}
        providerEntriesByEnvironment={new Map()}
        projectTitleOf={(value) => (value.projectId === "project-2" ? "notes" : "Houston")}
        nowIso="2026-01-01T00:00:00.000Z"
        selection={clearThreadSelection()}
        runningSubagents={new Map()}
        dragging={null}
        dropTarget={null}
        reorder={{ drag: null, begin: () => {} }}
        onOpenThread={overrides.onOpenThread ?? (() => {})}
        onSelectThread={() => {}}
        onCloseThread={() => {}}
        onHoldThread={() => {}}
        onPickHoldTime={async () => null}
        onDropOnWorkspace={overrides.onDropOnWorkspace ?? (() => {})}
        onCreateWorkspace={overrides.onCreateWorkspace ?? (() => {})}
        onRenameThread={() => {}}
        onSetAutoClose={() => {}}
        workspaceMoveFor={() => undefined}
        handleNewThread={async () => null}
      />
    </TooltipProvider>
  );
}

function headingFor(screen: Screen, workspaceId: string): HTMLButtonElement {
  const heading = screen.container.querySelector(
    `[data-workspace-key="${workspaceId}"] button[aria-expanded]`,
  );
  if (!(heading instanceof HTMLButtonElement)) {
    throw new Error(`The workspace ${workspaceId} has no heading button.`);
  }
  return heading;
}

/** The heading row: the toggle and its actions, which share one hover and selection fill. */
function headingRowFor(screen: Screen, workspaceId: string): HTMLElement {
  const row = headingFor(screen, workspaceId).closest("[data-workspace-heading-row]");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`The workspace ${workspaceId} has no heading row.`);
  }
  return row;
}

function headingGeometry(heading: HTMLButtonElement) {
  const chevron = heading.querySelector("svg");
  const chevronBox = heading.querySelector("[data-workspace-chevron-box]");
  const name = heading.children[1];
  if (chevron === null || chevronBox === null || name === undefined) {
    throw new Error("The workspace heading is missing its chevron box or name.");
  }
  const chevronRect = chevronBox.getBoundingClientRect();
  return {
    chevron,
    chevronLeft: chevronRect.left,
    chevronWidth: chevronRect.width,
    textLeft: name.getBoundingClientRect().left,
  };
}

function expectSameX(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

function CollapsibleGroup({
  value,
  threads,
}: {
  value: SidebarWorkspaceSection;
  threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return group(value, threads, {
    collapsed,
    onToggleCollapsed: () => setCollapsed((current) => !current),
  });
}

const threadKey = (id: string) => `env-1:${id}`;

/** Resets the layout store and the spies a test installed when its scope ends. */
function session(): Disposable {
  return {
    [Symbol.dispose]: () => {
      useLayoutStore.getState().reset();
      vi.restoreAllMocks();
    },
  };
}

describe("workspace group", () => {
  it("lists workspaces by name, with no project tree above them", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      <>
        {group(workspace({ workspaceId: "ws-a", name: "v2 rebuild" }), threads)}
        {group(workspace({ workspaceId: "ws-b", name: "Review" }), [])}
      </>,
    );

    expect(screen.getByRole("button", { name: /^v2 rebuild$/ }).element()).toBeVisible();
    expect(screen.getByRole("button", { name: /^Review empty$/ }).element()).toBeVisible();
    expect(screen.container.textContent).not.toContain("Projects");
    expect(screen.container.querySelector("[data-project-key]")).toBeNull();
  });

  it("lists threads of two projects in one workspace, each row naming its own project", async () => {
    await using screen = await render(
      group(workspace(), [
        thread({ id: "thread-a", projectId: "project-1" }),
        thread({ id: "thread-b", projectId: "project-2", title: "Notes cleanup" }),
      ]),
    );
    const projects = [...screen.container.querySelectorAll("[data-thread-project]")].map(
      (element) => element.textContent,
    );
    expect(projects).toEqual(["Houston", "notes"]);
  });

  it("renders a one-thread workspace with its heading and an indented thread row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await render(
      group(
        workspace({ workspaceId: "ws-c", name: "Landing copy" }),
        [thread({ id: "thread-c" })],
        {
          onOpenThread,
        },
      ),
    );

    expect(screen.getByRole("button", { name: /^Landing copy$/ }).element()).toBeVisible();
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    expect(getComputedStyle(row).paddingLeft).toBe("12px");

    await userEvent.click(screen.getByText("Split drawer state from the thread store").element());
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "thread-c" }));
  });

  it("shows an empty workspace's name, an empty label and a New thread action", async () => {
    using _session = session();
    useLayoutStore.setState({ layout: layoutOf([{ name: "Scratch", chats: [] }]) });
    const target = listLayoutWorkspaces(useLayoutStore.getState().layout)[0]!;
    await using screen = await render(
      group(workspace({ workspaceId: target.id, name: "Scratch" }), []),
    );

    expect(screen.getByRole("button", { name: /^Scratch empty$/ }).element()).toBeVisible();
    expect(screen.container.querySelector("[data-workspace-empty]")?.textContent).toContain(
      "No threads yet",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "New thread", exact: true }).element(),
    );
    const opened = useLayoutStore
      .getState()
      .layout.workspaces.find((candidate) => candidate.id === target.id)!;
    expect(opened.columns[0]?.panes[0]?.tabs[0]?.content.kind).toBe("launcher");
  });

  it("draws rows for unplaced threads under an empty workspace instead of the empty label", async () => {
    await using screen = await render(
      group(workspace({ empty: true }), [thread({ id: "thread-u" })]),
    );
    expect(screen.container.querySelector("[data-workspace-empty]")).toBeNull();
    expect(screen.container.querySelectorAll("[data-thread-key]")).toHaveLength(1);
  });

  it("marks a pinned workspace with a pin glyph and none otherwise", async () => {
    await using screen = await render(
      <>
        {group(workspace({ workspaceId: "ws-p", name: "Pinned one", pinned: true }), [])}
        {group(workspace({ workspaceId: "ws-q", name: "Loose" }), [])}
      </>,
    );
    expect(headingFor(screen, "ws-p").querySelector("[data-workspace-pin]")).not.toBeNull();
    expect(headingFor(screen, "ws-q").querySelector("[data-workspace-pin]")).toBeNull();
  });

  it("renames a workspace from its actions menu in the layout store and keeps the input until Enter", async () => {
    using _session = session();
    const layout = layoutOf([{ name: "Grid 1", chats: ["thread-r"] }]);
    useLayoutStore.setState({ layout });
    const id = listLayoutWorkspaces(layout)[0]!.id;
    await using screen = await render(
      group(workspace({ workspaceId: id, name: "Grid 1" }), [thread({ id: "thread-r" })]),
    );

    await userEvent.click(
      page.getByRole("button", { name: "Workspace actions for Grid 1" }).element(),
    );
    await userEvent.click(page.getByRole("menuitem", { name: /Rename workspace/ }).element());

    const input = screen.getByRole("textbox");
    await expect.element(input).toBeVisible();
    await expect.element(input).toHaveFocus();

    await userEvent.fill(input.element(), "Review");
    await userEvent.keyboard("{Enter}");
    expect(listLayoutWorkspaces(useLayoutStore.getState().layout)[0]?.name).toBe("Review");
  });

  it("refuses a rename over the name limit, naming the limit and the length", async () => {
    using _session = session();
    const layout = layoutOf([{ name: "One", chats: ["thread-1"] }]);
    useLayoutStore.setState({ layout });
    const [first] = listLayoutWorkspaces(layout);
    const tooLong = "x".repeat(WORKSPACE_NAME_MAX_CHARS + 1);
    const add = vi.spyOn(toastManager, "add");
    await using screen = await render(
      group(workspace({ workspaceId: first!.id, name: "One" }), [thread({ id: "thread-1" })]),
    );

    headingFor(screen, first!.id).focus();
    await userEvent.keyboard("{F2}");
    const input = screen.getByRole("textbox");
    await userEvent.fill(input.element(), tooLong);
    await userEvent.keyboard("{Enter}");

    expect(listLayoutWorkspaces(useLayoutStore.getState().layout)[0]?.name).toBe("One");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(String(WORKSPACE_NAME_MAX_CHARS)),
      }),
    );
  });

  it("opens the workspace menu on right-click and pins from it", async () => {
    using _session = session();
    const layout = layoutOf([{ name: "Grid 1", chats: ["thread-m"] }]);
    useLayoutStore.setState({ layout });
    const id = listLayoutWorkspaces(layout)[0]!.id;
    await using screen = await render(
      group(workspace({ workspaceId: id, name: "Grid 1" }), [thread({ id: "thread-m" })]),
    );

    await userEvent.click(headingFor(screen, id), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Pin workspace" }).element());
    await expect
      .poll(() => listLayoutWorkspaces(useLayoutStore.getState().layout)[0]?.pinnedAt)
      .not.toBeUndefined();
  });

  it("refuses to delete the last workspace at once, naming it, and leaves the layout alone", async () => {
    using _session = session();
    const layout = layoutOf([{ name: "Only", chats: ["thread-d"] }]);
    useLayoutStore.setState({ layout });
    const id = listLayoutWorkspaces(layout)[0]!.id;
    const add = vi.spyOn(toastManager, "add");
    await using screen = await render(
      group(workspace({ workspaceId: id, name: "Only" }), [thread({ id: "thread-d" })]),
    );

    await userEvent.click(headingFor(screen, id), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: /Delete workspace/ }).element());

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not delete workspace",
        description: expect.stringContaining("Only"),
      }),
    );
    expect(useLayoutStore.getState().layout).toBe(layout);
  });

  it("moves a workspace down and up from its menu with the neighbours given", async () => {
    using _session = session();
    const layout = layoutOf([
      { name: "One", chats: ["thread-1"] },
      { name: "Two", chats: ["thread-2"] },
    ]);
    useLayoutStore.setState({ layout });
    const [first, second] = listLayoutWorkspaces(layout);
    await using screen = await render(
      group(workspace({ workspaceId: first!.id, name: "One" }), [thread({ id: "thread-1" })], {
        nextWorkspaceId: second!.id,
      }),
    );

    await userEvent.click(headingFor(screen, first!.id), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Move workspace down" }).element());
    await expect
      .poll(() => listLayoutWorkspaces(useLayoutStore.getState().layout).map((w) => w.name))
      .toEqual(["Two", "One"]);
  });

  it("keeps a long thread title clear of the row's hover actions", async () => {
    const title = "App de desenvolvimento para testes com um nome bem comprido";
    await using screen = await render(
      <div style={{ width: 300 }}>{group(workspace(), [thread({ id: "thread-l", title })])}</div>,
    );

    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    await userEvent.hover(row);
    const titleText = row.querySelector("[data-card-open] > span") as HTMLElement;
    const close = screen.getByRole("button", { name: "Close thread" }).element();
    const actions = close.parentElement as HTMLElement;
    await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
    // The actions take the project line's right corner; the title line below never runs under them.
    const titleBox = titleText.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    expect(titleBox.top >= actionsBox.bottom || titleBox.right <= actionsBox.left).toBe(true);
  });

  it("keeps a long project name and a long branch clear of the status and provider at 240px", async () => {
    await using screen = await render(
      <div style={{ width: 240 }}>
        {group(workspace(), [
          thread({
            id: "thread-long",
            branch: "feature/an-extremely-long-branch-name-that-cannot-fit-in-the-rail",
            hasPendingUserInput: true,
          }),
        ])}
      </div>,
      {},
    );
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    const project = row.querySelector<HTMLElement>("[data-thread-project-line]")!;
    const meta = row.querySelector<HTMLElement>("[data-thread-meta]")!;
    expect(project.scrollWidth).toBeLessThanOrEqual(project.clientWidth + 1);
    expect(meta.scrollWidth).toBeLessThanOrEqual(meta.clientWidth + 1);
    const rowBox = row.getBoundingClientRect();
    for (const line of [project, meta]) {
      expect(line.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right + 0.5);
    }
  });

  it("hides the heading actions again once a clicked heading loses the pointer, and shows them on keyboard focus", async () => {
    const value = workspace({ workspaceId: "ws-h", name: "Grid 1" });
    await using screen = await render(group(value, [thread({ id: "thread-h" })]));
    const heading = headingFor(screen, "ws-h");
    const add = screen.getByRole("button", { name: "New thread in Grid 1" }).element();
    const more = screen.getByRole("button", { name: "Workspace actions for Grid 1" }).element();
    const opacity = (element: Element) => Number(getComputedStyle(element).opacity);

    await userEvent.click(heading);
    await userEvent.unhover(heading);
    await expect.poll(() => opacity(add)).toBe(0);
    expect(opacity(more)).toBe(0);

    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(heading);
    await expect.poll(() => opacity(add)).toBe(1);
    expect(opacity(more)).toBe(1);
  });

  it("keeps every workspace heading untinted, open or not", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      <>
        {group(workspace({ workspaceId: "ws-a", name: "v2 rebuild" }), threads, { open: true })}
        {group(workspace({ workspaceId: "ws-b", name: "Review" }), threads, { open: false })}
      </>,
    );

    expect(headingRowFor(screen, "ws-a").className).not.toContain("bg-sidebar-row-selected");
    expect(headingRowFor(screen, "ws-b").className).not.toContain("bg-sidebar-row-selected");
  });

  it("leaves an open empty workspace's heading untinted", async () => {
    await using screen = await render(
      group(workspace({ workspaceId: "ws-e", name: "UI/UX design" }), [], { open: true }),
    );

    expect(headingRowFor(screen, "ws-e").className).not.toContain("bg-sidebar-row-selected");
  });

  it("fills the whole heading row, actions included, while it is hovered", async () => {
    await using screen = await render(
      group(workspace({ workspaceId: "ws-h2", name: "UI/UX design" }), []),
    );
    const row = headingRowFor(screen, "ws-h2");
    const idle = getComputedStyle(row).backgroundColor;

    await userEvent.hover(
      page.getByRole("button", { name: "New thread in UI/UX design" }).element(),
    );

    await expect.poll(() => getComputedStyle(row).backgroundColor).not.toBe(idle);
    expect(headingFor(screen, "ws-h2").className).not.toContain("hover:bg-");
  });

  it("leaves the open workspace's heading untinted while its focused thread row shows the selection", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      group(workspace(), threads, { open: true, focusedThreadKey: threadKey("thread-a") }),
    );

    expect(headingRowFor(screen, "ws-a").className).not.toContain("bg-sidebar-row-selected");
  });

  it("hands the open workspace's selection fill to its revealed thread row while collapsed", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(
      group(workspace(), threads, {
        open: true,
        collapsed: true,
        focusedThreadKey: threadKey("thread-a"),
      }),
    );

    expect(headingRowFor(screen, "ws-a").className).not.toContain("bg-sidebar-row-selected");
    expect(screen.container.querySelector("[data-thread-key$=':thread-a']")).not.toBeNull();
    expect(screen.container.querySelector("[data-thread-key$=':thread-b']")).toBeNull();
  });

  it("leaves the open workspace's heading untinted when collapsing hides every row", async () => {
    const threads = [thread({ id: "thread-a" }), thread({ id: "thread-b", title: "Second" })];
    await using screen = await render(group(workspace(), threads, { open: true, collapsed: true }));

    expect(headingRowFor(screen, "ws-a").className).not.toContain("bg-sidebar-row-selected");
  });

  it("keeps the chevron and text still across collapse and thread counts", async () => {
    const counts = [0, 1, 2, 6] as const;
    const makeThreads = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        thread({ id: `thread-${count}-${index}`, title: `Thread ${index}` }),
      );
    await using screen = await render(
      <TooltipProvider delay={0}>
        {counts.map((count) => (
          <CollapsibleGroup
            key={count}
            value={workspace({ workspaceId: `ws-${count}`, name: "v2 rebuild" })}
            threads={makeThreads(count)}
          />
        ))}
      </TooltipProvider>,
    );

    const reference = headingGeometry(headingFor(screen, "ws-0"));
    expect(reference.chevron.getAttribute("class")).toContain("rotate-90");

    for (const count of counts) {
      const heading = headingFor(screen, `ws-${count}`);
      const expanded = headingGeometry(heading);
      expectSameX(expanded.chevronLeft, reference.chevronLeft);
      expectSameX(expanded.textLeft, reference.textLeft);
      expectSameX(expanded.chevronWidth, reference.chevronWidth);

      await userEvent.click(heading);
      expect(heading.getAttribute("aria-expanded")).toBe("false");
      const collapsed = headingGeometry(heading);
      expect(collapsed.chevron).toBe(expanded.chevron);
      expect(collapsed.chevron.getAttribute("class")).not.toContain("rotate-90");
      expectSameX(collapsed.chevronLeft, reference.chevronLeft);
      expectSameX(collapsed.textLeft, reference.textLeft);
      expectSameX(collapsed.chevronWidth, expanded.chevronWidth);

      const root = screen.container.querySelector(`[data-workspace-key="ws-${count}"]`);
      expect(root?.querySelectorAll("[data-thread-key]")).toHaveLength(0);

      await userEvent.click(heading);
      expect(heading.getAttribute("aria-expanded")).toBe("true");
      expect(root?.querySelectorAll("[data-thread-key]")).toHaveLength(count);
      expectSameX(headingGeometry(heading).textLeft, reference.textLeft);
    }
  });

  it("toggles collapse from Enter and Space on the focused heading", async () => {
    await using screen = await render(
      <CollapsibleGroup
        value={workspace({ workspaceId: "ws-toggle", name: "Toggle" })}
        threads={[thread()]}
      />,
    );
    const heading = headingFor(screen, "ws-toggle");

    heading.focus();
    expect(document.activeElement).toBe(heading);

    await userEvent.keyboard("{Enter}");
    expect(heading.getAttribute("aria-expanded")).toBe("false");

    await userEvent.keyboard(" ");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("truncates long names without moving the chevron or the overflow button", async () => {
    const container = document.createElement("div");
    container.style.width = "220px";
    await using screen = await render(
      <TooltipProvider delay={0}>
        {group(workspace({ workspaceId: "ws-short", name: "Short" }), [])}
        {group(
          workspace({ workspaceId: "ws-long", name: "A very long workspace name that never fits" }),
          [],
        )}
      </TooltipProvider>,
      { container },
    );

    const short = headingFor(screen, "ws-short");
    const long = headingFor(screen, "ws-long");
    const shortGeometry = headingGeometry(short);
    const longGeometry = headingGeometry(long);
    expectSameX(longGeometry.chevronLeft, shortGeometry.chevronLeft);
    expectSameX(longGeometry.textLeft, shortGeometry.textLeft);

    const shortActions = screen
      .getByRole("button", { name: "Workspace actions for Short" })
      .element();
    const longActions = screen
      .getByRole("button", {
        name: "Workspace actions for A very long workspace name that never fits",
      })
      .element();
    expectSameX(
      longActions.getBoundingClientRect().left,
      shortActions.getBoundingClientRect().left,
    );
    expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth + 1);
  });

  it("moves a dragged thread onto the workspace whose heading is under the pointer", async () => {
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onDropOnWorkspace = vi.fn();
    await using screen = await render(group(workspace(), [], { onDropOnWorkspace }), {
      router: false,
    });
    const heading = headingFor(screen, "ws-a");
    const rect = heading.getBoundingClientRect();
    const source = {
      workspaceId: "ws-other",
      threadId: "thread-a",
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

    expect(onDropOnWorkspace).toHaveBeenCalledWith(source, "ws-a");
  });
});

describe("View options", () => {
  const defaults = {
    threadSort: "grid",
    showBranch: true,
    showPullRequest: true,
    showSubagents: true,
    showNeedsYou: false,
  } as const;

  it("offers sorts, row fields and a reset, and reports each pick", async () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    await using screen = await render(
      <SidebarOptionsMenu options={defaults} onChange={onChange} onReset={onReset} />,
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "View options" }));
    await expect.element(page.getByText("Sort threads")).toBeVisible();
    await expect.element(page.getByText("Rows show")).toBeVisible();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Workspace order" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Branch" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Show Needs you" }))
      .toHaveAttribute("aria-checked", "false");
    expect(page.getByRole("menuitemcheckbox", { name: "Working shelf" }).elements()).toHaveLength(
      0,
    );

    await userEvent.click(page.getByRole("menuitemradio", { name: "Created" }));
    expect(onChange).toHaveBeenCalledWith({ threadSort: "created_at" });
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Subagents" }));
    expect(onChange).toHaveBeenCalledWith({ showSubagents: false });
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Show Needs you" }));
    expect(onChange).toHaveBeenCalledWith({ showNeedsYou: true });
    await userEvent.click(page.getByRole("menuitem", { name: "Reset to defaults" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("hides the branch line when Rows show leaves Branch off", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    try {
      {
        await using shown = await render(group(workspace(), [thread()]), { router: "/" });
        expect(shown.container.textContent).toContain("houston/split-drawer-state");
      }
      __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarRowShowBranch: false });
      await using hidden = await render(group(workspace(), [thread()]), { router: "/" });
      expect(hidden.container.textContent).not.toContain("houston/split-drawer-state");
    } finally {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    }
  });

  it("badges a merged pull request on the row and drops the badge when Rows show hides it", async () => {
    const merged = {
      number: 88,
      url: "https://github.com/acme/app/pull/88",
      linkedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        state: "merged",
        isDraft: false,
        title: "Ship it",
        updatedAt: "2026-01-02T00:00:00.000Z",
        checksState: "failing",
      },
    };
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    try {
      {
        await using shown = await render(group(workspace(), [thread({ pullRequests: [merged] })]));
        const badge = shown.container.querySelector("[data-thread-pull-request]");
        expect(badge?.textContent).toBe("88");
        expect(badge?.querySelector("svg")?.classList.contains("text-merged-foreground")).toBe(
          true,
        );
        expect(badge?.querySelector("span")?.classList.contains("text-merged-foreground")).toBe(
          false,
        );
      }
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        sidebarRowShowPullRequest: false,
      });
      await using hidden = await render(group(workspace(), [thread({ pullRequests: [merged] })]));
      expect(hidden.container.querySelector("[data-thread-pull-request]")).toBeNull();
    } finally {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    }
  });
});
