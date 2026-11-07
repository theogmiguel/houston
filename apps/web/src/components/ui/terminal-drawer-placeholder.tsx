import type { ReactNode, Ref } from "react";

import { cn } from "~/lib/utils";

/** The terminal drawer's frame, docked under the chat or filling the right panel. */
export function terminalDrawerFrameClassName(isPanel: boolean) {
  return cn(
    "relative flex min-w-0 flex-col overflow-hidden bg-background",
    isPanel ? "h-full flex-1" : "z-45 shrink-0 border-t border-border/80",
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
