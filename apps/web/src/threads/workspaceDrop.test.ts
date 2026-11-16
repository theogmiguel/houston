import { describe, expect, it } from "vite-plus/test";

import {
  DRAG_AUTO_SCROLL_BAND_PX,
  DRAG_AUTO_SCROLL_MAX_STEP_PX,
  NEW_WORKSPACE_DROP,
  WORKSPACE_SPRING_LOAD_MS,
  dragAutoScrollStep,
  isThreadDraggable,
  resolveWorkspaceDrop,
} from "./workspaceDrop";
import type { TabDragSource, ThreadDragSource } from "./threadDrag";

const card = (workspaceId: string | null = "ws-a"): ThreadDragSource => ({
  workspaceId,
  threadId: "t1",
  environmentId: "env-1",
  projectId: "p1",
  title: "Fix the build",
});

const chatTab = (workspaceId = "ws-a"): TabDragSource => ({
  tabId: "tab-1",
  workspaceId,
  thread: { environmentId: "env-1", threadId: "t1" },
  title: "Fix the build",
});

const pageTab = (workspaceId = "ws-a"): TabDragSource => ({
  tabId: "tab-2",
  workspaceId,
  thread: null,
  title: null,
});

describe("resolveWorkspaceDrop", () => {
  it("case 1: a card dropped on another workspace moves its thread there", () => {
    expect(resolveWorkspaceDrop(card("ws-a"), "ws-b")).toEqual({
      kind: "move-thread",
      thread: { environmentId: "env-1", threadId: "t1" },
      title: "Fix the build",
      target: "ws-b",
    });
  });

  it("case 2: a card dropped on its own workspace does nothing", () => {
    expect(resolveWorkspaceDrop(card("ws-a"), "ws-a")).toEqual({ kind: "none" });
  });

  it("case 5: a card dropped on the new-workspace zone moves its thread to a new workspace", () => {
    expect(resolveWorkspaceDrop(card("ws-a"), NEW_WORKSPACE_DROP)).toMatchObject({
      kind: "move-thread",
      target: NEW_WORKSPACE_DROP,
    });
  });

  it("case 6: a chat tab dropped on another workspace moves its thread through the same operation", () => {
    expect(resolveWorkspaceDrop(chatTab("ws-a"), "ws-b")).toEqual({
      kind: "move-thread",
      thread: { environmentId: "env-1", threadId: "t1" },
      title: "Fix the build",
      target: "ws-b",
    });
  });

  it("case 7: a tab dropped on its own workspace does nothing", () => {
    expect(resolveWorkspaceDrop(chatTab("ws-a"), "ws-a")).toEqual({ kind: "none" });
    expect(resolveWorkspaceDrop(pageTab("ws-a"), "ws-a")).toEqual({ kind: "none" });
  });

  it("case 9: a tab dropped on the new-workspace zone creates a workspace even from a lone workspace", () => {
    expect(resolveWorkspaceDrop(chatTab("ws-a"), NEW_WORKSPACE_DROP)).toMatchObject({
      kind: "move-thread",
      target: NEW_WORKSPACE_DROP,
    });
    expect(resolveWorkspaceDrop(pageTab("ws-a"), NEW_WORKSPACE_DROP)).toEqual({
      kind: "move-tab",
      tabId: "tab-2",
      target: NEW_WORKSPACE_DROP,
    });
  });

  it("case 13 and 20: a tab with no server thread moves as a tab", () => {
    expect(resolveWorkspaceDrop(pageTab("ws-a"), "ws-b")).toEqual({
      kind: "move-tab",
      tabId: "tab-2",
      target: "ws-b",
    });
  });

  it("moves a shelf card, which sits in no workspace, to any workspace", () => {
    expect(resolveWorkspaceDrop(card(null), "ws-b")).toMatchObject({ kind: "move-thread" });
  });
});

describe("isThreadDraggable", () => {
  const listed = { archivedAt: null, lineage: { relationshipToParent: null } };

  it("case 19: lets a listed root thread be dragged", () => {
    expect(isThreadDraggable(listed, undefined)).toBe(true);
    expect(isThreadDraggable(listed, { parentThreadId: null })).toBe(true);
  });

  it("case 19: refuses a child, an archived thread and a side thread", () => {
    expect(isThreadDraggable(listed, { parentThreadId: "parent" })).toBe(false);
    expect(
      isThreadDraggable(
        { archivedAt: null, lineage: { relationshipToParent: "subagent" } },
        undefined,
      ),
    ).toBe(false);
    expect(
      isThreadDraggable({ ...listed, archivedAt: "2026-01-01T00:00:00.000Z" }, undefined),
    ).toBe(false);
    expect(isThreadDraggable({ ...listed, side: {} }, undefined)).toBe(false);
    expect(isThreadDraggable({ ...listed, lineage: { sideChat: true } }, undefined)).toBe(false);
  });
});

describe("dragAutoScrollStep", () => {
  const rect = { top: 100, bottom: 500 };

  it("case 16: scrolls up near the top edge, faster closer to it", () => {
    const near = dragAutoScrollStep(100 + DRAG_AUTO_SCROLL_BAND_PX - 1, rect);
    const edge = dragAutoScrollStep(100, rect);
    expect(near).toBeLessThan(0);
    expect(edge).toBe(-DRAG_AUTO_SCROLL_MAX_STEP_PX);
    expect(edge).toBeLessThan(near);
  });

  it("case 16: scrolls down near the bottom edge", () => {
    expect(dragAutoScrollStep(500, rect)).toBe(DRAG_AUTO_SCROLL_MAX_STEP_PX);
    expect(dragAutoScrollStep(500 - DRAG_AUTO_SCROLL_BAND_PX + 1, rect)).toBeGreaterThan(0);
  });

  it("does not scroll in the middle or outside the list", () => {
    expect(dragAutoScrollStep(300, rect)).toBe(0);
    expect(dragAutoScrollStep(50, rect)).toBe(0);
    expect(dragAutoScrollStep(600, rect)).toBe(0);
  });
});

describe("spring load", () => {
  it("case 8: waits a named, positive delay", () => {
    expect(WORKSPACE_SPRING_LOAD_MS).toBeGreaterThan(0);
  });
});
