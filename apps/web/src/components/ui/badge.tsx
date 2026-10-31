import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--r-badge)] border border-transparent font-semibold text-[11px] leading-none outline-none transition-shadow focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        control: "h-6 min-w-6 rounded-[var(--control-radius)] px-2 text-xs",
        default: "h-5 min-w-5 rounded-[var(--r-ctl)] px-1.5",
        lg: "h-5.5 min-w-5.5 px-1.5 text-xs",
        // Fractional leading rounds font metrics and raises fixed-height labels, especially under zoom.
        sm: "h-4 min-w-4 px-1 text-[0.625rem]",
      },
      variant: {
        default: "bg-[var(--sel)] text-secondary-foreground",
        destructive: "bg-destructive text-white [button&,a&]:hover:bg-destructive/90",
        error: "bg-error-surface text-destructive-foreground",
        info: "bg-info/14 text-info-foreground dark:bg-info/18",
        outline: "border-border bg-card text-foreground [button&,a&]:hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90",
        success: "bg-success/14 text-success-foreground dark:bg-success/18",
        warning: "bg-warning-surface text-warning-foreground",
        label:
          "bg-[color-mix(in_srgb,var(--label)_8%,transparent)] text-[color-mix(in_srgb,var(--label)_30%,var(--color-foreground))] dark:bg-[color-mix(in_srgb,var(--label)_12%,transparent)] dark:text-[color-mix(in_srgb,var(--label)_45%,var(--color-foreground))]",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
