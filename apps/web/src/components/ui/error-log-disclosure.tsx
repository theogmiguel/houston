import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { MOTION_DISCLOSURE_ROTATE } from "./motion-recipes";

/** The error report behind a "Show log" disclosure, for errors whose headline already says enough. */
export function ErrorLogDisclosure({ report }: { report: string }) {
  return (
    <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0", MOTION_DISCLOSURE_ROTATE, "group-open:rotate-90")}
        />
        Show log
      </summary>
      <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
        {report}
      </pre>
    </details>
  );
}
