import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { MOTION_DISCLOSURE_ROTATE } from "./motion-recipes";

/** The chevron of a disclosure control: it turns a quarter as the section opens. */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn("size-3 shrink-0", MOTION_DISCLOSURE_ROTATE, open && "rotate-90")}
    />
  );
}
