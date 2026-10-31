import type { DailyTotals } from "@t3tools/shared/usageMerge";

const DAY_MS = 24 * 60 * 60 * 1000;

export function addUsageDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

/** The board's Activity calendar ends at the selected window's last day and spans one year. */
export function usageActivityWindow(untilDay: string): {
  readonly sinceDay: string;
  readonly untilDay: string;
} {
  return { sinceDay: addUsageDay(untilDay, -364), untilDay };
}

export type UsageActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface UsageActivityDay {
  readonly day: string;
  readonly costUsd: number;
  readonly level: UsageActivityLevel;
}

export interface UsageActivityMonth {
  readonly label: string;
  /** One-based calendar column where the month starts. */
  readonly column: number;
}

export interface UsageActivityCalendar {
  /** Seven rows per column, Sunday first; null pads the first and last weeks. */
  readonly cells: ReadonlyArray<UsageActivityDay | null>;
  readonly columns: number;
  readonly months: readonly UsageActivityMonth[];
  readonly totalCostUsd: number;
}

export function buildUsageActivityCalendar(
  sinceDay: string,
  untilDay: string,
  daily: readonly DailyTotals[],
): UsageActivityCalendar {
  const costs = new Map(daily.map((entry) => [entry.day, entry.costUsd]));
  const days: string[] = [];
  for (let day = sinceDay; day <= untilDay; day = addUsageDay(day, 1)) days.push(day);
  const maxCost = days.reduce((max, day) => Math.max(max, costs.get(day) ?? 0), 0);
  const leading = new Date(`${sinceDay}T00:00:00Z`).getUTCDay();
  const cells: Array<UsageActivityDay | null> = Array.from({ length: leading }, () => null);
  let totalCostUsd = 0;
  for (const day of days) {
    const costUsd = costs.get(day) ?? 0;
    totalCostUsd += costUsd;
    const level: UsageActivityLevel =
      costUsd <= 0 || maxCost <= 0
        ? 0
        : (Math.min(4, 1 + Math.floor((costUsd / maxCost) * 4)) as UsageActivityLevel);
    cells.push({ day, costUsd, level });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const months: UsageActivityMonth[] = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index]!;
    if (index > 0 && days[index - 1]!.slice(0, 7) === day.slice(0, 7)) continue;
    months.push({
      label: new Date(`${day}T00:00:00Z`).toLocaleString("en-US", {
        month: "short",
        timeZone: "UTC",
      }),
      column: Math.floor((leading + index) / 7) + 1,
    });
  }
  return { cells, columns: cells.length / 7, months, totalCostUsd };
}
