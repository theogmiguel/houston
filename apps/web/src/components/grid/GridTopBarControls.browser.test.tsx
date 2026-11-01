import "~/index.css";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryServerKeybindingsAtom: Atom.make([]) } as never;
});

import { render } from "../../../test/render";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
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

function visibility(threadId: string) {
  return useRightPanelStore.getState().threadPanelVisibilityByThreadKey[
    scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)))
  ];
}

it("toggles the details card for an empty grid's draft, which has no tree leaf yet", async () => {
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

it("toggles the focused cell's details card", async () => {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  await using _screen = await render(
    <GridTopBarControls
      grid={grid({
        tree: threadLeaf("thread-a", "p1"),
        focusedThreadId: "thread-a",
      })}
    />,
    { router: false },
  );

  const toggle = _screen.getByRole("button", { name: "Toggle thread details panel" });
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  expect(visibility("thread-a")).toEqual({ inlineOpen: true, popoverOpen: true });
});
