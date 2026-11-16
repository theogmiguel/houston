import type { ScopedThreadRef } from "@houston-app/contracts";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { openThreadInLayout } from "../threads/openThreadInLayout";
import type { ThreadOpenIntent } from "../threads/threadOpenContext";
import { LayoutChatGate } from "./LayoutChatGate";
import { LayoutChatTab } from "./LayoutChatTab";
import { LayoutLauncher } from "./LayoutLauncher";
import { LayoutPageTab } from "./LayoutPageTab";
import { LayoutSurfaceTab } from "./LayoutSurfaceTab";
import { chatTargetThreadRef } from "./layoutThreadRef";
import { selectFocusedTab, type LayoutState, type LayoutTab } from "./layoutModel";
import { LayoutPaneContext } from "./layoutPaneContext";
import type { LayoutTabRenderContext } from "./WorkspaceStrip";

/**
 * Draws the content of any tab: a chat, a surface, a launcher or a page. Every host of the layout
 * (the desktop strip and the phone) draws tabs through this one function.
 */
export function useLayoutTabRenderer(
  layout: LayoutState,
): (tab: LayoutTab, context: LayoutTabRenderContext) => ReactNode {
  const router = useRouter();
  const focusedContent = selectFocusedTab(layout)?.content ?? null;
  const focusedSurfaceThread = focusedContent?.kind === "surface" ? focusedContent.threadRef : null;
  const focusedSurfaceKey =
    focusedSurfaceThread === null ? null : scopedThreadKey(focusedSurfaceThread);

  const openThread = (
    ref: ScopedThreadRef,
    intent: ThreadOpenIntent | undefined,
    from: ScopedThreadRef | null,
  ) =>
    void openThreadInLayout(
      {
        navigate: (options) => router.navigate(options),
        pathname: () => router.state.location.pathname,
      },
      ref,
      { intent, from },
    );

  return (tab, context) => {
    const content = tab.content;
    const body = (() => {
      switch (content.kind) {
        case "chat":
          return (
            <LayoutChatGate target={content.target}>
              <LayoutChatTab
                tab={tab}
                target={content.target}
                split={context.split}
                onOpenThread={openThread}
              />
            </LayoutChatGate>
          );
        case "surface":
          return <LayoutSurfaceTab content={content} />;
        case "launcher":
          return <LayoutLauncher tabId={tab.id} context={content.context} />;
        default:
          return <LayoutPageTab content={content} />;
      }
    })();
    const thread = content.kind === "chat" ? chatTargetThreadRef(content.target) : null;
    const related =
      thread !== null &&
      focusedSurfaceKey !== null &&
      scopedThreadKey(thread) === focusedSurfaceKey;
    // The strip reports `related: false`; a chat whose surface has focus overrides it here. The
    // provider is always present so that gaining or losing `related` never remounts the tab.
    return (
      <LayoutPaneContext value={related ? { ...context, related: true } : context}>
        {body}
      </LayoutPaneContext>
    );
  };
}
