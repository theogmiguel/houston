import { BookmarkIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

export const ComposerStashBadge = memo(function ComposerStashBadge(props: {
  count: number;
  menuOpen: boolean;
  /** Bumped per stash; each new key replays the pulse. 0 means never pulsed. */
  pulseKey: number;
  onToggleMenu: () => void;
}) {
  if (props.count === 0) return null;
  const pulsed = props.pulseKey > 0;

  return (
    <button
      type="button"
      data-prompt-stash-badge="true"
      aria-label={`Stashed prompts: ${props.count}. Open stash.`}
      aria-expanded={props.menuOpen}
      className={cn(
        "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.25 rounded-(--r-pill) bg-muted px-2 text-xs text-secondary-foreground outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        props.menuOpen ? "pointer-events-none text-foreground" : "hover:text-foreground",
        // The button keeps its identity (focus, hover) across stashes. Swapping between two
        // identical keyframes restarts the pill's animation instead.
        pulsed &&
          (props.pulseKey % 2 === 0 ? "animate-stash-pulse-row-alt" : "animate-stash-pulse-row"),
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onToggleMenu}
    >
      <BookmarkIcon className="size-3.25" aria-hidden />
      <span>Stash</span>
      <span
        // Remounting the count per stash restarts its CSS pulse; no timer has to end it.
        key={props.pulseKey}
        className={cn(
          "font-semibold text-foreground tabular-nums",
          pulsed &&
            "animate-stash-pulse-count transition-[opacity,translate] duration-180 ease-out starting:translate-y-0.5 starting:opacity-0 motion-reduce:transition-none",
        )}
      >
        {props.count}
      </span>
    </button>
  );
});
