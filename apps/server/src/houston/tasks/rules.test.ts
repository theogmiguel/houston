// The outcome rules of the Tasks backlog on literal values.
import type { OrchestrationV2RunStatus } from "@t3tools/contracts";
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
  branchSlug,
  buildBrief,
  checkAcceptance,
  checkFindings,
  checkComment,
  checkCommentCount,
  checkDescription,
  checkTaskCount,
  checkTitle,
  compareReady,
  parentCycle,
  queueOf,
  readiness,
  reviewTrigger,
  rollupDelivery,
  taskBranch,
  taskRunStateOf,
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

describe("branch slugs are short lowercase ascii", () => {
  it("keeps letters and digits, joined by single dashes", () => {
    expect(branchSlug("Fix the Login, page!")).toBe("fix-the-login-page");
    expect(taskBranch(7, "Fix the Login, page!")).toBe("houston/task/hou-7-fix-the-login-page");
  });

  it("cuts a long title to 40 characters without a trailing dash", () => {
    const title = `${"abcdefghi ".repeat(12)}`.trim();
    expect(title.length).toBeGreaterThanOrEqual(119);
    const slug = branchSlug(`${title}x`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("abcdefghi-abcdefghi-abcdefghi-abcdefghi");
    expect(branchSlug("Ünïcode — only ✓")).toBe("ncode-only");
  });

  it("a title with no ascii letter or digit still names a branch", () => {
    expect(taskBranch(3, "✓✓✓")).toBe("houston/task/hou-3");
  });
});

describe("the brief wraps task data in markers", () => {
  const brief = buildBrief({
    key: "HOU-7",
    title: "Fix the login page",
    description: "The button does nothing.",
    acceptance: ["clicking logs in", "errors show"],
    links: ["https://example.test/issue/7"],
    initiative: {
      name: "Auth",
      trackerDescription: "Rewrite auth (from the tracker)",
      localDecisions: ["keep the old cookie name"],
    },
  });

  it("holds every task field between the two markers", () => {
    const open = brief.indexOf("<<<HOUSTON-TASK-DATA");
    const close = brief.indexOf("HOUSTON-TASK-DATA>>>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    const data = brief.slice(open, close);
    for (const text of [
      "HOU-7",
      "Fix the login page",
      "The button does nothing.",
      "clicking logs in",
      "errors show",
      "https://example.test/issue/7",
      "Rewrite auth (from the tracker)",
      "keep the old cookie name",
    ]) {
      expect(data).toContain(text);
    }
  });

  it("labels the tracker description unverified and keeps local decisions apart", () => {
    const tracker = brief.indexOf("Rewrite auth (from the tracker)");
    const decisions = brief.indexOf("keep the old cookie name");
    const label = brief.lastIndexOf("unverified", tracker);
    expect(label).toBeGreaterThanOrEqual(0);
    expect(brief.slice(label, tracker).split("\n").length).toBeLessThanOrEqual(2);
    const decisionsHeading = brief.lastIndexOf("Local decisions", decisions);
    expect(decisionsHeading).toBeGreaterThan(tracker);
  });

  it("appends review findings for a retry", () => {
    const retry = buildBrief({
      key: "HOU-7",
      title: "t",
      description: "",
      acceptance: ["a"],
      links: [],
      initiative: null,
      findings: [
        { path: "src/a.ts", line: 3, severity: "high", category: "bug", message: "off by one" },
      ],
    });
    expect(retry).toContain("src/a.ts:3");
    expect(retry).toContain("off by one");
    expect(retry.indexOf("off by one")).toBeLessThan(retry.indexOf("HOUSTON-TASK-DATA>>>"));
  });
});

describe("every thread run status maps to one task run state", () => {
  const cases: ReadonlyArray<[OrchestrationV2RunStatus, HoustonTaskRunState]> = [
    ["preparing", "preparing"],
    ["queued", "preparing"],
    ["starting", "preparing"],
    ["running", "running"],
    ["waiting", "waiting_for_input"],
    ["completed", "waiting_for_input"],
    ["failed", "failed"],
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
    ["rolled_back", "interrupted"],
  ];
  it.each(cases)("%s -> %s", (status, state) => {
    expect(taskRunStateOf(status)).toBe(state);
  });
  it("covers all 10 statuses", () => {
    expect(new Set(cases.map(([status]) => status)).size).toBe(10);
  });
});

describe("review triggers follow the mode", () => {
  const events = [
    { name: "handback", event: { type: "handback" } },
    { name: "new head", event: { type: "push", headSha: "b2" } },
  ] as const;
  const expected: Record<string, Record<string, boolean>> = {
    manual: { handback: false, "new head": false },
    handback: { handback: true, "new head": false },
    every_push: { handback: false, "new head": true },
  };
  for (const mode of ["manual", "handback", "every_push"] as const) {
    for (const { name, event } of events) {
      it(`${mode} on ${name}`, () => {
        expect(reviewTrigger({ mode, event, reviewOpen: false, reviewedHeads: ["a1"] })).toBe(
          expected[mode]?.[name],
        );
      });
      it(`${mode} on ${name} while a review is open`, () => {
        expect(reviewTrigger({ mode, event, reviewOpen: true, reviewedHeads: ["a1"] })).toBe(
          mode === "handback" && name === "handback",
        );
      });
    }
  }
  it("every_push starts once per head", () => {
    expect(
      reviewTrigger({
        mode: "every_push",
        event: { type: "push", headSha: "a1" },
        reviewOpen: false,
        reviewedHeads: ["a1"],
      }),
    ).toBe(false);
  });
});

describe("review findings are bounded and name a wrong field", () => {
  const finding = {
    path: "src/a.ts",
    line: 1,
    severity: "high",
    category: "bug",
    message: "m",
  };
  const fieldOf = (value: unknown) => {
    expect(value).toBeInstanceOf(HoustonTaskError);
    return (value as HoustonTaskError).message;
  };

  it("accepts 100 findings and refuses 101 as a limit", () => {
    expect(
      checkFindings(
        "op",
        Array.from({ length: 100 }, () => finding),
      ),
    ).toHaveLength(100);
    const refused = refusal(
      checkFindings(
        "op",
        Array.from({ length: 101 }, () => finding),
      ),
    );
    expect(refused.kind).toBe("limit");
    expect(refused.limit).toBe(100);
    expect(refused.actual).toBe(101);
  });

  it("bounds the path at 512 characters and refuses absolute, drive and parent paths", () => {
    expect(checkFindings("op", [{ ...finding, path: "a".repeat(512) }])).toHaveLength(1);
    for (const path of ["a".repeat(513), "/etc/passwd", "C:\\x\\y.ts", "c:/x.ts", "src/../x.ts"]) {
      expect(fieldOf(checkFindings("op", [{ ...finding, path }]))).toMatch(/findings\[0\]\.path/);
    }
  });

  it("accepts each severity and category and refuses others", () => {
    for (const severity of ["high", "medium", "low", "nit"]) {
      expect(checkFindings("op", [{ ...finding, severity }])).toHaveLength(1);
    }
    for (const category of ["bug", "security", "performance", "other"]) {
      expect(checkFindings("op", [{ ...finding, category }])).toHaveLength(1);
    }
    expect(fieldOf(checkFindings("op", [{ ...finding, severity: "critical" }]))).toMatch(
      /findings\[0\]\.severity/,
    );
    expect(fieldOf(checkFindings("op", [{ ...finding, category: "style" }]))).toMatch(
      /findings\[0\]\.category/,
    );
  });

  it("bounds the message at 2,000 characters and needs a line", () => {
    expect(checkFindings("op", [{ ...finding, message: "m".repeat(2000) }])).toHaveLength(1);
    expect(
      fieldOf(checkFindings("op", [finding, { ...finding, message: "m".repeat(2001) }])),
    ).toMatch(/findings\[1\]\.message/);
    expect(fieldOf(checkFindings("op", [{ ...finding, line: -1 }]))).toMatch(/findings\[0\]\.line/);
  });
});
