import type { DailyTotals } from "@houston-app/shared/usageMerge";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

const activity = vi.hoisted(() => ({ view: null as unknown }));

vi.mock(import("../../state/usage"), () => ({ useUsage: () => activity.view }) as never);

import { render } from "../../../test/render";
import { UsageActivity } from "./UsageActivity";

function view(daily: readonly DailyTotals[]): unknown {
  const merged = { daily };
  return { merged, shown: { merged, window: {} }, selectedEnvironments: [] };
}

async function show(daily: readonly DailyTotals[]) {
  activity.view = view(daily);
  return render(
    <UsageActivity
      timeZone="UTC"
      untilDay="2026-10-31"
      selectedEnvironmentIds={null}
      hiddenProviders={new Set()}
    />,
  );
}

it("draws an empty calendar for a year with no usage", async () => {
  await using screen = await show([]);

  await expect.element(screen.getByText("$0.00 in the last year")).toBeVisible();
  await expect.element(screen.getByLabelText("Oct 31: $0.00")).toBeVisible();
  await expect.element(screen.getByText("Less")).toBeVisible();
  await expect.element(screen.getByText("More")).toBeVisible();
});

it("fills the calendar days from the daily costs", async () => {
  await using screen = await show([
    { day: "2026-10-30", costUsd: 18, totalTokens: 0, byProvider: new Map() },
    { day: "2026-10-31", costUsd: 6, totalTokens: 0, byProvider: new Map() },
  ]);

  await expect.element(screen.getByText("$24.00 in the last year")).toBeVisible();
  await expect.element(screen.getByLabelText("Oct 30: $18.00")).toBeVisible();
  await expect.element(screen.getByLabelText("Oct 31: $6.00")).toBeVisible();
  await expect.element(screen.getByLabelText("Oct 29: $0.00")).toBeVisible();
});
