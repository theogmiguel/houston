import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@houston-app/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { useDiffPanelStore } from "../diffPanelStore";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { useRightPanelStore } from "../rightPanelStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
  draftIdByThread: null as string | null,
  failSettleWith: undefined as unknown,
  lastToast: undefined as unknown,
  closedToasts: [] as string[],
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { href: "/" }, matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      if (action === "settle" && state.failSettleWith !== undefined) {
        return AsyncResult.failure(Cause.fail(state.failSettleWith));
      }
      state.afterRequest?.(action);
      return AsyncResult.success(undefined);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (environmentId: string) =>
    state.sessionLookupFails
      ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
      : AsyncResult.success({
          authenticated: true,
          scopes: [...(state.scopes.get(environmentId) ?? [])],
          auth: { serverUpdateScope: "environment:maintain" },
        }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
      "resumeThreadQueue",
      "cancelQueuedRun",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
      getDraftIdByRef: () => state.draftIdByThread,
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
      state.lastToast = toast;
    },
    close: (id: string) => state.closedToasts.push(id),
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { queuedCloseRefusalToastId } from "../threads/queuedCloseRefusal";
import { useThreadActions } from "./useThreadActions";

function seedThreadPanelState(ref: ScopedThreadRef) {
  useRightPanelStore.getState().show(ref);
  useDiffPanelStore.getState().selectGitScope(ref, "branch");
  usePreviewMiniPlayerStore.getState().open(ref, browserMiniPlayerSource("tab"));
}

function threadPanelStatePresence(ref: ScopedThreadRef) {
  const key = scopedThreadKey(ref);
  return {
    rightPanel: key in useRightPanelStore.getState().byThreadKey,
    diffPanel: key in useDiffPanelStore.getState().byThreadKey,
    miniPlayer: key in usePreviewMiniPlayerStore.getState().byThreadKey,
  };
}
const panelStateKept = { rightPanel: true, diffPanel: true, miniPlayer: true };
const panelStateCleared = { rightPanel: false, diffPanel: false, miniPlayer: false };

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.closedToasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  state.draftIdByThread = null;
  state.failSettleWith = undefined;
  useRightPanelStore.setState(useRightPanelStore.getInitialState(), true);
  useDiffPanelStore.setState(useDiffPanelStore.getInitialState(), true);
  usePreviewMiniPlayerStore.setState(usePreviewMiniPlayerStore.getInitialState(), true);
});

describe("settling an unsent draft thread", () => {
  it("closes the draft without asking the server", async () => {
    state.threads = [];
    state.draftIdByThread = "draft-1";
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);

    const result = await useThreadActions().settleThread(target);

    expect(result._tag).toBe("Success");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual(["clear-draft"]);
    expect(state.toasts).toEqual([]);
  });
});

describe("closing a thread the server never created", () => {
  it("treats a settle refused for a missing projection as already closed", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.failSettleWith = {
      _tag: "OrchestrationV2DispatchCommandError",
      reason: "thread_not_found",
      message: `No orchestration projection exists for thread ${target.threadId}.`,
    };

    await useThreadActions().closeThread(target);

    expect(state.toasts).toEqual([]);
  });

  it("still reports other settle failures", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.failSettleWith = new Error(`Thread ${target.threadId} has queued run run-1.`);

    await useThreadActions().closeThread(target);

    expect(state.toasts).toEqual(["Failed to close thread"]);
  });
});

describe("closing a thread with queued messages", () => {
  interface Refusal {
    readonly actionProps: { readonly onClick: () => void };
    readonly data: { readonly secondaryActionProps: { readonly onClick: () => void } };
  }
  const environmentId = secondary;
  const notice = queuedCloseRefusalToastId(target);
  beforeEach(() => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.failSettleWith = {
      _tag: "OrchestrationV2DispatchCommandError",
      blockingQueuedRunIds: ["run-1", "run-2"],
      message: `Thread ${target.threadId} has queued run run-1.`,
    };
  });

  it("removes the queued messages the server named and closes the thread", async () => {
    await useThreadActions().closeThread(target);
    expect(state.toasts).toEqual(["Failed to close thread"]);
    state.requests = [];
    state.failSettleWith = undefined;
    (state.lastToast as Refusal).data.secondaryActionProps.onClick();

    const threadId = target.threadId;
    await vi.waitFor(() =>
      expect(state.requests).toEqual([
        { action: "cancelQueuedRun", environmentId, input: { threadId, runId: "run-1" } },
        { action: "cancelQueuedRun", environmentId, input: { threadId, runId: "run-2" } },
        { action: "settle", environmentId, input: { threadId } },
      ]),
    );
  });

  it("sends the first queued message and leaves the thread open", async () => {
    await useThreadActions().closeThread(target);
    state.requests = [];
    (state.lastToast as Refusal).actionProps.onClick();

    await vi.waitFor(() =>
      expect(state.requests).toEqual([
        {
          action: "resumeThreadQueue",
          environmentId,
          input: { threadId: target.threadId, runId: "run-1" },
        },
      ]),
    );
  });

  it("removes nothing once the connection may no longer change threads", async () => {
    await useThreadActions().closeThread(target);
    state.requests = [];
    state.scopes.get(secondary)!.clear();
    (state.lastToast as Refusal).data.secondaryActionProps.onClick();

    await vi.waitFor(() =>
      expect(state.toasts.at(-1)).toBe("Queued message 1 of 2 was not removed"),
    );
    expect(state.requests).toEqual([]);
  });

  it("keeps the notice while the close is refused and drops it once the thread closes", async () => {
    await useThreadActions().closeThread(target);
    expect(state.closedToasts).toEqual([]);

    state.failSettleWith = undefined;
    await useThreadActions().closeThread(target);
    expect(state.closedToasts).toEqual([notice]);
  });

  it.each([
    { name: "archiving it", loaded: true, run: "archiveThread" },
    { name: "archiving one that is no longer loaded", loaded: false, run: "archiveThread" },
    { name: "deleting it", loaded: true, run: "deleteThread" },
    { name: "deleting one that is no longer loaded", loaded: false, run: "deleteThread" },
  ] as const)("drops the notice after $name", async ({ loaded, run }) => {
    if (!loaded) state.threads = [];
    expect((await useThreadActions()[run](target))._tag).toBe("Success");
    expect(state.closedToasts).toEqual([notice]);
  });

  it.each(["archiveThread", "deleteThread"] as const)(
    "keeps the notice when %s is refused",
    async (run) => {
      state.scopes.get(secondary)!.clear();
      expect((await useThreadActions()[run](target))._tag).toBe("Failure");
      expect(state.closedToasts).toEqual([]);
    },
  );
});

describe("thread action permissions", () => {
  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    seedThreadPanelState(target);
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
    expect(threadPanelStatePresence(target)).toEqual(panelStateKept);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    seedThreadPanelState(target);
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
    expect(threadPanelStatePresence(target)).toEqual(panelStateCleared);
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});
