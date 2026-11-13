import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  chatHoldsLiveWork,
  queueChatRender,
  registerWaitingChat,
  renderWaitingChatNow,
} from "./chatRenderGate";

const shells = vi.hoisted(() => ({ current: null as unknown }));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: () => shells.current as never,
}));

const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));
const target: ThreadRouteTarget = { kind: "server", threadRef: ref };

/** Resets what a test sets (the thread shell, the submitting sends) when the test ends. */
function openSession(): Disposable {
  return {
    [Symbol.dispose]() {
      shells.current = null;
      useComposerDraftStore.setState({ backgroundSubmissionThreadKeys: {} });
    },
  };
}

describe("queueChatRender", () => {
  it("runs the focused chat before the ones already waiting, and a later one last", async () => {
    const ran: string[] = [];
    using stack = new DisposableStack();
    stack.defer(queueChatRender(() => ran.push("later"), "later"));
    stack.defer(queueChatRender(() => ran.push("normal"), "normal"));
    stack.defer(queueChatRender(() => ran.push("focused"), "focused"));
    await expect.poll(() => ran.length, { timeout: 5000 }).toBe(3);
    expect(ran).toEqual(["focused", "normal", "later"]);
  });

  it("never runs a turn that left the queue", async () => {
    const ran: string[] = [];
    const leave = queueChatRender(() => ran.push("left"), "normal");
    const stay = queueChatRender(() => ran.push("stayed"), "normal");
    leave();
    await expect.poll(() => ran).toEqual(["stayed"]);
    stay();
  });
});

describe("renderWaitingChatNow", () => {
  it("renders a waiting chat synchronously once, and reports there was none after", () => {
    const render = vi.fn();
    const stop = registerWaitingChat("tab", render);
    expect(renderWaitingChatNow("tab")).toBe(true);
    expect(render).toHaveBeenCalledOnce();
    expect(renderWaitingChatNow("tab")).toBe(false);
    expect(renderWaitingChatNow(null)).toBe(false);
    stop();
  });
});

describe("chatHoldsLiveWork", () => {
  it("holds a chat with a turn in flight, an approval or a question waiting", () => {
    using _session = openSession();
    for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
      shells.current = {
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        runtime: { status },
      };
      expect(chatHoldsLiveWork(target), status).toBe(true);
    }
    shells.current = { hasPendingApprovals: true, hasPendingUserInput: false, runtime: null };
    expect(chatHoldsLiveWork(target)).toBe(true);
    shells.current = { hasPendingApprovals: false, hasPendingUserInput: true, runtime: null };
    expect(chatHoldsLiveWork(target)).toBe(true);
  });

  it("holds a chat whose send is still submitting", () => {
    using _session = openSession();
    useComposerDraftStore.setState({
      backgroundSubmissionThreadKeys: { [scopedThreadKey(ref)]: true },
    });
    expect(chatHoldsLiveWork(target)).toBe(true);
  });

  it("releases an idle chat, a finished one and a thread nothing knows", () => {
    using _session = openSession();
    shells.current = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: { status: "completed" },
    };
    expect(chatHoldsLiveWork(target)).toBe(false);
    shells.current = null;
    expect(chatHoldsLiveWork(target)).toBe(false);
  });

  it("releases a draft whose session is gone", () => {
    using _session = openSession();
    expect(chatHoldsLiveWork({ kind: "draft", draftId: "missing" as never })).toBe(false);
  });
});
