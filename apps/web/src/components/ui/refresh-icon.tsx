import { RefreshCwIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { GLYPH_BOX_CLASS, GLYPH_BOX_SPIN_CLASS, splitGlyphSize } from "./spinner";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const refreshIconVariants = cva("", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
  },
});

/** The box stays in place while idle so starting a refresh never shifts the layout. */
export function RefreshIcon({
  refreshing = false,
  className,
  size,
  ...props
}: Omit<React.ComponentPropsWithoutRef<"span">, "onAnimationIteration"> &
  VariantProps<typeof refreshIconVariants> & {
    refreshing?: boolean;
    // Element, so handlers written for the glyph when it was the animated node still fit.
    onAnimationIteration?: React.AnimationEventHandler<Element> | undefined;
  }) {
  const [boxClassName, glyphSize] = splitGlyphSize(className);
  return (
    <span
      aria-hidden
      data-slot="glyph-box"
      ref={refreshing ? observeVisibleAnimation : undefined}
      className={cn(GLYPH_BOX_CLASS, refreshing && GLYPH_BOX_SPIN_CLASS, boxClassName)}
      {...props}
    >
      <RefreshCwIcon aria-hidden className={cn(refreshIconVariants({ size }), glyphSize)} />
    </span>
  );
}
