import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const toggleVariants = cva(
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-[var(--r-ctl)] border font-medium text-[13px] text-foreground outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 aria-disabled:opacity-64 data-pressed:bg-input/64 data-pressed:text-accent-foreground [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 min-w-7 rounded-[var(--r-ctl)] px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-7 min-w-7 px-2",
        lg: "h-8 min-w-8 px-2.5",
        segmented: "h-6 min-w-0 rounded-[var(--r-badge)] px-2.5 text-xs",
        sm: "h-7 min-w-7 px-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 min-w-6 rounded-[var(--r-ctl)] px-1.5 text-xs",
      },
      variant: {
        default: "border-transparent",
        pill: "border-transparent rounded-full px-3 font-normal text-muted-foreground data-pressed:text-foreground",
        ghost:
          "border-transparent text-foreground shadow-none [:disabled,:active,[data-pressed]]:shadow-none before:shadow-none data-pressed:bg-accent data-pressed:text-accent-foreground disabled:opacity-100 disabled:text-muted-foreground disabled:[&_svg]:opacity-100",
        outline: "border-border bg-card hover:bg-[var(--surface-raised)] data-pressed:bg-accent",
        segmented:
          "border-transparent text-secondary-foreground shadow-none transition-colors before:shadow-none hover:bg-accent hover:text-foreground data-pressed:bg-[var(--surface-raised)] data-pressed:text-foreground data-pressed:shadow-[var(--shadow-seg)]",
      },
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
