import type { HTMLAttributes, Ref } from "react";

import { cn } from "../../lib/utils";

/**
 * A row of controls that scrolls sideways without drawing a scrollbar: a header's controls in a
 * pane too narrow to show them all, so none is clipped out of reach.
 */
export function ScrollRow({
  ref,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={cn(
        "scrollbar-hidden flex min-w-0 shrink items-center gap-1 overflow-x-auto",
        className,
      )}
      {...props}
    />
  );
}
