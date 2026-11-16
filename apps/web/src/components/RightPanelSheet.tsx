import { type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  /** The phone presents the panel as a full-window sheet with its own Back control. */
  phone?: boolean;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={0}
        side="right"
        showCloseButton={false}
        {...(props.phone ? { variant: "phone-page" as const } : {})}
        keepMounted
        className={cn(
          "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]",
        )}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
