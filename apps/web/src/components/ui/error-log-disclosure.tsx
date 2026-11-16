import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { MOTION_DISCLOSURE_ROTATE, MOTION_FEEDBACK } from "./motion-recipes";

/** The error report behind a "Show log" disclosure, for errors whose headline already says enough. */
export function ErrorLogDisclosure({ report }: { report: string }) {
  return (
    <details className="group mt-3">
      {/* The negative margin keeps the chevron on the card's text edge while the hover fill reaches past it. */}
      <summary
        className={cn(
          "-ml-2 inline-flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-(--r-ctl) px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden",
          MOTION_FEEDBACK,
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0", MOTION_DISCLOSURE_ROTATE, "group-open:rotate-90")}
        />
        Show log
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
        {report}
      </pre>
    </details>
  );
}
