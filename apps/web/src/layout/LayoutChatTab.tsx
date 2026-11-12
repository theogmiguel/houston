import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { useEffect } from "react";

import { ThreadChatSurface } from "../components/chat/ThreadChatSurface";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { useComposerDraftStore } from "../composerDraftStore";
import { usePaneDensity } from "../components/grid/usePaneDensity";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import { ThreadOpenProvider, type ThreadOpenIntent } from "../threads/threadOpenContext";
import {
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
  type ThreadRouteTarget,
} from "../threadRoutes";
import type { ScopedThreadRef } from "@houston-app/contracts";
import type { LayoutTab } from "./layoutModel";
import { PhoneEmptyState } from "../mobile/PhoneEmptyState";
import { usePhoneThreadHost } from "../mobile/phoneThreadHost";
import { useLayoutPane } from "./layoutPaneContext";
import { useLayoutStore } from "./layoutStore";

/** Panes beside each other count as a split for the chat's density. */
const SPLIT_THREAD_COUNT = 2;

/**
 * The content of a chat tab: the thread's chat with its composer, a draft's, or a plain statement
 * that the thread is gone. A draft that became a thread hands its tab to the thread.
 */
export function LayoutChatTab({
  tab,
  target,
  split,
  onOpenThread,
}: {
  readonly tab: LayoutTab;
  readonly target: ThreadRouteTarget;
  readonly split: boolean;
  /** How the chat opens a thread related to it; `from` is this tab's own thread. */
  readonly onOpenThread: (
    ref: ScopedThreadRef,
    intent: ThreadOpenIntent | undefined,
    from: ScopedThreadRef | null,
  ) => void;
}) {
  const draftId = target.kind === "draft" ? target.draftId : null;
  const session = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const promoted = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverRef = target.kind === "server" ? target.threadRef : null;
  const shell = useQuietThreadShell(serverRef);
  const draftThread = useComposerDraftStore((store) =>
    serverRef ? store.getDraftThreadByRef(serverRef) : null,
  );
  const shellStatus = useEnvironmentShellStatus(serverRef?.environmentId ?? null);
  const unlistedRef =
    serverRef !== null && shell === null && draftThread === null ? serverRef : null;
  const unlistedDetail = useEnvironmentThread(
    unlistedRef?.environmentId ?? null,
    unlistedRef?.threadId ?? null,
  );
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete: isThreadRouteSnapshotAuthoritative(shellStatus),
    serverThreadExists: shell !== null,
    serverThreadDeleted: shell?.deletedAt != null,
    unlistedThreadDetail: unlistedDetail,
    draftThreadExists: draftThread !== null,
  });
  const { ref: densityRef, density } = usePaneDensity(split ? SPLIT_THREAD_COUNT : 1);
  const phone = usePhoneThreadHost();
  const { visible } = useLayoutPane();

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- hands a promoted draft's tab to its thread, or closes the tab of a draft nothing holds
  useEffect(() => {
    if (draftId === null || session !== null) return;
    const store = useLayoutStore.getState();
    if (promoted !== null) {
      store.replaceTabContent(tab.id, {
        kind: "chat",
        target: { kind: "server", threadRef: promoted },
      });
    } else {
      store.closeTab(tab.id);
    }
  }, [draftId, promoted, session, tab.id]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears pending file drops once a server thread is confirmed missing
  useEffect(() => {
    if (serverRef !== null && renderState === "missing") {
      useSidebarPendingFileDropStore.getState().clearPendingFileDropsForThread(serverRef);
    }
  }, [renderState, serverRef]);

  const threadRef =
    serverRef ?? (session ? scopeThreadRef(session.environmentId, session.threadId) : promoted);
  let body: React.ReactNode = null;
  if (serverRef !== null && renderState === "missing") {
    body = <MissingThread threadId={serverRef.threadId} tabId={tab.id} />;
  } else if (
    threadRef !== null &&
    (serverRef === null || renderState !== "loading" || shell !== null)
  ) {
    body = (
      <ThreadOpenProvider open={(ref, intent) => onOpenThread(ref, intent, threadRef)}>
        <ThreadChatSurface
          threadRef={threadRef}
          draftId={session && draftId !== null ? draftId : undefined}
          paneDensity={density}
          {...(phone === null
            ? {}
            : {
                phoneShell: true,
                detailsOpen: phone.detailsOpen && visible,
                onDetailsOpenChange: phone.onDetailsOpenChange,
                detailsCardAnchor: phone.detailsAnchor,
              })}
        />
      </ThreadOpenProvider>
    );
  }
  return (
    <div
      ref={(element) => {
        densityRef.current = element;
      }}
      data-layout-chat-tab={tab.id}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      {body}
    </div>
  );
}

function MissingThread({ threadId, tabId }: { readonly threadId: string; readonly tabId: string }) {
  const phone = usePhoneThreadHost();
  const closeTab = () => useLayoutStore.getState().closeTab(tabId);
  const message = `No thread with id ${threadId} is stored on this machine.`;
  if (phone !== null) {
    return (
      <PhoneEmptyState
        data-layout-missing-thread={threadId}
        title="This thread no longer exists"
        action={
          <Button size="touch" variant="outline" onClick={closeTab}>
            Close tab
          </Button>
        }
      >
        {message}
      </PhoneEmptyState>
    );
  }
  return (
    <Empty data-layout-missing-thread={threadId}>
      <EmptyHeader>
        <EmptyTitle>This thread no longer exists</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
        <Button variant="secondary" size="sm" onClick={closeTab}>
          Close tab
        </Button>
      </EmptyHeader>
    </Empty>
  );
}
