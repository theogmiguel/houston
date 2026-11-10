import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ContextWindowMeter } from "./ContextWindowMeter";

function snapshot(usedPercentage: number): ContextWindowSnapshot {
  const maxTokens = 200_000;
  const usedTokens = Math.round((maxTokens * usedPercentage) / 100);
  return {
    usedTokens,
    maxTokens,
    remainingTokens: maxTokens - usedTokens,
    usedPercentage,
    remainingPercentage: 100 - usedPercentage,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ContextWindowSnapshot;
}

function renderMeter(usedPercentage: number) {
  return render(
    <TooltipProvider delay={0}>
      <div data-testid="host">
        <ContextWindowMeter usage={snapshot(usedPercentage)} modelDisplayName="Opus" />
      </div>
    </TooltipProvider>,
    { router: false },
  );
}

it("renders nothing below 80% used", async () => {
  await using _screen = await renderMeter(79);
  expect(document.querySelector('[data-testid="host"]')?.children).toHaveLength(0);
});

it("shows a 16px pie and the percentage from 80% used", async () => {
  await using _screen = await renderMeter(82);
  const meter = page.getByRole("button", { name: "Context window 82% used" });
  await expect.element(meter).toHaveTextContent("82%");
  const svg = meter.element().querySelector("svg") as SVGElement;
  expect(svg.getBoundingClientRect().width).toBe(16);
});

it("fills the popover bar with a scaleX transform, not a width", async () => {
  await using _screen = await renderMeter(85);
  await userEvent.hover(page.getByRole("button", { name: "Context window 85% used" }));
  const bar = page.getByRole("progressbar", { name: "Context window usage" });
  await expect.element(bar).toBeVisible();
  const fill = bar.element().firstElementChild as HTMLElement;
  expect(fill.style.transform).toBe("scaleX(0.85)");
  expect(fill.style.width).toBe("");
  expect(getComputedStyle(fill).transitionProperty).not.toContain("width");
});
