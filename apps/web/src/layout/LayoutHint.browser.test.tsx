import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import { LayoutHints } from "./LayoutHint";
import {
  createLayoutState,
  focusLayoutWorkspace,
  normalizeLayout,
  openLayoutTab,
  renameLayoutWorkspace,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { createLayoutWorkspaceNamed } from "./layoutWorkspaces";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("t"));
const chat = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
});

function withWorkspaces(names: readonly string[]): LayoutState {
  let state = createLayoutState();
  names.forEach((name, index) => {
    state = openLayoutTab(state, chat(`thread-${index}`));
    state = renameLayoutWorkspace(state, state.focusedWorkspaceId, name);
    state = createLayoutWorkspaceNamed(state, "").state;
  });
  return focusLayoutWorkspace(normalizeLayout(state), state.workspaces[0]!.id);
}

const Host = () => (
  <div style={{ position: "relative", width: 480, height: 240 }}>
    <LayoutHints resolveThreadTitle={() => "Billing migration"} />
  </div>
);

/** Puts the stores in a known state for one test and restores them when the test ends. */
function openSession(): Disposable {
  useLayoutStore.getState().reset();
  useLayoutStore.setState({ hint: null });
  return {
    [Symbol.dispose]() {
      useLayoutStore.getState().reset();
    },
  };
}

describe("LayoutHints", () => {
  it("shows a column hint and clears it after its one-shot fade", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    useLayoutStore.getState().showHint({ kind: "column", index: 1, count: 4, command: null });
    await expect.element(page.getByText("Column 2 of 4")).toBeVisible();
    await expect.poll(() => useLayoutStore.getState().hint, { timeout: 5000 }).toBeNull();
    expect(page.getByText("Column 2 of 4").elements()).toHaveLength(0);
  });

  it("names a workspace a pane was sent to, with its place in the stack", async () => {
    using _session = openSession();
    const layout = withWorkspaces(["Research", "Review"]);
    useLayoutStore.setState({ layout });
    await using _screen = await render(<Host />);
    useLayoutStore.getState().showHint({
      kind: "workspace",
      workspaceId: layout.workspaces[0]!.id,
      index: 0,
      count: 2,
      command: null,
    });
    await expect.element(page.getByText("Research · workspace 1 of 2")).toBeVisible();
  });

  it("names the workspace a switch landed on", async () => {
    using _session = openSession();
    useLayoutStore.setState({ layout: withWorkspaces(["Research", "Review"]) });
    await using _screen = await render(<Host />);
    useLayoutStore.getState().focusWorkspaceStep(1);
    await expect.element(page.getByText("Review", { exact: true })).toBeVisible();
  });

  it("says nothing on a switch when there is only one workspace", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    useLayoutStore.getState().focusWorkspaceStep(1);
    expect(useLayoutStore.getState().hint).toBeNull();
  });

  it("titles the terminal hint from the caller's resolver", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    useLayoutStore.getState().showHint({ kind: "terminal", threadRef });
    await expect.element(page.getByText("Terminal for Billing migration")).toBeVisible();
  });

  it("fades with a transition that reduced motion turns off", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    useLayoutStore.getState().showHint({ kind: "column", index: 0, count: 2, command: null });
    await expect.element(page.getByText("Column 1 of 2")).toBeVisible();
    const pill = page.getByText("Column 1 of 2").element().closest("[data-layout-hint]")!;
    expect(pill.className).toContain("motion-reduce:transition-none");
  });
});
