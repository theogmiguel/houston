import type * as React from "react";

import brandMarkUrl from "../assets/houston-mark-64.png";
import { cn } from "~/lib/utils";

/** Houston's app mark alone, for rows that render a product icon. */
export function HoustonMark({ className }: { readonly className?: string }) {
  return <img src={brandMarkUrl} alt="" aria-hidden className={cn("size-4", className)} />;
}

/**
 * Houston's product lockup: the app mark and its name. Replaces the upstream
 * T3 wordmark so every surface (sidebar, welcome, lifecycle rows, standalone
 * pages) carries one brand.
 */
export function HoustonWordmark({
  className,
  markClassName,
  ...props
}: React.ComponentProps<"span"> & { readonly markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} {...props}>
      <img src={brandMarkUrl} alt="" aria-hidden className={cn("size-[1.35em]", markClassName)} />
      <span className="font-semibold tracking-[-0.02em]">Houston</span>
    </span>
  );
}
