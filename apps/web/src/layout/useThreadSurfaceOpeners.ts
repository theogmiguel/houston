import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type ScopedThreadRef,
} from "@houston-app/contracts";
import { visibleThreadPullRequests } from "@houston-app/shared/threadPullRequests";

import { recallCheckoutIsRepo } from "../components/ChatView.logic";
import { useSideChat } from "../components/chat/useSideChat";
import { addBrowserSurface } from "../components/preview/addBrowserSurface";
import { threadPullRequestPanelTarget } from "../components/pullRequest/pullRequestDetail.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { useStableCallback } from "../hooks/useStableCallback";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import {
  useEnvironmentSupportsServerBrowser,
  useProject,
  useQuietThreadShell,
} from "../state/entities";
import { previewEnvironment } from "../state/preview";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { chatGitStatusAtom, NO_CHAT_GIT_STATUS_ATOM, vcsEnvironment } from "../state/vcs";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadChatBridge } from "./threadSurfaceBridge";

/** The surfaces a launcher can open for a thread. */
export type LauncherSurfaceKind =
  | "diff"
  | "files"
  | "browser"
  | "terminal"
  | "pull-request"
  | "pull-requests"
  | "device"
  | "side-chat";

/** A row is shown with its reason when its surface is unavailable. */
export interface ThreadSurfaceAvailability {
  readonly available: boolean;
  readonly reason: string;
}

export interface ThreadSurfaceOpeners {
  readonly surfaces: Readonly<Record<LauncherSurfaceKind, ThreadSurfaceAvailability>>;
  /** Opens the surface in the stores; the layout sync turns that into a tab. */
  readonly open: (kind: LauncherSurfaceKind, browserProfileId?: string) => void;
}

/**
 * What a launcher offers for one thread, without the thread's chat being mounted: each surface's
 * availability (with the reason when it is not) and the action that opens it. The surface stores
 * hold the result; the layout sync gives each opened surface its tab.
 */
export function useThreadSurfaceOpeners(threadRef: ScopedThreadRef): ThreadSurfaceOpeners {
  const { environmentId } = threadRef;
  const shell = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectId = shell?.projectId ?? draftThread?.projectId ?? null;
  const project = useProject(projectId === null ? null : scopeProjectRef(environmentId, projectId));
  const isServerThread = shell !== null;
  const worktreePath = shell?.worktreePath ?? draftThread?.worktreePath ?? null;
  const gitCwd = worktreePath ?? project?.workspaceRoot ?? null;
  const gitStatus = useAtomValue(
    gitCwd === null
      ? NO_CHAT_GIT_STATUS_ATOM
      : chatGitStatusAtom(vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } })),
  );
  const isGitRepo = gitStatus?.isRepo ?? recallCheckoutIsRepo(environmentId, gitCwd) ?? true;

  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  const browserSupported = isPreviewSupportedInRuntime() || serverBrowser;
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const bridge = useThreadChatBridge(threadRef);

  const pullRequests = visibleThreadPullRequests(shell?.pullRequests ?? []);
  const pullRequestTarget =
    shell === null
      ? null
      : threadPullRequestPanelTarget({
          projectId: shell.projectId,
          pullRequests,
          linkedPullRequest: bridge?.linkedPullRequest ?? null,
          branchPullRequest: shell.branchPullRequest,
        });
  const supportsPullRequests = serverConfig !== null;

  const lineage = shell?.lineage ?? null;
  const sideChatReason =
    lineage?.sideChat === true
      ? "Side chats cannot start side chats."
      : lineage?.relationshipToParent === "subagent"
        ? "Subagent threads cannot start side chats."
        : serverConfig === null
          ? "Side chats are not ready yet."
          : serverConfig.environment.capabilities.sideChats !== true
            ? "Update this environment's Houston server to use side chats."
            : !isServerThread
              ? "Available after the first message."
              : !canOperateThread
                ? "This connection cannot start threads."
                : null;
  const sideChat = useSideChat({
    threadRef: sideChatReason === null ? threadRef : null,
    onError: (message) =>
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Side chat", description: message }),
      ),
  });

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openBrowser = (profileId?: string) => {
    void addBrowserSurface({
      threadRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    }).then((result) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open browser",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  };

  const surfaces: ThreadSurfaceOpeners["surfaces"] = {
    diff: {
      available: isServerThread && isGitRepo,
      reason: isServerThread ? "Not a Git repository." : "Available after the first message.",
    },
    files: { available: project !== null, reason: "Available when a project is open." },
    browser: {
      available: browserSupported && canOperatePreview,
      reason: browserSupported
        ? "This connection cannot open a browser."
        : "Only available in the desktop app.",
    },
    terminal: {
      available: project !== null && canOperateTerminal,
      reason:
        project === null
          ? "Available when a project is open."
          : "This connection cannot open terminals.",
    },
    "pull-request": {
      available: supportsPullRequests && pullRequestTarget !== null,
      reason: "No pull request on this branch yet.",
    },
    "pull-requests": {
      available: isServerThread && supportsPullRequests && pullRequests.length > 0,
      reason: "No linked pull requests.",
    },
    device: { available: true, reason: "Available from a thread." },
    "side-chat": { available: sideChatReason === null, reason: sideChatReason ?? "" },
  };

  const open = useStableCallback((kind: LauncherSurfaceKind, browserProfileId?: string) => {
    if (!surfaces[kind].available) return;
    const panels = useRightPanelStore.getState();
    switch (kind) {
      case "diff":
        useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
        panels.open(threadRef, "diff");
        return;
      case "files":
      case "pull-requests":
      case "device":
        panels.open(threadRef, kind);
        return;
      case "browser":
        openBrowser(browserProfileId);
        return;
      case "terminal":
        useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
        return;
      case "pull-request":
        if (pullRequestTarget !== null) panels.openPullRequest(threadRef, pullRequestTarget);
        return;
      case "side-chat":
        void sideChat.open();
        return;
    }
  });
  return { surfaces, open };
}
