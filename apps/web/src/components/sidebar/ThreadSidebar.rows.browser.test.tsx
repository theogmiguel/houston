import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { beginThreadDragAt, endThreadDrag, useThreadDropTarget } from "../../threads/threadDrag";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import type { SidebarProviderEntry } from "./SidebarThreadRow";
import { ThreadCard } from "./ThreadCard";

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
  workspaceId?: string | null;
  timeLabel?: string | null;
  runningSubagents?: number;
  onOpen?: () => void;
  onSelect?: (input: { shiftKey: boolean; toggleKey: boolean }) => void;
  onWake?: () => void;
  onReopen?: () => void;
  onDropOnThread?: (source: unknown) => void;
  providerEntries?: ReadonlyMap<string, SidebarProviderEntry>;
}

function card(value: EnvironmentThreadShell, overrides: CardOverrides = {}) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        workspaceId={overrides.workspaceId === undefined ? "ws-a" : overrides.workspaceId}
        thread={value}
        query=""
        providerEntries={overrides.providerEntries ?? new Map()}
        nowIso="2026-01-01T00:00:00.000Z"
        focused={false}
        selected={false}
        dragging={false}
        projectTitle="Houston"
        timeLabel={overrides.timeLabel === undefined ? "9:00" : overrides.timeLabel}
        shelf={overrides.shelf ?? null}
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

/** The title never runs under a row action: it ends before it. */
function expectTitleClearOf(title: DOMRect, action: DOMRect) {
  expect(title.top >= action.bottom || title.right <= action.left).toBe(true);
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

    expectTitleClearOf(titleOf(row).getBoundingClientRect(), reopen.getBoundingClientRect());
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
    expectTitleClearOf(title, wake.getBoundingClientRect());
    // The invisible wake time must not take room on top of the actions.
    expect(title.width).toBeGreaterThanOrEqual(60);
  });

  it("gives a resting row's title the full width of its line and its time the row's edge", async () => {
    await using screen = await render(
      <div style={{ width: 320 }}>{card(thread({ title: LONG_TITLE }), { timeLabel: "3d" })}</div>,
    );
    const row = rowOf(screen.container);
    const time = screen.getByText("3d").element();
    // The hidden Hold, Close and More buttons take no room until the row is hovered: the age
    // ends the title line at the row's edge and the title runs up to it. The provider mark closes
    // the second line, right under the age.
    const providerSlot = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
    const titleLine = row.querySelector<HTMLElement>("[data-thread-title-line]")!;
    expect(
      row.getBoundingClientRect().right - time.getBoundingClientRect().right,
    ).toBeLessThanOrEqual(12);
    // The 8px line gap plus the age cell's 28px minimum, which a short age sits right-aligned in.
    expect(
      time.getBoundingClientRect().left - titleOf(row).getBoundingClientRect().right,
    ).toBeLessThanOrEqual(24);
    expect(providerSlot.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      titleLine.getBoundingClientRect().bottom,
    );
    expect(
      Math.abs(providerSlot.getBoundingClientRect().right - time.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(1);

    await userEvent.hover(row);
    const hold = screen.getByRole("button", { name: "Hold" });
    await expect.element(hold).toBeVisible();
    expectTitleClearOf(
      titleOf(row).getBoundingClientRect(),
      hold.element().getBoundingClientRect(),
    );
  });

  it("cross-fades the time label and the actions in one grid cell", async () => {
    await using screen = await render(
      <div style={{ width: 240 }}>{card(thread({ title: LONG_TITLE }), { timeLabel: "6m" })}</div>,
    );
    const row = rowOf(screen.container);
    const label = screen.getByText("6m").element();
    const actions = screen.getByRole("button", { name: "Hold" }).element()
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
        {card(thread(), { workspaceId: null, onDropOnThread })}
        <DropTargetProbe />
      </>,
    );
    const rect = rowOf(screen.container).getBoundingClientRect();

    await act(() =>
      beginThreadDragAt(
        { threadId: "thread-b", environmentId: "env-1", projectId: "project-1" },
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        1,
      ),
    );

    expect(screen.getByTestId("drop-target").element().textContent).toBe("none");
  });
});

describe("ThreadCard lines at the narrowest sidebar", () => {
  it("keeps the subagent count inside the row", async () => {
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
    const label = screen.getByRole("img", { name: /subagents? running/ }).element();
    const rowBox = row.getBoundingClientRect();

    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(rowBox.right);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });
});

const PROVIDERS = new Map([
  [
    "claude",
    {
      instanceId: "claude",
      driverKind: "claudeAgent",
      enabled: true,
      displayName: "Claude",
      models: [],
    },
  ],
]) as unknown as ReadonlyMap<string, SidebarProviderEntry>;

function worstCaseRow(branch: string) {
  return thread({
    title: LONG_TITLE,
    branch,
    hasPendingUserInput: true,
    providerInstanceHistory: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    pullRequests: [
      { number: 4812, url: "https://example.test/pr/4812", snapshot: { state: "open" } },
    ] as never,
  });
}

const SIBLING_BRANCHES = ["v2-ui-feedback-composer", "v2-ui-feedback-chrome"] as const;

async function renderWorstCaseRows() {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS });
  const screen = await render(
    <div style={{ width: 240 }}>
      {SIBLING_BRANCHES.map((branch, index) => (
        <div key={branch}>
          {card({ ...worstCaseRow(branch), id: `thread-${index}` } as never, {
            timeLabel: "3d",
            providerEntries: PROVIDERS,
          })}
        </div>
      ))}
    </div>,
  );
  return {
    screen,
    rows: [...screen.container.querySelectorAll<HTMLElement>("[data-thread-key]")],
  };
}

describe("ThreadCard worst-case row at the narrowest sidebar", () => {
  it("keeps the title wide and never pushes it off by the status or the age", async () => {
    const { screen, rows } = await renderWorstCaseRows();
    await using _screen = screen;
    for (const row of rows) {
      const line = row.querySelector<HTMLElement>("[data-thread-title-line]")!;
      const title = titleOf(row).getBoundingClientRect();
      const time = row.querySelector<HTMLElement>(
        "[data-thread-title-line] > :not([data-card-open])",
      );
      expect(row.querySelector("[data-thread-status]")!.textContent).toBe("Input");
      expect(title.width).toBeGreaterThanOrEqual(line.getBoundingClientRect().width * 0.6);
      expect(title.left).toBeGreaterThanOrEqual(line.getBoundingClientRect().left);
      if (time !== null) expect(title.right).toBeLessThanOrEqual(time.getBoundingClientRect().left);
    }
  });

  it("keeps the pull request badge and the provider mark fully inside the row", async () => {
    const { screen, rows } = await renderWorstCaseRows();
    await using _screen = screen;
    for (const row of rows) {
      const rowBox = row.getBoundingClientRect();
      const badge = row.querySelector<HTMLElement>("[data-thread-pr-slot]")!;
      const mark = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
      expect(mark.querySelector("svg, img")).not.toBeNull();
      for (const box of [badge, mark].map((element) => element.getBoundingClientRect())) {
        expect(box.left).toBeGreaterThanOrEqual(rowBox.left);
        expect(box.right).toBeLessThanOrEqual(rowBox.right);
        expect(box.top).toBeGreaterThanOrEqual(rowBox.top);
        expect(box.bottom).toBeLessThanOrEqual(rowBox.bottom);
      }
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
  });

  it("tells sibling branches apart: a clipped branch is spelled out in full by the row's tooltip", async () => {
    const { screen, rows } = await renderWorstCaseRows();
    await using _screen = screen;
    const visible: string[] = [];
    for (const [index, row] of rows.entries()) {
      const branch = row.querySelector<HTMLElement>("[data-thread-branch] .truncate")!;
      expect(branch.textContent).toBe(SIBLING_BRANCHES[index]);
      const clipped = branch.scrollWidth > branch.clientWidth;
      visible.push(clipped ? "" : (branch.textContent ?? ""));
      if (!clipped) continue;
      await userEvent.hover(row);
      await expect.element(page.getByText(SIBLING_BRANCHES[index]!, { exact: true })).toBeVisible();
      await userEvent.unhover(row);
    }
    // Either both branches read in full, or each is recoverable from its tooltip.
    expect(visible.every((text) => text !== "") ? new Set(visible).size : 2).toBe(2);
  });
});

describe("ThreadCard status slot and branch line", () => {
  const withModel = (overrides: Record<string, unknown> = {}) =>
    thread({
      providerInstanceHistory: [],
      modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
      ...overrides,
    });

  async function renderOne(value: EnvironmentThreadShell) {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS });
    return render(
      <div style={{ width: 240 }}>
        {card(value, { timeLabel: "3d", providerEntries: PROVIDERS })}
      </div>,
    );
  }

  it("states an attention status with its glyph at the project line's end, in place of the age", async () => {
    await using screen = await renderOne(worstCaseRow("v2-ui-feedback-composer"));
    const row = rowOf(screen.container);
    const line = row.querySelector<HTMLElement>("[data-thread-project-line]")!;
    const status = line.querySelector<HTMLElement>("[data-thread-status]")!;
    expect(status.textContent).toBe("Input");
    expect(status.querySelector("[data-thread-status-glyph]")).not.toBeNull();
    expect(row.querySelector("[data-thread-time]")).toBeNull();
    // No leading glyph column: the title starts at the row's content edge.
    expect(row.querySelectorAll("[data-thread-status-glyph]")).toHaveLength(1);
    expect(row.querySelector("[data-thread-meta] [data-thread-status]")).toBeNull();
  });

  it("shows only the age for an idle row", async () => {
    await using screen = await renderOne(withModel());
    const row = rowOf(screen.container);
    expect(row.querySelector("[data-thread-status]")).toBeNull();
    expect(row.querySelector("[data-thread-project-line] [data-thread-time]")!.textContent).toBe(
      "3d",
    );
    expect(row.querySelector("[data-thread-status-glyph]")).toBeNull();
  });

  it("leads the second line with the branch, the default one included", async () => {
    await using screen = await renderOne(withModel({ branch: "main" }));
    const meta = rowOf(screen.container).querySelector<HTMLElement>("[data-thread-meta]")!;
    const first = meta.querySelector<HTMLElement>("[data-meta-label]")!;
    expect(first.getAttribute("data-meta-label")).toBe("Branch main");
  });

  it("puts the pull request beside the provider mark as its glyph and bare number", async () => {
    await using screen = await renderOne(worstCaseRow("v2-ui-feedback-composer"));
    const row = rowOf(screen.container);
    const badge = row.querySelector<HTMLElement>("[data-thread-pr-slot]")!;
    expect(badge.textContent).toBe("4812");
    const mark = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
    expect(badge.nextElementSibling).toBe(mark);
  });
});
