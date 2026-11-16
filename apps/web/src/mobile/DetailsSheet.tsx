import type { ReactNode } from "react";

import { PhoneSheetHeader } from "../components/ui/phone-sheet-header";
import { Sheet, SheetPopup } from "../components/ui/sheet";

/**
 * The phone thread's details card in a bottom sheet with the shared sheet header and a scrim.
 * The sheet sizes to its content up to 85% of the window; the bar's Details button sits under
 * the scrim, so the sheet's own close control and a scrim tap close it.
 */
export function DetailsSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup
        side="bottom"
        variant="phone"
        showCloseButton={false}
        data-phone-details-sheet=""
        className="max-h-[85dvh]"
      >
        <PhoneSheetHeader title="Thread details" />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </SheetPopup>
    </Sheet>
  );
}
