import type {
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  Link2Icon,
  Unlink2Icon,
  TriangleAlertIcon,
  UserCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from "lucide-react";
import { Spinner } from "~/components/ui/spinner";

import type { PullRequestReviewOutcome } from "./pullRequestDetail.logic";

export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  reopen: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  link: Link2Icon,
  unlink: Unlink2Icon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];
export type PullRequestPresentationIcon = PullRequestGlyphIcon | typeof Spinner;

export interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly hoverToneClassName: string;
  readonly Icon: PullRequestGlyphIcon;
}

interface PullRequestPresentationEntry {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: PullRequestPresentationIcon;
  readonly hoverToneClassName?: string;
  readonly ringClassName?: string;
  readonly staleRingClassName?: string;
  readonly fillClassName?: string;
  readonly badgeVariant?: "success" | "error" | "outline";
}

// Every pull request and check surface reads its colour from this one map, so a
// state cannot render with different colours on different surfaces.
export const PULL_REQUEST_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-success-foreground",
    hoverToneClassName: "group-hover/sidebar-row:text-success-foreground",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-muted-foreground",
    hoverToneClassName: "group-hover/sidebar-row:text-muted-foreground",
    Icon: PullRequestGlyph.draft,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-merged-foreground",
    hoverToneClassName: "group-hover/sidebar-row:text-merged-foreground",
    Icon: PullRequestGlyph.merged,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-error-foreground",
    hoverToneClassName: "group-hover/sidebar-row:text-error-foreground",
    Icon: PullRequestGlyph.closed,
  },
  conflict: {
    label: "Has conflicts",
    toneClassName: "text-error-foreground",
    Icon: PullRequestGlyph.conflicting,
  },
  "check-pending": {
    label: "Running",
    toneClassName: "text-warning-foreground",
    Icon: Spinner,
  },
  "check-action-required": {
    label: "Awaiting action",
    toneClassName: "text-warning-foreground",
    Icon: CircleDotIcon,
  },
  "check-success": {
    label: "Passed",
    toneClassName: "text-success-foreground",
    Icon: CircleCheckIcon,
  },
  "check-failure": {
    label: "Failed",
    toneClassName: "text-error-foreground",
    Icon: CircleXIcon,
  },
  "check-cancelled": {
    label: "Cancelled",
    toneClassName: "text-error-foreground",
    Icon: CircleXIcon,
  },
  "check-skipped": {
    label: "Skipped",
    toneClassName: "text-muted-foreground",
    Icon: CircleSlashIcon,
  },
  "check-neutral": {
    label: "Neutral",
    toneClassName: "text-muted-foreground",
    Icon: CircleDashedIcon,
  },
  "checks-passing": {
    label: "All checks have passed",
    toneClassName: "text-success-foreground",
    Icon: CircleCheckIcon,
  },
  "checks-failing": {
    label: "Some checks were not successful",
    toneClassName: "text-error-foreground",
    Icon: CircleXIcon,
  },
  "checks-pending": {
    label: "Some checks haven't completed yet",
    toneClassName: "text-warning-foreground",
    Icon: CircleDotIcon,
  },
  "review-decision-approved": {
    label: "Approved",
    toneClassName: "text-success-foreground",
    Icon: UserCheckIcon,
  },
  "review-decision-changes-requested": {
    label: "Changes requested",
    toneClassName: "text-warning-foreground",
    Icon: UserRoundXIcon,
  },
  "review-decision-required": {
    label: "Awaiting review",
    toneClassName: "text-muted-foreground",
    Icon: UserRoundIcon,
  },
  "review-outcome-approved": {
    label: "Approved",
    toneClassName: "text-success-foreground",
    Icon: CircleCheckIcon,
    ringClassName: "ring-2 ring-success",
    staleRingClassName: "ring-2 ring-[color-mix(in_srgb,var(--success)_35%,var(--background))]",
    fillClassName: "fill-success",
    badgeVariant: "success",
  },
  "review-outcome-changes-requested": {
    label: "Changes requested",
    toneClassName: "text-error-foreground",
    Icon: CircleXIcon,
    ringClassName: "ring-2 ring-error",
    staleRingClassName: "ring-2 ring-[color-mix(in_srgb,var(--error)_35%,var(--background))]",
    fillClassName: "fill-error",
    badgeVariant: "error",
  },
  "review-outcome-dismissed": {
    label: "Review dismissed",
    toneClassName: "text-muted-foreground",
    Icon: CircleDashedIcon,
    ringClassName: "ring-2 ring-muted-foreground/60",
    staleRingClassName:
      "ring-2 ring-[color-mix(in_srgb,var(--muted-foreground)_30%,var(--background))]",
    fillClassName: "fill-muted-foreground",
    badgeVariant: "outline",
  },
} as const satisfies Record<string, PullRequestPresentationEntry>;

const CHECK_STATUS_KEY = {
  pending: "check-pending",
  "action-required": "check-action-required",
  success: "check-success",
  failure: "check-failure",
  cancelled: "check-cancelled",
  skipped: "check-skipped",
  neutral: "check-neutral",
} as const satisfies Record<PullRequestCheckStatus, keyof typeof PULL_REQUEST_PRESENTATION>;

const CHECKS_STATE_KEY = {
  passing: "checks-passing",
  failing: "checks-failing",
  pending: "checks-pending",
} as const satisfies Record<PullRequestChecksState, keyof typeof PULL_REQUEST_PRESENTATION>;

const REVIEW_DECISION_KEY = {
  approved: "review-decision-approved",
  "changes-requested": "review-decision-changes-requested",
  "review-required": "review-decision-required",
} as const satisfies Record<PullRequestReviewDecision, keyof typeof PULL_REQUEST_PRESENTATION>;

const REVIEW_OUTCOME_KEY = {
  approved: "review-outcome-approved",
  "changes-requested": "review-outcome-changes-requested",
  dismissed: "review-outcome-dismissed",
} as const satisfies Record<PullRequestReviewOutcome, keyof typeof PULL_REQUEST_PRESENTATION>;

export function pullRequestCheckStatusPresentation(status: PullRequestCheckStatus) {
  return PULL_REQUEST_PRESENTATION[CHECK_STATUS_KEY[status]];
}

export function pullRequestChecksStatePresentation(state: PullRequestChecksState) {
  return PULL_REQUEST_PRESENTATION[CHECKS_STATE_KEY[state]];
}

export function pullRequestReviewDecisionPresentation(decision: PullRequestReviewDecision) {
  return PULL_REQUEST_PRESENTATION[REVIEW_DECISION_KEY[decision]];
}

export function pullRequestReviewOutcomePresentation(outcome: PullRequestReviewOutcome) {
  return PULL_REQUEST_PRESENTATION[REVIEW_OUTCOME_KEY[outcome]];
}

export function pullRequestStateHoverToneClassName(state: PullRequestState | "draft"): string {
  return PULL_REQUEST_PRESENTATION[state].hoverToneClassName;
}
