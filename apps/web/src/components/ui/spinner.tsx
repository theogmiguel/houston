import { LoaderCircleIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

// Chromium turns an <svg> on the main thread every frame but an HTML box on the compositor.
// Centring keeps the glyph on the axis when a parent's svg rule gives it a negative margin.
export const GLYPH_BOX_CLASS = "inline-flex shrink-0 items-center justify-center";
export const GLYPH_BOX_SPIN_CLASS = "motion-safe:visible-animate-spin";

// Sizes go on the glyph and the box wraps it, so the box flows as wide as a bare glyph did,
// including the negative margin a parent's svg rule gives the glyph.
const SIZE_CLASS = /^(?:\S*:)?!?size-/;
const WHITESPACE = /\s+/;
export function splitGlyphSize(
  className: string | undefined,
): [box: string | undefined, glyph: string | undefined] {
  const tokens = className?.split(WHITESPACE).filter(Boolean) ?? [];
  const glyph = tokens.filter((token) => SIZE_CLASS.test(token));
  if (glyph.length === 0) return [className, undefined];
  return [tokens.filter((token) => !SIZE_CLASS.test(token)).join(" "), glyph.join(" ")];
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
  const [boxClassName, glyphSize] = splitGlyphSize(className);
  return (
    <span
      aria-label="Loading"
      data-slot="glyph-box"
      ref={observeVisibleAnimation}
      className={cn(GLYPH_BOX_CLASS, GLYPH_BOX_SPIN_CLASS, boxClassName)}
      role="status"
      {...props}
    >
      <LoaderCircleIcon
        aria-hidden
        className={cn(spinnerTones({ tone }), spinnerSizes({ size }), glyphSize)}
      />
    </span>
  );
}

export { Spinner };
