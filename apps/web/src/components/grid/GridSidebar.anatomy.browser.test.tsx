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
import { ThreadCard } from "./ThreadCard";

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
        workspaceId="ws-a"
        thread={value}
        query=""
        providerEntries={PROVIDERS}
        nowIso={NOW}
        focused={false}
        selected={false}
        dragging={false}
        projectTitle="Houston"
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
  "Branch feature/streaming-import-with-a-long-name",
  "Unsent draft",
  "Terminal running",
  "Runs on another machine",
  "2 subagents running",
  "#perf",
  "#q3",
  "Renaming title",
];

/** The locked order of the second line, by the start of each item's label. */
const ORDER_PREFIXES = [
  "Branch",
  "Worktree",
  "Unsent draft",
  "Uncommitted changes",
  "Terminal",
  "Runs on another machine",
  "1 subagent",
  "2 subagents",
  "#",
  "Renaming",
];

describe("thread row anatomy", () => {
  it("keeps every row 60px tall whatever it carries, with 2px between its three lines, at the docked rail and the drawer", async () => {
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
      for (const height of heights) expect(height).toBeCloseTo(60, 0);
      for (const row of screen.container.querySelectorAll<HTMLElement>("[data-thread-key]")) {
        const project = row.querySelector("[data-thread-project-line]")!.getBoundingClientRect();
        const title = row.querySelector("[data-thread-title-line]")!.getBoundingClientRect();
        const meta = row.querySelector("[data-thread-meta]")!.getBoundingClientRect();
        expect(title.top - project.bottom).toBeCloseTo(2, 0);
        expect(meta.top - title.bottom).toBeCloseTo(2, 0);
      }
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

  it("puts the project and the age on the first line and the title alone on the second", async () => {
    for (const rail of RAILS) {
      await page.viewport(rail.viewport, 900);
      arrangeRich();
      await using screen = await render(
        <div style={{ width: rail.width }}>{card(richThread(), { subagents: 2 })}</div>,
      );
      const row = rowOf(screen.container);
      const first = row.querySelector<HTMLElement>("[data-thread-project-line]")!;
      expect(first.querySelector("[data-thread-project]")?.textContent).toBe("Houston");
      expect(first.querySelector("[data-thread-time]")).not.toBeNull();
      const time = first.querySelector<HTMLElement>("[data-thread-time]")!;
      expect(getComputedStyle(time).fontVariantNumeric).toContain("tabular-nums");
      expect(getComputedStyle(time).fontSize).toBe("12px");

      const second = row.querySelector<HTMLElement>("[data-thread-title-line]")!;
      expect(second.querySelector("[data-card-open]")?.textContent).toBe(
        "Stream CSV import for large files",
      );
      expect(second.textContent).toBe("Stream CSV import for large files");
      expect(getComputedStyle(second.querySelector("[data-card-open] > span")!).fontSize).toBe(
        "14px",
      );
      // The title takes the row's full content width.
      const rowBox = row.getBoundingClientRect();
      const titleBox = second.getBoundingClientRect();
      expect(titleBox.left - rowBox.left).toBeLessThan(24);
      expect(rowBox.right - titleBox.right).toBeLessThan(16);
      for (const selector of [
        "[data-thread-pull-request]",
        "[data-thread-provider-mark]",
        "[data-thread-diff]",
        "[data-thread-tag]",
        "[data-thread-branch]",
      ]) {
        expect(first.querySelector(selector), selector).toBeNull();
        expect(second.querySelector(selector), selector).toBeNull();
      }
    }
  });

  it("draws the third line in one fixed order, with the provider mark last at the right edge", async () => {
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
    const pullRequest = row.querySelector<HTMLElement>("[data-thread-pr-slot]")!;
    const diff = row.querySelector<HTMLElement>("[data-thread-diff]")!;
    expect(diff.textContent).toContain("128");
    expect(pullRequest.nextElementSibling).toBe(diff);
    expect(diff.nextElementSibling).toBe(mark);
    expect(pullRequest.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      items.getBoundingClientRect().right + 8 - 0.5,
    );
    expect(diff.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      pullRequest.getBoundingClientRect().right - 0.5,
    );
    expect(mark.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      diff.getBoundingClientRect().right - 0.5,
    );
    const time = row.querySelector<HTMLElement>("[data-thread-time]")!;
    expect(mark.getBoundingClientRect().right).toBeCloseTo(time.getBoundingClientRect().right, 0);
  });

  it("keeps the same order on rows that carry only some of the items", async () => {
    await page.viewport(1440, 900);
    const subagentsAndTags = thread({
      id: "thread-coordinate",
      blockedOnThreadWait: true,
      tags: ["migration", "q3"],
      runtime: { status: "running", activeRunId: "r", activityStartedAt: runningSince() },
    });
    const pullRequestAndDiff = thread({
      id: "thread-csv",
      pullRequests: [
        {
          number: 214,
          url: "https://example.test/pr/214",
          linkedAt: "2026-01-01T00:00:00.000Z",
          snapshot: { state: "open", checksState: "failing" },
        },
      ],
    });
    reset();
    fixture.totals = { insertions: 128, deletions: 16 };
    const cases = [
      {
        value: subagentsAndTags,
        subagents: 1,
        labels: ["Branch main", "1 subagent running"],
        pullRequest: false,
        diff: true,
      },
      {
        value: pullRequestAndDiff,
        subagents: 0,
        labels: ["Branch main"],
        pullRequest: true,
        diff: true,
      },
    ];
    for (const { value, subagents, labels, pullRequest, diff } of cases) {
      await using screen = await render(
        <div style={{ width: 760 }}>{card(value, { subagents })}</div>,
      );
      const row = rowOf(screen.container);
      const drawn = itemsOf(row).map((item) => item.dataset.metaLabel ?? "");
      const ranks = drawn.map((label) =>
        ORDER_PREFIXES.findIndex((prefix) => label.startsWith(prefix)),
      );
      expect(ranks).not.toContain(-1);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      for (const label of labels) expect(drawn).toContain(label);
      expect(row.querySelector("[data-thread-pr-slot]") !== null).toBe(pullRequest);
      // Both rows share the fixture totals, so the counts are drawn on each.
      expect(row.querySelector("[data-thread-diff]") !== null).toBe(diff);
    }
  });

  it("states no status for a calm row: only its age on the project line, and no Idle word", async () => {
    await page.viewport(1440, 900);
    reset();
    await using calm = await render(<div style={{ width: 264 }}>{card(thread())}</div>);
    const row = rowOf(calm.container);
    expect(row.querySelector("[data-thread-status]")).toBeNull();
    expect(row.querySelector("[data-thread-status-glyph]")).toBeNull();
    expect(row.querySelector("[data-thread-project-line] [data-thread-time]")).not.toBeNull();
    expect(row.textContent).not.toContain("Idle");
    expect(itemsOf(row).map((item) => item.dataset.metaLabel)).not.toContain("Status");
    expect(itemsOf(row)[0]?.dataset.metaLabel).toBe("Branch main");
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
      // The sub-agent count goes first, then items go from the right: what stays is a prefix of
      // the fixed order, less the sub-agent count.
      expect(hidden).toContain("2 subagents running");
      expect(shown).not.toContain("2 subagents running");
      const withoutPeople = FULL_ORDER.filter((label) => label !== "2 subagents running");
      expect(shown).toEqual(withoutPeople.slice(0, shown.length));
      expect(shown[0]).toBe(FULL_ORDER[0]);

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

  it("draws a distinct shape for each state and names the state at the project line's end", async () => {
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
      if (state.kind === "idle") {
        // An idle row has nothing to state: no glyph and no word, only the age.
        expect(row.querySelector("[data-thread-status-glyph]")).toBeNull();
        expect(row.querySelector("[data-thread-status]")).toBeNull();
        continue;
      }
      // Every status, Back included, sits at the end of the project line.
      const line = "[data-thread-project-line]";
      const glyph = row.querySelector<HTMLElement>(`${line} [data-thread-status-glyph]`)!;
      expect(glyph.dataset.statusKind, state.word).toBe(state.kind);
      expect(glyph.getAttribute("aria-label")).toBe(state.word);
      expect(glyph.getBoundingClientRect().width).toBe(14);
      expect(glyph.getBoundingClientRect().height).toBe(14);
      expect(row.querySelector("[data-thread-status]")?.textContent ?? "").toMatch(
        new RegExp(`^${state.word}`),
      );
      shapes.set(state.kind, glyph.querySelector("svg")!.innerHTML);
      hues.set(state.kind, getComputedStyle(glyph).color);
      // The glyph is centred on the title line and sits before its word.
      const box = glyph.getBoundingClientRect();
      const lineBox = row.querySelector(line)!.getBoundingClientRect();
      expect(box.top + box.height / 2).toBeCloseTo(lineBox.top + lineBox.height / 2, 0);
      expect(glyph.nextElementSibling?.textContent ?? glyph.nextSibling?.textContent).toMatch(
        new RegExp(`^${state.word}`),
      );
    }
    const stated = STATES.filter((state) => state.kind !== "idle");
    expect(new Set(shapes.values()).size).toBe(stated.length);
    // Input, Request and Approval share the amber hue, and every other kind has its own hue.
    const inputFamily = new Set(["input", "request", "approval"].map((kind) => hues.get(kind)));
    expect(inputFamily.size).toBe(1);
    const distinct = ["input", "failed", "waiting", "running", "back", "ready"].map((kind) =>
      hues.get(kind),
    );
    expect(new Set(distinct).size).toBe(distinct.length);
  });

  it("draws the Failed glyph's ink as wide as the Ready glyph's, not a small cross in a faint disc", async () => {
    await page.viewport(1440, 900);
    reset();
    /** The width of the stroked geometry, the part of a glyph the eye reads at 14px. */
    const inkWidth = async (kind: string) => {
      const state = STATES.find((candidate) => candidate.kind === kind)!;
      await using screen = await render(
        <div style={{ width: 264 }}>
          {card(thread({ id: `thread-${kind}`, ...state.overrides }))}
        </div>,
      );
      const svg = rowOf(screen.container).querySelector<SVGSVGElement>(
        "[data-thread-status-glyph] svg",
      )!;
      // The stroke is painted once on the 24-unit viewBox and scales with the glyph.
      const scale = svg.getBoundingClientRect().width / 24;
      return (svg.getBBox().width + Number(svg.getAttribute("stroke-width"))) * scale;
    };
    const ready = await inkWidth("ready");
    const failed = await inkWidth("failed");
    expect(failed).toBeGreaterThanOrEqual(ready - 1.5);
    expect(failed).toBeGreaterThanOrEqual(11);
  });

  it("states a running row's elapsed time once, after its word, in the age's place", async () => {
    await page.viewport(1440, 900);
    reset();
    const running = STATES.find((state) => state.kind === "running")!;
    await using screen = await render(
      <div style={{ width: 264 }}>{card(thread(running.overrides))}</div>,
    );
    const row = rowOf(screen.container);
    await expect
      .poll(() => row.querySelector("[data-thread-status]")?.textContent ?? "")
      .toBe("Running 7m");
    // The elapsed time replaces the age: there is no second clock on the row.
    expect(row.querySelector("[data-thread-time]")).toBeNull();
    expect(row.querySelector("[data-thread-meta] [data-thread-status]")).toBeNull();
  });

  it("gives the Closed shelf neither a glyph nor a status word", async () => {
    await page.viewport(1440, 900);
    reset();
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: 264 }}>
          <ThreadCard
            workspaceId={null}
            thread={thread({ settledOverride: "settled" })}
            query=""
            providerEntries={PROVIDERS}
            nowIso={NOW}
            focused={false}
            selected={false}
            dragging={false}
            projectTitle="Houston"
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
    expect(row.querySelector("[data-thread-status-glyph]")).toBeNull();
    expect(row.querySelector("[data-thread-status]")).toBeNull();
    expect(screen.getByText("Closed 2h").element()).toBeVisible();
  });
});

describe("thread row provider marks and tags", () => {
  it("draws the brand glyph where one exists and a 16px monogram tile otherwise", async () => {
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
    expect(mark.getBoundingClientRect().width).toBe(16);
    expect(mark.getBoundingClientRect().height).toBe(16);
    expect(getComputedStyle(mark).fontSize).toBe("11px");
    expect(getComputedStyle(mark).fontWeight).toBe("600");
    expect(mark.getAttribute("aria-label")).toBe("Fable Agent");
    // The monogram is neutral: it shares no hue with the status colours.
    const ink = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const statusHues = [
      "--status-running-ink",
      "--status-back-ink",
      "--status-waiting-ink",
      "--status-input-ink",
      "--status-approval-ink",
      "--success-foreground",
      "--error-foreground",
    ];
    for (const token of statusHues) expect(getComputedStyle(mark).color).not.toBe(ink(token));
    expect(getComputedStyle(mark).color).toBe(ink("--color-secondary-label"));
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
    expect(badge.textContent).toBe("209");
    expect(getComputedStyle(badge).color).not.toBe(
      getComputedStyle(badge.querySelector("svg")!).color,
    );
  });
});
