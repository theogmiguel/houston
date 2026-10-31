import { WorkLogBlock } from "./WorkLog";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import { memo, use, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { V2LifecycleRow } from "./V2LifecycleRow";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { subagentGroupSummaryText } from "./TimelineV2EventRow.logic";

export function V2EventTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type === "subagent" && (row.subagents?.length ?? 1) > 1) {
    return <V2SubagentGroup key={row.id} row={row} />;
  }
  if (item.type === "secret_request") {
    return (
      <SecretRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  if (item.type === "link_request") {
    return (
      <LinkRequestCard
        environmentId={ctx.activeThreadEnvironmentId}
        item={item}
        visibility={visibility}
      />
    );
  }
  return (
    <V2LifecycleRow
      environmentId={ctx.activeThreadEnvironmentId}
      item={item}
      resourceSummary={row.resourceSummary}
      runs={ctx.runs}
      onOpenThread={ctx.onOpenThread}
    />
  );
}

const V2SubagentGroup = memo(function V2SubagentGroup({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const groupId = `subagent-group:${row.id}`;
  const [expanded, setExpanded] = useState(() =>
    ctx.workGroupViewState.expandedEntries.has(groupId),
  );
  const members = (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
    item.type === "subagent" ? [item] : [],
  );
  const liveAgents = useAtomValue(
    environmentThreadDetails.threadAtom(
      scopeThreadRef(ctx.activeThreadEnvironmentId, row.projectedItem.item.threadId),
    ),
    (thread) => thread?.projection.subagents,
  );
  const agents = members.map((item) => {
    const live = liveAgents?.find((agent) => agent.id === item.subagentId);
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: live?.startedAt ?? item.startedAt,
      completedAt: live?.completedAt ?? item.completedAt,
    };
  });
  const summary = subagentGroupSummaryText(agents.map(({ status }) => status));
  const fullSummary = summary.running === null ? summary.label : `${summary.label} · ${summary.running}`;
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <Collapsible open={expanded} onOpenChange={toggleExpanded} data-subagent-group>
        <CollapsibleTrigger
          aria-label={fullSummary}
          className="group/subagent-group flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-headline text-(--t2) transition-colors hover:text-(--t1)"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.25 shrink-0 text-(--t3) transition-transform",
              !expanded && "-rotate-90",
            )}
          />
          <span className="shrink-0">{summary.label}</span>
          {summary.running === null ? null : (
            <span className="min-w-0 truncate text-(--t3)">· {summary.running}</span>
          )}
        </CollapsibleTrigger>
        {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
        <CollapsiblePanel animate={false}>
          {expanded ? (
            <div className="-mt-1 ms-[22px] mb-1 grid gap-0.5 border-l border-border ps-2.5">
              {members.map((item) => (
                <V2LifecycleRow
                  environmentId={ctx.activeThreadEnvironmentId}
                  key={item.id}
                  item={item}
                  runs={ctx.runs}
                  onOpenThread={ctx.onOpenThread}
                />
              ))}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </WorkLogBlock>
  );
});
