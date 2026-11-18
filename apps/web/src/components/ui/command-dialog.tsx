import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";
import { useRef } from "react";
import type * as React from "react";
import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";
import { AUTOCOMPLETE_START_ADDON_CLASS } from "~/components/ui/autocomplete-styles";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Input } from "~/components/ui/input";

// The palette's frame, apart from the Autocomplete in ./command, which loads with its results.
const COMMAND_INPUT_FRAME_CLASS =
  "relative border-b border-border px-[var(--command-shell-inset)] py-2.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]";
const COMMAND_INPUT_CLASS =
  "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0 has-focus-visible:outline-0! placeholder:text-placeholder *:data-[slot=autocomplete-input]:ps-9! sm:*:data-[slot=autocomplete-input]:ps-[calc(var(--command-shell-inset)+1.5rem)]!";

const CommandDialog = CommandDialogPrimitive.Root;

const CommandDialogPortal = CommandDialogPrimitive.Portal;

function CommandDialogTrigger(props: CommandDialogPrimitive.Trigger.Props) {
  return <CommandDialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />;
}

function CommandDialogBackdrop({ className, ...props }: CommandDialogPrimitive.Backdrop.Props) {
  return (
    <CommandDialogPrimitive.Backdrop
      // The palette floats over a busy workspace, so it dims more than an ordinary dialog.
      className={cn(
        DIALOG_BACKDROP_CLASS,
        "[--dialog-scrim:color-mix(in_srgb,#000_60%,transparent)]",
        className,
      )}
      data-slot="command-dialog-backdrop"
      {...props}
    />
  );
}

function CommandDialogViewport({ className, ...props }: CommandDialogPrimitive.Viewport.Props) {
  // Short desktop windows would put the search field under the native window controls.
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const titlebarStyle = {
    "--command-titlebar-height": `${nativeTitlebarHeight}px`,
  } as React.CSSProperties;
  return (
    <CommandDialogPrimitive.Viewport
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 pt-[max(--spacing(4),4vh,calc(var(--command-titlebar-height)+--spacing(2)))] pb-[max(--spacing(4),4vh)] sm:pt-[max(10vh,calc(var(--command-titlebar-height)+--spacing(2)))] sm:pb-[10vh]",
        className,
      )}
      data-slot="command-dialog-viewport"
      style={titlebarStyle}
      {...props}
    />
  );
}

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: CommandDialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <CommandDialogPortal>
      <CommandDialogBackdrop onPointerDown={onBackdropPointerDown} />
      <CommandDialogViewport>
        <CommandDialogPrimitive.Popup
          // The first tabbable can be an input addon, such as a submenu's Back button.
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
          ref={popupRef}
          className={cn(
            DIALOG_POPUP_CLASS,
            "pointer-events-auto max-h-105 max-w-[640px] rounded-(--r-group) text-foreground",
            className,
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </CommandDialogPrimitive.Popup>
      </CommandDialogViewport>
    </CommandDialogPortal>
  );
}

/** CommandInput's look without its Autocomplete, for a palette whose results are still loading. */
function CommandInputFallback({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <div className={COMMAND_INPUT_FRAME_CLASS}>
      <div className="relative w-full text-foreground">
        <div
          aria-hidden="true"
          className={AUTOCOMPLETE_START_ADDON_CLASS}
          data-slot="autocomplete-start-addon"
        >
          <SearchIcon className="translate-x-0.5 text-icon-muted" />
        </div>
        <Input
          autoFocus
          className={cn(COMMAND_INPUT_CLASS, className)}
          data-slot="autocomplete-input"
          nativeInput
          size="lg"
          {...props}
        />
      </div>
    </div>
  );
}

export {
  COMMAND_INPUT_CLASS,
  COMMAND_INPUT_FRAME_CLASS,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandInputFallback,
};
