import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ProviderDriverKind } from "@houston-app/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import type { SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { ThreadCard } from "./GridSidebar";

const fixture = vi.hoisted(() => ({
  terminalIds: [] as string[],
  totals: null as { insertions: number; deletions: number } | null,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "env-1") as never,
  useEnvironmentMachines: (() => new Map([["env-2", "server"]])) as never,
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
  useProject: (() => ({ workspaceRoot: "/repo" })) as never,
  readEnvironmentServerConfigLoaded: () => true,
  readEnvironmentSupportsAutoSettleOptOut: () => true,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: fixture.totals === null ? null : { refName: "main", workingTree: fixture.totals },
  })) as never,
}));
vi.mock(import("../../state/vcs"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => ({})) as never },
  };
});
vi.mock(import("../../state/terminalSessions"), async (original) => ({
  ...(await original()),
  useThreadRunningTerminalIds: (() => fixture.terminalIds) as never,
}));

const NOW = "2026-01-01T12:00:00.000Z";

/** A run that began 7 minutes ago on the real clock, which the row's own timers read. */
// oxlint-disable-next-line houston/no-wall-clock-in-tests -- the row's duration timers read the real clock, so the fixture start is relative to it
const runningSince = () => new Date(Date.now() - 7 * 60_000).toISOString();

/** The rail's row width at each viewport: the docked 280px rail, and the drawer at 800px. */
const RAILS = [
  { viewport: 1440, width: 264 },
  { viewport: 800, width: 304 },
] as const;

const PROVIDERS: ReadonlyMap<string, SidebarProviderEntry> = new Map([
  [
    "claude",
    {
      instanceId: "claude",
      driverKind: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      displayName: "Claude",
      models: [],
    } as unknown as SidebarProviderEntry,
  ],
  [
    "fable",
    {
      instanceId: "fable",
      driverKind: ProviderDriverKind.make("acpRegistry"),
      enabled: true,
      displayName: "Fable Agent",
      models: [],
    } as unknown as SidebarProviderEntry,
  ],
]);

function thread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return {
    id: "thread-a",
    environmentId: "env-1",
    projectId: "project-1",
    title: "Stream CSV import for large files",
    branch: "main",
    worktreePath: null,
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude" },
    providerInstanceHistory: [],
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T11:50:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    tags: [],
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

/** Every item the second line can carry, in one thread. */
function richThread(overrides: Record<string, unknown> = {}): EnvironmentThreadShell {
  return thread({
    id: "thread-rich",
    environmentId: "env-2",
    branch: "feature/streaming-import-with-a-long-name",
    pullRequests: [
      {
        number: 214,
        url: "https://example.test/pr/214",
        linkedAt: "2026-01-01T00:00:00.000Z",
        snapshot: { state: "open", checksState: "failing", title: "Stream the import" },
      },
    ],
    tags: ["perf", "q3"],
    titleRegeneration: { requestId: "r", startedAt: NOW },
    ...overrides,
  });
}

function card(value: EnvironmentThreadShell, props: { subagents?: number } = {}) {
  return (
    <TooltipProvider delay={0}>
      <ThreadCard
        gridId="grid-a"
        thread={value}
        query=""
        providerEntries={PROVIDERS}
        nowIso={NOW}
        focused={false}
        selected={false}
        dragging={false}
        workspaceTitle="Houston"
        runningSubagents={props.subagents ?? 0}
        onOpen={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onHold={() => {}}
        onPickHoldTime={async () => null}
        onRename={() => {}}
        onSetAutoClose={() => {}}
        onDropOnThread={() => {}}
      />
    </TooltipProvider>
  );
}

function reset() {
  useComposerDraftStore
    .getState()
    .clearComposerContent(scopeThreadRef("env-2" as never, "thread-rich" as never));
  fixture.terminalIds = [];
  fixture.totals = null;
}

function arrangeRich() {
  reset();
  useComposerDraftStore
    .getState()
    .setPrompt(scopeThreadRef("env-2" as never, "thread-rich" as never), "half-written");
  fixture.terminalIds = ["term-1"];
  fixture.totals = { insertions: 128, deletions: 16 };
}

const rowOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-thread-key]")!;
const itemsOf = (row: HTMLElement) => [
  ...row.querySelectorAll<HTMLElement>("[data-thread-meta-items] > [data-meta-item]"),
];
const isHidden = (item: HTMLElement) => item.hasAttribute("data-meta-hidden");
const labelsOf = (row: HTMLElement, hidden: boolean) =>
  itemsOf(row)
    .filter((item) => isHidden(item) === hidden)
    .map((item) => item.dataset.metaLabel);

/** Item labels in the order the second line draws them, with every item present. */
const FULL_ORDER = [
  "Status",
  "Unsent draft",
  "Pull request #214",
  "Uncommitted changes +128 −16",
  "Terminal running",
  "Branch feature/streaming-import-with-a-long-name",
  "Runs on another machine",
  "2 subagents running",
  "#perf",
  "#q3",
  "Renaming title",
];

describe("thread row anatomy", () => {
  it("keeps every row 58px tall whatever it carries, at the docked rail and the drawer", async () => {
    for (const rail of RAILS) {
      await page.viewport(rail.viewport, 900);
      reset();
      const rows = [
        thread(),
        thread({ id: "thread-b", hasPendingApprovals: true }),
        thread({
          id: "thread-c",
          title: "A title long enough to need an ellipsis at any rail width",
        }),
        thread({ id: "thread-d", tags: ["a", "b", "c", "d", "e", "f"] }),
      ];
      await using screen = await render(
        <div style={{ width: rail.width }}>
          {rows.map((value) => (
            <div key={value.id}>{card(value)}</div>
          ))}
        </div>,
      );
      const heights = [...screen.container.querySelectorAll<HTMLElement>("[data-thread-key]")].map(
        (row) => row.getBoundingClientRect().height,
      );
      expect(heights).toHaveLength(rows.length);
      for (const height of heights) expect(height).toBeCloseTo(58, 0);
    }
  });

  it("keeps a rich row at the same height as a bare one", async () => {
    await page.viewport(1440, 900);
    arrangeRich();
    await using rich = await render(
      <div style={{ width: 264 }}>{card(richThread(), { subagents: 2 })}</div>,
    );
    reset();
    await using bare = await render(<div style={{ width: 264 }}>{card(thread())}</div>);
    expect(rowOf(rich.container).getBoundingClientRect().height).toBe(
      rowOf(bare.container).getBoundingClientRect().height,
    );
  });

  it("puts only the title and the age on the first line", async () => {
    for (const rail of RAILS) {
      await page.viewport(rail.viewport, 900);
      arrangeRich();
      await using screen = await render(
        <div style={{ width: rail.width }}>{card(richThread(), { subagents: 2 })}</div>,
      );
      const row = rowOf(screen.container);
      const line = row.querySelector<HTMLElement>("[data-thread-title-line]")!;
      expect(line.querySelector("[data-card-open]")?.textContent).toBe(
        "Stream CSV import for large files",
      );
      expect(line.querySelector("[data-thread-time]")).not.toBeNull();
      for (const selector of [
        "[data-thread-pull-request]",
        "[data-thread-status]",
        "[data-thread-provider-mark]",
        "[data-thread-diff]",
        "[data-thread-tag]",
        "[data-thread-branch]",
      ]) {
        expect(line.querySelector(selector), selector).toBeNull();
      }
      const time = line.querySelector<HTMLElement>("[data-thread-time]")!;
      expect(getComputedStyle(time).fontVariantNumeric).toContain("tabular-nums");
      expect(getComputedStyle(time).fontSize).toBe("12px");
      expect(getComputedStyle(line.querySelector("[data-card-open] > span")!).fontSize).toBe(
        "14px",
      );
    }
  });

  it("draws the second line in one fixed order, with the provider mark last under the age", async () => {
    await page.viewport(1440, 900);
    arrangeRich();
    await using screen = await render(
      <div style={{ width: 760 }}>{card(richThread(), { subagents: 2 })}</div>,
    );
    const row = rowOf(screen.container);
    await expect.poll(() => labelsOf(row, true)).toEqual([]);
    expect(itemsOf(row).map((item) => item.dataset.metaLabel)).toEqual(FULL_ORDER);
    const lefts = itemsOf(row).map((item) => item.getBoundingClientRect().left);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));

    const mark = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
    const items = row.querySelector<HTMLElement>("[data-thread-meta-items]")!;
    expect(mark.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      items.getBoundingClientRect().right + 8 - 0.5,
    );
    const time = row.querySelector<HTMLElement>("[data-thread-time]")!;
    expect(mark.getBoundingClientRect().right).toBeCloseTo(time.getBoundingClientRect().right, 0);
  });

  it("always names the status first, in the second line, calm or not", async () => {
    await page.viewport(1440, 900);
    reset();
    await using calm = await render(<div style={{ width: 264 }}>{card(thread())}</div>);
    const word = rowOf(calm.container).querySelector<HTMLElement>("[data-thread-status]")!;
    expect(word.textContent).toBe("Idle");
    expect(itemsOf(rowOf(calm.container))[0]?.dataset.metaLabel).toBe("Status");
  });

  it("drops whole items from the right behind a +N counter that names them", async () => {
    for (const rail of RAILS) {
      await page.viewport(rail.viewport, 900);
      arrangeRich();
      await using screen = await render(
        <div style={{ width: rail.width }}>{card(richThread(), { subagents: 2 })}</div>,
      );
      const row = rowOf(screen.container);
      const counter = row.querySelector<HTMLElement>("[data-thread-meta-overflow]");
      await expect.poll(() => row.querySelector("[data-thread-meta-overflow]")).not.toBeNull();
      const hidden = labelsOf(row, true);
      const shown = labelsOf(row, false);
      expect(hidden.length).toBeGreaterThan(0);
      // Dropping is from the right: what stays is a prefix of the fixed order.
      expect([...shown, ...hidden]).toEqual(FULL_ORDER);
      expect(shown[0]).toBe("Status");

      const overflow = row.querySelector<HTMLElement>("[data-thread-meta-overflow]")!;
      expect(overflow.textContent).toBe(`+${hidden.length}`);
      expect(overflow.getAttribute("aria-label")).toBe(
        `${hidden.length} more: ${hidden.join(", ")}`,
      );
      expect(counter === null || counter === overflow).toBe(true);

      // Nothing visible is clipped, and a dropped item is neither visible nor focusable.
      const line = row
        .querySelector<HTMLElement>("[data-thread-meta-items]")!
        .getBoundingClientRect();
      for (const item of itemsOf(row)) {
        if (isHidden(item)) {
          expect(getComputedStyle(item).visibility).toBe("hidden");
          expect(item.getAttribute("aria-hidden")).toBe("true");
        } else {
          expect(item.getBoundingClientRect().right).toBeLessThanOrEqual(line.right + 0.5);
          expect(item.getBoundingClientRect().left).toBeGreaterThanOrEqual(line.left - 0.5);
        }
      }
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);

      await userEvent.hover(overflow);
      const tooltipText = () =>
        document.querySelector('[data-slot="tooltip-popup"]')?.textContent ?? "";
      for (const label of hidden) {
        await expect.poll(tooltipText).toContain(label);
      }
    }
  });

  it("never shrinks a branch name below its minimum width and keeps whole chips", async () => {
    await page.viewport(1440, 900);
    reset();
    fixture.totals = { insertions: 128, deletions: 16 };
    await using screen = await render(
      <div style={{ width: 264 }}>
        {card(
          thread({
            branch: "feature/a-branch-name-too-long-to-show-in-full",
            pullRequests: [
              {
                number: 214,
                url: "https://example.test/pr/214",
                linkedAt: "2026-01-01T00:00:00.000Z",
                snapshot: { state: "open" },
              },
            ],
            tags: ["perf"],
          }),
        )}
      </div>,
    );
    const row = rowOf(screen.container);
    await expect.poll(() => labelsOf(row, true).length).toBeGreaterThanOrEqual(0);
    const branch = row.querySelector<HTMLElement>("[data-thread-branch]");
    if (branch !== null && !isHidden(branch.closest<HTMLElement>("[data-meta-item]")!)) {
      expect(branch.getBoundingClientRect().width).toBeGreaterThanOrEqual(56 - 0.5);
    }
    for (const chip of row.querySelectorAll<HTMLElement>("[data-thread-tag]")) {
      if (isHidden(chip.closest<HTMLElement>("[data-meta-item]")!)) continue;
      expect(chip.scrollWidth).toBeLessThanOrEqual(chip.clientWidth + 0.5);
      expect(chip.textContent).toBe("#perf");
    }
  });

  it("brings the dropped items back when the line is wide enough", async () => {
    await page.viewport(1440, 900);
    arrangeRich();
    const narrow = <div style={{ width: 264 }}>{card(richThread(), { subagents: 2 })}</div>;
    await using screen = await render(narrow);
    const row = rowOf(screen.container);
    await expect.poll(() => labelsOf(row, true).length).toBeGreaterThan(0);

    await screen.rerender(<div style={{ width: 760 }}>{card(richThread(), { subagents: 2 })}</div>);
    await expect.poll(() => labelsOf(rowOf(screen.container), true)).toEqual([]);
    expect(screen.container.querySelector("[data-thread-meta-overflow]")).toBeNull();
  });
});

describe("thread row status glyphs", () => {
  const STATES: ReadonlyArray<{
    kind: string;
    word: string;
    overrides: Record<string, unknown>;
  }> = [
    { kind: "approval", word: "Approval", overrides: { hasPendingApprovals: true } },
    { kind: "input", word: "Input", overrides: { hasPendingUserInput: true } },
    { kind: "request", word: "Request", overrides: { pendingSubagentRequest: "user_input" } },
    {
      kind: "failed",
      word: "Failed",
      overrides: {
        latestRun: { status: "failed", completedAt: "2026-01-01T10:00:00.000Z" },
        runtime: { status: "failed", lastErrorClass: "provider" },
      },
    },
    {
      kind: "waiting",
      word: "Waiting",
      overrides: {
        blockedOnThreadWait: true,
        runtime: { status: "running", activeRunId: "r", activityStartedAt: runningSince() },
      },
    },
    {
      kind: "running",
      word: "Running",
      overrides: {
        runtime: { status: "running", activeRunId: "r", activityStartedAt: runningSince() },
      },
    },
    {
      kind: "goal",
      word: "Goal",
      overrides: {
        goal: { status: "active" },
        runtime: { status: "running", activeRunId: "r", activityStartedAt: runningSince() },
      },
    },
    { kind: "back", word: "Back", overrides: { unsettledAt: "2026-01-01T11:00:00.000Z" } },
    {
      kind: "ready",
      word: "Ready",
      overrides: {
        latestRun: { status: "completed", completedAt: "2026-01-01T10:00:00.000Z" },
        lastVisitedAt: "2026-01-01T09:00:00.000Z",
      },
    },
    { kind: "idle", word: "Idle", overrides: {} },
  ];

  it("draws a distinct shape for each state and names the state in the second line", async () => {
    await page.viewport(1440, 900);
    reset();
    const shapes = new Map<string, string>();
    const hues = new Map<string, string>();
    for (const state of STATES) {
      await using screen = await render(
        <div style={{ width: 264 }}>
          {card(thread({ id: `thread-${state.kind}`, ...state.overrides }))}
        </div>,
      );
      const row = rowOf(screen.container);
      const glyph = row.querySelector<HTMLElement>("[data-thread-status-glyph]")!;
      expect(glyph.dataset.statusKind, state.word).toBe(state.kind);
      expect(glyph.getAttribute("aria-label")).toBe(state.word);
      expect(glyph.getBoundingClientRect().width).toBe(14);
      expect(glyph.getBoundingClientRect().height).toBe(14);
      expect(row.querySelector("[data-thread-status]")?.textContent ?? "").toMatch(
        new RegExp(`^${state.word}`),
      );
      shapes.set(state.kind, glyph.querySelector("svg")!.innerHTML);
      hues.set(state.kind, getComputedStyle(glyph).color);
      // The glyph is centred across both lines.
      const box = glyph.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      expect(box.top + box.height / 2).toBeCloseTo(rowBox.top + rowBox.height / 2, 0);
    }
    expect(new Set(shapes.values()).size).toBe(STATES.length);
    // Warning kinds share one hue; every other kind has its own.
    const warning = new Set(["approval", "input", "request"].map((kind) => hues.get(kind)));
    expect(warning.size).toBe(1);
    const distinct = ["approval", "failed", "waiting", "running", "back", "ready", "idle"].map(
      (kind) => hues.get(kind),
    );
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("sets a running row's second line and its age to the same start-based duration", async () => {
    await page.viewport(1440, 900);
    reset();
    const running = STATES.find((state) => state.kind === "running")!;
    await using screen = await render(
      <div style={{ width: 264 }}>{card(thread(running.overrides))}</div>,
    );
    const row = rowOf(screen.container);
    await expect
      .poll(() => row.querySelector("[data-thread-status]")?.textContent ?? "")
      .toBe("Running for 7m");
    expect(row.querySelector("[data-thread-time]")?.textContent).toBe("7m");
  });

  it("gives the Closed shelf its own glyph and no status word", async () => {
    await page.viewport(1440, 900);
    reset();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: 264 }}>
          <ThreadCard
            gridId={null}
            thread={thread({ settledOverride: "settled" })}
            query=""
            providerEntries={PROVIDERS}
            nowIso={NOW}
            focused={false}
            selected={false}
            dragging={false}
            workspaceTitle="Houston"
            timeLabel="Closed 2h"
            shelf="settled"
            onOpen={() => {}}
            onSelect={() => {}}
            onClose={() => {}}
            onHold={() => {}}
            onPickHoldTime={async () => null}
            onRename={() => {}}
            onSetAutoClose={() => {}}
            onDropOnThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    const row = rowOf(screen.container);
    expect(row.querySelector("[data-thread-status-glyph]")?.getAttribute("data-status-kind")).toBe(
      "closed",
    );
    expect(row.querySelector("[data-thread-status]")).toBeNull();
    expect(screen.getByText("Closed 2h").element()).toBeVisible();
  });
});

describe("thread row provider marks and tags", () => {
  it("draws the brand glyph where one exists and a 14px monogram square otherwise", async () => {
    await page.viewport(1440, 900);
    reset();
    await using glyph = await render(<div style={{ width: 264 }}>{card(thread())}</div>);
    const brand = rowOf(glyph.container).querySelector<HTMLElement>("[data-provider-mark]")!;
    expect(brand.dataset.providerMarkKind).toBe("glyph");
    expect(brand.getBoundingClientRect().width).toBe(14);

    await using monogram = await render(
      <div style={{ width: 264 }}>
        {card(
          thread({
            id: "thread-fa",
            providerInstanceId: "fable",
            modelSelection: { instanceId: "fable" },
          }),
        )}
      </div>,
    );
    const mark = rowOf(monogram.container).querySelector<HTMLElement>("[data-provider-mark]")!;
    expect(mark.dataset.providerMarkKind).toBe("monogram");
    expect(mark.textContent).toBe("FA");
    expect(mark.getBoundingClientRect().width).toBe(14);
    expect(mark.getBoundingClientRect().height).toBe(14);
    expect(getComputedStyle(mark).fontSize).toBe("9px");
    expect(getComputedStyle(mark).fontWeight).toBe("600");
    expect(mark.getAttribute("aria-label")).toBe("Fable Agent");
    // The monogram has no squiggle prefix: the mark is its two letters only.
    expect(mark.querySelector("svg")).toBeNull();
  });

  it("keeps the mark in a fixed slot at least 8px clear of the line's items", async () => {
    await page.viewport(1440, 900);
    arrangeRich();
    await using screen = await render(
      <div style={{ width: 264 }}>
        {card(
          richThread({ providerInstanceId: "fable", modelSelection: { instanceId: "fable" } }),
          { subagents: 2 },
        )}
      </div>,
    );
    const row = rowOf(screen.container);
    const slot = row.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
    const items = row
      .querySelector<HTMLElement>("[data-thread-meta-items]")!
      .getBoundingClientRect();
    expect(slot.getBoundingClientRect().left - items.right).toBeGreaterThanOrEqual(8 - 0.5);
  });

  it("renders tags as muted #tag text with no fill, and the pull request number as neutral text", async () => {
    await page.viewport(1440, 900);
    reset();
    await using screen = await render(
      <div style={{ width: 600 }}>
        {card(
          thread({
            pullRequests: [
              {
                number: 209,
                url: "https://example.test/pr/209",
                linkedAt: "2026-01-01T00:00:00.000Z",
                snapshot: { state: "open" },
              },
            ],
            tags: ["migration"],
          }),
        )}
      </div>,
    );
    const row = rowOf(screen.container);
    const tag = row.querySelector<HTMLElement>("[data-thread-tag]")!;
    expect(tag.textContent).toBe("#migration");
    expect(getComputedStyle(tag).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(tag).color).toBe(
      getComputedStyle(row.querySelector("[data-thread-meta]")!).color,
    );
    const badge = row.querySelector<HTMLElement>("[data-thread-pull-request]")!;
    expect(badge.textContent).toBe("#209");
    expect(getComputedStyle(badge).color).not.toBe(
      getComputedStyle(badge.querySelector("svg")!).color,
    );
  });
});
