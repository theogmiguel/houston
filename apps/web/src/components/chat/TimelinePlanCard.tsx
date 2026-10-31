import type { OrchestrationV2PlanStep } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { StreamingGlyph } from "./TimelineRowParts";
import { cn } from "~/lib/utils";

/** The agent's running plan, drawn as the Timeline board's checklist card. */
export function TimelinePlanCard({ steps }: { steps: ReadonlyArray<OrchestrationV2PlanStep> }) {
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  return (
    <section
      aria-label="Plan"
      className="flex flex-col gap-2 rounded-(--r-group) border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-headline font-semibold text-foreground">Plan</span>
        <span className="text-callout text-(--t3) tabular-nums">
          {completed} of {steps.length}
        </span>
      </div>
      {steps.map((step) => {
        const done = step.status === "completed";
        const running = step.status === "running";
        return (
          <div key={step.id} className="flex items-center gap-2.5">
            {done ? (
              <CheckCircle2Icon aria-hidden className="size-3.5 shrink-0 text-(--t3)" />
            ) : running ? (
              <StreamingGlyph />
            ) : (
              <CircleIcon aria-hidden className="size-3.5 shrink-0 text-(--t3)" />
            )}
            <span
              className={cn(
                "min-w-0",
                done && "text-(--t3) line-through",
                running ? "text-foreground" : !done && "text-(--t2)",
              )}
            >
              {step.text}
            </span>
          </div>
        );
      })}
    </section>
  );
}
