import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { beginThreadDragAt, endThreadDrag, useThreadDropTarget } from "../../grid/threadDrag";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadCard } from "./GridSidebar";

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));

vi.mock(import("../../hooks/useSupportsMultiplePullRequests"), () => ({
  useSupportsMultiplePullRequests: () => false,
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

const LONG_TITLE = "App de desenvolvimento para testes com um nome bem comprido";

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
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
  } as unknown as EnvironmentThreadShell;
}

interface CardOverrides {
  shelf?: "snoozed" | "settled" | null;
  gridId?: string | null;
  notInGrid?: boolean;
  timeLabel?: string | null;
  runningSubagents?: number;
  onOpen?: () => void;
  onSelect?: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onWake?: () => void;
  onReopen?: () => void;
  onDropOnThread?: (source: unknown) => void;
}

function card(value: EnvironmentThreadShell, overrides: CardOverrides = {}) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId={overrides.gridId === undefined ? "grid-a" : overrides.gridId}
        thread={value}
        query=""
        providerEntries={new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={false}
        selected={false}
        dragging={false}
        workspaceTitle="Houston"
        timeLabel={overrides.timeLabel === undefined ? "9:00" : overrides.timeLabel}
        shelf={overrides.shelf ?? null}
        notInGrid={overrides.notInGrid ?? false}
        runningSubagents={overrides.runningSubagents ?? 0}
        onOpen={overrides.onOpen ?? (() => {})}
        onSelect={overrides.onSelect ?? (() => {})}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={() => {}}
        onDropOnThread={overrides.onDropOnThread ?? (() => {})}
        {...(overrides.onWake === undefined ? {} : { onWake: overrides.onWake })}
        {...(overrides.onReopen === undefined ? {} : { onReopen: overrides.onReopen })}
      />
    </TooltipProvider>
  );
}

function DropTargetProbe() {
  const target = useThreadDropTarget();
  return <output data-testid="drop-target">{target === null ? "none" : target.kind}</output>;
}

function rowOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-thread-key]")!;
}

function titleOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-card-open] > span")!;
}

describe("ThreadCard title against the trailing time and actions", () => {
  it("keeps a Closed row's title clear of its Reopen button", async () => {
    await using screen = await render(
      <div style={{ width: 240 }}>
        {card(thread({ id: "thread-closed", title: LONG_TITLE }), {
          shelf: "settled",
          timeLabel: "3d",
        })}
      </div>,
    );
    const row = rowOf(screen.container);
    await userEvent.hover(row);
    const reopen = screen.getByRole("button", { name: "Reopen thread" }).element();
    await expect.element(screen.getByRole("button", { name: "Reopen thread" })).toBeVisible();

    expect(titleOf(row).getBoundingClientRect().right).toBeLessThanOrEqual(
      reopen.getBoundingClientRect().left,
    );
  });

  it("keeps an On hold row's title readable beside its Wake button at the narrowest width", async () => {
    await using screen = await render(
      <div style={{ width: 240 }}>
        {card(thread({ id: "thread-held", title: LONG_TITLE }), {
          shelf: "snoozed",
          timeLabel: "tomorrow at 9:00 AM",
        })}
      </div>,
    );
    const row = rowOf(screen.container);
    await userEvent.hover(row);
    const wake = screen.getByRole("button", { name: "Wake thread now" }).element();
    await expect.element(screen.getByRole("button", { name: "Wake thread now" })).toBeVisible();

    const title = titleOf(row).getBoundingClientRect();
    expect(title.right).toBeLessThanOrEqual(wake.getBoundingClientRect().left);
    // The invisible wake time must not take room on top of the actions.
    expect(title.width).toBeGreaterThanOrEqual(60);
  });

  it("gives a resting row's title the width up to its time label", async () => {
    await using screen = await render(
      <div style={{ width: 320 }}>{card(thread({ title: LONG_TITLE }), { timeLabel: "3d" })}</div>,
    );
    const row = rowOf(screen.container);
    const time = screen.getByText("3d").element();
    // The hidden Hold, Close and More buttons take no room until the row is hovered.
    expect(
      time.getBoundingClientRect().left - titleOf(row).getBoundingClientRect().right,
    ).toBeLessThanOrEqual(12);

    await userEvent.hover(row);
    const hold = screen.getByRole("button", { name: "Hold" });
    await expect.element(hold).toBeVisible();
    expect(titleOf(row).getBoundingClientRect().right).toBeLessThanOrEqual(
      hold.element().getBoundingClientRect().left,
    );
  });

  it("cross-fades the time label and the actions in one grid cell", async () => {
    await using screen = await render(
      <div style={{ width: 240 }}>
        {card(thread({ title: LONG_TITLE }), {
          shelf: "snoozed",
          timeLabel: "tomorrow at 9:00 AM",
        })}
      </div>,
    );
    const row = rowOf(screen.container);
    const label = screen.getByText("tomorrow at 9:00 AM").element();
    const actions = screen.getByRole("button", { name: "Wake thread now" }).element()
      .parentElement as HTMLElement;
    const labelBox = label.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();

    expect(actions.parentElement).toBe(label.parentElement!.parentElement);
    expect(Math.abs(labelBox.right - actionsBox.right)).toBeLessThanOrEqual(1);
    expect(getComputedStyle(label.parentElement!).display).not.toBe("none");
    expect(getComputedStyle(actions).display).not.toBe("none");
    await userEvent.hover(row);
    await vi.waitFor(() => expect(getComputedStyle(label.parentElement!).opacity).toBe("0"));
    expect(getComputedStyle(actions).opacity).toBe("1");
  });
});

describe("ThreadCard hover actions over the fading time", () => {
  it("keeps every action the hit target at its own centre while the time label is faded", async () => {
    await using screen = await render(<div style={{ width: 300 }}>{card(thread())}</div>);
    await userEvent.hover(rowOf(screen.container));

    for (const name of ["Hold", "Close thread", /Thread actions for/]) {
      const button = screen.getByRole("button", { name }).element();
      await expect.element(screen.getByRole("button", { name })).toBeVisible();
      await userEvent.hover(button);
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      expect(hit === button || button.contains(hit)).toBe(true);
    }
  });
});

describe("ThreadCard on a shelf", () => {
  it("opens the row without selecting it when a selection modifier is held", async () => {
    const onSelect = vi.fn();
    const onOpen = vi.fn();
    await using screen = await render(
      card(thread(), { shelf: "settled", onSelect, onOpen, timeLabel: "3d" }),
    );

    await userEvent.click(titleOf(rowOf(screen.container)), { modifiers: ["Control"] });
    await userEvent.click(titleOf(rowOf(screen.container)), { modifiers: ["Shift"] });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still selects a regular row on a modified click", async () => {
    const onSelect = vi.fn();
    await using screen = await render(card(thread(), { onSelect }));

    await userEvent.click(titleOf(rowOf(screen.container)), { modifiers: ["Control"] });

    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ shiftKey: false, toggleKey: true });
  });

  it("reopens through the same action as the Reopen button when chosen from the menu", async () => {
    const onReopen = vi.fn();
    await using screen = await render(
      card(thread({ settledOverride: "settled" }), {
        shelf: "settled",
        onReopen,
        timeLabel: "3d",
      }),
    );

    await userEvent.click(rowOf(screen.container), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Reopen thread" }).element());

    await vi.waitFor(() => expect(onReopen).toHaveBeenCalledTimes(1));
  });

  it("wakes through the same action as the Wake button when chosen from the menu", async () => {
    const onWake = vi.fn();
    await using screen = await render(
      card(thread({ snoozedUntil: "2099-01-01T09:00:00.000Z" }), {
        shelf: "snoozed",
        onWake,
        timeLabel: "tomorrow at 9:00 AM",
      }),
    );

    await userEvent.click(rowOf(screen.container), { button: "right" });
    await userEvent.click(page.getByRole("menuitem", { name: "Bring thread back" }).element());

    await vi.waitFor(() => expect(onWake).toHaveBeenCalledTimes(1));
  });
});

describe("ThreadCard for a thread no grid shows", () => {
  it("does not register a drop target", async () => {
    using _drag = { [Symbol.dispose]: () => endThreadDrag() };
    const onDropOnThread = vi.fn();
    await using screen = await render(
      <>
        {card(thread(), { gridId: null, notInGrid: true, onDropOnThread })}
        <DropTargetProbe />
      </>,
    );
    const rect = rowOf(screen.container).getBoundingClientRect();

    await act(() =>
      beginThreadDragAt(
        { gridId: "grid-a", threadId: "thread-b", environmentId: "env-1", projectId: "project-1" },
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );

    expect(screen.getByTestId("drop-target").element().textContent).toBe("none");
  });
});

describe("ThreadCard second line at the narrowest sidebar", () => {
  it("truncates the subagent label and keeps the provider mark inside the row", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS });
    await using screen = await render(
      <div style={{ width: 240 }}>
        {card(
          thread({
            branch: "houston/a-very-long-branch-name-for-narrow-widths",
            pullRequests: [
              { number: 4812, url: "https://example.test/pr/4812", snapshot: { state: "open" } },
            ] as never,
          }),
          { runningSubagents: 12 },
        )}
      </div>,
    );
    const row = rowOf(screen.container);
    const mark = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
    const label = screen.getByText(/subagents? running|agents/).element();
    const rowBox = row.getBoundingClientRect();

    expect(mark.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right);
    expect(mark.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });
});
