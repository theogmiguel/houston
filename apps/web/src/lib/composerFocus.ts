const COMPOSER_FOCUS_EVENT = "houston:focus-composer";

/** Asks the thread on screen to put the caret at the end of its composer. */
export function dispatchComposerFocus(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
}

export function subscribeComposerFocus(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(COMPOSER_FOCUS_EVENT, listener);
  return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, listener);
}

/**
 * Focuses after the next frame so a composer mounted by the route change can
 * subscribe first. Without a frame, such as in a unit test, dispatch at once.
 */
export function requestComposerFocus(): void {
  if (typeof window === "undefined") return;
  if (typeof window.requestAnimationFrame !== "function") {
    dispatchComposerFocus();
    return;
  }
  window.requestAnimationFrame(() => dispatchComposerFocus());
}
