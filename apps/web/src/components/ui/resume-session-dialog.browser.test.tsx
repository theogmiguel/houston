import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@houston-app/contracts";
import type { HoustonResumeSession } from "@houston-app/contracts/houston/resumeSessions";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadOpenProvider } from "../../threads/threadOpenContext";
import type { ThreadOpenIntent } from "../../threads/threadOpenContext";
import { ResumeSessionDialog } from "./resume-session-dialog";

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");

function session(overrides: Partial<HoustonResumeSession> = {}): HoustonResumeSession {
  return {
    session: {
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent" as never,
      providerSessionId: "session-1",
      filePath: "/home/me/.claude/projects/-repo/session-1.jsonl",
      size: 100,
      mtimeMs: 1,
      device: 1,
      inode: 1,
      birthtimeMs: 1,
    },
    provider: "claudeAgent",
    providerInstanceId: "claudeAgent" as never,
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

const state = vi.hoisted(() => ({
  sessions: [] as ReadonlyArray<HoustonResumeSession>,
  openSession: vi.fn(),
}));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { sessions: state.sessions, scannedAt: "2026-11-03T12:00:00.000Z" },
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("~/state/resumeSessions"), async (original) => ({
  ...(await original()),
  houstonResumeSessions: (() => "sessions-atom" as never) as never,
  houstonOpenResumeSession: "open-session" as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: string) =>
    command === "open-session" ? state.openSession : vi.fn()) as never,
}));

function renderDialog(openThread: (ref: ScopedThreadRef, intent?: ThreadOpenIntent) => void) {
  return render(
    <ThreadOpenProvider open={openThread}>
      <ResumeSessionDialog
        open
        onOpenChange={() => {}}
        environmentId={environmentId}
        projectId={projectId}
        projectWorkspaceRoot="/repo"
      />
    </ThreadOpenProvider>,
  );
}

describe("ResumeSessionDialog", () => {
  it("opens the thread that already owns a session without importing it", async () => {
    const threadId = ThreadId.make("owned-thread");
    state.sessions = [session({ threadId, live: true })];
    const openThread = vi.fn();
    state.openSession.mockReset();
    await using _screen = await renderDialog(openThread);

    await userEvent.click(page.getByText("Fix the login"));

    // `join` gives the thread its own grid cell instead of replacing the cell that resumed it.
    expect(openThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, threadId }),
      "join",
    );
    expect(state.openSession).not.toHaveBeenCalled();
  });

  it("imports an unowned session and opens the returned thread", async () => {
    const threadId = ThreadId.make("imported-thread");
    state.sessions = [session()];
    const openThread = vi.fn();
    state.openSession.mockReset();
    state.openSession.mockResolvedValue({ _tag: "Success", value: { threadId } });
    await using _screen = await renderDialog(openThread);

    await userEvent.click(page.getByText("Fix the login"));

    expect(state.openSession).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, session: state.sessions[0]?.session },
    });
    // `join` gives the thread its own grid cell instead of replacing the cell that resumed it.
    expect(openThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, threadId }),
      "join",
    );
  });
});
