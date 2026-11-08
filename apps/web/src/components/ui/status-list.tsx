import { CheckIcon, ChevronRightIcon, CircleMinusIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "./button";
import { MOTION_DISCLOSURE_ROTATE } from "./motion-recipes";

/** A bordered card of one-line status rows, such as the providers on the welcome screen. */
export function StatusList({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="status-list"
      className={cn(
        "overflow-hidden rounded-(--r-group) border border-border bg-card text-left",
        className,
      )}
      {...props}
    />
  );
}

/** One status row: a ready check or a muted dash, the label, a muted detail and an optional action. */
export function StatusListRow({
  ready,
  label,
  detail,
  action,
  divided = false,
}: {
  readonly ready: boolean;
  readonly label: ReactNode;
  readonly detail: ReactNode;
  /** `link` is the install-style hint; `ghost` is a quiet button such as Sign in. */
  readonly action?: {
    readonly label: string;
    readonly emphasis: "link" | "ghost";
    readonly onClick: () => void;
  };
  readonly divided?: boolean;
}) {
  return (
    <div
      data-slot="status-list-row"
      className={cn("flex h-9 items-center gap-2.5 px-3.5", divided && "border-t border-border")}
    >
      {ready ? (
        <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <CircleMinusIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden="true" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          ready ? "text-foreground" : "text-secondary-foreground",
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      {action !== undefined ? (
        <Button
          size="xs"
          variant={action.emphasis}
          className={action.emphasis === "link" ? "text-info-foreground" : undefined}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A row that expands inline to reveal more rows; the chevron turns on the disclosure motion role. */
export function StatusListDisclosure({
  summary,
  divided = false,
  children,
}: {
  readonly summary: ReactNode;
  readonly divided?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details data-slot="status-list-disclosure" className="group">
      <summary
        className={cn(
          "flex h-9 cursor-pointer list-none items-center gap-2.5 px-3.5 text-sm text-secondary-foreground outline-none hover:bg-hover focus-visible:bg-hover [&::-webkit-details-marker]:hidden",
          divided && "border-t border-border",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-icon-muted",
            MOTION_DISCLOSURE_ROTATE,
            "group-open:rotate-90",
          )}
        />
        {summary}
      </summary>
      {children}
    </details>
  );
}
