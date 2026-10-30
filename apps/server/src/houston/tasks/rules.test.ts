// The outcome rules of the Tasks backlog on literal values.
import {
  HoustonTaskError,
  type HoustonTaskRunState,
  type HoustonTaskStatus,
} from "@t3tools/contracts/houston/tasks";
import { describe, expect, it } from "vite-plus/test";

import {
  OPEN_RUN_STATES,
  blockerCycle,
  blockerFinished,
  checkAcceptance,
  checkComment,
  checkCommentCount,
  checkDescription,
  checkTaskCount,
  checkTitle,
  compareReady,
  parentCycle,
  queueOf,
  readiness,
  rollupDelivery,
  v1PathMatches,
} from "./rules.ts";

const STATUSES: ReadonlyArray<HoustonTaskStatus> = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
];
const RUN_STATES: ReadonlyArray<HoustonTaskRunState> = [
  "preparing",
  "running",
  "waiting_for_input",
  "validating",
  "handed_back",
  "needs_review",
  "failed",
  "cancelled",
  "interrupted",
];

const refusal = (value: unknown) => {
  expect(value).toBeInstanceOf(HoustonTaskError);
  return value as HoustonTaskError;
};

describe("every limit names the limit, the actual value and the operation", () => {
  const cases = [
    {
      name: "title",
      accepted: () => checkTitle("houston.tasks.save", "t".repeat(200)),
      refused: () => checkTitle("houston.tasks.save", "t".repeat(201)),
      limit: 200,
      actual: 201,
    },
    {
      name: "description",
      accepted: () => checkDescription("houston.tasks.save", "d".repeat(65_536)),
      refused: () => checkDescription("houston.tasks.save", "d".repeat(65_537)),
      limit: 65_536,
      actual: 65_537,
    },
    {
      name: "comment",
      accepted: () => checkComment("houston.tasks.comment", "c".repeat(16_384)),
      refused: () => checkComment("houston.tasks.comment", "c".repeat(16_385)),
      limit: 16_384,
      actual: 16_385,
    },
    {
      name: "acceptance items",
      accepted: () =>
        checkAcceptance(
          "houston.tasks.save",
          Array.from({ length: 50 }, (_, index) => `item ${index}`),
        ),
      refused: () =>
        checkAcceptance(
          "houston.tasks.save",
          Array.from({ length: 51 }, (_, index) => `item ${index}`),
        ),
      limit: 50,
      actual: 51,
    },
    {
      name: "comments per task",
      accepted: () => checkCommentCount("houston.tasks.comment", 499),
      refused: () => checkCommentCount("houston.tasks.comment", 500),
      limit: 500,
      actual: 501,
    },
    {
      name: "tasks",
      accepted: () => checkTaskCount("houston.tasks.save", 4_999),
      refused: () => checkTaskCount("houston.tasks.save", 5_000),
      limit: 5_000,
      actual: 5_001,
    },
  ] as const;

  it.each(cases)("$name", (testCase) => {
    expect(testCase.accepted()).not.toBeInstanceOf(HoustonTaskError);
    const error = refusal(testCase.refused());
    expect(error.kind).toBe("limit");
    expect(error.limit).toBe(testCase.limit);
    expect(error.actual).toBe(testCase.actual);
    expect(error.operation).toBe(
      testCase.name.startsWith("comment") ? "houston.tasks.comment" : "houston.tasks.save",
    );
    expect(error.message).toContain(String(testCase.limit));
    expect(error.message).toContain(String(testCase.actual));
    expect(error.message).toContain(error.operation);
  });

  it("an empty or blank title is invalid, not a limit", () => {
    expect(refusal(checkTitle("houston.tasks.save", "")).kind).toBe("invalid");
    expect(refusal(checkTitle("houston.tasks.save", "   ")).kind).toBe("invalid");
    expect(checkTitle("houston.tasks.save", "  Fix it  ")).toBe("Fix it");
  });

  it("an empty acceptance item is invalid", () => {
    expect(refusal(checkAcceptance("houston.tasks.save", ["ok", " "])).kind).toBe("invalid");
  });
});

describe("a parent that is the task or its descendant is a cycle", () => {
  // 1 <- 2 <- 3 (3's parent is 2, 2's parent is 1); 4 stands alone.
  const parents = new Map<number, number | null>([
    [1, null],
    [2, 1],
    [3, 2],
    [4, null],
  ]);
  const parentOf = (id: number) => parents.get(id);

  it("the task itself is a cycle", () => {
    expect(parentCycle(2, 2, parentOf)).toBe("cycle");
  });

  it("a descendant is a cycle, at any depth", () => {
    expect(parentCycle(1, 2, parentOf)).toBe("cycle");
    expect(parentCycle(1, 3, parentOf)).toBe("cycle");
  });

  it("an ancestor or an unrelated task is fine, and an unknown parent is missing", () => {
    expect(parentCycle(3, 1, parentOf)).toBeNull();
    expect(parentCycle(4, 3, parentOf)).toBeNull();
    expect(parentCycle(null, 3, parentOf)).toBeNull();
    expect(parentCycle(4, 99, parentOf)).toBe("missing");
  });
});

describe("a blocker cycle is refused", () => {
  const blocks = new Map<number, ReadonlyArray<number>>([
    [1, [2]],
    [2, []],
    [3, [1]],
  ]);
  const blockersOf = (id: number) => blocks.get(id) ?? [];

  it("A blocked by B, then B blocked by A, is a cycle", () => {
    expect(blockerCycle(2, [1], blockersOf)).toBe(true);
  });

  it("A blocked by itself is a cycle", () => {
    expect(blockerCycle(1, [1], blockersOf)).toBe(true);
  });

  it("a longer loop is a cycle and a chain is not", () => {
    // 2 blocked by 3: 3 -> 1 -> 2 closes the loop.
    expect(blockerCycle(2, [3], blockersOf)).toBe(true);
    expect(blockerCycle(3, [2], blockersOf)).toBe(false);
    expect(blockerCycle(4, [1, 3], blockersOf)).toBe(false);
  });
});

describe("each task sits in exactly one queue", () => {
  const OPEN = new Set<HoustonTaskRunState>([
    "preparing",
    "running",
    "waiting_for_input",
    "validating",
  ]);

  const expected = (input: {
    readonly status: HoustonTaskStatus;
    readonly archived: boolean;
    readonly ready: boolean;
    readonly runState: HoustonTaskRunState | null;
  }) => {
    if (input.archived) return "none";
    const open = input.runState !== null && OPEN.has(input.runState) ? input.runState : null;
    if (open === "waiting_for_input") return "your_turn";
    if (open !== null) return "working";
    if (input.status === "in_review") return "your_turn";
    if (input.status === "in_progress") return "stopped";
    if (input.status === "todo" && input.ready) return "up_next";
    return "none";
  };

  it("the open run states are the four in flight", () => {
    expect([...OPEN_RUN_STATES].toSorted()).toEqual([...OPEN].toSorted());
  });

  const runs: ReadonlyArray<HoustonTaskRunState | null> = [null, ...RUN_STATES];
  const table = STATUSES.flatMap((status) =>
    runs.flatMap((runState) =>
      [false, true].flatMap((archived) =>
        [false, true].map((ready) => ({ status, archived, ready, runState })),
      ),
    ),
  );
  it.each(table)("$status, run $runState, archived $archived, ready $ready", (input) => {
    expect(queueOf(input)).toBe(expected(input));
  });

  it("in review with an open review run is working (the strong case)", () => {
    expect(
      queueOf({ status: "in_review", archived: false, ready: false, runState: "running" }),
    ).toBe("working");
    expect(queueOf({ status: "in_review", archived: false, ready: false, runState: null })).toBe(
      "your_turn",
    );
  });

  it("a waiting run is your turn even in progress; a closed run is ignored", () => {
    expect(
      queueOf({
        status: "in_progress",
        archived: false,
        ready: true,
        runState: "waiting_for_input",
      }),
    ).toBe("your_turn");
    expect(
      queueOf({ status: "in_progress", archived: false, ready: true, runState: "interrupted" }),
    ).toBe("stopped");
  });
});

describe("ready tasks order by priority then age", () => {
  const task = (id: number, priority: string, createdAt: string) => ({
    id,
    number: id,
    priority: priority as "none" | "urgent" | "high" | "medium" | "low",
    createdAt,
  });

  it("urgent, high, medium, low, then none; oldest first within a priority", () => {
    const tasks = [
      task(1, "none", "2026-01-01T00:00:00.000Z"),
      task(2, "low", "2026-01-02T00:00:00.000Z"),
      task(3, "urgent", "2026-01-05T00:00:00.000Z"),
      task(4, "high", "2026-01-04T00:00:00.000Z"),
      task(5, "medium", "2026-01-03T00:00:00.000Z"),
      task(6, "urgent", "2026-01-04T00:00:00.000Z"),
      task(7, "high", "2026-01-03T00:00:00.000Z"),
    ];
    expect(tasks.toSorted(compareReady).map((entry) => entry.id)).toEqual([6, 3, 7, 4, 5, 2, 1]);
  });

  it("an urgent task blocked by an unfinished one is skipped for a ready high one", () => {
    const urgent = readiness({
      hasProject: true,
      acceptance: ["works"],
      unansweredQuestions: 0,
      unfinishedBlockers: [9],
      domain: null,
      planningOpen: false,
    });
    const high = readiness({
      hasProject: true,
      acceptance: ["works"],
      unansweredQuestions: 0,
      unfinishedBlockers: [],
      domain: null,
      planningOpen: false,
    });
    const candidates = [
      { ...task(1, "urgent", "2026-01-01T00:00:00.000Z"), ready: urgent.ready },
      { ...task(2, "high", "2026-01-02T00:00:00.000Z"), ready: high.ready },
    ];
    const next = candidates.filter((entry) => entry.ready).toSorted(compareReady)[0];
    expect(next?.id).toBe(2);
  });
});

describe("a delivery rolls up from its slices only", () => {
  const slice = (status: HoustonTaskStatus) => ({ kind: "slice" as const, status });

  it("2 slices, 1 done: not done", () => {
    expect(
      rollupDelivery({
        current: "todo",
        userStatusOverride: false,
        children: [slice("done"), slice("todo")],
      }),
    ).not.toBe("done");
  });

  it("both slices done: done", () => {
    expect(
      rollupDelivery({
        current: "in_progress",
        userStatusOverride: false,
        children: [slice("done"), slice("done")],
      }),
    ).toBe("done");
  });

  it("a non-slice child that is not done is ignored (the strong case)", () => {
    expect(
      rollupDelivery({
        current: "in_progress",
        userStatusOverride: false,
        children: [
          slice("done"),
          slice("done"),
          { kind: null, status: "todo" },
          { kind: "delivery", status: "in_progress" },
        ],
      }),
    ).toBe("done");
  });

  it("a delivery the user set stays", () => {
    expect(
      rollupDelivery({
        current: "in_progress",
        userStatusOverride: true,
        children: [slice("done"), slice("done")],
      }),
    ).toBeNull();
  });

  it("no slices changes nothing, and an unchanged status is no change", () => {
    expect(
      rollupDelivery({
        current: "todo",
        userStatusOverride: false,
        children: [{ kind: null, status: "done" }],
      }),
    ).toBeNull();
    expect(
      rollupDelivery({ current: "done", userStatusOverride: false, children: [slice("done")] }),
    ).toBeNull();
  });
});

describe("a blocker is finished when done or canceled", () => {
  const table = STATUSES.flatMap((status) =>
    [false, true].map((archived) => ({ status, archived })),
  );
  it.each(table)("$status, archived $archived", ({ status, archived }) => {
    expect(blockerFinished({ status, archived })).toBe(status === "done" || status === "canceled");
  });
});

describe("readiness lists every missing condition", () => {
  const ready = {
    hasProject: true,
    acceptance: ["the page loads"],
    unansweredQuestions: 0,
    unfinishedBlockers: [] as ReadonlyArray<number>,
    domain: null,
    planningOpen: false,
  };

  it("all conditions hold: ready, no reasons", () => {
    expect(readiness(ready)).toMatchObject({ ready: true, reasons: [] });
  });

  const missing = [
    { name: "project", patch: { hasProject: false }, reason: /project/ },
    { name: "acceptance item", patch: { acceptance: [] }, reason: /acceptance/ },
    { name: "tbd acceptance item", patch: { acceptance: ["TBD"] }, reason: /acceptance/ },
    { name: "open question", patch: { unansweredQuestions: 2 }, reason: /2 unanswered/ },
    { name: "unfinished blocker", patch: { unfinishedBlockers: [4, 5] }, reason: /2 unfinished/ },
  ] as const;

  it.each(missing)("missing $name", (condition) => {
    const result = readiness({ ...ready, ...condition.patch });
    expect(result.ready).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(condition.reason);
  });

  it("every missing condition is listed at once", () => {
    const result = readiness({
      hasProject: false,
      acceptance: [],
      unansweredQuestions: 1,
      unfinishedBlockers: [3],
      domain: null,
      planningOpen: false,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toHaveLength(4);
  });

  it("an unresolved tracker conflict makes a task unready", () => {
    const conflicted = readiness({ ...ready, trackerConflict: true });
    expect(conflicted.ready).toBe(false);
    expect(conflicted.reasons).toEqual(["the task has an unresolved tracker conflict"]);
    expect(readiness({ ...ready, trackerConflict: false })).toMatchObject({
      ready: true,
      reasons: [],
    });
  });

  it("a task with no domain row needs no initiative; a delivery does", () => {
    expect(readiness({ ...ready, domain: null }).ready).toBe(true);
    expect(readiness({ ...ready, domain: { kind: "slice", initiative: null } }).ready).toBe(true);
    const delivery = readiness({ ...ready, domain: { kind: "delivery", initiative: null } });
    expect(delivery.ready).toBe(false);
    expect(delivery.reasons[0]).toMatch(/initiative/);
  });
});

describe("v1 workspace paths match project roots per platform", () => {
  it("an exact path matches", () => {
    expect(v1PathMatches("/dev/x", "/dev/x", "linux")).toBe(true);
    expect(v1PathMatches("C:\\dev\\x", "C:\\dev\\x", "win32")).toBe(true);
  });

  it("on Windows, case and a trailing separator do not matter (the strong case)", () => {
    expect(v1PathMatches("C:\\dev\\x\\", "c:\\dev\\x", "win32")).toBe(true);
    expect(v1PathMatches("C:/dev/x", "c:\\dev\\x", "win32")).toBe(true);
    expect(v1PathMatches("C:\\dev\\xy", "c:\\dev\\x", "win32")).toBe(false);
  });

  it("on Linux, case matters and a trailing slash does not", () => {
    expect(v1PathMatches("/dev/x", "/dev/X", "linux")).toBe(false);
    expect(v1PathMatches("/dev/x/", "/dev/x", "linux")).toBe(true);
    expect(v1PathMatches("/", "/", "linux")).toBe(true);
  });
});
