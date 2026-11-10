import { WorkLogBlock } from "./WorkLog";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadDetails } from "../../state/threads";
import { memo, use, useState } from "react";
import * as DateTime from "effect/DateTime";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import {
  AgentAvatarStack,
  AgentGroupCard,
  AgentGroupRows,
  AgentGroupTrigger,
} from "../ui/agent-group-card";
import { AgentElapsed } from "./AgentElapsed";
import { EnvironmentSubagentAvatar, V2LifecycleRow } from "./V2LifecycleRow";
import { LinkRequestCard } from "./LinkRequestCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { subagentGroupSummary, subagentGroupTiming } from "./TimelineV2EventRow.logic";

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
    const startedAt = live?.startedAt ?? item.startedAt;
    const completedAt = live?.completedAt ?? item.completedAt;
    return {
      item,
      status: live?.status ?? item.status,
      startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
      completedAt: completedAt ? DateTime.formatIso(completedAt) : null,
    };
  });
  const summary = subagentGroupSummary(agents.map(({ status }) => status));
  const toggleExpanded = (open: boolean) => {
    ctx.onToggleWorkEntry(row.id, expanded);
    if (open) ctx.workGroupViewState.expandedEntries.add(groupId);
    else ctx.workGroupViewState.expandedEntries.delete(groupId);
    setExpanded(open);
  };
  return (
    <WorkLogBlock continues={row.continuesWorkLog}>
      <Collapsible open={expanded} onOpenChange={toggleExpanded} data-subagent-group>
        <AgentGroupCard>
          <AgentGroupTrigger
            open={expanded}
            title={summary.title}
            status={summary.status}
            tone={summary.tone}
            elapsed={<AgentElapsed agent={subagentGroupTiming(agents)} />}
            avatars={
              <AgentAvatarStack>
                {agents.map(({ item }) => (
                  <EnvironmentSubagentAvatar
                    key={item.id}
                    environmentId={ctx.activeThreadEnvironmentId}
                    providerInstanceId={item.providerInstanceId}
                    driver={item.driver}
                    remote={item.remoteChild}
                  />
                ))}
              </AgentAvatarStack>
            }
          />
          {/* Virtualized rows must settle before disclosure scroll anchoring resumes. */}
          <CollapsiblePanel animate={false}>
            {expanded ? (
              <AgentGroupRows>
                {members.map((item) => (
                  <V2LifecycleRow
                    environmentId={ctx.activeThreadEnvironmentId}
                    key={item.id}
                    item={item}
                    runs={ctx.runs}
                    onOpenThread={ctx.onOpenThread}
                    subagentLayout="card"
                  />
                ))}
              </AgentGroupRows>
            ) : null}
          </CollapsiblePanel>
        </AgentGroupCard>
      </Collapsible>
    </WorkLogBlock>
  );
});
