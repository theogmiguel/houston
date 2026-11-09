import type { ReactNode } from "react";

import { Sheet, SheetPopup, SheetTitle } from "../components/ui/sheet";

/**
 * The phone thread's details card in a bottom sheet. It is not modal: the bar's Details button
 * stays reachable and closes it, and the sheet's own close control does the same.
 */
export function DetailsSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={false}
      disablePointerDismissal
    >
      <SheetPopup
        side="bottom"
        data-phone-details-sheet=""
        showBackdrop={false}
        className="h-[85dvh] max-h-[85dvh]"
      >
        <div className="px-4 pt-3 pb-2">
          <SheetTitle>Thread details</SheetTitle>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-safe">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
