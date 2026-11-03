import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** A lifted surface: one hairline, the card ground and the group radius. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-(--r-group) border border-border bg-card p-3", className)}
      {...props}
    />
  );
}
