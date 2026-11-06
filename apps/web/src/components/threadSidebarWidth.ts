export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
// 272px is 19% of a 1440px window: two-line rows still fit a title and a right-aligned age, and
// the main column keeps the rest.
const THREAD_SIDEBAR_DEFAULT_WIDTH = 272;
const THREAD_SIDEBAR_MIN_WIDTH = 240;
const THREAD_SIDEBAR_MAX_WIDTH = 440;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMinimumWidth(brandWidth: number): number {
  return Math.max(THREAD_SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
}

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth = THREAD_SIDEBAR_MIN_WIDTH,
): number {
  return Math.max(
    minimumWidth,
    Math.min(THREAD_SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH),
  );
}

export function clampThreadSidebarWidth(
  width: number,
  minimumWidth: number,
  maximumWidth: number,
): number {
  return Math.min(maximumWidth, Math.max(minimumWidth, width));
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth));
}
