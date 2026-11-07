/** The shell that stays visible while the primary server is unreachable. */
export const SERVER_UNAVAILABLE_SHELL = "flex h-dvh w-full bg-(--rail) text-foreground";
export const SERVER_UNAVAILABLE_SIDEBAR =
  "hidden w-64 shrink-0 flex-col gap-2 border-e border-(--divider) p-3 opacity-40 md:flex";
export const SERVER_UNAVAILABLE_SIDEBAR_BRAND = "mb-1 h-5 w-24 rounded-(--r-ctl) bg-hover";
export const SERVER_UNAVAILABLE_SIDEBAR_CONTROL = "h-7 w-full rounded-(--r-ctl) bg-hover";
export const SERVER_UNAVAILABLE_SIDEBAR_ROW = "h-7 w-11/12 rounded-(--r-ctl) bg-hover";
export const SERVER_UNAVAILABLE_SIDEBAR_ROW_SHORT = "h-7 w-10/12 rounded-(--r-ctl) bg-hover";
export const SERVER_UNAVAILABLE_HEADER =
  "flex h-(--h-top) shrink-0 items-center gap-2 px-2 opacity-40";
export const SERVER_UNAVAILABLE_HEADER_LABEL = "h-2.5 w-40 rounded-full bg-hover";
export const SERVER_UNAVAILABLE_HEADER_ACTION = "ms-auto h-2.5 w-16 rounded-full bg-hover";
export const SERVER_UNAVAILABLE_CONTENT = "flex min-w-0 flex-1 flex-col p-(--canvas-inset)";
export const SERVER_UNAVAILABLE_CANVAS =
  "flex min-h-0 flex-1 items-center-safe justify-center overflow-y-auto rounded-(--r-canvas) border border-(--card-edge) bg-background px-4 py-10 sm:px-6";
export const SERVER_UNAVAILABLE_CARD = "dialog-glass w-full max-w-xl rounded-2xl border p-6";
export const SERVER_UNAVAILABLE_SIDEBAR_GROUP = "mt-4 flex flex-col gap-1.5";
