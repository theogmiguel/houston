import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

function thread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Split drawer state from the thread store",
    branch: "houston/split-drawer-state",
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

function card(
  value: EnvironmentThreadShell,
  overrides: { onSetAutoClose?: (enabled: boolean) => void } = {},
) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId="grid-a"
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={false}
        selected={false}
        dragging={false}
        workspaceTitle="Houston"
        timeLabel="9:00"
        onOpen={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={overrides.onSetAutoClose ?? (() => {})}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDropOnThread={() => {}}
        readDragged={() => null}
      />
    </TooltipProvider>
  );
}

describe("ThreadCard", () => {
  it("closes the preview tooltip while the card actions are hovered", async () => {
    await using screen = await render(card(thread()));

    const cardElement = screen.container.querySelector("[data-thread-key]");
    expect(cardElement).not.toBeNull();
    const trigger = page.elementLocator(cardElement as HTMLElement);
    await userEvent.hover(cardElement as HTMLElement);
    await expect.element(trigger).toHaveAttribute("data-popup-open");

    const actions = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(actions).toBeVisible();
    await userEvent.hover(actions);

    await expect.element(trigger).not.toHaveAttribute("data-popup-open");
  });

  it("keeps the actions trigger visible while its menu is open", async () => {
    await using screen = await render(card(thread()));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    const trigger = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.hover(trigger);
    await userEvent.click(trigger);

    const item = page.getByRole("menuitem", { name: /Open in grid/ });
    await expect.element(item).toBeVisible();
    await userEvent.hover(item);

    await expect.element(trigger).toBeVisible();
  });

  it("labels the auto-close toggle without a glued On suffix and toggles it", async () => {
    const onSetAutoClose = vi.fn();
    await using screen = await render(card(thread(), { onSetAutoClose }));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    const trigger = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.hover(trigger);
    await userEvent.click(trigger);

    const toggle = page.getByRole("menuitem", { name: "Auto-close on merge" });
    await expect.element(toggle).toBeVisible();
    await userEvent.click(toggle);

    expect(onSetAutoClose).toHaveBeenCalledWith(false);
  });
});
