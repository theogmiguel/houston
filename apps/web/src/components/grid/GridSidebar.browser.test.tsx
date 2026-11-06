import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useGridStore } from "../../grid/gridStore";
import { beginThreadDragAt, endThreadDrag, getThreadDragSource } from "../../grid/threadDrag";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";
import type { SidebarProviderEntry } from "../sidebar/SidebarThreadRow";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
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
  overrides: {
    onSetAutoClose?: (enabled: boolean) => void;
    onRename?: (title: string) => void;
    onOpen?: () => void;
    onOpenGrid?: (gridId: string) => void;
    onDropOnThread?: (source: unknown) => void;
    timeLabel?: string | null;
    tooltipDelay?: number;
    focused?: boolean;
    selected?: boolean;
    gridId?: string | null;
    providerEntries?: ReadonlyMap<string, SidebarProviderEntry>;
  } = {},
) {
  return (
    <TooltipProvider delay={overrides.tooltipDelay ?? 0}>
      <ThreadCard
        gridId={overrides.gridId === undefined ? "grid-a" : overrides.gridId}
        thread={value}
        query=""
        providerEntries={overrides.providerEntries ?? new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={overrides.focused ?? false}
        selected={overrides.selected ?? false}
        dragging={false}
        workspaceTitle="Houston"
        timeLabel={overrides.timeLabel === undefined ? "9:00" : overrides.timeLabel}
        onOpen={overrides.onOpen ?? (() => {})}
        onSelect={() => {}}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={overrides.onRename ?? (() => {})}
        onSetAutoClose={overrides.onSetAutoClose ?? (() => {})}
        onDropOnThread={overrides.onDropOnThread ?? (() => {})}
        {...(overrides.onOpenGrid === undefined ? {} : { onOpenGrid: overrides.onOpenGrid })}
      />
    </TooltipProvider>
  );
}

function startRowDrag(row: HTMLElement): void {
  const rect = row.getBoundingClientRect();
  const startX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  row.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: startX,
      clientY: startY,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: startX + 20,
      clientY: startY,
    }),
  );
}

describe("ThreadCard drag source", () => {
  it("carries the thread's project so grid zones can accept or refuse it", async () => {
    await using screen = await render(card(thread()));
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    startRowDrag(row);
    expect(getThreadDragSource()).toEqual({
      gridId: "grid-a",
      threadId: "thread-a",
      environmentId: "env-1",
      projectId: "project-1",
    });
    endThreadDrag();
  });

  it("lets a thread no grid shows start a drag", async () => {
    await using screen = await render(card(thread(), { gridId: null }));
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    startRowDrag(row);
    expect(getThreadDragSource()).toMatchObject({ gridId: null, threadId: "thread-a" });
    endThreadDrag();
  });

  it("takes a thread dropped on its row", async () => {
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onDropOnThread = vi.fn();
    await using screen = await render(card(thread(), { onDropOnThread }));
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;
    const rect = row.getBoundingClientRect();
    const source = {
      gridId: "grid-a",
      threadId: "thread-b",
      environmentId: "env-1",
      projectId: "project-1",
    };

    await act(() =>
      beginThreadDragAt(
        source,
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );
    await act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });

    expect(onDropOnThread).toHaveBeenCalledWith(source);
  });
});

describe("ThreadCard", () => {
  it("keeps the provider mark on the branch line while the card actions are showing", async () => {
    await using screen = await render(card(thread()));

    const cardElement = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const mark = screen.container.querySelector("[data-thread-provider-mark]") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(getComputedStyle(mark).opacity).toBe("1");

    await userEvent.hover(cardElement);

    const actions = screen.getByRole("button", { name: /Thread actions for/ }).element();
    await vi.waitFor(() => expect(getComputedStyle(actions.parentElement!).opacity).toBe("1"));
    expect(getComputedStyle(mark).opacity).toBe("1");
    expect(mark.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      actions.parentElement!.getBoundingClientRect().bottom,
    );
  });

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

  it("does not open the preview tooltip after the pointer leaves the row through its actions", async () => {
    await using screen = await render(
      <div style={{ display: "flex" }}>
        <div style={{ width: 300 }}>
          {/* Base UI's default hover delay: an open is still pending when the pointer leaves. */}
          {card(thread(), { tooltipDelay: 600 })}
        </div>
        <button type="button" style={{ width: 300, height: 300 }}>
          Elsewhere
        </button>
      </div>,
    );
    using _timers = fakeTimers();
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const trigger = page.elementLocator(row);

    await userEvent.hover(row);
    await userEvent.hover(screen.getByRole("button", { name: /Thread actions for/ }));
    await userEvent.hover(screen.getByRole("button", { name: "Elsewhere" }));
    await vi.advanceTimersByTimeAsync(2000);

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

  it("eases the row tint and the action reveal on the feedback role", async () => {
    await using screen = await render(card(thread()));

    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const rowStyle = getComputedStyle(row);
    expect(rowStyle.transitionProperty).toContain("color");
    expect(rowStyle.transitionDuration).toBe("0.1s");
    expect(rowStyle.transitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");

    const reveal = [...row.querySelectorAll("span")].find((span) =>
      span.className.includes("right-2.5"),
    );
    if (reveal === undefined) throw new Error("The thread card has no action reveal span.");
    const revealStyle = getComputedStyle(reveal);
    expect(revealStyle.transitionProperty).toBe("opacity");
    expect(revealStyle.transitionDuration).toBe("0.1s");
    expect(revealStyle.opacity).toBe("0");
  });

  it("keeps the rename input mounted after the Rename menu item closes the menu, and commits on Enter", async () => {
    const onRename = vi.fn();
    await using screen = await render(card(thread({ title: "Greeting" }), { onRename }));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    const trigger = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("menuitem", { name: /Rename/ }).element());

    const input = screen.getByRole("textbox");
    await expect.element(input).toBeVisible();
    await expect.element(input).toHaveFocus();
    expect(onRename).not.toHaveBeenCalled();

    await userEvent.fill(input.element(), "Hello");
    await userEvent.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Hello");
  });

  it("keeps the rename input focused when Rename is chosen while the pointer rests on the row", async () => {
    const onRename = vi.fn();
    await using screen = await render(card(thread({ title: "Greeting" }), { onRename }));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    const trigger = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menuitem", { name: /Open in grid/ })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    const input = screen.getByRole("textbox");
    await expect.element(input).toBeVisible();
    await expect.element(input).toHaveFocus();
    expect(onRename).not.toHaveBeenCalled();

    await userEvent.fill(input.element(), "Hello");
    await userEvent.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Hello");
  });

  it("does not open the thread when the rename input is clicked", async () => {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    await using screen = await render(card(thread({ title: "Greeting" }), { onOpen, onRename }));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /Thread actions for/ }).element());
    await userEvent.click(page.getByRole("menuitem", { name: /Rename/ }).element());
    const input = screen.getByRole("textbox");
    await expect.element(input).toBeVisible();

    await userEvent.click(input.element());
    await expect.element(input).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("labels the auto-close toggle without a glued On suffix and toggles it", async () => {
    const onSetAutoClose = vi.fn();
    await using screen = await render(card(thread(), { onSetAutoClose }));

    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    const trigger = screen.getByRole("button", { name: /Thread actions for/ });
    await expect.element(trigger).toBeVisible();
    await userEvent.click(trigger);

    const behavior = page.getByRole("menuitem", { name: "Auto-close behavior" });
    await expect.element(behavior).toBeVisible();
    await userEvent.hover(behavior);
    const toggle = page.getByRole("menuitemradio", { name: "Disabled" });
    await expect.element(toggle).toBeVisible();
    await userEvent.click(toggle);

    expect(onSetAutoClose).toHaveBeenCalledWith(false);
  });
});

describe("ThreadCard layout", () => {
  it("is three lines, about 62px tall: title and age, branch, then status", async () => {
    await using screen = await render(card(thread({ tags: [] } as never)));
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    const height = row.getBoundingClientRect().height;
    expect(height).toBeGreaterThanOrEqual(58);
    expect(height).toBeLessThanOrEqual(66);

    const meta = row.querySelector<HTMLElement>("[data-thread-meta]")!;
    const statusLine = row.querySelector<HTMLElement>("[data-thread-status-line]")!;
    const title = screen.getByText("Split drawer state from the thread store").element();
    const time = row.querySelector<HTMLElement>("[data-thread-time]")!;
    const branch = screen.getByText("houston/split-drawer-state").element();
    expect(meta.contains(branch)).toBe(true);
    expect(getComputedStyle(branch).fontFamily).not.toContain("Mono");
    expect(getComputedStyle(branch).fontSize).toBe("12px");
    expect(getComputedStyle(title).fontSize).toBe("13px");
    expect(getComputedStyle(title).fontWeight).toBe("500");
    expect(getComputedStyle(time).fontSize).toBe("12px");

    // The age sits right-aligned on the title line; the branch line and the status line follow.
    const titleBox = title.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const branchBox = branch.getBoundingClientRect();
    const statusBox = statusLine.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    expect(meta.contains(time)).toBe(false);
    expect(time.closest("[data-card-open]")).not.toBeNull();
    expect(time.textContent).toMatch(/^\S+$/);
    expect(timeBox.left).toBeGreaterThanOrEqual(titleBox.right);
    expect(rowBox.right - timeBox.right).toBeLessThan(16);
    expect(Math.abs(timeBox.top - titleBox.top)).toBeLessThan(6);
    expect(branchBox.top).toBeGreaterThan(titleBox.bottom - 2);
    expect(statusBox.top).toBeGreaterThanOrEqual(branchBox.bottom);
    expect(statusLine.textContent).toContain("Idle");
    expect(getComputedStyle(time).fontVariantNumeric).toContain("tabular-nums");
    expect(getComputedStyle(time).color).toBe(getComputedStyle(branch).color);
    expect(row.textContent).not.toContain("not in a grid");

    // Meta-line icons share one 14px size.
    for (const icon of row.querySelectorAll<SVGElement>(
      "[data-thread-meta] svg, [data-thread-status-line] svg",
    )) {
      expect(icon.getBoundingClientRect().width).toBe(14);
    }
  });

  it("gives the title at least 240px of a 312px sidebar before it truncates", async () => {
    await using screen = await render(
      <div style={{ width: 295 }}>{card(thread({ title: "T".repeat(200) }), { timeLabel: "6m" })}</div>,
    );
    const title = screen.container.querySelector<HTMLElement>("[data-card-open] > span")!;
    expect(title.getBoundingClientRect().width).toBeGreaterThanOrEqual(240);
  });

  it("starts a flat row and a grid row at the same inset", async () => {
    await using grid = await render(card(thread(), { gridId: "grid-a" }));
    const gridLeft = getComputedStyle(
      grid.container.querySelector<HTMLElement>("[data-thread-key]")!,
    ).paddingLeft;
    await using flat = await render(card(thread(), { gridId: null }));
    const flatLeft = getComputedStyle(
      flat.container.querySelector<HTMLElement>("[data-thread-key]")!,
    ).paddingLeft;
    expect(flatLeft).toBe(gridLeft);
  });
});

describe("ThreadCard selected state", () => {
  it("paints the open thread's row with the selected background and a medium-weight title", async () => {
    await using screen = await render(card(thread()), { router: "/env-1/thread-a" });
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    expect(row.hasAttribute("data-thread-current")).toBe(true);
    expect(getComputedStyle(row).backgroundColor).toBe(tokenBackground("--sidebar-row-selected"));
    const title = screen.getByText("Split drawer state from the thread store").element();
    expect(getComputedStyle(title).fontWeight).toBe("500");
    expect(row.querySelector("[aria-current]")).not.toBeNull();
  });

  it("marks a thread whose id needs URL encoding as open when its route is encoded", async () => {
    await using screen = await render(card(thread({ id: "mcp:thread-a" as never })), {
      router: "/env-1/mcp%3Athread-a",
    });
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    expect(row.hasAttribute("data-thread-current")).toBe(true);
    expect(getComputedStyle(row).backgroundColor).toBe(tokenBackground("--sidebar-row-selected"));
  });

  it("leaves a thread that is not open without a background", async () => {
    await using screen = await render(card(thread()), { router: "/env-1/another-thread" });
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    expect(row.hasAttribute("data-thread-current")).toBe(false);
    expect(getComputedStyle(row).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("treats the focused cell of the open grid as the open thread", async () => {
    await using screen = await render(card(thread(), { focused: true }));
    const row = screen.container.querySelector<HTMLElement>("[data-thread-key]")!;

    expect(row.hasAttribute("data-thread-current")).toBe(true);
    expect(getComputedStyle(row).backgroundColor).toBe(tokenBackground("--sidebar-row-selected"));
  });
});

function tokenBackground(token: string): string {
  const probe = document.createElement("span");
  probe.style.backgroundColor = `var(${token})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}

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

  it("puts the time on the title line, right-aligned, and the status and tags on the third line", async () => {
    await using screen = await render(
      card(
        thread({
          tags: ["bug", "linux"],
          runtime: { status: "running" } as never,
          latestRun: {
            id: "run-1",
            status: "running",
            startedAt: "2025-12-31T23:59:30.000Z",
            completedAt: null,
          } as never,
        } as never),
        { timeLabel: "9:00" },
      ),
    );

    const meta = screen.container.querySelector("[data-thread-meta]");
    const statusLine = screen.container.querySelector("[data-thread-status-line]");
    expect(meta).not.toBeNull();
    expect(statusLine).not.toBeNull();
    expect(meta!.querySelector("[data-thread-status]")).toBeNull();
    const status = statusLine!.querySelector<HTMLElement>("[data-thread-status]");
    expect(status?.textContent).toContain("Running");
    const tags = [...statusLine!.querySelectorAll<HTMLElement>("[data-thread-tag]")];
    expect(tags.map((tag) => tag.textContent)).toEqual(["bug", "linux"]);
    expect(status!.getBoundingClientRect().right).toBeLessThanOrEqual(
      tags[0]!.getBoundingClientRect().left,
    );
    expect(meta!.querySelector("[data-thread-tag]")).toBeNull();
    expect(getComputedStyle(tags[0]!).backgroundColor).not.toBe(tokenBackground("--sel"));
    const button = screen.container.querySelector<HTMLElement>("[data-card-open]")!;
    const time = button.querySelector<HTMLElement>("[data-thread-time]");
    expect(time?.textContent).toBe("9:00");
    expect(time).toBeVisible();
    expect(meta!.querySelector("[data-thread-time]")).toBeNull();
    expect(screen.container.querySelectorAll("[data-thread-time]")).toHaveLength(1);
    expect(meta!.textContent).not.toContain("9:00");

    // The age ends the title line at the row's right edge, after the title.
    const title = titleOf(screen).getBoundingClientRect();
    const timeBox = time!.getBoundingClientRect();
    const rowBox = screen.container.querySelector("[data-thread-key]")!.getBoundingClientRect();
    expect(timeBox.left).toBeGreaterThanOrEqual(title.right);
    expect(rowBox.right - timeBox.right).toBeLessThan(16);
  });

  it("labels a thread with nothing running Idle, in the muted ink", async () => {
    await using screen = await render(card(thread()));
    const status = screen.container.querySelector<HTMLElement>("[data-thread-status]");
    expect(status?.textContent).toBe("Idle");
    expect(getComputedStyle(status!).color).toBe(tokenColor("--contrast-secondary-label"));
  });

  it("keeps a ready thread's mark neutral instead of success green", async () => {
    await using screen = await render(
      card(
        thread({
          lastVisitedAt: "2025-12-31T23:00:00.000Z",
          latestRun: {
            id: "run-1",
            status: "completed",
            startedAt: "2025-12-31T23:30:00.000Z",
            completedAt: "2025-12-31T23:45:00.000Z",
          } as never,
        }),
      ),
    );

    const status = screen.container.querySelector<HTMLElement>("[data-thread-status]");
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe("Ready");
    expect(getComputedStyle(status!).color).toBe(tokenColor("--contrast-secondary-label"));
    expect(getComputedStyle(status!).color).not.toBe(tokenColor("--success-foreground"));
  });

  it("draws the other state marks as stroked outlines, not filled discs", async () => {
    await using screen = await render(
      card(thread({ hasPendingUserInput: true }), { timeLabel: null }),
    );

    const label = screen.getByText("Needs you").element();
    const outline = label.parentElement?.querySelector("svg path");
    expect(outline).not.toBeNull();
    expect(getComputedStyle(outline!).fill).toBe("none");
    expect(getComputedStyle(outline!).stroke).not.toBe("none");
    expect(getComputedStyle(outline!).stroke).toBe(tokenColor("--warn-ink"));
  });
});

function classColor(className: string): string {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

function titleOf(screen: Screen): HTMLElement {
  const title = screen.container.querySelector("[data-thread-key] [data-card-open] > span");
  if (!(title instanceof HTMLElement)) {
    throw new Error("The thread card has no title span.");
  }
  return title;
}

describe("ThreadCard layout and contrast", () => {
  it("keeps the row's bounding box unchanged while hovered", async () => {
    await using screen = await render(card(thread()));
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const before = row.getBoundingClientRect();

    await userEvent.hover(row);
    await expect.element(screen.getByRole("button", { name: /Thread actions for/ })).toBeVisible();

    const during = row.getBoundingClientRect();
    expect({ left: during.left, top: during.top }).toEqual({ left: before.left, top: before.top });
    expect({ width: during.width, height: during.height }).toEqual({
      width: before.width,
      height: before.height,
    });
  });

  it("keeps an idle title at normal contrast instead of the quiet secondary tone", async () => {
    await using screen = await render(card(thread()));
    const title = titleOf(screen);

    expect(title.className).toContain("text-foreground");
    expect(title.className).not.toContain("text-secondary-foreground");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("keeps a selected idle title at normal contrast over the selection fill", async () => {
    await using screen = await render(card(thread(), { selected: true }));
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const title = titleOf(screen);

    expect(row.className).toContain("bg-(--row-current)");
    expect(title.className).toContain("text-foreground");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("keeps a focused idle title at normal contrast over the active fill", async () => {
    await using screen = await render(card(thread(), { focused: true }));
    const row = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const title = titleOf(screen);

    expect(row.className).toContain("bg-sidebar-row-selected");
    expect(title.className).toContain("text-foreground");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("keeps an attention title at full contrast and medium weight", async () => {
    await using screen = await render(card(thread({ hasPendingUserInput: true })));
    const title = titleOf(screen);

    expect(getComputedStyle(title).fontWeight).toBe("500");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("sets a resting title in medium weight and the regular foreground", async () => {
    await using screen = await render(card(thread()));

    const title = titleOf(screen);
    expect(getComputedStyle(title).fontWeight).toBe("500");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("draws the provider mark muted and uncoloured, beside a state mark too", async () => {
    const providerEntries = new Map([
      [
        "claude",
        {
          instanceId: "claude",
          driverKind: "claudeAgent",
          enabled: true,
          displayName: "Claude",
          models: [],
        } as unknown as SidebarProviderEntry,
      ],
    ]);
    const claudeThread = {
      modelSelection: { instanceId: "claude", model: "claude-haiku-5-5" },
      providerInstanceHistory: [],
    };
    await using idle = await render(card(thread(claudeThread as never), { providerEntries }));
    const mark = idle.container.querySelector("[data-thread-provider-mark]") as HTMLElement;
    expect(mark.innerHTML).toContain("grayscale");

    await using attention = await render(
      card(thread({ ...claudeThread, hasPendingUserInput: true } as never), { providerEntries }),
    );
    expect(attention.container.querySelector("[data-thread-status]")).not.toBeNull();
    const attentionMark = attention.container.querySelector("[data-thread-provider-mark]");
    expect(attentionMark?.innerHTML).toContain("grayscale");
    expect(attentionMark?.closest("[data-thread-meta]")).not.toBeNull();
  });
});

const capturesEnabled = import.meta.env.VITE_HOUSTON_CAPTURES === "1";

describe.skipIf(!capturesEnabled)("ThreadCard captures", () => {
  it.each(["light", "dark"] as const)(
    "captures idle, selected and running rows in %s",
    async (appearance) => {
      document.documentElement.classList.toggle("dark", appearance === "dark");
      const container = document.createElement("div");
      container.className = "flex w-[300px] flex-col gap-px bg-(--sidebar) p-2";
      await using screen = await render(
        <>
          {card(thread({ title: "Review the merge queue" }), {
            timeLabel: "9:42",
            tooltipDelay: 60_000,
          })}
          {card(
            thread({
              title: "Split drawer state from the thread store",
            }),
            { timeLabel: "9:12", selected: true, tooltipDelay: 60_000 },
          )}
          {card(
            thread({
              title: "Port the settings search",
              runtime: { status: "running" } as never,
            }),
            { timeLabel: null, tooltipDelay: 60_000 },
          )}
        </>,
        { container },
      );

      await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
      await expect
        .element(
          screen.getByRole("button", {
            name: "Thread actions for Review the merge queue",
          }),
        )
        .toBeVisible();
      await page.screenshot({
        element: container,
        path: `../../../../../.slice/captures/thread-rows-${appearance}.png`,
      });
      document.documentElement.classList.remove("dark");
    },
  );
});

describe("ThreadCard move to grid", () => {
  function seedGrids() {
    useGridStore.setState({ grids: [], threadOrigins: {}, closedCells: {} });
    const store = useGridStore.getState();
    store.createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey: "env-1:project-1",
      id: "grid-a",
      name: "Alpha",
      now: "2026-01-01T00:00:00Z",
    });
    store.createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey: "env-1:project-1",
      id: "grid-b",
      name: "Review",
      now: "2026-01-02T00:00:00Z",
    });
    store.createGrid({
      environmentId: "env-1",
      projectId: "project-2",
      workspaceKey: "env-1:project-2",
      id: "grid-other",
      name: "Elsewhere",
      now: "2026-01-03T00:00:00Z",
    });
    useGridStore.getState().addThread("grid-a", "thread-a");
  }

  async function openMoveMenu() {
    const screen = await render(card(thread(), { onOpenGrid: () => {} }));
    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /Thread actions for/ }));
    await userEvent.hover(page.getByRole("menuitem", { name: /Move to grid/ }));
    return screen;
  }

  it("lists the project's other grids and no other project's grid", async () => {
    seedGrids();
    await using _screen = await openMoveMenu();

    await expect.element(page.getByRole("menuitem", { name: "Review" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "New grid" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Alpha" }).elements()).toHaveLength(0);
    expect(page.getByRole("menuitem", { name: "Elsewhere" }).elements()).toHaveLength(0);
  });

  it("hides the submenu when the thread has no project", async () => {
    seedGrids();
    await using screen = await render(
      card(thread({ projectId: "" as never }), { onOpenGrid: () => {} }),
    );
    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /Thread actions for/ }));
    await expect.element(page.getByRole("menuitem", { name: /Open in grid/ })).toBeVisible();
    expect(page.getByRole("menuitem", { name: /Move to grid/ }).elements()).toHaveLength(0);
  });

  it("moves the thread to the chosen grid and opens it", async () => {
    seedGrids();
    const onOpenGrid = vi.fn();
    await using screen = await render(card(thread(), { onOpenGrid }));
    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /Thread actions for/ }));
    await userEvent.hover(page.getByRole("menuitem", { name: /Move to grid/ }));
    await userEvent.click(page.getByRole("menuitem", { name: "Review" }));

    expect(onOpenGrid).toHaveBeenCalledExactlyOnceWith("grid-b");
    const grids = useGridStore.getState().grids;
    expect(grids.find((grid) => grid.id === "grid-a")?.tree).toBeNull();
    expect(grids.find((grid) => grid.id === "grid-b")?.tree).toMatchObject({
      kind: "thread",
      threadId: "thread-a",
    });
  });

  it("creates a new grid in the thread's project", async () => {
    seedGrids();
    const onOpenGrid = vi.fn();
    await using screen = await render(card(thread(), { onOpenGrid }));
    await userEvent.hover(screen.container.querySelector("[data-thread-key]") as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /Thread actions for/ }));
    await userEvent.hover(page.getByRole("menuitem", { name: /Move to grid/ }));
    await userEvent.click(page.getByRole("menuitem", { name: "New grid" }));

    const createdId = onOpenGrid.mock.calls[0]?.[0] as string | undefined;
    expect(createdId).toBeDefined();
    const created = useGridStore.getState().grids.find((grid) => grid.id === createdId);
    expect(created).toMatchObject({ environmentId: "env-1", projectId: "project-1" });
    expect(created?.tree).toMatchObject({ kind: "thread", threadId: "thread-a" });
  });
});
