import type { HoustonBlockingBackgroundWork } from "@houston-app/contracts/houston/backgroundWork";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ComposerBackgroundWorkCard } from "./ComposerBackgroundWorkCard";

const items: ReadonlyArray<HoustonBlockingBackgroundWork> = [
  {
    kind: "command",
    description: "pnpm test",
    startedAt: DateTime.makeUnsafe("2026-11-18T11:00:00.000Z") as never,
  },
  { kind: "subagent", startedAt: null },
];

function renderCard(props: Partial<Parameters<typeof ComposerBackgroundWorkCard>[0]> = {}) {
  return render(
    <ComposerBackgroundWorkCard
      items={items}
      providerLabel="Claude 2"
      isSending={false}
      onWait={() => undefined}
      onEnd={() => undefined}
      onCancel={() => undefined}
      {...props}
    />,
    { router: false },
  );
}

it("lists the running work a provider switch would end", async () => {
  await using _screen = await renderCard();
  await expect.element(page.getByText("Switching to Claude 2 ends 2 running items")).toBeVisible();
  await expect.element(page.getByText("command", { exact: true })).toBeVisible();
  await expect.element(page.getByText("pnpm test", { exact: true })).toBeVisible();
  await expect.element(page.getByText("subagent", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Background work", { exact: true })).toBeVisible();
});

it("uses the singular for one item and falls back when the provider is unnamed", async () => {
  await using _screen = await renderCard({ items: items.slice(0, 1), providerLabel: null });
  await expect
    .element(page.getByText("Switching to the selected provider ends 1 running item"))
    .toBeVisible();
});

it("offers wait, end and cancel, and disables them while sending", async () => {
  const onWait = vi.fn();
  const onEnd = vi.fn();
  const onCancel = vi.fn();
  await using _screen = await renderCard({ onWait, onEnd, onCancel });

  await page.getByRole("button", { name: "Wait, then switch", exact: true }).click();
  await page.getByRole("button", { name: "End them and switch", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(onWait).toHaveBeenCalledTimes(1);
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it("keeps the decisions disabled while the resend runs", async () => {
  await using _screen = await renderCard({ isSending: true });
  await expect
    .element(page.getByRole("button", { name: "Wait, then switch", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "End them and switch", exact: true }))
    .toBeDisabled();
});
