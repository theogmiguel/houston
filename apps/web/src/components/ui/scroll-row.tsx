import type { HTMLAttributes, Ref } from "react";

import { cn } from "../../lib/utils";

/**
 * A row of controls that scrolls sideways without drawing a scrollbar: a header's controls in a
 * pane too narrow to show them all, so none is clipped out of reach.
 */
export function ScrollRow({
  ref,
  className,
  spacing = "tight",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>;
  /** Space between the controls: `tight` for a search box and its buttons, `loose` for groups. */
  spacing?: "tight" | "loose";
}) {
  return (
    <div
      ref={ref}
      className={cn(
        "scrollbar-hidden flex min-w-0 shrink items-center overflow-x-auto",
        spacing === "loose" ? "gap-3" : "gap-1",
        className,
      )}
      {...props}
    />
  );
}
