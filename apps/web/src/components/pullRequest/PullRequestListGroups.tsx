import type { EnvironmentId, PullRequestAction } from "@houston-app/contracts";
import { EyeIcon, LayersIcon, PenLineIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { Fragment, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import {
  clusterPullRequestStacks,
  pullRequestEntryKey,
  scorePullRequestMatch,
  type EnvironmentPullRequestEntry,
  type PullRequestGroup,
} from "./pullRequestList.logic";
import { PullRequestStackGroup } from "./PullRequestStackGroup";
import { PullRequestRow, type PullRequestRowTarget } from "./PullRequestRow";
import {
  PullRequestSpeedModeProvider,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";

const GROUP_ICONS: Record<string, LucideIcon> = {
  authored: PenLineIcon,
  reviewRequested: EyeIcon,
  others: UsersIcon,
};

const MATCHED_ELSEWHERE_SCORE = 10;

function PullRequestGroupHeader({
  group,
}: {
  group: { key: string; label: string; entries: ReadonlyArray<unknown> };
}) {
  const Icon = GROUP_ICONS[group.key] ?? LayersIcon;
  return (
    <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{group.label}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{group.entries.length}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

export function PullRequestListGroups({
  groups,
  queuePositions,
  environmentLabels,
  query,
  selected,
  showProvider,
  statsRef,
  onSelect,
  hostActionsOf,
  onActed,
  closingKeys,
  sweepingKeys,
  onCloseSweepStart,
}: {
  groups: ReadonlyArray<PullRequestGroup<EnvironmentPullRequestEntry>>;
  queuePositions: ReadonlyMap<string, number>;
  /** Only when rows come from more than one server, so each says which. */
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null;
  query: string;
  selected: {
    readonly environmentId: string | undefined;
    readonly repository: string;
    readonly host: string | undefined;
    readonly number: number;
  } | null;
  showProvider: boolean;
  statsRef: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  hostActionsOf: (entry: EnvironmentPullRequestEntry) => ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closingKeys: ReadonlySet<string>;
  sweepingKeys: ReadonlySet<string>;
  onCloseSweepStart: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const isSelectedEntry = (entry: EnvironmentPullRequestEntry) =>
    selected?.environmentId === entry.environmentId &&
    selected.repository === entry.repository &&
    selected.host?.toLowerCase() === entry.host.toLowerCase() &&
    selected.number === entry.number;
  const rowPropsFor = (entry: EnvironmentPullRequestEntry) => {
    const entryKey = pullRequestEntryKey(entry);
    const environmentLabel = environmentLabels?.get(entry.environmentId);
    return {
      statsKey: entryKey,
      statsRef,
      showProjectTitle: true,
      showProvider,
      ...(environmentLabel !== undefined ? { environmentLabel } : {}),
      matchedElsewhere:
        query.length > 0 && scorePullRequestMatch(entry, query) <= MATCHED_ELSEWHERE_SCORE,
      queuePosition:
        queuePositions.get(
          `${entry.environmentId}:${entry.projectId}:${entry.repository.toLowerCase()}:${entry.number}`,
        ) ?? null,
      onSelect,
      hostActions: hostActionsOf(entry),
      onActed,
      closing: closingKeys.has(entryKey),
      sweeping: sweepingKeys.has(entryKey),
      onCloseSweepStart,
    };
  };
  return (
    <PullRequestSpeedModeProvider>
      <div className={cn("space-y-3", sweepingKeys.size > 0 && "**:pointer-events-none")}>
        {groups.map((group) => (
          <div key={group.key} className="space-y-0.5">
            {group.label ? <PullRequestGroupHeader group={group} /> : null}
            {clusterPullRequestStacks(group.entries).map((item, index) => (
              <Fragment key={item.kind === "row" ? pullRequestEntryKey(item.entry) : item.key}>
                {index > 0 ? <Separator /> : null}
                {item.kind === "row" ? (
                  <PullRequestRow
                    {...rowPropsFor(item.entry)}
                    entry={item.entry}
                    selected={isSelectedEntry(item.entry)}
                  />
                ) : (
                  <PullRequestStackGroup
                    entries={item.entries}
                    isSelected={isSelectedEntry}
                    rowProps={rowPropsFor}
                  />
                )}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </PullRequestSpeedModeProvider>
  );
}
