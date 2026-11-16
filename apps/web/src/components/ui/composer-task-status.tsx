import type { OrchestrationV2PlanStep } from "@houston-app/contracts";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { StreamingGlyph } from "../chat/TimelineRowParts";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./collapsible";

/**
 * The agent's todo list as a tray above the composer: one summary row with
 * progress that opens to every step. Nothing renders without steps.
 */
export function ComposerTaskStatus({ steps }: { steps: ReadonlyArray<OrchestrationV2PlanStep> }) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "running");
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <section
        data-composer-task-status={expanded ? "expanded" : "collapsed"}
        className="mb-1 flex min-w-0 flex-col overflow-hidden rounded-(--r-group) border border-border bg-card"
      >
        <CollapsibleTrigger className="flex min-h-8 w-full min-w-0 items-center gap-2 px-2.5 text-start outline-none hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-(--houston)" />
          <span className="shrink-0 text-headline font-medium text-foreground">Tasks</span>
          <span className="min-w-0 flex-1 truncate text-callout text-muted-foreground">
            {expanded ? null : current?.text}
          </span>
          {expanded ? null : (
            <span
              aria-hidden
              className="flex max-w-24 min-w-0 items-center gap-0.5 overflow-hidden"
            >
              {steps.map((step) => (
                <span
                  key={step.id}
                  className={cn(
                    "h-1 w-3 flex-none rounded-full",
                    step.status === "completed"
                      ? "bg-foreground"
                      : step.status === "running"
                        ? "bg-muted-foreground"
                        : "bg-muted-foreground/25",
                  )}
                />
              ))}
            </span>
          )}
          <span
            aria-label={`${completed} of ${steps.length} tasks done`}
            className="shrink-0 text-callout text-muted-foreground tabular-nums"
          >
            {completed}/{steps.length}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              !expanded && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ol className="grid gap-2 px-2.5 pb-2.5 text-callout">
            {steps.map((step) => (
              <li
                key={step.id}
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  step.status === "pending" ? "text-muted-foreground" : "text-secondary-foreground",
                )}
              >
                {step.status === "completed" ? (
                  <CheckCircle2Icon
                    aria-hidden
                    className="size-3.5 shrink-0 text-success-foreground"
                  />
                ) : step.status === "running" ? (
                  <StreamingGlyph />
                ) : (
                  <CircleIcon aria-hidden className="size-3.5 shrink-0 text-(--houston)" />
                )}
                <span className="min-w-0 flex-1 truncate">{step.text}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {step.status === "running"
                    ? "now"
                    : step.durationMs !== undefined
                      ? `${Math.round(step.durationMs / 1000)}s`
                      : null}
                </span>
              </li>
            ))}
          </ol>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}
