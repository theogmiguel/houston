import "~/index.css";
import { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryServerKeybindingsAtom: Atom.make([]) } as never;
});

import { render } from "../../../test/render";
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { useRightPanelStore } from "../../rightPanelStore";
import type { GridRecord } from "../../grid/gridStore";
import { threadLeaf } from "../../grid/tree";
import { GridTopBarControls } from "./GridTopBarControls";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function grid(overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "g-1",
    name: "Review",
    environmentId,
    projectId,
    workspaceKey: "env-1:project-1",
    tree: null,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A viewport for one test, restoring the previous size on dispose. */
async function viewport(width: number, height = 900): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height) };
}

function visibility(threadId: string) {
  return useRightPanelStore.getState().threadPanelVisibilityByThreadKey[
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)))
  ];
}

it("toggles the details card for an empty grid's draft, which has no tree leaf yet", async () => {
  await using _viewport = await viewport(1440);
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  await using _screen = await render(
    <GridTopBarControls grid={grid()} emptyDraftThreadId="thread-draft" />,
    { router: false },
  );

  const toggle = _screen.getByRole("button", { name: "Toggle thread details panel" });
  expect(visibility("thread-draft")).toBeUndefined();

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  expect(visibility("thread-draft")).toEqual({ inlineOpen: true, popoverOpen: true });

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  expect(visibility("thread-draft")).toEqual({ inlineOpen: false, popoverOpen: false });
});

it("leaves the details toggle to the pane header when the grid has cells", async () => {
  await using _viewport = await viewport(1440);
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  await using screen = await render(
    <GridTopBarControls
      grid={grid({
        tree: threadLeaf("thread-a", "p1"),
        focusedThreadId: "thread-a",
      })}
    />,
    { router: false },
  );

  expect(screen.container.querySelector('[aria-label="Toggle thread details panel"]')).toBeNull();
});

it("keeps details, grid layout, terminal and right panel in the strip, in that order, while the panel is open", async () => {
  await using _viewport = await viewport(1440);
  const ref = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
  useRightPanelStore.getState().toggleVisibility(ref);
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.isOpen).toBe(true);
  await using screen = await render(
    <GridTopBarControls
      grid={grid({ tree: threadLeaf("thread-a", "p1"), focusedThreadId: "thread-a" })}
    />,
    { router: false },
  );

  const controls = screen.container.querySelector("[data-panel-layout-controls]") as HTMLElement;
  const labels = [...controls.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label !== null);
  expect(labels).toEqual([
    "Tidy panes",
    "Choose tidy layout",
    "Toggle terminal drawer",
    "Toggle right panel",
  ]);
  await expect
    .element(screen.getByRole("button", { name: "Toggle right panel" }))
    .toHaveAttribute("aria-pressed", "true");
});

it("moves the terminal and the tidy layouts into the More menu at 800px", async () => {
  await using _viewport = await viewport(800);
  await using screen = await render(
    <GridTopBarControls
      grid={grid({
        tree: {
          kind: "split",
          dir: "row",
          children: [threadLeaf("thread-a", "p1"), threadLeaf("thread-b", "p2")],
          weights: [1, 1],
        },
        focusedThreadId: "thread-a",
      })}
    />,
    { router: false },
  );

  const controls = screen.container.querySelector("[data-panel-layout-controls]") as HTMLElement;
  const labels = [...controls.querySelectorAll("button")].map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(labels).toEqual(["More layout controls", "Toggle right panel"]);

  await screen.getByRole("button", { name: "More layout controls" }).click();
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Toggle terminal drawer" }))
    .toBeVisible();
  expect(page.getByRole("menuitemcheckbox", { name: "Toggle thread details" }).query()).toBeNull();
  for (const name of ["Balanced grid", "One row", "One column"]) {
    await expect.element(page.getByRole("menuitem", { name })).toBeVisible();
  }
});
