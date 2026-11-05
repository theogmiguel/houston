import { ChevronDownIcon, PaperclipIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MOTION_RISE_IN, MOTION_RISE_OUT } from "../ui/motion-recipes";

export function WorkspaceFileDropOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
      data-chat-workspace-drop-overlay="true"
    >
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
      >
        <PaperclipIcon className="size-4 text-(--accent-ink)" aria-hidden="true" />
        Drop files to attach
      </div>
    </div>
  );
}

/**
 * Sits `bottom` pixels up, clear of the composer and its attached banners. The summary names
 * what waits at the end of the timeline, which is out of view while it shows.
 */
export function ScrollToEndButton(props: {
  readonly bottom: number;
  readonly summary: string | null;
  readonly open: boolean;
  readonly onScrollToEnd: () => void;
}) {
  return (
    <div
      aria-hidden={!props.open || undefined}
      inert={!props.open}
      className={cn(
        "chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5",
        props.open ? MOTION_RISE_IN : MOTION_RISE_OUT,
      )}
      style={{ bottom: props.bottom }}
    >
      <Button
        data-scroll-to-end="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onScrollToEnd}
        className={props.open ? "pointer-events-auto" : undefined}
        size="xs"
        variant="glass"
      >
        <ChevronDownIcon className="size-3.5" />
        Scroll to end
        {props.summary === null ? null : (
          <span className="text-muted-foreground">
            <span aria-hidden>· </span>
            {props.summary}
          </span>
        )}
      </Button>
    </div>
  );
}
