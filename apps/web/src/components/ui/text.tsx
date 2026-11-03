import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

import { cn } from "~/lib/utils";

const textVariants = cva("min-w-0", {
  variants: {
    variant: {
      body: "text-body",
      callout: "text-callout",
      caption: "text-caption",
      headline: "text-headline",
      title: "text-title",
      display: "text-large-title",
    },
    tone: {
      default: "text-foreground",
      secondary: "text-secondary-foreground",
      muted: "text-muted-foreground",
      accent: "text-(--accent-ink)",
      success: "text-success-foreground",
      warning: "text-(--warn-ink)",
      danger: "text-error-foreground",
      inherit: "",
    },
    weight: {
      normal: "font-normal",
      medium: "font-medium",
      semibold: "font-semibold",
    },
    mono: {
      true: "font-mono",
      false: "",
    },
    tabular: {
      true: "tabular-nums",
      false: "",
    },
    truncate: {
      true: "truncate",
      false: "",
    },
    preserve: {
      true: "whitespace-pre-wrap",
      false: "",
    },
  },
  defaultVariants: {
    variant: "body",
    tone: "default",
    weight: "normal",
    mono: false,
    tabular: false,
    truncate: false,
    preserve: false,
  },
});

type TextOwnProps = {
  /** The element the text renders as; `span` for inline copy. */
  readonly as?: ElementType;
  readonly children?: ReactNode;
} & VariantProps<typeof textVariants>;

export type TextProps = TextOwnProps &
  Omit<ComponentPropsWithoutRef<"span">, keyof TextOwnProps | "children">;

/**
 * The typography recipe: one readable size and ink tier per role, with optional
 * mono and tabular figures for keys, branches and counts.
 */
export function Text({
  as,
  variant,
  tone,
  weight,
  mono,
  tabular,
  truncate,
  preserve,
  className,
  ...props
}: TextProps) {
  const Component = as ?? "span";
  return (
    <Component
      className={cn(
        textVariants({ variant, tone, weight, mono, tabular, truncate, preserve }),
        className,
      )}
      {...props}
    />
  );
}
