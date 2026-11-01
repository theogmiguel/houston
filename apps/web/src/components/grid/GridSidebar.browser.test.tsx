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
  overrides: { onSetAutoClose?: (enabled: boolean) => void; timeLabel?: string | null } = {},
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
        timeLabel={overrides.timeLabel === undefined ? "9:00" : overrides.timeLabel}
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

  it("shows a focus ring and the card actions when the title has keyboard focus", async () => {
    await using screen = await render(card(thread()));

    await userEvent.tab();
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    expect(row.matches(":has(:focus-visible)")).toBe(true);
    expect(getComputedStyle(row).boxShadow).not.toBe("none");

    const actions = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(actions).toBeVisible();
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

function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function accentColor(): string {
  return tokenColor("--accent-ink");
}

describe("ThreadCard status marks", () => {
  it("draws a running thread's mark as the accent dotted ring", async () => {
    await using screen = await render(
      card(
        thread({
          runtime: { status: "running" } as never,
          latestRun: {
            id: "run-1",
            status: "running",
            startedAt: "2025-12-31T23:59:30.000Z",
            completedAt: null,
          } as never,
        }),
        { timeLabel: null },
      ),
    );

    const glyph = screen.container.querySelector("[data-streaming-glyph]");
    const dots = [...screen.container.querySelectorAll("[data-streaming-dot]")];
    expect(glyph).not.toBeNull();
    expect(dots).toHaveLength(8);
    expect(getComputedStyle(glyph!).animationName).not.toBe("none");
    expect(getComputedStyle(glyph!).color).toBe(accentColor());
    for (const dot of dots) {
      expect(getComputedStyle(dot).fill).toBe(accentColor());
    }
    expect(getComputedStyle(screen.getByText("Running").element()).color).toBe(accentColor());
  });

  it("draws the other state marks as stroked outlines, not filled discs", async () => {
    await using screen = await render(
      card(thread({ hasPendingUserInput: true }), { timeLabel: null }),
    );

    const label = screen.getByText("Needs you").element();
    const circle = label.parentElement?.querySelector("circle");
    expect(circle).not.toBeNull();
    expect(getComputedStyle(circle!).fill).toBe("none");
    expect(getComputedStyle(circle!).stroke).not.toBe("none");
    expect(getComputedStyle(circle!).stroke).toBe(tokenColor("--warn-ink"));
  });
});
