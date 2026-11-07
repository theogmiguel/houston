import type { ReactNode, Ref } from "react";

/** The terminal drawer's frame, shown at the drawer's height while its code loads. */
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
      className="relative flex shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${height}px` }}
    >
      {children}
    </div>
  );
}
