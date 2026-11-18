import type { ScopedThreadRef } from "@houston-app/contracts";

import { findLayoutChatForThread, findLayoutTabByContent } from "../layout/layoutModel";
import { runInNewLayoutTab, useLayoutStore } from "../layout/layoutStore";
import { followLayoutCompanions } from "../layout/openRules";
import { buildThreadRouteParams, isThreadRoutePathname } from "../threadRoutes";
import type { ThreadOpenIntent } from "./threadOpenContext";

/** The slice of a router a thread open needs; `useNavigate()` and `router.navigate` both fit. */
export interface ThreadOpenNavigation {
  readonly navigate: (options: {
    to: "/$environmentId/$threadId";
    params: ReturnType<typeof buildThreadRouteParams>;
  }) => Promise<unknown> | unknown;
  readonly pathname: () => string;
}

/**
 * Shows a thread in the layout: a related thread takes over the tab it was opened from, else the
 * tab already holding its chat is focused or one opens by the layout's rules; `join` adds a tab.
 * The URL follows the focused tab.
 */
export async function openThreadInLayout(
  navigation: ThreadOpenNavigation,
  ref: ScopedThreadRef,
  options: {
    readonly intent?: ThreadOpenIntent | undefined;
    readonly from?: ScopedThreadRef | null;
  } = {},
): Promise<void> {
  const store = useLayoutStore.getState();
  const content = { kind: "chat", target: { kind: "server", threadRef: ref } } as const;
  const go = () =>
    Promise.resolve(
      navigation.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(ref),
      }),
    );
  const syncRoute = async () => {
    if (!isThreadRoutePathname(navigation.pathname(), ref)) await go();
  };
  if (options.from && options.intent !== "join") {
    const fromTab = findLayoutChatForThread(store.layout, options.from);
    if (fromTab !== null) {
      followLayoutCompanions(() => {
        store.replaceTabContent(fromTab.tab.id, content);
        store.focusTab(fromTab.tab.id);
      });
      await syncRoute();
      return;
    }
  }
  if (findLayoutTabByContent(store.layout, content) !== null) {
    store.focusChat(content.target);
    await syncRoute();
    return;
  }
  if (options.intent === "join") {
    await runInNewLayoutTab(go, "active-pane");
    return;
  }
  if (options.from) {
    await runInNewLayoutTab(go, { ghostOf: options.from });
    return;
  }
  await go();
}
