import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import { buildLayout } from "./layoutFixtures";
import {
  findLayoutTabByContent,
  openLayoutTab,
  selectFocusedTab,
  type LayoutTabContent,
} from "./layoutModel";
import { setThreadMemberships } from "./threadMembership";
import { showRouteInLayout } from "./useLayoutRouteSync";

const chat = (threadId: string): LayoutTabContent => ({
  kind: "chat",
  target: {
    kind: "server",
    threadRef: scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(threadId)),
  },
});

const belongsTo = (threadId: string, workspaceId: string) =>
  setThreadMemberships(
    [{ environmentId: "local", threadId, workspaceId, parentThreadId: null }],
    true,
  );

afterEach(() => setThreadMemberships([], false));

describe("showRouteInLayout", () => {
  it("opens a thread with no tab in the workspace it belongs to and focuses that workspace", () => {
    belongsTo("t-b", "w1");
    const layout = buildLayout([[[["a"]]], [[["b"]]]]);
    const shown = showRouteInLayout(layout, chat("t-b"), null, null);
    expect(shown.focusedWorkspaceId).toBe("w1");
    expect(findLayoutTabByContent(shown, chat("t-b"))).not.toBeNull();
    const inFirst = shown.workspaces[0]!.columns.flatMap((column) =>
      column.panes.flatMap((pane) => pane.tabs),
    );
    expect(inFirst.map((tab) => tab.id)).toEqual(["a"]);
  });

  it("keeps the focused workspace for a thread that belongs to it", () => {
    belongsTo("t-a", "w0");
    const shown = showRouteInLayout(buildLayout([[[["a"]]], [[["b"]]]]), chat("t-a"), null, null);
    expect(shown.focusedWorkspaceId).toBe("w0");
  });

  it("focuses the tab a thread already has instead of moving it", () => {
    belongsTo("b", "w1");
    const shown = showRouteInLayout(buildLayout([[[["a"]]], [[["b"]]]]), chat("b"), null, null);
    expect(shown.focusedWorkspaceId).toBe("w1");
    expect(selectFocusedTab(shown)?.id).toBe("b");
  });

  it("opens a thread whose membership has not arrived in the focused workspace", () => {
    const shown = showRouteInLayout(buildLayout([[[["a"]]], [[["b"]]]]), chat("late"), null, null);
    expect(shown.focusedWorkspaceId).toBe("w0");
  });

  it("opens a new draft in the workspace the request names, even with no columns", () => {
    const draft: LayoutTabContent = {
      kind: "chat",
      target: { kind: "draft", draftId: DraftId.make("draft-1") },
    };
    const shown = showRouteInLayout(buildLayout([[[["a"]]], []]), draft, null, {
      workspaceId: "w1",
    });
    expect(shown.focusedWorkspaceId).toBe("w1");
    const opened = findLayoutTabByContent(shown, draft);
    expect(opened?.workspace.id).toBe("w1");
    expect(shown.workspaces[1]!.columns).toHaveLength(1);
  });

  it("moves a draft's tab from another workspace into the requested one and focuses it", () => {
    const draft: LayoutTabContent = {
      kind: "chat",
      target: { kind: "draft", draftId: DraftId.make("draft-1") },
    };
    const layout = openLayoutTab(buildLayout([[[["a"]]], []]), draft);
    expect(findLayoutTabByContent(layout, draft)?.workspace.id).toBe("w0");

    const shown = showRouteInLayout(layout, draft, null, { workspaceId: "w1" });

    expect(findLayoutTabByContent(shown, draft)?.workspace.id).toBe("w1");
    expect(shown.focusedWorkspaceId).toBe("w1");
    expect(selectFocusedTab(shown)?.content).toEqual(draft);
    expect(
      shown.workspaces[0]!.columns.flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs)
        .map((tab) => tab.content),
    ).not.toContainEqual(draft);
  });
});
