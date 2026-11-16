import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

/** The per-item list of a line that stands for several, one entry per line. */
export function ThreadNowDetails({
  label,
  entries,
}: {
  readonly label: string;
  readonly entries: ReadonlyArray<ReactNode>;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} className="flex-none" />
        }
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverPopup
        aria-label="Details"
        tooltipStyle
        side="top"
        className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere"
      >
        <ul className="flex flex-col gap-1">
          {entries.map((entry, index) => (
            // The entries are a positional snapshot of one render; none is reordered.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} data-thread-now-detail="true">
              {entry}
            </li>
          ))}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
