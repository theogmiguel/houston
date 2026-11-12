import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { createLayoutWorkspaceNamed } from "./layoutWorkspaces";
import {
  createLayoutState,
  focusLayoutWorkspace,
  normalizeLayout,
  renameLayoutWorkspace,
  openLayoutTab,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const environmentId = EnvironmentId.make("local");
const chat = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
});

/** One workspace per name, each holding a chat; the first one has focus. */
function withWorkspaces(names: readonly string[]): LayoutState {
  let state = createLayoutState();
  names.forEach((name, index) => {
    state = openLayoutTab(state, chat(`thread-${index}`));
    state = renameLayoutWorkspace(state, state.focusedWorkspaceId, name);
    state = createLayoutWorkspaceNamed(state, "").state;
  });
  return focusLayoutWorkspace(normalizeLayout(state), state.workspaces[0]!.id);
}

const names = () =>
  useLayoutStore
    .getState()
    .layout.workspaces.filter((workspace) => workspace.columns.length > 0)
    .map((workspace) => workspace.name);

beforeEach(() => useLayoutStore.getState().reset());
afterEach(() => useLayoutStore.getState().reset());

describe("WorkspaceSwitcher", () => {
  it("shows one workspace without a position count", async () => {
    useLayoutStore.setState({ layout: openLayoutTab(createLayoutState(), chat("only")) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await expect.element(page.getByRole("button", { name: "Workspaces" })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/\d of \d/);
  });

  it("shows the position among many workspaces and goes to one", async () => {
    useLayoutStore.setState({ layout: withWorkspaces(["Alpha", "Beta", "Gamma"]) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await userEvent.click(page.getByRole("button", { name: "Go to Alpha" }));
    const layout = useLayoutStore.getState().layout;
    expect(layout.workspaces.find((w) => w.id === layout.focusedWorkspaceId)?.name).toBe("Alpha");
    await expect.element(page.getByText(/1 of \d/)).toBeVisible();
  });

  it("keeps a long name inside its trigger", async () => {
    const long = "A workspace named for a very long migration of the billing platform ".repeat(2).trim();
    useLayoutStore.setState({ layout: withWorkspaces([long.slice(0, 120)]) });
    await using screen = await render(
      <div style={{ width: 220 }}>
        <WorkspaceSwitcher />
      </div>,
    );
    const trigger = screen.container.querySelector<HTMLElement>("[data-layout-workspace-switcher]")!;
    expect(trigger.scrollWidth).toBeLessThanOrEqual(220);
    expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(220);
  });

  it("lists an empty workspace as empty", async () => {
    await using _screen = await render(<WorkspaceSwitcher />);
    await expect.element(page.getByText("Empty workspace")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await expect.element(page.getByText("Empty", { exact: true })).toBeVisible();
  });

  it("refuses to delete the last workspace and says why", async () => {
    useLayoutStore.setState({ layout: openLayoutTab(createLayoutState(), chat("only")) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await userEvent.click(page.getByRole("button", { name: /^Delete / }));
    await expect.element(page.getByText(/is the last workspace \(1 of 1\)/)).toBeVisible();
    expect(useLayoutStore.getState().layout.workspaces.some((w) => w.columns.length > 0)).toBe(true);
  });

  it("renames with Enter and refuses a name over the limit", async () => {
    useLayoutStore.setState({ layout: withWorkspaces(["Alpha", "Beta"]) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await userEvent.click(page.getByRole("button", { name: "Rename Alpha" }));
    const field = page.getByRole("textbox", { name: "Rename Alpha" });
    await userEvent.fill(field, "x".repeat(121));
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("A workspace name is at most 120 characters; got 121.")).toBeVisible();
    await userEvent.fill(field, "Inbox");
    await userEvent.keyboard("{Enter}");
    expect(names()).toContain("Inbox");
  });

  it("reorders, and deletes after a confirmation", async () => {
    useLayoutStore.setState({ layout: withWorkspaces(["Alpha", "Beta"]) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await userEvent.click(page.getByRole("button", { name: "Move Alpha down" }));
    expect(names()).toEqual(["Beta", "Alpha"]);
    await userEvent.click(page.getByRole("button", { name: "Delete Beta" }));
    expect(names()).toEqual(["Beta", "Alpha"]);
    await userEvent.click(page.getByRole("button", { name: "Delete", exact: true }));
    expect(names()).toEqual(["Alpha"]);
  });

  it("creates a workspace by name", async () => {
    useLayoutStore.setState({ layout: openLayoutTab(createLayoutState(), chat("one")) });
    await using _screen = await render(<WorkspaceSwitcher />);
    await userEvent.click(page.getByRole("button", { name: "Workspaces" }));
    await userEvent.click(page.getByRole("button", { name: "New workspace" }));
    await userEvent.fill(page.getByRole("textbox", { name: "New workspace name" }), "Research");
    await userEvent.keyboard("{Enter}");
    const layout = useLayoutStore.getState().layout;
    expect(layout.workspaces.find((w) => w.id === layout.focusedWorkspaceId)?.name).toBe("Research");
  });

  it("hides the title at a narrow width and keeps an accessible name", async () => {
    useLayoutStore.setState({ layout: withWorkspaces(["Alpha", "Beta"]) });
    await using screen = await render(
      <div style={{ width: 120 }}>
        <WorkspaceSwitcher />
      </div>,
    );
    const trigger = screen.container.querySelector<HTMLElement>("[data-layout-workspace-switcher]")!;
    expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(120);
    await expect.element(page.getByRole("button", { name: "Workspaces" })).toBeVisible();
  });
});
