import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { buttonVariants } from "./button";
import { renderClosingPositioner } from "./closing-positioner";
import { Input, type InputProps } from "./input";
import { overlayMotion } from "./overlayMotion";
import { Spinner } from "./spinner";

const Menu = MenuPrimitive.Root;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  collisionAvoidance,
  anchor,
  keepMounted = false,
  width = "default",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  collisionAvoidance?: MenuPrimitive.Positioner.Props["collisionAvoidance"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  keepMounted?: boolean;
  width?: "default" | "content";
}) {
  return (
    <MenuPrimitive.Portal keepMounted={keepMounted}>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className="z-[130]"
        data-slot="menu-positioner"
        render={renderClosingPositioner}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "dropdown-glass relative flex rounded-[var(--r-group)] outline-none focus:outline-none",
            overlayMotion,
            // Electron drag hit-testing ignores z-index; opt portaled menus out to keep overlapping rows
            // hoverable.
            "[-webkit-app-region:no-drag]",
            "max-w-[calc(100vw-2rem)]",
            width === "content" ? "w-max min-w-0" : "min-w-[min(15rem,calc(100vw-2rem))]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1.5">{children}</div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** A menu's filter field, drawn like `ComboboxSearchInput` so every searchable popup matches. */
function MenuSearchInput({
  busy = false,
  onKeyDown,
  ...props
}: Omit<InputProps, "className" | "size" | "unstyled" | "nativeInput"> & { busy?: boolean }) {
  return (
    <div className="min-w-0 shrink-0 px-2 pt-1.5 pb-1">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
        {busy ? (
          <Spinner
            aria-hidden="true"
            size="md"
            tone="muted"
            className="pointer-events-none absolute top-1.5 left-0"
          />
        ) : (
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
        )}
        <Input
          {...props}
          className="rounded-none bg-transparent text-sm [&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
          size="compact"
          unstyled
          onKeyDown={(event) => {
            // Menu typeahead would otherwise take the letters; arrows still reach the items.
            if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            onKeyDown?.(event);
          }}
        />
      </div>
    </div>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  density = "default",
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  density?: "default" | "touch";
  variant?: "default" | "destructive" | "ghost";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "[&>svg]:-mx-0.5 flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-[var(--r-selection)] px-2.5 text-[13px] text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-[var(--sel)] data-inset:ps-9 data-[variant=destructive]:text-destructive-foreground data-highlighted:text-hover-foreground data-disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>svg:not([class*='text-'])]:text-current [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>[data-slot=glyph-box]]:-mx-0.5 [&>[data-slot=glyph-box]]:pointer-events-none [&>[data-slot=glyph-box]:not([class*='opacity-'])]:opacity-80 [&>[data-slot=glyph-box]:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&>[data-slot=glyph-box]:not([class*='text-'])]:text-current [&>[data-slot=glyph-box]>svg:not([class*='size-'])]:size-4",
        variant === "ghost" &&
          buttonVariants({
            variant: "ghost",
            size: "compact",
            className: "h-auto min-h-8 w-full text-xs",
          }),
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuItemLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-item-label"
      className={cn(
        "min-w-0 truncate in-data-[density=touch]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:in-data-[density=touch]:py-[0.5em]",
        className,
      )}
      {...props}
    />
  );
}

/** Secondary text at the end of a menu row, such as why an item is unavailable. */
function MenuItemHint({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-item-hint"
      className={cn("ml-auto text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "icon" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center gap-2.5 rounded-[var(--r-selection)] ps-2.5 text-[13px] text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-[var(--sel)] data-highlighted:text-hover-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-2"
          : "grid-cols-[1rem_minmax(0,1fr)] pe-4",
        variant === "icon" && "grid-cols-[0.625rem_minmax(0,1fr)]",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className="inline-flex h-5 w-9 shrink-0 items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-(--motion-feedback) ease-standard [--thumb-size:1rem] [--thumb-travel:1rem] focus-visible:outline-2 focus-visible:outline-ring data-checked:bg-primary data-unchecked:bg-[var(--tog-off)] data-disabled:opacity-64"
            keepMounted
          >
            <span className="pointer-events-none block size-[var(--thumb-size)] shrink-0 rounded-full bg-(--thumb) shadow-[0_1px_2px_rgba(0,0,0,0.3)] in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] origin-left in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[var(--thumb-travel)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)] transition-[translate,border-radius,scale,transform-origin] duration-(--motion-feedback) ease-standard" />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator
            className={cn("col-start-1", variant === "icon" && "-mx-0.5")}
          >
            <svg
              className={variant === "icon" ? "size-3.5" : undefined}
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  hideIndicator: _hideIndicator = false,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  hideIndicator?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "[&_svg]:-mx-0.5 flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-[var(--r-selection)] px-2.5 text-[13px] text-foreground outline-none data-checked:bg-[var(--sel)] data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-highlighted:bg-[var(--sel)] data-highlighted:text-hover-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuRadioItemIndicator({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItemIndicator.Props) {
  return (
    <MenuPrimitive.RadioItemIndicator
      aria-hidden
      className={cn("flex shrink-0", className)}
      data-slot="menu-radio-item-indicator"
      {...props}
    >
      {children ?? <CheckIcon className="size-3.5" />}
    </MenuPrimitive.RadioItemIndicator>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "px-2.5 pt-2 pb-1 font-medium text-xs text-muted-foreground data-inset:ps-9",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2.5 my-1.5 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-[11px] text-secondary-label tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

/** Trailing muted text that says why a row is unavailable. */
function MenuReason({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ms-auto min-w-0 max-w-[60%] truncate text-secondary-label text-xs", className)}
      data-slot="menu-reason"
      {...props}
    />
  );
}

// Trailing value on a menu row, such as the time a snooze preset wakes at.
// Reads as text at the row's size; MenuShortcut is only for key chords.
function MenuItemDetail({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ms-auto shrink-0 ps-4 text-secondary-label tabular-nums", className)}
      data-slot="menu-item-detail"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  density = "default",
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
  density?: "default" | "touch";
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        // Exclude the last SVG so leading-icon margin rules cannot remove the chevron's ms-auto alignment.
        "[&>svg:not(:last-child)]:-mx-0.5 flex min-h-8 cursor-pointer items-center gap-2.5 rounded-[var(--r-selection)] px-2.5 text-[13px] text-foreground outline-none data-disabled:cursor-not-allowed data-disabled:pointer-events-none data-highlighted:bg-[var(--sel)] data-popup-open:bg-[var(--sel)] data-inset:ps-9 data-highlighted:text-hover-foreground data-popup-open:text-hover-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&>svg:not(:last-child):not([class*='opacity-'])]:opacity-80 [&_svg]:pointer-events-none [&>svg]:shrink-0",
        density === "touch" && "min-h-10 sm:min-h-10",
        className,
      )}
      data-density={density}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="-me-0.5 ms-auto opacity-80" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  Menu,
  Menu as DropdownMenu,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuSearchInput,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItemHint,
  MenuItemLabel,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuRadioItemIndicator,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuReason,
  MenuItemDetail,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};
