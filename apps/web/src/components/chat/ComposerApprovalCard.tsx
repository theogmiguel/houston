import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { memo } from "react";

import type { PaneDensity } from "../../grid/density";
import { type PendingApproval } from "../../session-logic";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const APPROVAL_TITLES: Record<PendingApproval["requestKind"], string> = {
  command: "The agent wants to run a command",
  "file-change": "The agent wants to edit files",
  "file-read": "The agent wants to read a file",
  permission: "The agent wants permission",
  "mcp-elicitation": "The agent wants app access",
};

export interface ComposerApprovalCardProps {
  readonly approval: PendingApproval;
  readonly density: PaneDensity;
  readonly index: number;
  readonly count: number;
  readonly canOperateThread: boolean;
  readonly isResponding: boolean;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

/**
 * The approval request that takes the composer's place. Solo and comfortable
 * show the command; compact and glance keep only the title and two decisions.
 */
export const ComposerApprovalCard = memo(function ComposerApprovalCard({
  approval,
  density,
  index,
  count,
  canOperateThread,
  isResponding,
  onRespond,
}: ComposerApprovalCardProps) {
  const compact = density === "compact" || density === "glance";
  const title = APPROVAL_TITLES[approval.requestKind] ?? "Approval needed";
  const detail = approval.detail?.trim() || approval.reason?.trim() || "";
  const primaryOptions = approval.options?.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  ) ?? [
    { decision: "decline" as const, label: "Decline" },
    { decision: "accept" as const, label: "Approve" },
  ];
  const titleLine = (
    <div className="flex min-w-0 items-center gap-2">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      <span className="truncate text-sm font-medium text-foreground">{title}</span>
      {count > 1 ? (
        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {index + 1} of {count}
        </span>
      ) : null}
    </div>
  );
  return (
    <section
      aria-label="Approval needed"
      data-composer-approval-card={density}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border border-warning/30 bg-warning-surface",
        compact ? "px-2.5 py-2" : "px-3 py-3",
      )}
    >
      {compact ? (
        <Tooltip>
          <TooltipTrigger render={<div className="min-w-0" />}>{titleLine}</TooltipTrigger>
          <TooltipPopup side="top">{detail || title}</TooltipPopup>
        </Tooltip>
      ) : (
        titleLine
      )}
      {compact ? null : (
        <div className="flex min-w-0 flex-col gap-1.5">
          <pre
            aria-label="Approval detail"
            className="max-h-40 min-w-0 overflow-auto rounded-md border border-border bg-code px-2.5 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground select-text! [scrollbar-width:thin]"
          >
            {detail || title}
          </pre>
          {approval.appName ? (
            <span className="truncate text-2xs text-muted-foreground">{approval.appName}</span>
          ) : null}
          {approval.reason && approval.reason !== detail ? (
            <span className="text-2xs text-muted-foreground">{approval.reason}</span>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          disabled={!canOperateThread}
          isResponding={isResponding}
          canRespond={approval.responseCapability === "live"}
          {...(compact ? { options: primaryOptions } : {})}
          onRespondToApproval={onRespond}
        />
      </div>
    </section>
  );
});
