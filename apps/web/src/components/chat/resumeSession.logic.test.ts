import { ProviderInstanceId, ThreadId } from "@houston-app/contracts";
import type { HoustonResumeSession } from "@houston-app/contracts/houston/resumeSessions";
import { describe, expect, it } from "vite-plus/test";

import {
  planResumeSelection,
  resumeSessionLocation,
  resumeSessionRows,
  resumeSessionStatusLabel,
  resumeSessionTitle,
} from "./resumeSession.logic";

const instanceId = ProviderInstanceId.make("claudeAgent");

function session(overrides: Partial<HoustonResumeSession> = {}): HoustonResumeSession {
  return {
    session: {
      provider: "claudeAgent",
      providerInstanceId: instanceId,
      providerSessionId: "session-1",
      filePath: "/home/me/.claude/projects/-repo/session-1.jsonl",
      size: 100,
      mtimeMs: 1,
      device: 1,
      inode: 1,
      birthtimeMs: 1,
    },
    provider: "claudeAgent",
    providerInstanceId: instanceId,
    providerSessionId: "session-1",
    title: "Fix the login",
    firstPrompt: "Fix the login flow",
    folder: "/repo",
    branch: "main",
    lastActiveAt: "2026-11-03T12:00:00.000Z",
    threadId: null,
    live: false,
    mayBeRunningElsewhere: false,
    ...overrides,
  };
}

describe("resumeSessionRows", () => {
  it("collapses a repeated session and keeps the newest copy", () => {
    const older = session({ lastActiveAt: "2026-11-01T12:00:00.000Z", branch: "old" });
    const newer = session({ lastActiveAt: "2026-11-03T12:00:00.000Z", branch: "new" });
    expect(resumeSessionRows([older, newer])).toEqual([newer]);
  });

  it("sorts sessions newest first", () => {
    const first = session({
      providerSessionId: "first",
      lastActiveAt: "2026-11-01T12:00:00.000Z",
    });
    const second = session({
      providerSessionId: "second",
      lastActiveAt: "2026-11-03T12:00:00.000Z",
    });
    expect(resumeSessionRows([first, second]).map((row) => row.providerSessionId)).toEqual([
      "second",
      "first",
    ]);
  });
});

describe("resumeSessionTitle", () => {
  it("prefers the saved title over the first prompt", () => {
    expect(resumeSessionTitle(session())).toBe("Fix the login");
  });

  it("falls back to the first line of the first prompt", () => {
    expect(resumeSessionTitle(session({ title: null }))).toBe("Fix the login flow");
  });

  it("names a session with no text", () => {
    expect(resumeSessionTitle(session({ title: null, firstPrompt: null }))).toBe(
      "Untitled session",
    );
  });
});

describe("resumeSessionLocation", () => {
  it("names the project root and its branch", () => {
    expect(resumeSessionLocation(session(), "/repo")).toBe("Project root · main");
  });

  it("names a worktree folder and its branch", () => {
    expect(
      resumeSessionLocation(
        session({ folder: "/repo/.houston/worktrees/c5", branch: "v2-c5" }),
        "/repo",
      ),
    ).toBe("c5 · v2-c5");
  });

  it("uses the folder when the branch is unknown", () => {
    expect(
      resumeSessionLocation(
        session({ folder: "/repo/.houston/worktrees/c5", branch: null }),
        "/repo",
      ),
    ).toBe("c5");
  });
});

describe("planResumeSelection", () => {
  it("opens the thread that already owns the session", () => {
    const threadId = ThreadId.make("thread-1");
    expect(planResumeSelection(session({ threadId, live: true }))).toEqual({
      action: "open",
      threadId,
    });
  });

  it("asks before resuming a session another CLI may hold", () => {
    expect(planResumeSelection(session({ mayBeRunningElsewhere: true }))).toEqual({
      action: "confirm",
    });
  });

  it("imports an unowned session directly", () => {
    expect(planResumeSelection(session())).toEqual({ action: "import" });
  });
});

describe("resumeSessionStatusLabel", () => {
  it("labels the thread states it can report", () => {
    expect(resumeSessionStatusLabel(session({ threadId: ThreadId.make("t"), live: true }))).toBe(
      "Running",
    );
    expect(resumeSessionStatusLabel(session({ threadId: ThreadId.make("t") }))).toBe("Open thread");
    expect(resumeSessionStatusLabel(session({ mayBeRunningElsewhere: true }))).toBe(
      "May be running",
    );
    expect(resumeSessionStatusLabel(session())).toBeNull();
  });
});
