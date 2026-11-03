import type {
  HoustonMergeQueueEntry,
  HoustonMergeQueueLogEntry,
  HoustonMergeQueueSettings,
  HoustonMergeQueueSnapshot,
} from "@houston-app/contracts/houston/mergeQueue";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  EyeIcon,
  GitCommitHorizontalIcon,
  ListOrderedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
  PauseIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import {
  MERGE_QUEUE_ROW_BUTTON,
  MERGE_QUEUE_ROW_DEPENDS,
  MERGE_QUEUE_ROW_FRAME,
  MERGE_QUEUE_ROW_FRAME_IDLE,
  MERGE_QUEUE_ROW_FRAME_SELECTED,
  MERGE_QUEUE_ROW_META,
  MERGE_QUEUE_ROW_NUMBER,
  MERGE_QUEUE_ROW_TIME,
  MERGE_QUEUE_ROW_TITLE,
  MERGE_QUEUE_RANK,
  MERGE_QUEUE_RANK_ICON,
  MERGE_QUEUE_SECTION_COUNT,
  MERGE_QUEUE_SECTION_HEADING,
} from "../ui/merge-queue-recipes";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import {
  mergeQueueEntryKey,
  mergeQueueLogLine,
  mergeQueueSections,
  mergeQueueStatusLabel,
  mergeQueueStatusTone,
  mergeQueueEntryLine,
  formatMergeQueueClock,
  type MergeQueueTone,
} from "./mergeQueue.logic";
import { PULL_REQUEST_ROW_CLASS } from "./PullRequestListRow";
import { PullRequestGlyph } from "./pullRequestIcons";

const BADGE_VARIANT: Record<MergeQueueTone, "success" | "warning" | "error" | "info" | "outline"> =
  {
    ok: "success",
    warn: "warning",
    error: "error",
    info: "info",
    neutral: "outline",
  };

const STATUS_ICON: Record<HoustonMergeQueueEntry["status"], LucideIcon> = {
  ready: CircleCheckIcon,
  blocked: CircleAlertIcon,
  verifying: LoaderCircleIcon,
  waitingForSlot: ClockIcon,
  fixing: WrenchIcon,
  parked: PauseCircleIcon,
  paused: PauseIcon,
  watching: EyeIcon,
};

const LOG_ICON: Record<HoustonMergeQueueLogEntry["kind"], LucideIcon> = {
  push: GitCommitHorizontalIcon,
  merge: PullRequestGlyph.merged,
  park: PauseCircleIcon,
  restack: GitCommitHorizontalIcon,
  retarget: GitCommitHorizontalIcon,
  hand_off: EyeIcon,
};

function MergeQueueStatusBadge({
  label,
  tone,
  Icon,
}: {
  label: string;
  tone: MergeQueueTone;
  Icon: LucideIcon;
}) {
  return (
    <Badge size="sm" variant={BADGE_VARIANT[tone]}>
      <Icon aria-hidden className="size-3" />
      {label}
    </Badge>
  );
}

function GroupHeader({
  icon: Icon,
  label,
  count,
}: {
  icon: LucideIcon;
  label: string;
  count: number;
}) {
  return (
    <div className={MERGE_QUEUE_SECTION_HEADING}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{label}</h2>
      <span className={MERGE_QUEUE_SECTION_COUNT}>{count}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

function Rank({ entry }: { entry: HoustonMergeQueueEntry }) {
  if (entry.position > 0) {
    return <span className={MERGE_QUEUE_RANK}>{entry.position}</span>;
  }
  return (
    <span className={MERGE_QUEUE_RANK_ICON}>
      <GitCommitHorizontalIcon aria-hidden className="size-3.5" />
    </span>
  );
}

function QueueEntryRow({
  entry,
  previous,
  next,
  settings,
  now,
  selected,
  onSelect,
}: {
  entry: HoustonMergeQueueEntry;
  previous: HoustonMergeQueueEntry | null;
  next: boolean;
  settings: HoustonMergeQueueSettings | null;
  now: number;
  selected: boolean;
  onSelect: (entry: HoustonMergeQueueEntry) => void;
}) {
  const Icon = STATUS_ICON[entry.status];
  const frameClass = selected ? MERGE_QUEUE_ROW_FRAME_SELECTED : MERGE_QUEUE_ROW_FRAME_IDLE;
  return (
    <div className={cn(MERGE_QUEUE_ROW_FRAME, frameClass)}>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        className={cn(PULL_REQUEST_ROW_CLASS, MERGE_QUEUE_ROW_BUTTON)}
      >
        <Rank entry={entry} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={MERGE_QUEUE_ROW_NUMBER}>#{entry.number}</span>
            <span className={MERGE_QUEUE_ROW_TITLE}>{entry.title ?? entry.headRef}</span>
            {entry.dependsOn === null ? null : (
              <span className={MERGE_QUEUE_ROW_DEPENDS}>
                <PullRequestGlyph.pullRequest aria-hidden className="size-3" />#{entry.dependsOn}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <MergeQueueStatusBadge
                Icon={Icon}
                label={mergeQueueStatusLabel(entry, settings, now)}
                tone={mergeQueueStatusTone(entry.status)}
              />
            </span>
          </span>
          <span className={MERGE_QUEUE_ROW_META}>
            <span className="min-w-0 truncate">
              {mergeQueueEntryLine(entry, previous, next, settings, now)}
            </span>
          </span>
        </span>
      </button>
    </div>
  );
}

function QueueLogRow({
  row,
  onSelect,
  onRevert,
  reverting,
}: {
  row: HoustonMergeQueueLogEntry;
  onSelect: (row: HoustonMergeQueueLogEntry) => void;
  onRevert: (number: number) => void;
  reverting: boolean;
}) {
  const Icon = LOG_ICON[row.kind];
  return (
    <div className={cn(MERGE_QUEUE_ROW_FRAME, MERGE_QUEUE_ROW_FRAME_IDLE)}>
      <button
        type="button"
        onClick={() => onSelect(row)}
        className={cn(PULL_REQUEST_ROW_CLASS, MERGE_QUEUE_ROW_BUTTON)}
      >
        <span className={MERGE_QUEUE_RANK_ICON}>
          <Icon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={MERGE_QUEUE_ROW_NUMBER}>#{row.number}</span>
            <span className={MERGE_QUEUE_ROW_TITLE}>{row.title ?? `#${row.number}`}</span>
            <span className={MERGE_QUEUE_ROW_TIME}>{formatMergeQueueClock(row.at)}</span>
          </span>
          <span className={MERGE_QUEUE_ROW_META}>
            <span className="min-w-0 truncate">{mergeQueueLogLine(row)}</span>
          </span>
        </span>
      </button>
      {row.kind === "merge" ? (
        <Button
          className="mr-1 shrink-0"
          size="xs"
          variant="ghost"
          disabled={reverting}
          onClick={() => onRevert(row.number)}
        >
          Revert
        </Button>
      ) : null}
    </div>
  );
}

export function MergeQueueList({
  snapshot,
  now,
  selectedKey,
  onSelectEntry,
  onSelectLog,
  onRevert,
  revertingNumber,
}: {
  snapshot: HoustonMergeQueueSnapshot;
  now: number;
  selectedKey: string | null;
  onSelectEntry: (entry: HoustonMergeQueueEntry) => void;
  onSelectLog: (row: HoustonMergeQueueLogEntry) => void;
  onRevert: (number: number) => void;
  revertingNumber: number | null;
}) {
  const sections = mergeQueueSections(snapshot, now);
  const next = sections.inLine.find((entry) => entry.status !== "blocked") ?? null;
  return (
    <div className="space-y-3">
      <section className="space-y-0.5">
        <GroupHeader icon={ListOrderedIcon} label="In line" count={sections.inLine.length} />
        {sections.inLine.map((entry, index) => {
          const previous =
            sections.inLine
              .slice(0, index)
              .filter((candidate) => candidate.status !== "blocked")
              .at(-1) ?? null;
          return (
            <QueueEntryRow
              key={mergeQueueEntryKey(entry.projectId, entry.number)}
              entry={entry}
              previous={previous}
              next={entry === next}
              settings={snapshot.settings}
              now={now}
              selected={selectedKey === mergeQueueEntryKey(entry.projectId, entry.number)}
              onSelect={onSelectEntry}
            />
          );
        })}
      </section>
      <section className="space-y-0.5">
        <GroupHeader icon={PauseCircleIcon} label="Parked" count={sections.parked.length} />
        {sections.parked.map((entry) => (
          <QueueEntryRow
            key={mergeQueueEntryKey(entry.projectId, entry.number)}
            entry={entry}
            previous={null}
            next={false}
            settings={snapshot.settings}
            now={now}
            selected={selectedKey === mergeQueueEntryKey(entry.projectId, entry.number)}
            onSelect={onSelectEntry}
          />
        ))}
      </section>
      {sections.today.length === 0 ? null : (
        <section className="space-y-0.5">
          <GroupHeader icon={ClockIcon} label="Today" count={sections.today.length} />
          {sections.today.map((row) => (
            <QueueLogRow
              key={`${row.kind}:${row.number}:${row.at}`}
              row={row}
              onSelect={onSelectLog}
              onRevert={onRevert}
              reverting={revertingNumber === row.number}
            />
          ))}
        </section>
      )}
    </div>
  );
}
