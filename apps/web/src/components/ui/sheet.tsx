import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { ControlledOpenContext, renderRetainedPopup } from "~/components/ui/dialog";

function Sheet<Payload>(props: SheetPrimitive.Root.Props<Payload>) {
  return (
    <ControlledOpenContext value={props.open}>
      <SheetPrimitive.Root {...props} />
    </ControlledOpenContext>
  );
}

const SheetPortal = SheetPrimitive.Portal;
const SheetClose = SheetPrimitive.Close;

function SheetBackdrop({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-(--z-sheet) bg-(--sheet-scrim) transition-opacity duration-(--motion-modal-in) ease-standard data-ending-style:duration-(--motion-modal-out) data-ending-style:ease-exit data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      data-slot="sheet-backdrop"
      // A sheet opened beneath another dialog root is "nested", and Base UI then omits the backdrop.
      forceRender
      {...props}
    />
  );
}

function SheetViewport({
  className,
  side,
  variant = "default",
  ...props
}: SheetPrimitive.Viewport.Props & {
  side?: "right" | "left" | "top" | "bottom";
  variant?: "default" | "inset" | "phone" | "phone-page";
}) {
  return (
    <SheetPrimitive.Viewport
      className={cn(
        "fixed inset-0 z-(--z-sheet) grid",
        side === "bottom" && "grid grid-rows-[1fr_auto] pt-12",
        side === "top" && "grid grid-rows-[auto_1fr] pb-12",
        side === "left" && "flex justify-start",
        side === "right" && "flex justify-end",
        variant === "inset" && "sm:p-4",
        className,
      )}
      data-slot="sheet-viewport"
      {...props}
    />
  );
}

function SheetPopup({
  className,
  children,
  showCloseButton = true,
  showBackdrop = true,
  keepMounted = false,
  transitionDurationMs,
  side = "right",
  variant = "default",
  style,
  ...props
}: SheetPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  /** A non-modal sheet that leaves the page behind it visible and interactive omits the scrim. */
  showBackdrop?: boolean;
  keepMounted?: boolean;
  transitionDurationMs?: number;
  side?: "right" | "left" | "top" | "bottom";
  /** `phone` is the bottom sheet of the phone layout; `phone-page` fills the window as a page. */
  variant?: "default" | "inset" | "phone" | "phone-page";
}) {
  const transitionStyle =
    transitionDurationMs === undefined
      ? undefined
      : ({ transitionDuration: `${transitionDurationMs}ms` } satisfies CSSProperties);
  const instant = transitionDurationMs === 0;

  return (
    <SheetPortal keepMounted={keepMounted}>
      {showBackdrop ? (
        <SheetBackdrop
          className={
            instant
              ? "transition-none! data-ending-style:opacity-100! data-starting-style:opacity-100!"
              : undefined
          }
          style={transitionStyle}
        />
      ) : null}
      <SheetViewport
        side={side}
        variant={variant}
        className={cn(!showBackdrop && "pointer-events-none")}
      >
        <SheetPrimitive.Popup
          className={cn(
            "relative flex max-h-full min-h-0 w-full min-w-0 flex-col bg-popover text-popover-foreground shadow-[var(--shadow-2)] transition-[opacity,translate] duration-(--motion-modal-in) ease-standard data-ending-style:duration-(--motion-modal-out) data-ending-style:ease-exit before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            side === "bottom" &&
              "row-start-2 border-t data-ending-style:translate-y-8 data-starting-style:translate-y-8",
            side === "top" &&
              "data-ending-style:-translate-y-8 data-starting-style:-translate-y-8 border-b",
            side === "left" &&
              "data-ending-style:-translate-x-8 data-starting-style:-translate-x-8 w-[calc(100%-(--spacing(12)))] max-w-md border-e",
            side === "right" &&
              "col-start-2 w-[calc(100%-(--spacing(12)))] max-w-md border-s data-ending-style:translate-x-8 data-starting-style:translate-x-8",
            // Rounded top corners, and a bottom inset of the safe area (at least 8px) on the
            // popup itself so no content row counts it twice.
            variant === "phone" && "rounded-t-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))]",
            variant === "phone-page" && "h-full! w-full! max-w-none! rounded-none border-s-0",
            variant === "inset" &&
              "before:hidden sm:rounded-[var(--r-dialog)] sm:border sm:**:data-[slot=sheet-footer]:rounded-b-[calc(var(--r-dialog)-1px)]",
            // Without a scrim the sheet is non-modal: its popup still takes pointers while the
            // positioning viewport lets them through to the page behind it.
            !showBackdrop && "pointer-events-auto",
            instant &&
              "transition-none! data-ending-style:translate-x-0! data-starting-style:translate-x-0! data-ending-style:translate-y-0! data-starting-style:translate-y-0! data-ending-style:opacity-100! data-starting-style:opacity-100!",
            className,
          )}
          data-slot="sheet-popup"
          render={keepMounted ? undefined : renderRetainedPopup}
          style={{ ...transitionStyle, ...style }}
          {...props}
        >
          {children}
          {showCloseButton && (
            <SheetPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon" variant="ghost" />}
            >
              <XIcon />
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </SheetViewport>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=sheet-popup]:has([data-slot=sheet-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="sheet-header"
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("font-semibold text-xl leading-none", className)}
      data-slot="sheet-title"
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="sheet-description"
      {...props}
    />
  );
}

export {
  Sheet,
  SheetPortal,
  SheetClose,
  SheetBackdrop,
  SheetBackdrop as SheetOverlay,
  SheetPopup,
  SheetPopup as SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
};
