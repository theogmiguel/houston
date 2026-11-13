import type { PullRequestAction } from "@houston-app/contracts";
import { sourceControlClients } from "@houston-app/client-runtime/source-control-clients";
import { SearchIcon } from "lucide-react";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import {
  PullRequestSpeedActions,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";
import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { useIsPhone } from "~/mobile/usePhone";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { PullRequestChecksUnknown } from "../ui/pull-request-checks-unknown";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import { PullRequestLabelChip, PullRequestReviewDecisionGlyph } from "./pullRequestPresentation";

const LABEL_SLOTS = [
  { overflow: "@xl/pr-row-meta:hidden" },
  { overflow: "@3xl/pr-row-meta:hidden" },
  { overflow: "" },
] as const;

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 max-[22rem]:hidden">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <PullRequestLabelChip
            key={label.name}
            label={label}
            className={
              index === 0
                ? ""
                : index === 1
                  ? "hidden @xl/pr-row-meta:inline-flex"
                  : "hidden @3xl/pr-row-meta:inline-flex"
            }
          >
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </PullRequestLabelChip>
        );
      })}
    </span>
  );
}

const PAGE_ROW_CLASS = "px-3 py-3 max-phone:min-h-11 max-phone:rounded-none max-phone:px-0";

// These providers put checks on the row; the others need the request opened.
const CHECK_STATE_KNOWN_PROVIDERS = new Set(["github", "gitcafe", "gitlab"]);

export type PullRequestRowTarget = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number"
>;

function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  queuePosition,
  statsKey,
  statsRef,
  onSelect,
  onIntent,
  hostActions,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  showProvider: boolean;
  environmentLabel?: string;
  matchedElsewhere?: boolean;
  /** Its place in the merge queue, `0` when queued but unranked. */
  queuePosition?: number | null;
  /** Visibility key for deferred line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  /** The row the pointer or focus rests on, or null when it leaves. */
  onIntent?: (entry: PullRequestRowTarget | null) => void;
  hostActions: ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const phone = useIsPhone();
  const { Icon, providerName, terminology } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      data-pull-request-key={statsKey}
      className={cn(
        "mx-1.5 flex items-center rounded-lg [content-visibility:auto] [contain-intrinsic-block-size:52.5px]",
        // A phone's row spans the page's gutter-to-gutter width and keeps no fill at rest.
        "max-phone:mx-0 max-phone:rounded-none max-phone:active:bg-hover/60",
        selected
          ? "bg-hover max-phone:bg-transparent"
          : "hover:bg-hover/60 max-phone:hover:bg-transparent",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        onPointerEnter={() => onIntent?.(entry)}
        onPointerLeave={(event) => {
          if (event.currentTarget !== document.activeElement) onIntent?.(null);
        }}
        onFocus={() => onIntent?.(entry)}
        onBlur={(event) => {
          if (!event.currentTarget.matches(":hover")) onIntent?.(null);
        }}
        className={cn(
          PULL_REQUEST_ROW_CLASS,
          PAGE_ROW_CLASS,
          "min-w-0 flex-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <PullRequestRowGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          baseBranch={entry.baseBranch}
          className="mt-0.75 self-start"
        />
        <PullRequestRowLines
          number={
            <span
              className={PULL_REQUEST_ROW_NUMBER_CLASS}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(sourceControlClients.get(entry.provider)),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              #{entry.number}
            </span>
          }
          title={entry.title}
          status={
            <>
              {entry.stack ? (
                <PullRequestStackPopover
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    host: entry.host,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                  membership={entry.stack}
                  onSelect={(target) =>
                    onSelect({ ...target, host: entry.host, environmentId: entry.environmentId })
                  }
                />
              ) : null}
              <PullRequestChangeBreakdownStat
                environmentId={entry.environmentId}
                reference={{
                  projectId: entry.projectId,
                  host: entry.host,
                  repository: entry.repository,
                  number: entry.number,
                }}
                additions={entry.additions}
                deletions={entry.deletions}
                className="font-mono"
              />
            </>
          }
          trailing={
            <>
              {entry.checksState === undefined ? (
                CHECK_STATE_KNOWN_PROVIDERS.has(entry.provider) ? null : (
                  <PullRequestChecksUnknown provider={entry.provider} />
                )
              ) : (
                <PullRequestChecksPopover
                  variant={phone ? "icon" : "label"}
                  checksState={entry.checksState}
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                />
              )}
              {entry.reviewDecision === undefined ? null : (
                <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
              )}
              {queuePosition === undefined || queuePosition === null ? null : (
                <Badge size="sm" variant="info">
                  {queuePosition > 0 ? `Queue ${queuePosition}` : "Queued"}
                </Badge>
              )}
            </>
          }
          metaClassName="@container/pr-row-meta"
          meta={
            <>
              {matchedElsewhere ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-3xs" />
                    }
                  >
                    <span className="sr-only">matched in the description</span>
                    <SearchIcon aria-hidden className="size-3 shrink-0" />
                    <span aria-hidden className="hidden truncate @xs/pr-row-meta:block">
                      matched in the description
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">Matched in the description</TooltipPopup>
                </Tooltip>
              ) : null}
              {showProvider ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <Icon aria-label={providerName} className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup>{providerName}</TooltipPopup>
                </Tooltip>
              ) : null}
              <PullRequestRowAuthor
                actor={entry.author}
                className="min-w-3.5 max-w-40 max-phone:max-w-none"
                labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate max-phone:not-sr-only max-phone:truncate"
              />
              {showProjectTitle ? (
                <span className="truncate max-phone:hidden">{entry.repository}</span>
              ) : null}
              {environmentLabel ? (
                <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
              ) : null}
              {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
      {hostActions.size > 0 ? (
        <PullRequestSpeedActions
          entry={entry}
          hostActions={hostActions}
          terminology={terminology}
          onActed={onActed}
          closing={closing}
          sweeping={sweeping}
          {...(onCloseSweepStart ? { onCloseSweepStart } : {})}
        />
      ) : null}
    </div>
  );
}

export const PullRequestRow = memo(PullRequestRowImpl);
