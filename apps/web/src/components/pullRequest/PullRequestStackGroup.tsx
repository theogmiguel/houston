import type { ComponentProps } from "react";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "~/lib/utils";

import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { pullRequestStackLayerRank } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import {
  STACK_BRANCH,
  STACK_CHAIN_ARROW,
  STACK_CHEVRON,
  STACK_CHEVRON_FOLDED,
  STACK_CHEVRON_OPEN,
  STACK_CHECKS_UNAVAILABLE,
  STACK_DIFF_STAT,
  STACK_DOT,
  STACK_EXPANDED_FRAME,
  STACK_LAYER_NUMBER_WORST,
  STACK_LAYERS_COUNT,
  STACK_SUMMARY_BUTTON,
  STACK_SUMMARY_BUTTON_IDLE,
  STACK_SUMMARY_BUTTON_OPEN,
  STACK_TONE_DRAFT,
  STACK_TONE_READY,
  STACK_TONE_WARNING,
  stackLayerDotClass,
} from "../ui/pull-request-stack-recipes";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import { PullRequestChecksGlyph } from "./pullRequestIcons";
import { PullRequestDiffStat, PullRequestReviewDecisionGlyph } from "./pullRequestPresentation";

// These providers put checks on the row; the others need the request opened.
const CHECK_STATE_KNOWN_PROVIDERS = new Set(["github", "gitcafe", "gitlab"]);

/** The layer's node on the chain: hollow while it is a draft. */
function layerDotClass(entry: EnvironmentPullRequestEntry) {
  if (entry.state === "merged") return stackLayerDotClass("merged");
  if (entry.state === "closed") return stackLayerDotClass("closed");
  if (entry.isDraft) return stackLayerDotClass("draft");
  const rank = pullRequestStackLayerRank(entry);
  if (rank <= 2) return stackLayerDotClass("failing");
  if (rank === 3) return stackLayerDotClass("pending");
  return stackLayerDotClass("ready");
}

/** How the worst layer stands, in the same terms the single-row list uses. */
function layerStatusLabel(entry: EnvironmentPullRequestEntry): string {
  if (entry.state === "merged") return "Merged";
  if (entry.state === "closed") return "Closed";
  if (entry.isDraft) return "Draft";
  if (entry.checksState === "failing") return "Checks failing";
  if (entry.mergeability === "conflicting") return "Conflicts with the base branch";
  if (entry.reviewDecision === "changes-requested") return "Changes requested";
  if (entry.checksState === "pending") return "Checks running";
  if (entry.viewerReviewRequested) return "Review requested";
  if (entry.reviewDecision === "review-required") return "Review required";
  return "Ready to merge";
}

/**
 * Long stacks keep their ends, and the worst layer, and say how many sit between them.
 */
const CHAIN_LIMIT = 4;

function chainLinks(
  entries: ReadonlyArray<EnvironmentPullRequestEntry>,
  worst: EnvironmentPullRequestEntry,
) {
  if (entries.length <= CHAIN_LIMIT) return entries.map((entry) => ({ entry, hidden: 0 }));
  const kept = new Set([0, entries.length - 1]);
  if (pullRequestStackLayerRank(worst) <= 2) kept.add(entries.indexOf(worst));
  const links: Array<{ entry: EnvironmentPullRequestEntry | null; hidden: number }> = [];
  let hidden = 0;
  entries.forEach((entry, index) => {
    if (!kept.has(index)) {
      hidden += 1;
      return;
    }
    if (hidden > 0) links.push({ entry: null, hidden });
    hidden = 0;
    links.push({ entry, hidden: 0 });
  });
  return links;
}

function StackChain({
  entries,
  worst,
}: {
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  worst: EnvironmentPullRequestEntry;
}) {
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
      {chainLinks(entries, worst).map(({ entry, hidden }, index) => (
        <Fragment key={entry?.number ?? `more-${index}`}>
          {index > 0 ? (
            <ArrowRightIcon aria-hidden className={cn("size-2.5 shrink-0", STACK_CHAIN_ARROW)} />
          ) : null}
          {entry === null ? (
            <span className={PULL_REQUEST_ROW_NUMBER_CLASS}>+{hidden}</span>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              <span aria-hidden className={cn("size-1.5", STACK_DOT, layerDotClass(entry))} />
              <span
                className={cn(
                  "shrink-0",
                  PULL_REQUEST_ROW_NUMBER_CLASS,
                  entry === worst &&
                    pullRequestStackLayerRank(entry) <= 2 &&
                    STACK_LAYER_NUMBER_WORST,
                )}
              >
                #{entry.number}
              </span>
            </span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

type RowProps = Omit<ComponentProps<typeof PullRequestRow>, "entry" | "selected">;

/**
 * Two or more layers of one native stack, folded into one row that reads as the stack: the
 * bottom layer's title, the chain of layers, their summed diff and the worst layer's status.
 * Opening it lists every layer, each a full row that opens its review.
 */
export function PullRequestStackGroup({
  entries,
  isSelected,
  rowProps,
}: {
  /** Bottom layer first. */
  entries: ReadonlyArray<EnvironmentPullRequestEntry>;
  isSelected: (entry: EnvironmentPullRequestEntry) => boolean;
  rowProps: (entry: EnvironmentPullRequestEntry) => RowProps;
}) {
  const holdsSelection = entries.some(isSelected);
  const [open, setOpen] = useState(holdsSelection);
  const [wasSelected, setWasSelected] = useState(holdsSelection);
  // Opening a layer from somewhere else (its link, the stack menu) shows where it sits.
  if (holdsSelection !== wasSelected) {
    setWasSelected(holdsSelection);
    if (holdsSelection) setOpen(true);
  }

  const bottom = entries[0]!;
  const worst = entries.reduce((a, b) =>
    pullRequestStackLayerRank(b) < pullRequestStackLayerRank(a) ? b : a,
  );
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  const updatedAt = entries.reduce<string | null>(
    (latest, entry) =>
      entry.updatedAt && (latest === null || entry.updatedAt > latest) ? entry.updatedAt : latest,
    null,
  );
  const status = layerStatusLabel(worst);
  const rank = pullRequestStackLayerRank(worst);
  const tone =
    rank <= 2
      ? STACK_TONE_WARNING
      : entries.every((entry) => entry.state === "open" && entry.isDraft)
        ? STACK_TONE_DRAFT
        : STACK_TONE_READY;
  const summaryLabel = `Stack of ${entries.length} pull requests from #${bottom.number}`;

  const summary = (
    <button
      type="button"
      aria-expanded={open}
      aria-label={summaryLabel}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "mx-1.5 min-w-0 px-2.5 py-2",
        STACK_SUMMARY_BUTTON,
        open ? STACK_SUMMARY_BUTTON_OPEN : STACK_SUMMARY_BUTTON_IDLE,
      )}
    >
      <PullRequestRowGlyph
        state={bottom.state}
        isDraft={bottom.isDraft}
        mergeability={bottom.mergeability}
        baseBranch={bottom.baseBranch}
        className="mt-0.75 self-start"
      />
      <PullRequestRowLines
        title={bottom.title}
        number={
          <span className="flex min-w-0 items-center gap-1.5">
            <StackChain entries={entries} worst={worst} />
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                STACK_CHEVRON,
                open ? STACK_CHEVRON_OPEN : STACK_CHEVRON_FOLDED,
              )}
            />
          </span>
        }
        signals={
          <>
            {worst.checksState === undefined ? (
              CHECK_STATE_KNOWN_PROVIDERS.has(worst.provider) ? null : (
                <span className={STACK_CHECKS_UNAVAILABLE}>Checks unavailable</span>
              )
            ) : (
              <PullRequestChecksGlyph state={worst.checksState} />
            )}
            {worst.reviewDecision === undefined ? null : (
              <PullRequestReviewDecisionGlyph decision={worst.reviewDecision} />
            )}
          </>
        }
        status={
          <>
            <span className={cn("flex items-center gap-1.25", tone)}>{status}</span>
            {additions === 0 && deletions === 0 ? null : (
              <PullRequestDiffStat
                additions={additions}
                deletions={deletions}
                className={STACK_DIFF_STAT}
              />
            )}
          </>
        }
        metaClassName="@container/pr-row-meta"
        meta={
          <>
            <PullRequestRowAuthor
              actor={bottom.author}
              className="min-w-3.5 max-w-40"
              labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
            />
            <Tooltip>
              <TooltipTrigger render={<span className={cn("min-w-0 truncate", STACK_BRANCH)} />}>
                {bottom.headBranch}
              </TooltipTrigger>
              <TooltipPopup side="top">
                <span className="flex flex-col gap-0.5">
                  <span>{bottom.repository}</span>
                  <span>{bottom.headBranch}</span>
                </span>
              </TooltipPopup>
            </Tooltip>
            <span className={cn("shrink-0", STACK_LAYERS_COUNT)}>
              {entries.length} {entries.length === 2 ? "layer" : "layers"}
            </span>
          </>
        }
        updatedAt={updatedAt}
      />
    </button>
  );

  return (
    // One wrapper either way, so toggling keeps the focused summary mounted.
    <div className={cn("flex min-w-0 flex-col", open && STACK_EXPANDED_FRAME, open && "pb-0.5")}>
      {summary}
      {open ? (
        <>
          <Separator />
          <div className="flex flex-col">
            {entries.map((entry) => (
              <PullRequestRow
                key={entry.number}
                {...rowProps(entry)}
                entry={entry}
                selected={isSelected(entry)}
              />
            ))}
          </div>
        </>
      ) : (
        // Folded, no layer row is mounted to report it is on screen; these empty markers do, so
        // the summed line count still loads under the date sorts.
        entries.map((entry) => {
          const { statsKey, statsRef } = rowProps(entry);
          return (
            <div
              key={entry.number}
              aria-hidden
              ref={statsRef}
              data-pull-request-stats-key={statsKey}
            />
          );
        })
      )}
    </div>
  );
}
