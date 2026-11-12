import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import ChatView from "./ChatView";
import { BackgroundThreadContext } from "./chat/backgroundThread";
import { isSidebarHiddenThread } from "./Sidebar.logic";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { SidebarInset } from "./ui/sidebar";
import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadGridLayoutControls } from "./grid/useThreadGridLayoutControls";
import { ensureThreadPlaced } from "../threads/ensureThreadPlaced";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import {
  buildThreadRouteParams,
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";

/**
 * Unkeyed so navigating between server threads reuses one ChatView. Rendered by the `_chat`
 * layout, since an element only survives a route swap when the same parent renders it. Draft
 * promotion runs in the draft store; this only follows the redirect it leaves behind.
 * `background` keeps the thread mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
}) {
  const draftId = target.kind === "draft" ? target.draftId : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftRedirect = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverThreadRef = target.kind === "server" ? target.threadRef : null;
  const headerLayoutControls = useThreadGridLayoutControls(
    serverThreadRef?.threadId ?? draftSession?.threadId ?? draftRedirect?.threadId ?? null,
  );
  const serverThreadShell = useQuietThreadShell(serverThreadRef);
  const shellStatus = useEnvironmentShellStatus(serverThreadRef?.environmentId ?? null);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(shellStatus);
  // A thread created outside a grid (a deep link, the CLI or the replay host) gets one here.
  const threadNeedsGrid =
    !background &&
    serverThreadShell !== null &&
    serverThreadShell.archivedAt === null &&
    serverThreadShell.deletedAt === null &&
    serverThreadShell.settledOverride !== "settled" &&
    !effectiveSnoozed(serverThreadShell, { now: new Date().toISOString() }) &&
    !isSidebarHiddenThread(serverThreadShell);
  const serverThreadProjectId =
    threadNeedsGrid && serverThreadShell !== null ? serverThreadShell.projectId : null;
  const serverThreadEnvironmentId = serverThreadRef?.environmentId ?? null;
  const serverThreadId = serverThreadRef?.threadId ?? null;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- a standalone thread joins its workspace's grid so the sidebar lists it
  useEffect(() => {
    if (
      serverThreadProjectId === null ||
      serverThreadEnvironmentId === null ||
      serverThreadId === null
    )
      return;
    ensureThreadPlaced({
      environmentId: serverThreadEnvironmentId,
      projectId: serverThreadProjectId,
      threadId: serverThreadId,
    });
  }, [serverThreadEnvironmentId, serverThreadId, serverThreadProjectId]);
  const draftThread = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftThreadByRef(serverThreadRef) : null,
  );
  // Reached from the sidebar before finalize, the thread still has its draft.
  const serverThreadDraftId = useComposerDraftStore((store) =>
    serverThreadRef ? store.getDraftIdByRef(serverThreadRef) : null,
  );
  // The ChatView that carried a draft keeps its key through the redirect to its thread, and only
  // until the route leaves that thread, so later visits reuse the shared unkeyed ChatView.
  const [handoffKey, setHandoffKey] = useState<{ threadKey: string; key: string } | null>(null);
  const nextHandoffKey =
    draftId !== null && draftSession === null && draftRedirect
      ? handoffKey?.key === draftId
        ? handoffKey
        : { threadKey: scopedThreadKey(draftRedirect), key: draftId }
      : serverThreadRef && handoffKey?.threadKey === scopedThreadKey(serverThreadRef)
        ? handoffKey
        : serverThreadRef && serverThreadDraftId
          ? { threadKey: scopedThreadKey(serverThreadRef), key: serverThreadDraftId }
          : null;
  if (nextHandoffKey !== handoffKey) {
    setHandoffKey(nextHandoffKey);
  }
  // Until the shell lists the thread, its own load (HTTP, then the socket)
  // decides whether it exists. Read only then: once listed, ChatView keeps
  // this stream open and its updates need not re-render the route.
  const unlistedThreadRef =
    target.kind === "server" && serverThreadShell === null && draftThread === null
      ? target.threadRef
      : null;
  const unlistedThreadDetail = useEnvironmentThread(
    unlistedThreadRef?.environmentId ?? null,
    unlistedThreadRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: serverThreadShell !== null,
    serverThreadDeleted: serverThreadShell?.deletedAt != null,
    unlistedThreadDetail,
    draftThreadExists: draftThread !== null,
  });

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears pending file drops once a server thread is confirmed missing
  useEffect(() => {
    if (target.kind !== "server" || !bootstrapComplete) {
      return;
    }
    if (renderState === "missing") {
      const { clearPendingFileDropsForThread } = useSidebarPendingFileDropStore.getState();
      clearPendingFileDropsForThread(target.threadRef);
    }
  }, [bootstrapComplete, renderState, target]);

  let view: React.ReactNode = null;
  let redirect: React.ReactNode = null;
  if (target.kind === "draft") {
    if (draftSession) {
      view = (
        <ChatView
          key={target.draftId}
          draftId={target.draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          headerLayoutControls={headerLayoutControls}
          forceExpandedMobileComposer
        />
      );
    } else if (draftRedirect) {
      // Same slot and key as the server route renders, so the swap keeps this instance.
      view = (
        <ChatView
          key={target.draftId}
          environmentId={draftRedirect.environmentId}
          threadId={draftRedirect.threadId}
          routeKind="server"
          headerLayoutControls={headerLayoutControls}
        />
      );
      redirect = (
        <Navigate
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(draftRedirect)}
          replace
        />
      );
    } else {
      redirect = <Navigate to="/" replace />;
    }
  } else if (renderState === "ready" || (renderState === "loading" && serverThreadShell !== null)) {
    view = (
      <ChatView
        key={nextHandoffKey?.key}
        environmentId={target.threadRef.environmentId}
        threadId={target.threadRef.threadId}
        routeKind="server"
        headerLayoutControls={headerLayoutControls}
      />
    );
  } else if (renderState === "missing" && target.kind === "server" && !background) {
    // Names the state and offers the way out; a silent redirect or a blank page hides both.
    return <NoActiveThreadState missingThreadId={target.threadRef.threadId} />;
  }

  return (
    <SidebarInset className="min-h-0 overflow-hidden overscroll-y-none" inert={background}>
      <BackgroundThreadContext value={background}>{view}</BackgroundThreadContext>
      {background ? null : redirect}
    </SidebarInset>
  );
}
