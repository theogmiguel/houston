import type * as React from "react";

import brandMarkUrl from "../assets/houston-mark.svg";
import { cn } from "~/lib/utils";

// The mark is one colour, so it is painted as a mask over the text colour. An <img> would
// ignore that colour, and inline SVG would repeat the mark's mask ids on every row.
const MARK_MASK = { "--houston-mark": `url("${brandMarkUrl}")` } as React.CSSProperties;
const MARK_CLASS =
  "inline-block shrink-0 bg-current [mask:var(--houston-mark)_center/contain_no-repeat]";

/** Houston's app mark alone, in the current text colour, for rows that render a product icon. */
export function HoustonMark({ className }: { readonly className?: string }) {
  return <span aria-hidden style={MARK_MASK} className={cn(MARK_CLASS, "size-4", className)} />;
}

/**
 * Houston's product lockup: the app mark and its name, so every surface (sidebar, welcome,
 * lifecycle rows, standalone pages) carries one brand.
 */
export function HoustonWordmark({
  className,
  markClassName,
  ...props
}: React.ComponentProps<"span"> & { readonly markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} {...props}>
      <HoustonMark className={cn("size-[1.35em]", markClassName)} />
      <span className="font-semibold tracking-[-0.02em]">Houston</span>
    </span>
  );
}
