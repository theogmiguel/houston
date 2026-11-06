import { CheckIcon, ChevronRightIcon, CircleMinusIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatProvidersToSet } from "../../onboarding/welcomeProviders.logic";
import { Button } from "./button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  DISCLOSURE_CHEVRON_MOTION,
} from "./collapsible";

export interface ProviderStatusRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  /** The row's one action, such as "Sign in" or "How to install"; null when there is none. */
  readonly actionLabel: string | null;
}

/**
 * Ready providers read as one quiet line; the rest sit behind a disclosure so their
 * install and sign-in actions stay reachable without competing with the page's primary action.
 */
function ProviderStatusSummary({
  readyLabel,
  readyCount,
  pending,
  onAction,
  className,
}: {
  /** The sentence for ready providers, such as "Claude Code and Codex ready"; null when none. */
  readyLabel: string | null;
  readyCount: number;
  pending: ReadonlyArray<ProviderStatusRow>;
  onAction: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full flex-col items-center gap-1.5 text-left", className)}>
      {readyLabel !== null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
          {readyLabel}
        </p>
      ) : null}
      {pending.length > 0 ? (
        <Collapsible className="w-full">
          <CollapsibleTrigger className="group mx-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon
              className={cn("size-3 group-data-panel-open:rotate-90", DISCLOSURE_CHEVRON_MOTION)}
              aria-hidden="true"
            />
            {formatProvidersToSet({ pending: pending.length, ready: readyCount })}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-1.5 overflow-hidden rounded-(--r-group) border border-border bg-card">
              {pending.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    "flex h-9 items-center gap-2.5 px-3.5",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <CircleMinusIcon
                    className="size-3.5 shrink-0 text-icon-muted"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
                    {row.label}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{row.detail}</span>
                  {row.actionLabel !== null ? (
                    <Button size="xs" variant="ghost" onClick={onAction}>
                      {row.actionLabel}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

export { ProviderStatusSummary };
