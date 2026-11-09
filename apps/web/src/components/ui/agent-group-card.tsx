import { Children, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { CollapsibleTrigger } from "./collapsible";
import { DisclosureChevron } from "./disclosure-chevron";

/** A bordered card that gathers the agents one turn started, such as a fan-out of subagents. */
export function AgentGroupCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="agent-group-card"
      className={cn(
        "min-w-0 overflow-hidden rounded-(--r-group) border border-border bg-card",
        className,
      )}
      {...props}
    />
  );
}

const STATUS_TONE = {
  active: "text-(--accent-ink)",
  failed: "text-(--stop-ink)",
  settled: "text-(--houston)",
} as const;

/** The card's disclosure: agent marks, the count, each state's count, the group's time. */
export function AgentGroupTrigger({
  avatars,
  title,
  status,
  tone,
  elapsed,
  open,
  ...props
}: Omit<ComponentProps<typeof CollapsibleTrigger>, "children" | "title"> & {
  readonly avatars: ReactNode;
  readonly title: string;
  readonly status: string;
  readonly tone: keyof typeof STATUS_TONE;
  readonly elapsed: ReactNode;
  readonly open: boolean;
}) {
  return (
    <CollapsibleTrigger
      data-slot="agent-group-trigger"
      aria-label={`${title}, ${status}`}
      className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      {...props}
    >
      {avatars}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-headline font-medium text-(--t1)">{title}</span>
        <span className={cn("truncate text-callout", STATUS_TONE[tone])}>{status}</span>
      </span>
      <span className="shrink-0 text-callout text-(--houston) tabular-nums">{elapsed}</span>
      <span className="shrink-0 text-(--houston)">
        <DisclosureChevron open={open} />
      </span>
    </CollapsibleTrigger>
  );
}

/** At most this many marks overlap; the rest fold into a count, so the heading keeps its width. */
const AVATAR_STACK_LIMIT = 3;

/** Agent marks drawn over one another, with a count for those past the limit. */
export function AgentAvatarStack({ children }: { readonly children: ReactNode }) {
  const avatars = Children.toArray(children);
  const hidden = avatars.length - AVATAR_STACK_LIMIT;
  return (
    <span aria-hidden className="flex shrink-0 items-center *:not-first:-ms-1.5">
      {avatars.slice(0, AVATAR_STACK_LIMIT)}
      {hidden > 0 ? (
        <span className="relative inline-flex h-6 min-w-6 items-center justify-center rounded-(--r-pill) border border-border bg-muted px-1 text-caption text-(--t2) ring-2 ring-card tabular-nums">
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/** The expanded list under the heading. */
export function AgentGroupRows({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="agent-group-rows"
      className={cn("grid gap-0.5 border-t border-border p-1", className)}
      {...props}
    />
  );
}

/** One agent's row: put this on the row's own element, a button when it opens the agent. */
export const AGENT_GROUP_ROW_CLS =
  "group/agent-row flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left";

export const AGENT_GROUP_ROW_INTERACTIVE_CLS =
  "cursor-pointer transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

/** The row's two lines: the agent's title, then its state or the start of its report. */
export function AgentGroupRowText({
  title,
  detail,
}: {
  readonly title: ReactNode;
  readonly detail: ReactNode;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-body font-medium text-(--t1)">{title}</span>
      <span className="truncate text-callout text-(--houston)">{detail}</span>
    </span>
  );
}

/** Time and the open affordance at the row's end. */
export function AgentGroupRowTrailing({
  elapsed,
  opens,
}: {
  readonly elapsed: ReactNode;
  readonly opens: boolean;
}) {
  return (
    <>
      <span className="shrink-0 text-callout text-(--houston) tabular-nums">{elapsed}</span>
      {opens ? (
        <span className="shrink-0 text-(--houston) transition-colors group-hover/agent-row:text-(--t1)">
          <DisclosureChevron open={false} />
        </span>
      ) : null}
    </>
  );
}
