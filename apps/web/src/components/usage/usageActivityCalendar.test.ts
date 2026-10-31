import { describe, expect, it } from "vite-plus/test";

import { addUsageDay, buildUsageActivityCalendar, usageActivityWindow } from "./usageActivityCalendar";

describe("usage activity calendar", () => {
  it("spans a year ending on the selected day", () => {
    expect(usageActivityWindow("2026-10-31")).toEqual({
      sinceDay: "2025-11-01",
      untilDay: "2026-10-31",
    });
    expect(addUsageDay("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("pads the first week and groups the grid into seven-day columns", () => {
    const calendar = buildUsageActivityCalendar("2026-01-01", "2026-01-14", []);
    // 2026-01-01 is a Thursday, so four Sunday-first pads lead the first week.
    expect(calendar.cells.slice(0, 4)).toEqual([null, null, null, null]);
    expect(calendar.cells).toHaveLength(21);
    expect(calendar.columns).toBe(3);
    expect(calendar.months).toEqual([{ label: "Jan", column: 1 }]);
  });

  it("scales each non-zero day against the busiest day", () => {
    const calendar = buildUsageActivityCalendar("2026-01-01", "2026-01-14", [
      { day: "2026-01-01", costUsd: 10, totalTokens: 0, byProvider: new Map() },
      { day: "2026-01-02", costUsd: 5, totalTokens: 0, byProvider: new Map() },
      { day: "2026-01-03", costUsd: 0, totalTokens: 0, byProvider: new Map() },
    ]);
    expect(calendar.totalCostUsd).toBe(15);
    expect(calendar.cells.find((cell) => cell?.day === "2026-01-01")?.level).toBe(4);
    expect(calendar.cells.find((cell) => cell?.day === "2026-01-02")?.level).toBe(3);
    expect(calendar.cells.find((cell) => cell?.day === "2026-01-03")?.level).toBe(0);
    expect(calendar.cells.find((cell) => cell?.day === "2026-01-04")?.level).toBe(0);
  });
});
