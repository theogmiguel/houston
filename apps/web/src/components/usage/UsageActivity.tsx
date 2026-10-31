import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { UsageDay } from "@t3tools/contracts";
import { formatDayShort, formatUsd } from "@t3tools/shared/usageFormat";
import { useMemo } from "react";

import { useUsage } from "../../state/usage";
import { buildUsageActivityCalendar, usageActivityWindow } from "./usageActivityCalendar";

const LEVEL_BACKGROUND: Readonly<Record<number, string>> = {
  0: "var(--border)",
  1: "color-mix(in srgb, var(--accent) 30%, var(--card))",
  2: "color-mix(in srgb, var(--accent) 50%, var(--card))",
  3: "color-mix(in srgb, var(--accent) 72%, var(--card))",
  4: "var(--accent)",
};

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

export function UsageActivity({
  timeZone,
  untilDay,
  selectedEnvironmentIds,
  hiddenProviders,
}: {
  readonly timeZone: string;
  readonly untilDay: string;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}) {
  const window = usageActivityWindow(untilDay);
  // useUsage stores the answered window by identity; a fresh input every render loops.
  const input = useMemo(
    () => ({
      sinceDay: UsageDay.make(window.sinceDay),
      untilDay: UsageDay.make(window.untilDay),
      timeZone,
      resolution: "day" as const,
    }),
    [window.sinceDay, window.untilDay, timeZone],
  );
  const activity = useUsage(input, selectedEnvironmentIds, hiddenProviders);
  const merged = activity.shown?.merged ?? null;
  const calendar = merged
    ? buildUsageActivityCalendar(window.sinceDay, window.untilDay, merged.daily)
    : null;
  return (
    <section className="rounded-[10px] border border-border bg-card p-5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] leading-[18px] font-semibold text-[var(--t1)]">Activity</h2>
        {calendar ? (
          <span className="ml-auto text-xs text-[var(--t3)]">
            {formatUsd(calendar.totalCostUsd)} in the last year
          </span>
        ) : null}
      </div>
      {calendar === null ? (
        <p className="mt-3 text-xs text-[var(--t3)]">Loading activity…</p>
      ) : (
        <ActivityCalendar calendar={calendar} />
      )}
    </section>
  );
}

function ActivityCalendar({
  calendar,
}: {
  readonly calendar: ReturnType<typeof buildUsageActivityCalendar>;
}) {
  return (
    <div className="mt-3 overflow-x-auto pb-1">
      <div className="grid w-max gap-1">
        <div
          className="ml-[34px] grid h-3.5 text-[11px] leading-3.5 text-[var(--t3)]"
          style={{
            gridTemplateColumns: `repeat(${calendar.columns}, 12px)`,
            columnGap: 3,
          }}
          aria-hidden
        >
          {calendar.months.map((month) => (
            <span key={`${month.label}:${month.column}`} style={{ gridColumnStart: month.column }}>
              {month.label}
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <div
            className="grid w-7 text-[10px] leading-3 text-[var(--t3)]"
            style={{ gridTemplateRows: "repeat(7, 12px)", rowGap: 3 }}
            aria-hidden
          >
            {WEEKDAY_LABELS.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
          <div
            role="grid"
            aria-label="Cost per day over the last year"
            className="grid"
            style={{
              gridAutoFlow: "column",
              gridTemplateRows: "repeat(7, 12px)",
              gridAutoColumns: "12px",
              gap: 3,
            }}
          >
            {calendar.cells.map((cell, index) =>
              cell === null ? (
                <span
                  key={`pad-${index}`}
                  aria-hidden
                  className="block size-3 rounded-[3px] opacity-0"
                />
              ) : (
                <span
                  key={cell.day}
                  role="gridcell"
                  aria-label={`${formatDayShort(cell.day)}: ${formatUsd(cell.costUsd)}`}
                  className="block size-3 rounded-[3px]"
                  style={{ backgroundColor: LEVEL_BACKGROUND[cell.level] }}
                />
              ),
            )}
          </div>
        </div>
        <div className="ml-[34px] flex items-center gap-1 text-[11px] text-[var(--t3)]">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              aria-hidden
              className="block size-3 rounded-[3px]"
              style={{ backgroundColor: LEVEL_BACKGROUND[level] }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
