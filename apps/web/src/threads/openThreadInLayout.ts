import type { ScopedThreadRef } from "@houston-app/contracts";

import { findLayoutTabByContent } from "../layout/layoutModel";
import { runInNewLayoutTab, useLayoutStore } from "../layout/layoutStore";
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
 * Shows a thread in the layout: focuses the tab that already holds its chat wherever it is, or
 * opens one by the layout's own rules. `from` names the thread it was opened from, so a related
 * thread (a subagent, its parent) opens as a provisional tab beside it; `join` adds a kept tab in
 * the focused pane instead. The URL follows the focused tab.
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
  if (findLayoutTabByContent(store.layout, content) !== null) {
    store.focusChat(content.target);
    if (!isThreadRoutePathname(navigation.pathname(), ref)) await go();
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
