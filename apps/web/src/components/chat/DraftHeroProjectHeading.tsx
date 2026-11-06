import type { ReactNode } from "react";

/**
 * "What should we build in <project>?" as one heading. The project picker sits inline with the
 * sentence at every width; a name too long for the line wraps below it instead of splitting the
 * heading into a title and an orphaned name.
 */
export function DraftHeroProjectHeading({ children }: { children: ReactNode }) {
  return (
    <h1
      className="flex w-full flex-wrap items-baseline justify-center gap-x-2 text-center font-medium text-2xl text-foreground tracking-tight sm:text-3xl"
    >
      <span>What should we build in</span>
      <span className="flex min-w-0 max-w-full items-baseline justify-center">
        <span className="min-w-0">{children}</span>
        <span className="shrink-0">?</span>
      </span>
    </h1>
  );
}
