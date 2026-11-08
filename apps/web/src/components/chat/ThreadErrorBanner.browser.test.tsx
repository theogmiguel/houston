import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

it("draws a failure as a card in the composer slot, never a floating toast", async () => {
  const onRetry = { called: false };
  await using screen = await render(
    <TooltipProvider delay={0}>
      <ThreadErrorBanner
        error="Build cache at 127.0.0.1:9 refused the connection while resolving the workspace cache directory."
        onRetry={() => {
          onRetry.called = true;
        }}
        onDismiss={() => {}}
      />
    </TooltipProvider>,
  );

  const card = screen.container.querySelector<HTMLElement>("[data-composer-failure-card]")!;
  expect(card).not.toBeNull();
  // In flow, not an overlay over the timeline.
  expect(getComputedStyle(card).position).not.toBe("absolute");
  expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);

  // The message is clamped to two lines with a way to read it in full.
  const message = card.querySelector<HTMLElement>(".line-clamp-2")!;
  expect(getComputedStyle(message).webkitLineClamp).toBe("2");
  await expect.element(screen.getByText("Show full error")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Dismiss error" })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry.called).toBe(true);
});
