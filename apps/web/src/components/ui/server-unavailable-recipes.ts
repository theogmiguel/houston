/** The shell that stays visible while the primary server is unreachable. */
export const SERVER_UNAVAILABLE_SHELL = "flex h-dvh w-full bg-(--rail) text-foreground";
export const SERVER_UNAVAILABLE_SIDEBAR =
  "hidden w-64 shrink-0 flex-col gap-2 border-e border-(--divider) p-3 md:flex";
export const SERVER_UNAVAILABLE_SIDEBAR_BRAND =
  "mb-1 flex h-5 items-center px-1 text-sm font-semibold text-foreground";
/** A settled "Server offline" row; the rail does not pretend to be loading while the server is down. */
export const SERVER_UNAVAILABLE_SIDEBAR_OFFLINE_ROW =
  "flex h-(--h-row) items-center gap-2 rounded-lg px-2 text-xs text-secondary-label";
export const SERVER_UNAVAILABLE_SIDEBAR_OFFLINE_DOT =
  "size-1.5 shrink-0 rounded-full bg-(--houston)";
export const SERVER_UNAVAILABLE_HEADER =
  "flex h-(--h-top) shrink-0 items-center gap-2 px-2 opacity-40";
export const SERVER_UNAVAILABLE_HEADER_LABEL = "h-2.5 w-40 rounded-full bg-hover";
export const SERVER_UNAVAILABLE_HEADER_ACTION = "ms-auto h-2.5 w-16 rounded-full bg-hover";
export const SERVER_UNAVAILABLE_CONTENT = "flex min-w-0 flex-1 flex-col";
export const SERVER_UNAVAILABLE_CANVAS =
  "flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto bg-background px-4 py-10 sm:px-6";
/** The composer column: the message sits on the same lane as the thread's composer. */
export const SERVER_UNAVAILABLE_MESSAGE = "mx-auto w-full max-w-(--chat-content-max-width)";
