import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const Select = SelectPrimitive.Root;

const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 rounded-[var(--r-ctl)] border text-left text-[13px] outline-none transition-[color,box-shadow,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      variant: {
        default:
          "w-full min-w-36 border-border bg-[var(--field)] text-foreground pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-destructive [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='text-'])]:text-icon-muted",
        ghost:
          "border-transparent text-secondary-label focus-visible:outline-2 focus-visible:outline-ring data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
      },
      size: {
        compact: "h-7 gap-1 px-2 text-xs",
        default: "h-7 px-2.5",
        lg: "h-8 px-3",
        sm: "h-6 gap-1.5 px-2 text-xs",
        xs: "h-6 gap-1 px-2 text-xs",
      },
    },
  },
);

function SelectTrigger({
  className,
  size = "default",
  variant = "default",
  children,
  icon,
  ...props
}: SelectPrimitive.Trigger.Props &
  VariantProps<typeof selectTriggerVariants> & { icon?: React.ReactNode }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        {icon ?? <ChevronDownIcon className="-me-1 size-3.5 opacity-70" />}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectButton({
  className,
  size = "default",
  children,
  render,
  ...props
}: useRender.ComponentProps<"button"> & Pick<VariantProps<typeof selectTriggerVariants>, "size">) {
  const defaultProps = {
    className: cn(selectTriggerVariants({ size }), className),
    "data-slot": "select-trigger",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: {
      ...mergeProps<"button">(defaultProps, props),
      children: (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{children}</span>
          <ChevronDownIcon aria-hidden className="-me-1 size-3.5 shrink-0 opacity-70" />
        </>
      ),
    },
    render,
  });
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn("flex-1 truncate data-placeholder:text-placeholder", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = true,
  matchTriggerWidth = true,
  anchor,
  ...props
}: SelectPrimitive.Popup.Props & {
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  matchTriggerWidth?: boolean;
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] select-none"
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-[var(--r-group)] text-foreground outline-none"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            className="top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-lg)-1px)] before:bg-linear-to-b before:from-50% before:from-popover"
            data-slot="select-scroll-up-arrow"
          >
            <ChevronUpIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <div
            className={cn(
              "dropdown-glass relative h-full rounded-[var(--r-group)]",
              matchTriggerWidth && "min-w-(--anchor-width)",
            )}
          >
            <SelectPrimitive.List
              className={cn("max-h-(--available-height) overflow-y-auto p-1", className)}
              data-slot="select-list"
            >
              {children}
            </SelectPrimitive.List>
          </div>
          <SelectPrimitive.ScrollDownArrow
            className="bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-lg)-1px)] before:bg-linear-to-t before:from-50% before:from-popover"
            data-slot="select-scroll-down-arrow"
          >
            <ChevronDownIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  ...props
}: SelectPrimitive.Item.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex min-h-7 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-[var(--r-ctl)] px-2 text-[13px] outline-none data-selected:bg-[var(--sel)] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-[var(--sel)] data-highlighted:text-accent-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText
        className="min-w-0 flex-1 [&_svg:not([class*='text-'])]:text-muted-foreground"
        data-slot="select-item-text"
      >
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className="px-2 py-1.5 font-semibold text-[11px] text-muted-foreground"
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectButton,
  SelectValue,
  SelectPopup,
  SelectPopup as SelectContent,
  SelectItem,
  SelectGroup,
  SelectGroupLabel,
};
