/**
 * The top of the Summary tab: whether this pull request can merge, one expandable row per thing
 * that decides it (checks, reviews, conflicts), and the merge itself under them. The merge control
 * and its menu are built by the detail panel, which owns every action; this card only lays out
 * the answer and the rows that explain it.
 */
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestUpdateMethod,
  ScopedThreadRef,
} from "@houston-app/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  HammerIcon,
  MessageSquareIcon,
  PlayIcon,
} from "lucide-react";
import { useState, type MouseEvent, type ReactNode, type RefCallback } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import {
  READINESS_CARD,
  READINESS_CHECK_NAME,
  READINESS_CHEVRON_OPEN,
  READINESS_REVIEW_AVATAR,
  READINESS_SR_ONLY,
  READINESS_UNRESOLVED_ICON,
  READINESS_UNRESOLVED_THREAD,
  READINESS_CHECK_BUTTON,
  READINESS_CHECK_BUTTON_ACTIVE,
  READINESS_CHECK_BUTTON_IDLE,
  READINESS_CHECK_ROW,
  READINESS_CHECK_STATUS,
  READINESS_CHEVRON,
  READINESS_CONFLICT_BODY,
  READINESS_CONFLICT_ICON,
  READINESS_FOOTER,
  READINESS_FOOTER_NOTE,
  READINESS_HEADER,
  READINESS_HEADER_META,
  READINESS_HEADER_TEXT,
  READINESS_MUTED,
  READINESS_REVIEW_CHIP,
  READINESS_REVIEW_LOGIN,
  READINESS_ROW_LABEL,
  READINESS_ROW_LABEL_TEXT,
  READINESS_ROW_META,
  READINESS_ROW_TRIGGER,
} from "../ui/pull-request-readiness-recipes";
import { cn } from "~/lib/utils";
import { RelativeTime } from "~/components/RelativeTime";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Group } from "../ui/group";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
  PullRequestReviewOutcomeAvatarBadge,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeLabel,
  PullRequestStateGlyph,
  pullRequestReviewOutcomeRingClassName,
  pullRequestReviewOutcomeStaleLabel,
} from "./pullRequestPresentation";
import { pullRequestReadiness } from "./pullRequestReadiness.logic";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";

/** "3s", "4m 12s", "1h 5m": how long a finished run took, where the host said. */
function checkDuration(check: PullRequestCheck): string | null {
  if (check.startedAt === undefined || check.completedAt === undefined) return null;
  const seconds = Math.round(
    (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000,
  );
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function ReadinessRow({
  icon,
  label,
  meta,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 items-center gap-2 px-2 py-1.5",
              READINESS_ROW_TRIGGER,
            )}
          />
        }
      >
        <span className={cn("flex min-w-0 flex-1 items-center gap-2", READINESS_ROW_LABEL)}>
          {icon}
          <span className={cn("min-w-0 flex-1 truncate", READINESS_ROW_LABEL_TEXT)}>{label}</span>
          {meta ? (
            <span className={cn("shrink-0 truncate", READINESS_ROW_META)}>{meta}</span>
          ) : null}
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", READINESS_CHEVRON, open && READINESS_CHEVRON_OPEN)}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="px-2 pb-2 pl-7">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function PullRequestReadinessCard({
  environmentId,
  threadRef,
  reference,
  detail,
  activityPending,
  checksState,
  checksStale,
  checksSummary,
  canApproveWorkflows,
  approvingWorkflows,
  approveWorkflows: {
    armed: approveWorkflowsArmed,
    ref: approveWorkflowsRef,
    onClick: onApproveWorkflows,
    onBlur: onApproveWorkflowsBlur,
  },
  onRefreshChecks,
  pendingFinding,
  fixCheckLabel,
  onFixFinding,
  freshness,
  actionPending,
  onUpdateBranch,
  resolveConflicts,
  primary,
  primaryMenu,
  primaryMenuVariant = "default",
  note,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  activityPending: boolean;
  checksState: PullRequestChecksState | null;
  checksStale: boolean;
  checksSummary: string | null;
  canApproveWorkflows: boolean;
  approvingWorkflows: boolean;
  /** The inline confirm for approving workflows: armed by the first click, run by the second. */
  approveWorkflows: {
    armed: boolean;
    ref?: RefCallback<HTMLElement> | undefined;
    onClick: (event: MouseEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
  onRefreshChecks: () => void;
  pendingFinding: string | null;
  fixCheckLabel: string;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
  freshness: {
    readonly behindBy: number | null;
    readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
  } | null;
  actionPending: boolean;
  onUpdateBranch: (method: PullRequestUpdateMethod) => void;
  /** The panel's own resolve-conflicts control, shown where the row says the branch conflicts. */
  resolveConflicts: ReactNode;
  /** The merge control, or the state that stands in its place. */
  primary: ReactNode;
  /** The split button's menu, when the primary is a button with more than one way to merge. */
  primaryMenu: ReactNode;
  /** The menu half matches the button it is welded to. */
  primaryMenuVariant?: "default" | "destructive-outline";
  /** A line under the merge control, such as an auto-merge that is already armed. */
  note?: ReactNode;
}) {
  const openLink = useOpenLink(threadRef);
  const openCheck = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: "Unable to open check details" });
    });
  };

  const readiness = pullRequestReadiness({
    detail,
    activityPending,
    checksState,
    checksStale,
    checksSummary,
    freshness,
  });
  const checksPresentation = checksState ? pullRequestChecksStatePresentation(checksState) : null;
  const checksIcon =
    checksState === "pending" ? (
      <PullRequestCheckStatusIcon status="pending" />
    ) : checksPresentation ? (
      <checksPresentation.Icon
        aria-hidden
        className={cn("size-3.5 shrink-0", checksPresentation.toneClassName)}
      />
    ) : (
      <PullRequestCheckStatusIcon status="neutral" />
    );

  return (
    <div className={cn("min-w-0", READINESS_CARD)}>
      <div>
        {/* A finished pull request leads with how it ended; the rows below are its record. */}
        {readiness.open ? null : (
          <div className={cn("flex min-w-0 items-center gap-2 px-2", READINESS_HEADER)}>
            <PullRequestStateGlyph state={detail.state} isDraft={false} className="size-3.5" />
            <span className={cn("min-w-0 flex-1 truncate", READINESS_HEADER_TEXT)}>
              {detail.state === "merged"
                ? `Merged into ${detail.baseBranch}`
                : "Closed without merging"}
            </span>
            {(detail.state === "merged" ? detail.mergedAt : detail.closedAt) ? (
              <span className={cn("shrink-0", READINESS_HEADER_META)}>
                <RelativeTime
                  timestamp={(detail.state === "merged" ? detail.mergedAt : detail.closedAt) ?? ""}
                />
              </span>
            ) : null}
          </div>
        )}
        <ReadinessRow icon={checksIcon} label={readiness.checksLabel} meta={readiness.checksMeta}>
          {canApproveWorkflows ? (
            <Button
              size="xs"
              variant="warning-outline"
              disabled={actionPending}
              ref={approveWorkflowsRef}
              onClick={onApproveWorkflows}
              onBlur={onApproveWorkflowsBlur}
            >
              <PlayIcon aria-hidden className="size-3.5" />
              {approvingWorkflows
                ? "Approving…"
                : approveWorkflowsArmed
                  ? "Confirm approve?"
                  : "Approve workflows to run"}
            </Button>
          ) : null}
          {checksStale ? (
            <div className={cn("flex items-center gap-2", READINESS_MUTED)}>
              <span>Check details are out of date.</span>
              <Button size="xs" variant="ghost" onClick={onRefreshChecks}>
                Refresh
              </Button>
            </div>
          ) : detail.checks.length === 0 ? (
            <p className={READINESS_MUTED}>No checks reported.</p>
          ) : (
            detail.checks.map((check, index) => {
              const finding = { kind: "check", check } as const;
              const failing = check.status === "failure" || check.status === "cancelled";
              const duration = checkDuration(check);
              return (
                <div
                  // oxlint-disable-next-line react/no-array-index-key -- Check names and URLs can repeat; these status rows have no local state.
                  key={`${index}:${check.name}:${check.url ?? ""}`}
                  className={cn("-ml-2 flex items-center gap-2 pr-1", READINESS_CHECK_ROW)}
                >
                  <button
                    type="button"
                    disabled={!check.url}
                    onClick={() => check.url && openCheck(check.url)}
                    className={cn(
                      "flex min-w-0 flex-1",
                      check.url ? READINESS_CHECK_BUTTON_ACTIVE : READINESS_CHECK_BUTTON_IDLE,
                    )}
                  >
                    <span
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 [&>svg]:mt-0.5",
                        READINESS_CHECK_BUTTON,
                      )}
                    >
                      <PullRequestCheckStatusIcon status={check.status} />
                      <span className={cn("min-w-0 flex-1", READINESS_CHECK_NAME)}>
                        {check.name}
                      </span>
                      <span className={cn("shrink-0", READINESS_CHECK_STATUS)}>
                        {/* A skipped run still reports times, but "Skipped" is the answer there. */}
                        {duration && check.status !== "pending" && check.status !== "skipped"
                          ? duration
                          : pullRequestCheckStatusLabel(check)}
                      </span>
                    </span>
                  </button>
                  {/* Only where there is something to fix. */}
                  {onFixFinding && failing ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="shrink-0"
                      disabled={pendingFinding !== null}
                      onClick={() => onFixFinding(finding)}
                    >
                      <HammerIcon className="size-3" />
                      {pendingFinding === pullRequestFindingKey(finding)
                        ? "Preparing…"
                        : fixCheckLabel}
                    </Button>
                  ) : null}
                </div>
              );
            })
          )}
        </ReadinessRow>

        <ReadinessRow
          icon={
            activityPending ? (
              <PullRequestCheckStatusIcon status="neutral" />
            ) : readiness.reviewOutcome ? (
              <PullRequestReviewOutcomeIcon outcome={readiness.reviewOutcome} />
            ) : (
              <PullRequestCheckStatusIcon status="skipped" />
            )
          }
          label={readiness.reviewLabel}
          meta={readiness.reviewMeta}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {readiness.reviewerEntries.length === 0 ? (
              <span className={READINESS_MUTED}>Nobody has been asked yet.</span>
            ) : (
              readiness.reviewerEntries.map((entry) => {
                const verdict = entry.outcome
                  ? entry.stale
                    ? pullRequestReviewOutcomeStaleLabel(entry.outcome)
                    : pullRequestReviewOutcomeLabel(entry.outcome)
                  : "Pending";
                return (
                  <Tooltip key={entry.key}>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "inline-flex min-w-0 items-center gap-1.5",
                            READINESS_REVIEW_CHIP,
                          )}
                        />
                      }
                    >
                      <span
                        className={cn(
                          "relative",
                          READINESS_REVIEW_AVATAR,
                          entry.outcome
                            ? pullRequestReviewOutcomeRingClassName(entry.outcome, entry.stale)
                            : undefined,
                        )}
                      >
                        <PullRequestActorLabel
                          actor={entry.actor}
                          tooltip={false}
                          variant="avatar"
                        />
                        {entry.outcome ? (
                          <PullRequestReviewOutcomeAvatarBadge
                            outcome={entry.outcome}
                            stale={entry.stale}
                          />
                        ) : null}
                      </span>
                      <span className={cn("truncate", READINESS_REVIEW_LOGIN)}>
                        {entry.actor?.login ?? "ghost"}
                      </span>
                      <span className={READINESS_SR_ONLY}>{verdict}</span>
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">{verdict}</TooltipPopup>
                  </Tooltip>
                );
              })
            )}
            {/* Shown wherever the host can take a review request at all, and disabled with the
                reason where this account may not make one. */}
            {detail.capabilities.reviewers.request &&
            detail.capabilities.reviewers.listCandidates ? (
              <PullRequestReviewerPicker
                environmentId={environmentId}
                reference={reference}
                allowed={detail.viewerPermissions.requestReviewers}
              />
            ) : null}
          </div>
          {detail.commentsTruncated ? (
            <p className={cn("mt-1", READINESS_MUTED)}>
              Only the recent conversation was read, so older reviews may be missing here.
            </p>
          ) : null}
        </ReadinessRow>

        {readiness.unresolvedThreads.length > 0 ? (
          <ReadinessRow
            icon={
              <MessageSquareIcon
                aria-hidden
                className={cn("size-3.5", READINESS_UNRESOLVED_ICON)}
              />
            }
            label={`${readiness.unresolvedThreads.length.toLocaleString()} unresolved ${
              readiness.unresolvedThreads.length === 1 ? "thread" : "threads"
            }`}
            meta={
              readiness.unresolvedThreads.some((thread) => thread.isOutdated)
                ? `${readiness.unresolvedThreads.filter((thread) => thread.isOutdated).length.toLocaleString()} outdated`
                : null
            }
          >
            <div className="flex flex-col gap-1">
              {readiness.unresolvedThreads.map((thread) => (
                <span
                  key={thread.id}
                  className={cn("truncate", READINESS_MUTED, READINESS_UNRESOLVED_THREAD)}
                >
                  {thread.path}
                  {thread.line === null ? "" : `:${thread.line}`}
                  {thread.isOutdated ? " (outdated)" : ""}
                </span>
              ))}
            </div>
          </ReadinessRow>
        ) : null}

        {readiness.open ? (
          <ReadinessRow
            icon={
              readiness.conflicting ? (
                <PullRequestGlyph.conflicting
                  aria-hidden
                  className={cn("size-3.5 shrink-0", READINESS_CONFLICT_ICON)}
                />
              ) : detail.mergeability === "unknown" ? (
                <PullRequestCheckStatusIcon status="pending" />
              ) : freshness ? (
                <PullRequestCheckStatusIcon status="action-required" />
              ) : (
                <PullRequestCheckStatusIcon status="success" />
              )
            }
            label={readiness.conflictsLabel}
            meta={readiness.conflictsMeta}
          >
            {readiness.conflicting ? (
              <div className={cn("flex flex-wrap items-center gap-2", READINESS_CONFLICT_BODY)}>
                <span>These changes conflict with {detail.baseBranch}.</span>
                {resolveConflicts}
              </div>
            ) : freshness ? (
              <div className={cn("flex flex-wrap items-center gap-1.5", READINESS_CONFLICT_BODY)}>
                <span className="w-full">Changes can be cleanly merged.</span>
                {freshness.methods.map((method) => (
                  <Button
                    key={method}
                    size="xs"
                    variant="secondary"
                    disabled={actionPending}
                    onClick={() => onUpdateBranch(method)}
                  >
                    <PullRequestGlyph.merged aria-hidden className="size-3" />
                    {method === "rebase" ? "Update with rebase" : "Update branch"}
                  </Button>
                ))}
              </div>
            ) : (
              <p className={READINESS_MUTED}>
                {detail.mergeability === "unknown"
                  ? "The host is still working out whether this merges cleanly."
                  : "Changes can be cleanly merged."}
              </p>
            )}
          </ReadinessRow>
        ) : null}
      </div>
      {primary ? (
        <div className={READINESS_FOOTER}>
          <div className="flex min-w-0 items-stretch">
            {primaryMenu ? (
              <Group className="w-full">
                {primary}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant={primaryMenuVariant}
                        aria-label="More merge actions"
                      />
                    }
                  >
                    <ChevronDownIcon aria-hidden className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom">
                    {primaryMenu}
                  </MenuPopup>
                </Menu>
              </Group>
            ) : (
              primary
            )}
          </div>
          {note ? <div className={READINESS_FOOTER_NOTE}>{note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
