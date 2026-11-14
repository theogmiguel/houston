import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ContextWindowMeter } from "./ContextWindowMeter";

function snapshot(usedPercentage: number | null): ContextWindowSnapshot {
  const maxTokens = 200_000;
  const usedTokens = Math.round((maxTokens * (usedPercentage ?? 0)) / 100);
  return {
    usedTokens,
    maxTokens,
    remainingTokens: maxTokens - usedTokens,
    usedPercentage,
    remainingPercentage: usedPercentage === null ? null : 100 - usedPercentage,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ContextWindowSnapshot;
}

function renderMeter(usedPercentage: number | null) {
  return render(
    <TooltipProvider delay={0}>
      <div data-testid="host">
        <ContextWindowMeter usage={snapshot(usedPercentage)} modelDisplayName="Opus" />
      </div>
    </TooltipProvider>,
    { router: false },
  );
}

const WARN_COLOR_CLASS = "text-(--warn-ink)";

it("shows only the muted pie below 80% used", async () => {
  await using _screen = await renderMeter(8);
  const meter = page.getByRole("button", { name: "Context window 8% used" });
  await expect.element(meter).toBeVisible();
  const element = meter.element();
  expect(element.textContent?.trim()).toBe("");
  expect(element.querySelector(`.${CSS.escape(WARN_COLOR_CLASS)}`)).toBeNull();
  const svg = element.querySelector("svg") as SVGElement;
  expect(svg.getBoundingClientRect().width).toBe(16);
});

it("opens the popover with the compact action below 80% used", async () => {
  await using _screen = await render(
    <TooltipProvider delay={0}>
      <ContextWindowMeter usage={snapshot(8)} modelDisplayName="Opus" onCompact={() => {}} />
    </TooltipProvider>,
    { router: false },
  );
  await userEvent.hover(page.getByRole("button", { name: "Context window 8% used" }));
  await expect.element(page.getByRole("button", { name: "Compact context" })).toBeVisible();
});

it("shows a 16px pie and the percentage in the warning colour from 80% used", async () => {
  await using _screen = await renderMeter(85);
  const meter = page.getByRole("button", { name: "Context window 85% used" });
  await expect.element(meter).toHaveTextContent("85%");
  const element = meter.element();
  expect(element.querySelector(`.${CSS.escape(WARN_COLOR_CLASS)}`)).not.toBeNull();
  const svg = element.querySelector("svg") as SVGElement;
  expect(svg.getBoundingClientRect().width).toBe(16);
});

it("still renders an empty pie when the used share is unknown", async () => {
  await using _screen = await renderMeter(null);
  const meter = page.getByRole("button", { name: "Context window 0 tokens used" });
  await expect.element(meter).toBeVisible();
  expect(meter.element().textContent?.trim()).toBe("");
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
