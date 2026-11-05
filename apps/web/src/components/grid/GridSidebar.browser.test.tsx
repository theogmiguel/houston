import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useGridStore } from "../../grid/gridStore";
import { beginThreadDragAt, endThreadDrag, getThreadDragSource } from "../../grid/threadDrag";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
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
  } = {},
) {
  return (
    <TooltipProvider delay={overrides.tooltipDelay ?? 0}>
      <ThreadCard
        gridId={overrides.gridId === undefined ? "grid-a" : overrides.gridId}
        thread={value}
        query=""
        providerEntries={new Map()}
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
  it("hides the provider mark while the card actions are showing, so they never touch", async () => {
    await using screen = await render(card(thread()));

    const cardElement = screen.container.querySelector("[data-thread-key]") as HTMLElement;
    const mark = screen.container.querySelector("[data-thread-provider-mark]") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(getComputedStyle(mark).opacity).toBe("1");

    await userEvent.hover(cardElement);

    await vi.waitFor(() => expect(getComputedStyle(mark).opacity).toBe("0"));
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
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

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

    expect(row.className).toContain("bg-(--sidebar-row-active)");
    expect(title.className).toContain("text-foreground");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
  });

  it("keeps an attention title at full contrast and semibold", async () => {
    await using screen = await render(card(thread({ hasPendingUserInput: true })));
    const title = titleOf(screen);

    expect(title.className).toContain("font-semibold");
    expect(getComputedStyle(title).color).toBe(classColor("text-foreground"));
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
