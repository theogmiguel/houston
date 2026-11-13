import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import {
  HOVER_CARD_BODY_CLS,
  HOVER_CARD_MUTED_CLS,
  HOVER_CARD_TEXT_CLS,
  HOVER_CARD_TITLE_CLS,
  HOVER_CARD_WARN_CLS,
} from "../ui/sidebar-rail-recipes";
import { cn } from "../../lib/utils";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  CpuIcon,
  FolderGit2Icon,
  GitBranchIcon,
  RepeatIcon,
  ServerIcon,
  SquareTerminalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { threadHoverDetails } from "../../threads/threadHoverDetails";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { vcsEnvironment } from "../../state/vcs";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useClientSettings } from "../../hooks/useSettings";

function Line({ icon, children, warn }: { icon: ReactNode; children: ReactNode; warn?: boolean }) {
  return (
    <span className={cn("flex items-start gap-1.5", warn && HOVER_CARD_WARN_CLS)}>
      <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-3">
        {icon}
      </span>
      <span className={`min-w-0 ${HOVER_CARD_TEXT_CLS}`}>{children}</span>
    </span>
  );
}

/**
 * What a rail row's hover shows about its thread: where it runs, the checkout and whether it
 * matches the thread's branch, the provider and model, handoffs, terminals, the last problem and
 * linked pull requests. It mounts only while the card is open, so the checkout's status and the
 * terminal list are read for the one row under the pointer.
 */
export function ThreadHoverCard({
  thread,
  workspaceTitle,
  providerEntries,
  branchName,
  nowMs,
}: {
  thread: EnvironmentThreadShell;
  workspaceTitle: string;
  providerEntries: ReadonlyMap<string, Pick<ProviderInstanceEntry, "displayName" | "models">>;
  /** The branch the row shows: the thread's own, else its checkout's. */
  branchName: string | null;
  nowMs: number;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { environments } = useEnvironments();
  const terminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const project = useProject(
    thread.worktreePath === null && thread.branch !== null
      ? scopeProjectRef(thread.environmentId, thread.projectId)
      : null,
  );
  const checkoutStatus = useEnvironmentQuery(
    project?.workspaceRoot === undefined
      ? null
      : vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: project.workspaceRoot },
        }),
  );
  const details = threadHoverDetails({
    thread,
    providerEntries,
    checkoutBranch: checkoutStatus.data?.refName ?? null,
    environmentLabel:
      environments.length > 1
        ? (environments.find((environment) => environment.environmentId === thread.environmentId)
            ?.label ?? null)
        : null,
    terminalCount: terminalIds.length,
    nowMs,
  });
  const shownBranch = details.branch ?? branchName;

  return (
    <div
      className={`flex flex-col gap-1.5 px-3 py-2.5 ${HOVER_CARD_BODY_CLS}`}
      data-thread-hover-card=""
    >
      <span className={HOVER_CARD_TITLE_CLS}>{thread.title}</span>
      <Line icon={<ChevronRightIcon />}>{workspaceTitle}</Line>
      {details.environment === null ? null : (
        <Line icon={<ServerIcon />}>{details.environment}</Line>
      )}
      <Line icon={details.checkout === "worktree" ? <FolderGit2Icon /> : <GitBranchIcon />}>
        {shownBranch ?? "no branch"}
        <span className={HOVER_CARD_MUTED_CLS}>
          {details.checkout === "worktree" ? " · worktree" : " · local checkout"}
        </span>
      </Line>
      {details.branchWarning === null ? null : (
        <Line icon={<AlertTriangleIcon />} warn>
          {details.branchWarning}
        </Line>
      )}
      <Line icon={<CpuIcon />}>
        {[details.provider, details.model].filter((part) => part !== null).join(" · ") || "model"}
      </Line>
      {details.handoffs.length === 0 ? null : (
        <Line icon={<RepeatIcon />}>Handed off: {details.handoffs.join(" → ")}</Line>
      )}
      {details.terminalCount === 0 ? null : (
        <Line icon={<SquareTerminalIcon />}>
          {details.terminalCount === 1
            ? "1 terminal process"
            : `${details.terminalCount} terminal processes`}
        </Line>
      )}
      {details.problem === null ? null : (
        <Line icon={<AlertTriangleIcon />} warn>
          {details.problem.kind === "limit"
            ? `Usage limit reached. Resets ${formatUpcomingTimestamp(details.problem.resetAt, timestampFormat)}`
            : details.problem.text}
        </Line>
      )}
      {details.pullRequests.map((pullRequest) => (
        <Line key={pullRequest.number} icon={<PullRequestGlyph.pullRequest />}>
          #{pullRequest.number}
          {pullRequest.title === null ? "" : ` ${pullRequest.title}`}
          {pullRequest.state === null ? null : (
            <span className={HOVER_CARD_MUTED_CLS}> · {pullRequest.state}</span>
          )}
        </Line>
      ))}
      {details.morePullRequests === 0 ? null : (
        <span className={`pl-4.5 ${HOVER_CARD_MUTED_CLS}`}>+{details.morePullRequests} more</span>
      )}
    </div>
  );
}
