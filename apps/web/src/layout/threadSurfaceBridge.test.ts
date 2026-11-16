import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  publishThreadChatBridge,
  useThreadChatBridgeStore,
  waitForThreadChatSendReady,
  type ThreadChatBridge,
} from "./threadSurfaceBridge";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-2"));

function bridge(sendReady: boolean): ThreadChatBridge {
  return {
    workspaceMutationId: null,
    sendReady,
    sendAnnotation: () => {},
    addTerminalContext: () => {},
    terminalLaunchContext: null,
    composerDraftTarget: threadRef,
    getShortcutContext: () => ({}) as ReturnType<ThreadChatBridge["getShortcutContext"]>,
    sideChatParentPanel: { openToolDiff: () => {}, runShellCommand: () => {} },
    linkedPullRequest: null,
  };
}

afterEach(() => {
  useThreadChatBridgeStore.setState({ byThreadKey: {} });
  vi.useRealTimers();
});

describe("thread chat bridge", () => {
  it("publishes per thread and unpublishes only its own bridge", () => {
    const first = bridge(true);
    const unpublishFirst = publishThreadChatBridge(threadRef, first);
    const second = bridge(true);
    const unpublishSecond = publishThreadChatBridge(threadRef, second);
    // A chat that remounted already replaced the first bridge; the old unpublish must not drop it.
    unpublishFirst();
    expect(Object.values(useThreadChatBridgeStore.getState().byThreadKey)).toEqual([second]);
    unpublishSecond();
    expect(useThreadChatBridgeStore.getState().byThreadKey).toEqual({});
  });

  it("resolves at once when the chat can already send", async () => {
    const ready = bridge(true);
    publishThreadChatBridge(threadRef, ready);
    await expect(waitForThreadChatSendReady(threadRef, 1000)).resolves.toBe(ready);
  });

  it("waits for a busy chat to become ready", async () => {
    publishThreadChatBridge(threadRef, bridge(false));
    const waiting = waitForThreadChatSendReady(threadRef, 1000);
    const ready = bridge(true);
    publishThreadChatBridge(threadRef, ready);
    await expect(waiting).resolves.toBe(ready);
  });

  it("gives up with null after the timeout when no chat of that thread is ready", async () => {
    vi.useFakeTimers();
    publishThreadChatBridge(otherRef, bridge(true));
    const waiting = waitForThreadChatSendReady(threadRef, 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).resolves.toBeNull();
  });
});
