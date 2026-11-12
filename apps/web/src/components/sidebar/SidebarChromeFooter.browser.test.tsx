import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarChromeFooter } from "./SidebarChrome";
import { buildLayout } from "../../layout/layoutFixtures";
import { selectFocusedTab, selectFocusedWorkspace } from "../../layout/layoutModel";
import { useLayoutStore } from "../../layout/layoutStore";

vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
}));
vi.mock("./SidebarUpdatePill", () => ({ SidebarUpdateArchitectureWarning: () => <></> }));
vi.mock("./SidebarUpdatesButton", () => ({ SidebarUpdatesButton: () => null }));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => <></> }));

const renderFooter = (hideTasks = false, router = "/") =>
  render(
    <TooltipProvider delay={0}>
      <SidebarProvider defaultOpen>
        <div style={{ width: 240 }}>
          <SidebarChromeFooter hideTasks={hideTasks} />
        </div>
      </SidebarProvider>
    </TooltipProvider>,
    { router },
  );

const focusedKind = () => selectFocusedTab(useLayoutStore.getState().layout)?.content.kind;
const workspaceTabKinds = () =>
  selectFocusedWorkspace(useLayoutStore.getState().layout).columns.flatMap((column) =>
    column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content.kind)),
  );

describe("SidebarChromeFooter", () => {
  it("shows Pull requests and Tasks, a gap, then the theme button and Settings", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    await using screen = await renderFooter();
    const box = (name: string | RegExp) =>
      screen.getByRole("button", { name }).element().getBoundingClientRect();
    const [pullRequests, tasks, theme, settings] = [
      box("Pull requests"),
      box("Tasks"),
      box(/^Theme:/),
      box("Settings"),
    ];
    for (const entry of [pullRequests, tasks, theme, settings]) {
      expect(entry.top).toBe(pullRequests.top);
      expect(entry.width).toBe(28);
    }
    expect(pullRequests.right).toBeLessThanOrEqual(tasks.left);
    expect(tasks.right).toBeLessThan(theme.left - 8);
    expect(theme.right).toBeLessThanOrEqual(settings.left);
    const footer = screen.container
      .querySelector<HTMLElement>('[data-slot="sidebar-footer"]')!
      .getBoundingClientRect();
    expect(settings.right).toBeLessThanOrEqual(footer.right + 0.5);
    expect(footer.right - settings.right).toBeLessThan(16);
    expect(screen.getByRole("button", { name: "Usage" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Back" }).elements()).toHaveLength(0);
  });

  it("drops Tasks when it is hidden", async () => {
    await using screen = await renderFooter(true);
    expect(screen.getByRole("button", { name: "Tasks" }).elements()).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: "Pull requests" })).toBeVisible();
  });

  it("keeps Settings and the theme button on a page route instead of swapping in Back", async () => {
    await using screen = await renderFooter(false, "/tasks");
    await expect.element(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Theme:/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back" }).elements()).toHaveLength(0);
  });

  it("marks a page button while a tab of that page is the focused tab, and no other", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    await using screen = await renderFooter();
    const current = (name: string) =>
      screen.getByRole("button", { name }).element().getAttribute("aria-current");
    expect(current("Tasks")).toBeNull();
    useLayoutStore.getState().openTab({ kind: "tasks" });
    await expect.poll(() => current("Tasks")).toBe("page");
    expect(current("Pull requests")).toBeNull();
    useLayoutStore.getState().focusTab("a");
    await expect.poll(() => current("Tasks")).toBeNull();
  });

  it("opens a page as a new tab beside the focused one and leaves that tab alone", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    await using screen = await renderFooter();
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }).element());
    await expect.poll(focusedKind).toBe("tasks");
    expect(workspaceTabKinds()).toEqual(["chat", "tasks"]);
    await userEvent.click(screen.getByRole("button", { name: "Pull requests" }).element());
    await expect.poll(focusedKind).toBe("pull-requests");
    expect(workspaceTabKinds()).toEqual(["chat", "tasks", "pull-requests"]);
  });

  it("focuses the open tab of a page instead of opening a second one", async () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    useLayoutStore.getState().openTab({ kind: "tasks" });
    useLayoutStore.getState().focusTab("a");
    await using screen = await renderFooter();
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }).element());
    await expect.poll(focusedKind).toBe("tasks");
    expect(workspaceTabKinds().filter((kind) => kind === "tasks")).toHaveLength(1);
  });

  it("names each button in a tooltip", async () => {
    await using screen = await renderFooter();
    await userEvent.hover(screen.getByRole("button", { name: "Pull requests" }).element());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
        "Pull requests",
      ),
    );
  });
});
