import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteListHeading,
  AutocompleteListVirtualized,
} from "~/components/ui/autocomplete";
import { COMMAND_INPUT_CLASS, COMMAND_INPUT_FRAME_CLASS } from "~/components/ui/command-dialog";
import { Button } from "~/components/ui/button";

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}

function CommandInput({
  className,
  placeholder,
  endAddon,
  ...props
}: React.ComponentProps<typeof AutocompleteInput> & { endAddon?: React.ReactNode }) {
  return (
    <div className={COMMAND_INPUT_FRAME_CLASS}>
      <AutocompleteInput
        autoFocus
        className={cn(
          COMMAND_INPUT_CLASS,
          endAddon && "*:data-[slot=autocomplete-input]:pe-16!",
          className,
        )}
        placeholder={placeholder}
        size="lg"
        startAddon={<SearchIcon className="translate-x-0.5 text-icon-muted" />}
        {...props}
      />
      {endAddon ? (
        <span className="pointer-events-none absolute inset-y-0 end-[var(--command-shell-inset)] flex items-center">
          {endAddon}
        </span>
      ) : null}
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListVirtualized({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListVirtualized>) {
  return (
    <AutocompleteListVirtualized
      className={cn("flex max-h-[inherit] min-h-0 flex-col", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandListHeading({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteListHeading>) {
  return (
    <AutocompleteListHeading className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-[var(--r-group)] not-has-[+[data-slot=command-footer]]:rounded-b-[var(--r-group)] bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  );
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

// Pass active to override primitive hover/keyboard highlights when the palette tracks its own row.
function CommandItem({
  className,
  active,
  ...props
}: React.ComponentProps<typeof AutocompleteItem> & { active?: boolean }) {
  return (
    <AutocompleteItem
      className={cn(
        "min-h-9 rounded-[var(--r-selection)] px-2.5 py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
        active !== undefined &&
          "cursor-pointer hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        active && "bg-[var(--sel)]! text-hover-foreground!",
        className,
      )}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--r-group)-1px)] border-t border-border px-[var(--command-content-inset)] py-2 font-medium text-xs text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

function CommandFooterAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="xs"
      className={cn("h-auto px-2 text-xs hover:bg-transparent", className)}
    />
  );
}

export {
  Command,
  CommandCollection,
  CommandFooter,
  CommandFooterAction,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandListHeading,
  CommandListVirtualized,
  CommandPanel,
  CommandShortcut,
};
