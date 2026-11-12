import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import type { ScopedThreadRef } from "@houston-app/contracts";
import { resolveProjectScripts } from "@houston-app/shared/projectScripts";
import { visibleThreadPullRequests } from "@houston-app/shared/threadPullRequests";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useRightPanelSurfaceClose } from "../../hooks/useRightPanelSurfaceClose";
import { useStableCallback } from "../../hooks/useStableCallback";
import { shortcutLabelForCommand } from "../../keybindings";
import { useThreadChatBridge } from "../../layout/threadSurfaceBridge";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useEnvironment } from "../../state/environments";
import { useProject, useQuietThreadShell } from "../../state/entities";
import {
  primaryServerAvailableEditorsAtom,
  primaryServerKeybindingsAtom,
} from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  selectPendingFileSurfaceIds,
  setFileSurfacePending,
  useFilePendingStore,
} from "../files/filePendingStore";
import { getConfiguredPreviewUrls } from "../preview/previewEmptyStateLogic";
import { useRightPanelTerminalActions } from "../terminal/useRightPanelTerminalActions";
import { useTerminalLabels } from "../terminal/useTerminalLabels";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

/**
 * The content of one right-panel surface of a thread, addressed by the thread and the surface id
 * and independent of the panel frame around it. Without a mounted chat there is no composer, so
 * annotations and terminal context go nowhere and the surface falls back to the thread's own
 * composer target.
 */
export function ThreadSurfaceContent(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surfaceId: string | null;
  /** The surface is on screen; a hidden surface keeps its resources but pauses its work. */
  readonly visible: boolean;
}) {
  const { threadRef, surfaceId, visible } = props;
  const bridge = useThreadChatBridge(threadRef);
  const surfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const surface =
    surfaceId === null ? null : (surfaces.find((entry) => entry.id === surfaceId) ?? null);
  const activeSurfaceId = useRightPanelStore(
    (state) => selectActiveRightPanelSurface(state.byThreadKey, threadRef)?.id ?? null,
  );
  const shell = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectId = shell?.projectId ?? draftThread?.projectId ?? null;
  const project = useProject(
    projectId === null ? null : scopeProjectRef(threadRef.environmentId, projectId),
  );
  const worktreePath = shell?.worktreePath ?? draftThread?.worktreePath ?? null;
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const serverConfig = useEnvironment(threadRef.environmentId)?.serverConfig ?? null;
  const terminalOpen = useTerminalUiStateStore(
    (state) =>
      selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen,
  );
  const projectKey = project ? `${project.environmentId}:${project.workspaceRoot}` : null;
  const pendingSurfaceIds = useFilePendingStore((state) =>
    selectPendingFileSurfaceIds(state.byProjectKey, projectKey),
  );
  const terminalLabelsById = useTerminalLabels(threadRef);
  const terminalActions = useRightPanelTerminalActions({ threadRef, surface });
  const { closeSurface } = useRightPanelSurfaceClose({ threadRef, terminalLabelsById });

  const openFile = useStableCallback((relativePath: string) => {
    if (project === null) return;
    useRightPanelStore.getState().openFile(threadRef, relativePath);
  });
  const changePending = useStableCallback((relativePath: string, pending: boolean) => {
    if (projectKey !== null) setFileSurfacePending(projectKey, relativePath, pending);
  });
  const openPullRequestsSurface = useStableCallback(() => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
  });

  const visiblePullRequests = visibleThreadPullRequests(shell?.pullRequests ?? []);
  const pullRequestsSurfaceAvailable =
    shell !== null && serverConfig !== null && visiblePullRequests.length > 0;
  const shortcutOptions = { context: { terminalFocus: true, terminalOpen: Boolean(terminalOpen) } };
  const noop = () => {};

  if (surface === null) return null;
  return (
    <RightPanelSurfaceContent
      surface={surface}
      activeSurfaceId={activeSurfaceId}
      threadRef={threadRef}
      environmentId={threadRef.environmentId}
      visible={visible}
      composerDraftTarget={bridge?.composerDraftTarget ?? threadRef}
      keybindings={keybindings}
      configuredPreviewUrls={getConfiguredPreviewUrls(
        project ? resolveProjectScripts(settings, project) : [],
      )}
      workspaceMutationId={bridge?.workspaceMutationId ?? null}
      getShortcutContext={
        bridge?.getShortcutContext ??
        (() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: false,
          isDesktop: false,
        }))
      }
      onSendAnnotation={bridge?.sendAnnotation ?? noop}
      onCloseSurface={closeSurface}
      sideChatParentPanel={
        bridge?.sideChatParentPanel ?? { openToolDiff: noop, runShellCommand: noop }
      }
      terminal={{
        launchContext: bridge?.terminalLaunchContext ?? null,
        keybindings,
        onAddTerminalContext: bridge?.addTerminalContext ?? noop,
        onSplitTerminal: terminalActions.splitPanelTerminalStable,
        onSplitTerminalVertical: terminalActions.splitPanelTerminalVerticalStable,
        onNewTerminal: terminalActions.addTerminalSurfaceStable,
        onActiveTerminalChange: terminalActions.activatePanelTerminalStable,
        onCloseTerminal: terminalActions.closePanelTerminalStable,
        splitShortcutLabel:
          shortcutLabelForCommand(keybindings, "terminal.split", shortcutOptions) ?? undefined,
        splitVerticalShortcutLabel:
          shortcutLabelForCommand(keybindings, "terminal.splitVertical", shortcutOptions) ??
          undefined,
        newShortcutLabel:
          shortcutLabelForCommand(keybindings, "terminal.new", shortcutOptions) ?? undefined,
        closeShortcutLabel:
          shortcutLabelForCommand(keybindings, "terminal.close", shortcutOptions) ?? undefined,
      }}
      pullRequest={{
        capabilityKnown: serverConfig !== null,
        supported: serverConfig !== null,
        projectId: shell?.projectId ?? null,
        pullRequests: visiblePullRequests,
        linkedPullRequest: bridge?.linkedPullRequest ?? null,
        branchPullRequest: shell?.branchPullRequest,
        onBack:
          pullRequestsSurfaceAvailable && visiblePullRequests.length > 1
            ? openPullRequestsSurface
            : undefined,
      }}
      files={{
        projectId: project?.id,
        projectName: project?.title ?? null,
        workspaceRoot: worktreePath ?? project?.workspaceRoot ?? undefined,
        availableEditors,
        pendingSurfaceIds,
        onOpenFile: openFile,
        onPendingChange: changePending,
      }}
    />
  );
}
