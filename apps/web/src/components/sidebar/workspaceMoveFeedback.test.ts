import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as commands from "../../layout/threadWorkspaceCommands";
import { toastManager } from "../ui/toast";
import { moveThreadToWorkspaceWithFeedback } from "./workspaceMoveFeedback";

const thread = { environmentId: "env-1", threadId: "t1" };
const base = {
  thread,
  threadTitle: "Fix the build",
  nameOf: (id: string) => (id === "ws-a" ? "Alpha" : id),
  onOpenTarget: () => {},
};

let toasts: Array<{ type?: string; title?: string; description?: string }>;

beforeEach(() => {
  toasts = [];
  vi.spyOn(toastManager, "add").mockImplementation(((toast: (typeof toasts)[number]) => {
    toasts.push(toast);
    return "id";
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("moveThreadToWorkspaceWithFeedback for a drop", () => {
  it("case 1: moves the thread and toasts the destination with the way back", async () => {
    const move = vi.spyOn(commands, "moveThreadToWorkspaceOnServer").mockResolvedValue({
      membership: { ...thread, workspaceId: "ws-b", parentThreadId: null },
      previous: { workspaceId: "ws-a", paneId: "p1", index: 0 },
    } as never);
    const moved = await moveThreadToWorkspaceWithFeedback({
      ...base,
      target: { workspaceId: "ws-b", name: "Beta" },
    });
    expect(moved).toBe(true);
    expect(move).toHaveBeenCalledWith({ thread, workspaceId: "ws-b" });
    expect(toasts[0]).toMatchObject({ type: "success", title: "Moved to “Beta”" });
    expect(JSON.stringify(toasts[0])).toContain("Undo");
  });

  it("case 5: creates a workspace first and moves the thread into it", async () => {
    vi.spyOn(commands, "createEmptyWorkspaceOnServer").mockResolvedValue({
      id: "ws-new",
      name: "Workspace 3",
    });
    const move = vi.spyOn(commands, "moveThreadToWorkspaceOnServer").mockResolvedValue({
      membership: { ...thread, workspaceId: "ws-new", parentThreadId: null },
      previous: { workspaceId: "ws-a", paneId: null, index: null },
    } as never);
    await moveThreadToWorkspaceWithFeedback({ ...base, target: "new-workspace" });
    expect(move).toHaveBeenCalledWith({ thread, workspaceId: "ws-new" });
    expect(toasts[0]).toMatchObject({ title: "Moved to “Workspace 3”" });
  });

  it("case 18: a refused move names the workspace, reports false and shows no success", async () => {
    vi.spyOn(commands, "moveThreadToWorkspaceOnServer").mockRejectedValue(
      new Error("no workspace 'ws-gone'"),
    );
    const moved = await moveThreadToWorkspaceWithFeedback({
      ...base,
      target: { workspaceId: "ws-gone", name: "Gone" },
    });
    expect(moved).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: "error", description: "no workspace 'ws-gone'" });
  });

  it("a move the window already made toasts without moving again, and Undo moves back to the old pane", async () => {
    const move = vi.spyOn(commands, "moveThreadToWorkspaceOnServer").mockResolvedValue({
      membership: { ...thread, workspaceId: "ws-a", parentThreadId: null },
      previous: { workspaceId: "ws-b", paneId: null, index: null },
    } as never);
    const moved = await moveThreadToWorkspaceWithFeedback({
      ...base,
      target: { workspaceId: "ws-b", name: "Beta" },
      placed: { previous: { workspaceId: "ws-a", paneId: "p1", index: 2 } },
    });
    expect(moved).toBe(true);
    expect(move).not.toHaveBeenCalled();
    expect(toasts[0]).toMatchObject({ type: "success", title: "Moved to “Beta”" });
    const actions = (
      toasts[0] as unknown as {
        data: {
          additionalActions: Array<{ id: string; props: { onClick: () => void } }>;
        };
      }
    ).data.additionalActions;
    actions.find((action) => action.id === "undo")!.props.onClick();
    expect(move).toHaveBeenCalledWith({ thread, workspaceId: "ws-a", paneId: "p1", index: 2 });
  });
});
