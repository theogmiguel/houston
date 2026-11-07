import { LoaderCircleIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

// Chromium turns an <svg> on the main thread every frame but an HTML box on the compositor.
// Centring keeps the glyph on the axis when a parent's svg rule gives it a negative margin.
export const GLYPH_BOX_CLASS = "inline-flex shrink-0 items-center justify-center";
export const GLYPH_BOX_SPIN_CLASS = "motion-safe:visible-animate-spin";

// A sized box fills its glyph; an unsized one leaves the glyph to the parent's svg rule.
export function boxHasSize(size: unknown, className: string | undefined): boolean {
  return size != null || (className?.includes("size-") ?? false);
}

const spinnerSizes = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
});

const spinnerTones = cva("", {
  variants: {
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "current" },
});

// No default size: inside a Button the parent's svg rule sizes the glyph.
function Spinner({
  className,
  size,
  tone,
  ...props
}: React.ComponentPropsWithoutRef<"span"> &
  VariantProps<typeof spinnerSizes> &
  VariantProps<typeof spinnerTones>) {
  const sized = boxHasSize(size, className);
  return (
    <span
      aria-label="Loading"
      data-slot="glyph-box"
      ref={observeVisibleAnimation}
      className={cn(GLYPH_BOX_CLASS, GLYPH_BOX_SPIN_CLASS, spinnerSizes({ size }), className)}
      role="status"
      {...props}
    >
      <LoaderCircleIcon aria-hidden className={cn(spinnerTones({ tone }), sized && "size-full")} />
    </span>
  );
}

export { Spinner };
