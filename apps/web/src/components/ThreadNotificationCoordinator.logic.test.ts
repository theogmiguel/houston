import { WORKING_EXIT_GRACE_MS } from "@houston-app/client-runtime/state/thread-inbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  boundedWaitNoticeText,
  createThreadNotificationGate,
  createWaitingNoticeTracker,
  WAITING_NOTICE_REMINDER_MS,
  waitingRequestKind,
  type ThreadNotificationObservation,
  type WaitingNoticeRequest,
} from "./ThreadNotificationCoordinator.logic";

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("waitingRequestKind", () => {
  it("treats a user_input request as a question and other requests as approvals", () => {
    expect(waitingRequestKind(null)).toBeNull();
    expect(waitingRequestKind({ kind: "user_input" })).toBe("question");
    expect(waitingRequestKind({ kind: "command" })).toBe("approval");
    expect(waitingRequestKind({ kind: "auth_refresh" })).toBeNull();
  });
});

describe("boundedWaitNoticeText", () => {
  it("keeps one plain line and bounds its length", () => {
    expect(boundedWaitNoticeText("  Fix the\n\nbroken build  ")).toBe("Fix the broken build");
    expect(boundedWaitNoticeText("x".repeat(500))).toHaveLength(120);
    expect(boundedWaitNoticeText("   ")).toBe("Untitled thread");
  });
});

describe("createWaitingNoticeTracker", () => {
  const request = (
    key: string,
    existingOutcome: WaitingNoticeRequest["existingOutcome"] = "none",
  ): WaitingNoticeRequest => ({
    key,
    kind: "question",
    title: `Thread ${key}`,
    existingOutcome,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a new request once and reminds after thirty minutes", () => {
    const notify = vi.fn();
    const tracker = createWaitingNoticeTracker<string>(notify);
    tracker.sync([request("a")]);
    expect(notify.mock.calls).toEqual([
      [
        {
          key: "a",
          kind: "question",
          title: "Thread a",
          reminder: false,
          playSound: true,
        },
      ],
    ]);
    tracker.sync([request("a")]);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WAITING_NOTICE_REMINDER_MS - 1);
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls[1]).toEqual([
      {
        key: "a",
        kind: "question",
        title: "Thread a",
        reminder: true,
        playSound: true,
      },
    ]);
    expect(WAITING_NOTICE_REMINDER_MS).toBe(30 * 60_000);
  });

  it("leaves the initial notice to the existing input notice but still reminds", () => {
    const notify = vi.fn();
    const tracker = createWaitingNoticeTracker<string>(notify);
    tracker.sync([request("a", "announced")]);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WAITING_NOTICE_REMINDER_MS);
    expect(notify.mock.calls).toEqual([
      [
        {
          key: "a",
          kind: "question",
          title: "Thread a",
          reminder: true,
          playSound: true,
        },
      ],
    ]);
  });

  it("announces without a second sound when the mode already played one", () => {
    const notify = vi.fn();
    const tracker = createWaitingNoticeTracker<string>(notify);
    tracker.sync([request("a", "sound")]);
    expect(notify.mock.calls).toEqual([
      [
        {
          key: "a",
          kind: "question",
          title: "Thread a",
          reminder: false,
          playSound: false,
        },
      ],
    ]);
  });

  it("drops the reminder when the request resolves and clears on dispose", () => {
    const notify = vi.fn();
    const tracker = createWaitingNoticeTracker<string>(notify);
    tracker.sync([request("a"), request("b")]);
    notify.mockClear();
    tracker.sync([request("b")]);
    vi.advanceTimersByTime(WAITING_NOTICE_REMINDER_MS);
    expect(notify.mock.calls.map(([notice]) => notice.key)).toEqual(["b"]);
    tracker.clear();
    vi.advanceTimersByTime(WAITING_NOTICE_REMINDER_MS);
    expect(notify.mock.calls.map(([notice]) => notice.key)).toEqual(["b"]);
  });
});
