import { createContext, useContext } from "react";
import { RAIL_KBD_CLS } from "../ui/sidebar-rail-recipes";

/** Jump shortcut labels by thread key; null while the jump modifier is not held. */
export const ThreadJumpHintContext = createContext<ReadonlyMap<string, string> | null>(null);

export function useThreadJumpHint(threadKey: string): string | null {
  return useContext(ThreadJumpHintContext)?.get(threadKey) ?? null;
}

/** The shortcut that jumps to a row, shown where the row's age sits. */
export function JumpHintBadge({ label }: { label: string }) {
  return (
    <kbd
      data-thread-jump-hint=""
      className={`inline-flex h-4 items-center rounded-(--r-badge) px-1 ${RAIL_KBD_CLS}`}
    >
      {label}
    </kbd>
  );
}
