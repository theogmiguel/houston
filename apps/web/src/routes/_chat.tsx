import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { Outlet, createFileRoute, redirect, useLocation, useMatches } from "@tanstack/react-router";
import { useState } from "react";

import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { LayoutHost } from "../layout/LayoutHost";
import { layoutRoutePage } from "../layout/pageNavigation";
import { useIndexShowsLayout } from "../layout/useIndexShowsLayout";
import { PhoneLayoutHost } from "../mobile/PhoneLayoutHost";
import { useIsPhone } from "../mobile/usePhone";

function threadRouteTargetKey(target: ThreadRouteTarget | null) {
  if (!target) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

function ChatRouteLayout() {
  return useIsPhone() ? <PhoneChatRouteLayout /> : <LayoutChatRouteLayout />;
}

/** The main area is the layout; routes the layout does not show render beside it. */
function LayoutChatRouteLayout() {
  const { authGateState } = Route.useRouteContext();
  const location = useLocation();
  const threadTarget = useThreadRouteTarget();
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  const atIndex = location.pathname === "/";
  const indexShowsLayout = useIndexShowsLayout(authGateState.status === "hosted-static");
  const layoutShowsRoute =
    threadTarget !== null || layoutRoutePage(location) !== null || (atIndex && indexShowsLayout);
  const hostActive = layoutShowsRoute || modalOpen;
  return (
    <>
      {threadTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
      ) : null}
      <SidebarInset className={hostActive ? "min-h-0" : "hidden"}>
        <LayoutHost
          threadTarget={threadTarget}
          atIndex={atIndex && indexShowsLayout}
          active={hostActive}
        />
      </SidebarInset>
      {hostActive && !modalOpen ? null : <Outlet />}
    </>
  );
}

function PhoneChatRouteLayout() {
  // The thread and draft routes render here, so promoting a draft keeps its tab and chat mounted.
  const threadTarget = useThreadRouteTarget();
  // Read matches, not location, so this agrees with the params useThreadRouteTarget reads.
  const modalOpen = useMatches({
    select: (matches) => matches.some((match) => isAppModalPage(match.pathname)),
  });
  // Settings and Usage render over the thread that opened them, so ChatView never remounts.
  const [backgroundTarget, setBackgroundTarget] = useState(threadTarget);
  if (!modalOpen && threadRouteTargetKey(backgroundTarget) !== threadRouteTargetKey(threadTarget)) {
    setBackgroundTarget(threadTarget);
  }
  const shownTarget = modalOpen ? backgroundTarget : threadTarget;
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <PhoneLayoutHost threadTarget={shownTarget} active={!modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="min-h-0" />
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
