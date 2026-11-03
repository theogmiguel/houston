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

/** A card whose rows are separated by one hairline; the row owns its padding. */
export function ListCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="list-card"
      className={cn(
        "divide-y divide-border overflow-hidden rounded-(--r-group) border border-border bg-card",
        className,
      )}
      {...props}
    />
  );
}

/** A filled value plate inside a card, for a compared or read-only value. */
export function ValuePanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="value-panel"
      className={cn("min-w-0 rounded-(--r-ctl) bg-(--field) px-2.5 py-2", className)}
      {...props}
    />
  );
}
