import { cn } from "~/lib/utils";

/** A small filled dot that marks something as live; the label is its accessible name. */
export function LiveDot({ label, className }: { label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      data-slot="live-dot"
      className={cn("size-1.5 shrink-0 rounded-full bg-success", className)}
    />
  );
}
