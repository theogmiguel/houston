import type { PullRequestChecksState, ScopedThreadRef } from "@houston-app/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { RowPullRequest } from "../../grid/sidebar";
import { useSupportsMultiplePullRequests } from "../../hooks/useSupportsMultiplePullRequests";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import {
  PULL_REQUEST_PRESENTATION,
  PullRequestGlyph,
  pullRequestChecksStatePresentation,
} from "../pullRequest/pullRequestIcons";
import { MOTION_FEEDBACK } from "../ui/motion-recipes";
import { FOCUS_ACTION_CLS, ROW_BADGE_BUTTON_CLS } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const CHECKS_SUMMARY: Record<PullRequestChecksState, string> = {
  passing: "Checks passed",
  failing: "Checks failed",
  pending: "Checks running",
};

/** A pending or passing run is stated in the tooltip only; the row flags just a failure. */
function showsChecksGlyph(pullRequest: RowPullRequest): boolean {
  return (
    pullRequest.checksState === "failing" &&
    (pullRequest.state === "open" || pullRequest.state === "draft")
  );
}

export function describePullRequest(pullRequest: RowPullRequest): {
  readonly headline: string;
  readonly checks: string | null;
  readonly label: string;
} {
  const stateLabel =
    pullRequest.state === null ? null : PULL_REQUEST_PRESENTATION[pullRequest.state].label;
  const lead = `PR #${pullRequest.number}${stateLabel === null ? "" : ` · ${stateLabel}`}`;
  const headline = pullRequest.title === null ? lead : `${lead}: ${pullRequest.title}`;
  const checks = pullRequest.checksState === null ? null : CHECKS_SUMMARY[pullRequest.checksState];
  return {
    headline,
    checks,
    label: checks === null ? headline : `${headline}. ${checks}`,
  };
}

/**
 * The pull request badge on a thread row. The glyph carries the state (its shape and hue) and the
 * number stays neutral text. A plain click shows the pull request in the right
 * panel (the list when the thread has several); Ctrl/Cmd+click and middle-click open it in
 * the browser.
 */
export function ThreadRowPullRequestBadge({
  threadRef,
  pullRequest,
  pullRequestCount,
  onOpenThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly pullRequest: RowPullRequest;
  readonly pullRequestCount: number;
  /** Brings the thread forward once its right panel shows the pull request. */
  readonly onOpenThread: () => void;
}) {
  const openPullRequestLink = useOpenPrLink(threadRef);
  const supportsList = useSupportsMultiplePullRequests(threadRef.environmentId);
  const presentation = describePullRequest(pullRequest);
  const tone =
    pullRequest.state === null
      ? { toneClassName: "text-secondary-label", Icon: PullRequestGlyph.pullRequest }
      : PULL_REQUEST_PRESENTATION[pullRequest.state];
  const checks = showsChecksGlyph(pullRequest)
    ? pullRequestChecksStatePresentation("failing")
    : null;

  const open = (event: ReactMouseEvent<HTMLElement>) => {
    const external = event.metaKey || event.ctrlKey || event.button === 1;
    if (!external && supportsList && pullRequestCount > 1) {
      event.stopPropagation();
      useRightPanelStore.getState().open(threadRef, "pull-requests");
      onOpenThread();
      return;
    }
    if (openPullRequestLink(event, pullRequest.url, threadRef)) onOpenThread();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-thread-pull-request=""
            aria-label={presentation.label}
            onClick={open}
            onAuxClick={(event) => {
              if (event.button === 1) open(event);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            className={cn(ROW_BADGE_BUTTON_CLS, MOTION_FEEDBACK, FOCUS_ACTION_CLS)}
          />
        }
      >
        <tone.Icon aria-hidden className={cn("size-3 shrink-0", tone.toneClassName)} />
        <span>#{pullRequest.number}</span>
        {checks === null ? null : (
          <checks.Icon aria-hidden className={cn("size-3 shrink-0", checks.toneClassName)} />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <span className="block">{presentation.headline}</span>
        {presentation.checks === null ? null : <span className="block">{presentation.checks}</span>}
      </TooltipPopup>
    </Tooltip>
  );
}
