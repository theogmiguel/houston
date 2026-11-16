import { cn } from "~/lib/utils";

const CORNER_DOT = {
  available: "size-1.5 bg-update",
  ready: "size-2 bg-update",
  failed: "size-2 bg-warning",
} as const;

/**
 * A status dot for the top-right corner of an icon button. It is decorative: the button's own
 * accessible name states the status in words. The ring cuts it out of the surface behind it.
 */
export function CornerDot({
  tone,
  className,
}: {
  readonly tone: keyof typeof CORNER_DOT;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      data-slot="corner-dot"
      className={cn(
        "pointer-events-none absolute top-1 right-1 rounded-full ring-2 ring-sidebar",
        CORNER_DOT[tone],
        className,
      )}
    />
  );
}
