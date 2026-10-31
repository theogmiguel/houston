import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--r-ctl)] border font-medium text-[13px] outline-none transition-[background-color,color] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-[0.45] aria-disabled:cursor-not-allowed aria-disabled:opacity-[0.45] [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-[var(--r-ctl)] px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-7 px-3",
        icon: "size-7",
        "icon-lg": "size-9",
        "icon-micro": "size-5 rounded-[var(--r-badge)] p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-tiny": "size-4 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[22px] rounded-[var(--r-ctl)] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-3.5",
        micro:
          "h-5 gap-1 rounded-[var(--r-badge)] px-1.5 text-[11px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[22px] gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        selection:
          "h-[26px] gap-1.5 rounded-[7px] px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        "sm-multiline":
          "min-h-[22px] gap-1.5 px-2 py-1 whitespace-normal [&_svg:not([class*='size-'])]:size-3.5",
        xl: "h-10 px-4 text-base [&_svg:not([class*='size-'])]:size-5",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [:hover,[data-pressed]]:bg-[var(--primary-hover)]",
        primary:
          "border-transparent bg-[var(--accent)] text-white [:hover,[data-pressed]]:bg-[var(--accent-hover)]",
        destructive:
          "border-transparent bg-[var(--danger-fill)] text-white [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--danger-fill)_90%,black)]",
        danger:
          "border-transparent bg-transparent text-destructive-foreground [:hover,[data-pressed]]:bg-[var(--danger-wash)]",
        "danger-solid":
          "border-transparent bg-[var(--danger-fill)] text-white [:hover,[data-pressed]]:bg-[color-mix(in_srgb,var(--danger-fill)_90%,black)]",
        "destructive-outline":
          "border-border bg-transparent text-destructive-foreground [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-error-surface",
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-secondary-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        "ghost-muted":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        "ghost-destructive":
          "[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-error-surface [:hover,[data-pressed]]:bg-error-surface [:hover,[data-pressed]]:text-destructive",
        glass:
          "surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        "media-close":
          "[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover,[data-pressed]]:bg-black/80 focus-visible:ring-white",
        "media-navigation":
          "[--control-icon-color:currentColor] absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover,[data-pressed]]:bg-white/10 [:hover,[data-pressed]]:text-white focus-visible:ring-white focus-visible:ring-offset-transparent",
        outline:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-border bg-card text-foreground [:hover,[data-pressed]]:border-[var(--border-hover)] [:hover,[data-pressed]]:bg-[var(--surface-raised)]",
        overlay: "border-transparent bg-black/70 text-white/65 [:hover,[data-pressed]]:bg-black/90",
        secondary:
          "border-border bg-card text-foreground [:active,[data-pressed]]:bg-secondary [:hover,[data-pressed]]:border-[var(--border-hover)] [:hover,[data-pressed]]:bg-[var(--surface-raised)]",
        raised:
          "border-transparent bg-[var(--surface-raised)] text-foreground shadow-[var(--shadow-2)] [:hover,[data-pressed]]:bg-[var(--surface-raised)]",
        "warning-outline":
          "border-warning/32 bg-warning-surface text-warning-foreground shadow-xs/5 [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-warning/40 [:hover,[data-pressed]]:bg-warning/16 dark:[:hover,[data-pressed]]:bg-warning/24",
      },
    },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants, type ButtonSize, type ButtonVariant };

const inlineButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64",
  {
    defaultVariants: { tone: "default" },
    variants: {
      tone: {
        default: "text-foreground",
        muted: "text-muted-foreground hover:text-foreground",
        destructive: "text-destructive/80 hover:text-destructive",
        picker:
          "gap-1 text-foreground decoration-from-font underline-offset-4 data-popup-open:underline",
      },
    },
  },
);

export function InlineButton({
  className,
  tone,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof inlineButtonVariants>) {
  const defaultProps = {
    className: cn(inlineButtonVariants({ tone }), className),
    "data-slot": "inline-button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
