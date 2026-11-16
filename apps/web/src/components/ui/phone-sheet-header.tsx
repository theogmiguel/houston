import { XIcon } from "lucide-react";

import { Button } from "./button";
import { SheetClose, SheetTitle } from "./sheet";

/** The one header every phone bottom sheet shares: title at the start, close centred on it. */
export function PhoneSheetHeader(props: { title: string }) {
  return (
    <div
      data-phone-sheet-header=""
      className="flex h-11 shrink-0 items-center justify-between pr-1 pl-4"
    >
      <SheetTitle className="min-w-0 flex-1 truncate font-semibold text-base leading-none">
        {props.title}
      </SheetTitle>
      <SheetClose
        aria-label="Close"
        className="size-11 shrink-0"
        render={<Button variant="ghost" size="icon" />}
      >
        <XIcon />
      </SheetClose>
    </div>
  );
}
