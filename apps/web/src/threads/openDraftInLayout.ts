import type { DraftId } from "../composerDraftStore";
import { findLayoutTabByContent, selectLayoutOpenAnchor } from "../layout/layoutModel";
import { runInNewLayoutTab, useLayoutStore } from "../layout/layoutStore";
import { buildDraftThreadRouteParams } from "../threadRoutes";

/** The slice of a router a draft open needs; `useNavigate()` and `router.navigate` both fit. */
export interface DraftOpenNavigation {
  readonly navigate: (options: {
    to: "/draft/$draftId";
    params: ReturnType<typeof buildDraftThreadRouteParams>;
  }) => Promise<unknown> | unknown;
}

/**
 * Runs an action that opens a new thread's route so the thread takes the place of the focused
 * tab, as a new thread does in the layout. Outside a loaded layout the action runs as it is.
 */
export function openAsNewThreadTab<T>(open: () => Promise<T>): Promise<T> {
  const store = useLayoutStore.getState();
  const anchor =
    store.layoutLoaded && store.newTabRequest === null
      ? selectLayoutOpenAnchor(store.layout)
      : null;
  return anchor ? runInNewLayoutTab(open, { replaceTabId: anchor.tab.id }) : open();
}

/** Shows a registered draft in the layout: focuses its tab, or opens it where a new thread goes. */
export async function openDraftInLayout(
  navigation: DraftOpenNavigation,
  draftId: DraftId,
): Promise<void> {
  const target = { kind: "draft", draftId } as const;
  const go = () =>
    Promise.resolve(
      navigation.navigate({ to: "/draft/$draftId", params: buildDraftThreadRouteParams(draftId) }),
    );
  const store = useLayoutStore.getState();
  if (findLayoutTabByContent(store.layout, { kind: "chat", target }) !== null) {
    store.focusChat(target);
    await go();
    return;
  }
  await openAsNewThreadTab(go);
}
