import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";

/** The terminal drawer's frame, docked under the chat or filling the right panel. */
export function terminalDrawerFrameClassName(isPanel: boolean) {
  return cn(
    "group/terminal relative flex min-w-0 flex-col overflow-hidden bg-background",
    isPanel ? "h-full flex-1" : "z-45 shrink-0 border-t border-border/80",
  );
}

/**
 * The terminal's split, new and close buttons, floating over its top end. They fade in while the
 * pointer is over the frame or focus is inside it, so a quiet terminal shows no chrome.
 */
export function TerminalFloatingToolbar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-20 opacity-0 transition-opacity duration-(--motion-feedback) ease-standard group-focus-within/terminal:opacity-100 group-hover/terminal:opacity-100 motion-reduce:transition-none">
      {children}
    </div>
  );
}

/** The docked drawer's frame, shown at the drawer's height while its code loads. */
export function TerminalDrawerPlaceholder({
  ref,
  height,
  children,
}: {
  readonly ref?: Ref<HTMLDivElement>;
  readonly height: number;
  readonly children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      data-thread-terminal-drawer-placeholder
      className={terminalDrawerFrameClassName(false)}
      style={{ height: `${height}px` }}
    >
      {children}
    </div>
  );
}
