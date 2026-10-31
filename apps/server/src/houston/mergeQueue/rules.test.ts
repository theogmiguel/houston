// The merge queue's pure rules on literal values.
import { describe, expect, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonMergeQueueEntry } from "@t3tools/contracts/houston/mergeQueue";
import type { HoustonTaskRunState } from "@t3tools/contracts/houston/tasks";

import {
  checkEnqueue,
  checkSettings,
  failureHolds,
  failureNote,
  gates,
  handOffMode,
  line,
  nextUp,
  order,
  pushGuard,
  reportTail,
  verificationHolds,
  wslRefusal,
  type Facts,
  type LineContext,
  type QueueRow,
  type Review,
} from "./rules.ts";

const PROJECT = "project-rules" as ProjectId;
const sha = (n: number) => n.toString(16).padStart(40, "0");

const facts = (patch: Partial<Facts> = {}): Facts => ({
  readAt: "2026-10-30T10:00:00.000Z",
  error: null,
  state: "open",
  isDraft: false,
  headSha: sha(1),
  headRef: "houston/one",
  baseRef: "main",
  title: "One",
  url: "https://github.com/o/r/pull/7",
  checks: [{ name: "build", status: "success", required: true }],
  reviewDecision: "approved",
  mergeState: "CLEAN",
  mergeability: "mergeable",
  unresolvedThreads: 0,
  threadsTruncated: false,
  mergeMethods: { merge: true, squash: true, rebase: true },
  defaultBranch: "main",
  ...patch,
});

const row = (number: number, patch: Partial<QueueRow> = {}): QueueRow => ({
  projectId: PROJECT,
  number,
  repository: "o/r",
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  headRef: `houston/${number}`,
  headSha: sha(number),
  baseRef: "main",
  dependsOn: null,
  ownerThreadId: null,
  position: number,
  enqueuedAt: "2026-10-30T09:00:00.000Z",
  facts: facts({ headSha: sha(number), url: `https://github.com/o/r/pull/${number}` }),
  verification: null,
  failure: null,
  stacked: null,
  github: null,
  ...patch,
});

const NOT_SLICE: Review = { kind: "notSlice" };
const context = (patch: Partial<LineContext> = {}): LineContext => ({
  commandSet: false,
  paused: null,
  running: null,
  refusal: null,
  ...patch,
});
const lineOf = (rows: ReadonlyArray<QueueRow>, ctx = context()) =>
  line(
    rows,
    rows.map(() => NOT_SLICE),
    ctx,
  );
const entry = (entries: ReadonlyArray<HoustonMergeQueueEntry>, number: number) =>
  entries.find((candidate) => candidate.number === number)!;
const mergeable = (value: QueueRow, review: Review = NOT_SLICE) =>
  gates(value, review).find((gate) => gate.kind === "mergeable")!;
const threads = (value: QueueRow) =>
  gates(value, NOT_SLICE).find((gate) => gate.kind === "reviewThreads")!;

describe("enqueue checks refuse a full queue, unknown dependencies and cycles", () => {
  it("enqueue checks refuse a full queue, unknown dependencies and cycles", () => {
    const full = Array.from({ length: 32 }, (_, index) => row(index + 1));
    const refusal = checkEnqueue(full, "web", 33, null);
    expect(refusal?.kind).toBe("limit");
    expect(refusal?.message).toContain(
      "holds 32 entries and its limit is 32; refusing to enqueue PR #33",
    );
    expect(refusal?.limit).toBe(32);
    expect(refusal?.actual).toBe(32);
    // Re-enqueueing a queued pull request keeps its place, even at the limit.
    expect(checkEnqueue(full, "web", 12, null)).toBeUndefined();
    expect(checkEnqueue(full, "web", 12, 3)).toBeUndefined();

    const queue = [row(12, { dependsOn: 14 }), row(14)];
    const self = checkEnqueue(queue, "web", 12, 12);
    expect(self?.kind).toBe("invalid");
    expect(self?.message).toContain("#12 → #12");
    const unknown = checkEnqueue(queue, "web", 13, 99);
    expect(unknown?.kind).toBe("invalid");
    expect(unknown?.message).toContain("enqueue #99 first");
    const cycle = checkEnqueue(queue, "web", 14, 12);
    expect(cycle?.kind).toBe("invalid");
    expect(cycle?.message).toContain("#14 → #12 → #14");
    expect(checkEnqueue(queue, "web", 13, 14)).toBeUndefined();
  });
});

describe("order is first in first out and waits behind a dependency", () => {
  it("order is first in first out and waits behind a dependency", () => {
    const numbers = (rows: ReadonlyArray<QueueRow>) => order(rows).map((value) => value.number);
    expect(
      numbers([
        row(13, { position: 1 }),
        row(12, { position: 2, dependsOn: 14 }),
        row(14, { position: 3 }),
      ]),
    ).toEqual([13, 14, 12]);
    expect(
      numbers([row(3, { position: 3 }), row(1, { position: 1 }), row(2, { position: 2 })]),
    ).toEqual([1, 2, 3]);
    expect(numbers([row(13, { position: 2 }), row(12, { position: 1, dependsOn: 99 })])).toEqual([
      12, 13,
    ]);
  });
});

describe("gates fail closed on a missing or failed read", () => {
  it("gates fail closed on a missing or failed read", () => {
    const unread = row(7, { facts: null });
    expect(mergeable(unread)).toMatchObject({
      state: "failed",
      reason: "PR #7 has not been read from GitHub yet",
    });
    expect(threads(unread)).toMatchObject({
      state: "failed",
      reason: "PR #7 has not been read from GitHub yet",
    });
    const failed = row(7, { facts: { ...facts(), error: "HTTP 502" } });
    expect(mergeable(failed)).toMatchObject({
      state: "failed",
      reason: "could not read PR #7 from GitHub: HTTP 502",
    });
    expect(threads(failed)).toMatchObject({
      state: "failed",
      reason: "could not read PR #7 from GitHub: HTTP 502",
    });
  });
});

describe("mergeable passes only an open green approved clean pull request", () => {
  const checks = (
    ...entries: ReadonlyArray<readonly [string, Facts["checks"][number]["status"]]>
  ) => entries.map(([name, status]) => ({ name, status, required: false }));
  const CASES: ReadonlyArray<readonly [string, Partial<Facts>, string]> = [
    [
      "a failing check",
      { checks: checks(["build", "failure"]) },
      "PR #7 has 1 failing check: build",
    ],
    [
      "a pending check",
      { checks: checks(["test", "pending"]) },
      "PR #7 is waiting on 1 check: test",
    ],
    [
      "a cancelled check",
      { checks: checks(["lint", "cancelled"]) },
      "PR #7 has 1 failing check: lint",
    ],
    [
      "an action-required check",
      { checks: checks(["deploy", "action-required"]) },
      "PR #7 has 1 failing check: deploy",
    ],
    ["a draft", { isDraft: true }, "PR #7 is a draft"],
    [
      "changes requested",
      { reviewDecision: "changes-requested" },
      "changes were requested on PR #7",
    ],
    ["review required", { reviewDecision: "review-required" }, "PR #7 needs an approving review"],
    ["behind", { mergeState: "BEHIND" }, "PR #7 is behind main"],
    [
      "unstable with every check green",
      { mergeState: "UNSTABLE" },
      "GitHub reports PR #7 unstable",
    ],
    // The first blocking fact in the stated order wins.
    [
      "a draft with a failing check",
      { isDraft: true, checks: checks(["build", "failure"]) },
      "PR #7 is a draft",
    ],
    [
      "a failing check with changes requested and behind",
      {
        checks: checks(["build", "failure"]),
        reviewDecision: "changes-requested",
        mergeState: "BEHIND",
      },
      "PR #7 has 1 failing check: build",
    ],
  ];

  it("mergeable passes only an open green approved clean pull request", () => {
    for (const [name, patch, reason] of CASES) {
      const gate = mergeable(row(7, { facts: facts(patch) }));
      expect(gate.state, name).toBe("failed");
      expect(gate.reason, name).toContain(reason);
    }
    const green = facts({
      checks: checks(["build", "success"], ["docs", "skipped"], ["notes", "neutral"]),
    });
    expect(mergeable(row(7, { facts: green }))).toMatchObject({ state: "passed", reason: null });
  });
});

describe("a base-only refusal waits for the verification's rebase", () => {
  it("a base-only refusal waits for the verification's rebase", () => {
    const conflicting = row(7, {
      facts: facts({ mergeState: "DIRTY", mergeability: "conflicting" }),
    });
    const withCommand = lineOf([conflicting], context({ commandSet: true }));
    const gate = entry(withCommand, 7).gates.find((value) => value.kind === "mergeable")!;
    expect(gate.state).toBe("pending");
    expect(gate.reason).toContain("PR #7 conflicts with main");
    expect(gate.reason).toContain("; verification rebases it onto main");
    expect(entry(withCommand, 7).status).toBe("waitingForSlot");
    expect(nextUp(withCommand)?.number).toBe(7);

    const behind = row(7, { facts: facts({ mergeState: "BEHIND" }) });
    expect(entry(lineOf([behind], context({ commandSet: true })), 7).status).toBe("waitingForSlot");

    const withoutCommand = lineOf([conflicting]);
    expect(entry(withoutCommand, 7).status).toBe("blocked");
    expect(entry(withoutCommand, 7).gates.find((value) => value.kind === "mergeable")!.state).toBe(
      "failed",
    );
    expect(nextUp(withoutCommand)).toBeUndefined();

    const alsoFailing = row(7, {
      facts: facts({
        mergeState: "DIRTY",
        mergeability: "conflicting",
        checks: [{ name: "build", status: "failure", required: true }],
      }),
    });
    const failing = entry(lineOf([alsoFailing], context({ commandSet: true })), 7);
    expect(failing.status).toBe("blocked");
    const failedGate = failing.gates.find((value) => value.kind === "mergeable")!;
    expect(failedGate.state).toBe("failed");
    expect(failedGate.reason).toContain("PR #7 has 1 failing check: build");
  });
});

describe("review threads pass only with none unresolved and none unread", () => {
  it("review threads pass only with none unresolved and none unread", () => {
    expect(threads(row(7, { facts: facts({ unresolvedThreads: 0 }) }))).toMatchObject({
      state: "passed",
    });
    expect(threads(row(7, { facts: facts({ unresolvedThreads: 1 }) }))).toMatchObject({
      state: "failed",
      reason: "PR #7 has 1 unresolved review thread",
    });
    expect(threads(row(7, { facts: facts({ unresolvedThreads: 3 }) }))).toMatchObject({
      state: "failed",
      reason: "PR #7 has 3 unresolved review threads",
    });
    const truncated = threads(
      row(7, { facts: facts({ unresolvedThreads: 0, threadsTruncated: true }) }),
    );
    expect(truncated.state).toBe("failed");
    expect(truncated.reason).toContain(
      "has more review threads than Houston reads; check them on GitHub",
    );
  });
});

describe("the reviewer gate follows the slice's newest review run", () => {
  const reviewer = (review: Review) =>
    gates(row(7), review).find((gate) => gate.kind === "reviewer")!;
  const CASES: ReadonlyArray<readonly [HoustonTaskRunState | null, string | null]> = [
    ["handed_back", null],
    [null, "HOU-4 has no reviewer verdict yet"],
    ["preparing", "still running"],
    ["running", "still running"],
    ["waiting_for_input", "still running"],
    ["validating", "still running"],
    ["needs_review", "is not pass"],
    ["failed", "ended without a verdict"],
    ["cancelled", "ended without a verdict"],
    ["interrupted", "ended without a verdict"],
  ];

  it("the reviewer gate follows the slice's newest review run", () => {
    for (const [state, reason] of CASES) {
      const gate = reviewer({ kind: "slice", key: "HOU-4", state });
      if (reason === null) {
        expect(gate.state, String(state)).toBe("passed");
      } else {
        expect(gate.state, String(state)).toBe("failed");
        expect(gate.reason, String(state)).toContain(reason);
        expect(gate.reason, String(state)).toContain("HOU-4");
      }
    }
    expect(reviewer(NOT_SLICE).state).toBe("notApplicable");
    const unreadable = reviewer({ kind: "unreadable", error: "database is locked" });
    expect(unreadable.state).toBe("failed");
    expect(unreadable.reason).toContain("database is locked");
  });
});

describe("a blocked entry keeps its rank and only an unanswered one holds the line", () => {
  it("a blocked entry keeps its rank and only an unanswered one holds the line", () => {
    const unresolved = row(1, { facts: facts({ headSha: sha(1), unresolvedThreads: 1 }) });
    const passed = lineOf([unresolved, row(2)]);
    expect(entry(passed, 1)).toMatchObject({ position: 1, status: "blocked" });
    expect(entry(passed, 1).reason).toContain("1 unresolved review thread");
    expect(entry(passed, 2)).toMatchObject({ position: 2, status: "ready" });
    expect(nextUp(passed)?.number).toBe(2);

    // Once the thread resolves, #1 goes next again.
    const resolved = lineOf([row(1), row(2)]);
    expect(nextUp(resolved)?.number).toBe(1);

    const holders: ReadonlyArray<readonly [string, QueueRow]> = [
      [
        "checks pending",
        row(1, { facts: facts({ checks: [{ name: "test", status: "pending", required: true }] }) }),
      ],
      ["never read", row(1, { facts: null })],
      ["read failed", row(1, { facts: { ...facts(), error: "HTTP 502" } })],
      ["computing", row(1, { facts: facts({ mergeState: "UNKNOWN", mergeability: "unknown" }) })],
    ];
    for (const [name, holder] of holders) {
      const held = lineOf([holder, row(2)]);
      expect(entry(held, 1).status, name).toBe("blocked");
      expect(entry(held, 2).status, name).toBe("blocked");
      expect(entry(held, 2).reason, name).toContain("the queue waits for #1: ");
      expect(nextUp(held), name).toBeUndefined();
    }

    const dependent = lineOf([unresolved, row(2), row(3, { dependsOn: 1 })]);
    expect(entry(dependent, 3).status).toBe("blocked");
    expect(entry(dependent, 3).reason).toContain("waits for #1, which is blocked");
    expect(nextUp(dependent)?.number).toBe(2);

    const failure = {
      kind: "failed" as const,
      message: "`pnpm test` failed (exit 1)",
      headSha: sha(1),
      baseSha: sha(90),
      files: [],
      outputTail: null,
      notifiedThreadId: null,
      at: "2026-10-30T10:00:00.000Z",
    };
    const parked = lineOf([row(1, { failure }), row(2)], context({ commandSet: true }));
    expect(entry(parked, 1)).toMatchObject({ position: 0, status: "parked" });
    expect(entry(parked, 2).position).toBe(1);
    const fixing = lineOf(
      [row(1, { failure: { ...failure, notifiedThreadId: "thread-1" } }), row(2)],
      context({ commandSet: true }),
    );
    expect(entry(fixing, 1)).toMatchObject({ position: 0, status: "fixing" });

    for (const entries of [passed, resolved, dependent, parked, fixing]) {
      for (const value of entries) {
        expect(value.status).toBeTypeOf("string");
        expect(value.gates.map((gate) => gate.kind)).toEqual([
          "mergeable",
          "reviewThreads",
          "reviewer",
          "verification",
        ]);
      }
    }
  });
});

describe("settings are bounded and the policy needs a command", () => {
  const input = (patch: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    mergeWhenVerified: false,
    verificationCommand: "pnpm test",
    timeLimitMinutes: 30,
    ...patch,
  });

  it("settings are bounded and the policy needs a command", () => {
    const trimmed = checkSettings(input({ verificationCommand: "  pnpm test  " }), 0);
    expect(trimmed).toEqual({
      verificationCommand: "pnpm test",
      timeLimitMinutes: 30,
      mergeWhenVerified: false,
    });

    expect("kind" in checkSettings(input({ verificationCommand: "x".repeat(1_024) }), 0)).toBe(
      false,
    );
    const long = checkSettings(input({ verificationCommand: "x".repeat(1_025) }), 0);
    expect(long).toMatchObject({ kind: "limit", limit: 1_024, actual: 1_025 });
    expect((long as { message: string }).message).toContain("1,024");
    expect((long as { message: string }).message).toContain("1,025");

    const multi = checkSettings(input({ verificationCommand: "pnpm lint\npnpm test" }), 0);
    expect(multi).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("the verification command must be one line"),
    });

    for (const minutes of [0, 241]) {
      const refused = checkSettings(input({ timeLimitMinutes: minutes }), 0);
      expect(refused).toMatchObject({ kind: "limit", actual: minutes });
      expect((refused as { message: string }).message).toContain("1-240");
      expect((refused as { message: string }).message).toContain(String(minutes));
    }

    const policy = checkSettings(input({ mergeWhenVerified: true, verificationCommand: "  " }), 0);
    expect(policy).toMatchObject({ kind: "invalid" });
    expect((policy as { message: string }).message).toContain(
      "Settings ▸ Workspaces ▸ Merge queue",
    );

    const stale = checkSettings(input({ expectedRevision: 2 }), 3);
    expect(stale).toMatchObject({ kind: "conflict", expected: 2, actual: 3 });
    expect("kind" in checkSettings(input({ expectedRevision: 3 }), 3)).toBe(false);
  });
});

describe("the tail is the last lines without colour or secrets", () => {
  it("the tail is the last lines without colour or secrets", () => {
    const coloured = Array.from({ length: 100 }, (_, index) => `\x1b[31mline ${index + 1}\x1b[0m`);
    const tail = reportTail(Buffer.from(`${coloured.join("\n")}\n`));
    expect(tail.split("\n")).toEqual(
      Array.from({ length: 40 }, (_, index) => `line ${index + 61}`),
    );
    expect(tail).not.toContain("\x1b");

    const wide = reportTail(Buffer.from(`${"a".repeat(1_000)}${"b".repeat(4_000)}`));
    expect(wide).toBe("b".repeat(4_000));

    const token = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;
    expect(token).toHaveLength(40);
    const secrets = reportTail(
      Buffer.from(
        [
          `token=${token}`,
          "Authorization: Bearer abc.def",
          "aws key AKIAIOSFODNN7EXAMPLE here",
        ].join("\n"),
      ),
    );
    expect(secrets).not.toContain(token);
    expect(secrets).not.toContain("abc.def");
    expect(secrets).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(secrets).toContain("token=");
  });
});

describe("secrets behind quoted json keys are redacted", () => {
  it("secrets behind quoted json keys are redacted", () => {
    const values = {
      access_token: "s3cr3tValue0123456789",
      token: "plainTokenValue42",
      password: "hunter two words",
      client_secret: "clientSecretValue7",
      apiKey: "apiKeyValue99",
    };
    const tail = reportTail(
      Buffer.from(
        [
          JSON.stringify({ access_token: values.access_token }),
          JSON.stringify(values, null, 2),
          `{'token': '${values.token}'}`,
        ].join("\n"),
      ),
    );
    for (const value of Object.values(values)) expect(tail).not.toContain(value);
    expect(tail).toContain('"access_token": "[redacted]"');
    expect(tail).toContain('"password": "[redacted]"');
    expect(tail).toContain("'token': '[redacted]'");
  });
});

describe("a verification and a failure hold only for their head and base", () => {
  it("a verification and a failure hold only for their head and base", () => {
    const verification = {
      baseRef: "main",
      baseSha: sha(90),
      headSha: sha(1),
      verifiedSha: sha(91),
      at: "2026-10-30T10:00:00.000Z",
    };
    expect(verificationHolds(row(1, { verification }))).toEqual(verification);
    // The commit the queue pushed is the head now.
    expect(verificationHolds(row(1, { headSha: sha(91), verification }))).toEqual(verification);
    expect(verificationHolds(row(1, { headSha: sha(2), verification }))).toBeNull();
    expect(verificationHolds(row(1, { baseRef: "release", verification }))).toBeNull();

    const failure = {
      kind: "conflict" as const,
      message: "Rebasing onto main stopped on a conflict in 1 file",
      headSha: sha(1),
      baseSha: sha(90),
      files: ["a.txt"],
      outputTail: null,
      notifiedThreadId: null,
      at: "2026-10-30T10:00:00.000Z",
    };
    expect(failureHolds(row(1, { failure }))).toEqual(failure);
    const moved = row(1, { headSha: sha(5), failure });
    expect(failureHolds(moved)).toBeNull();
    expect(entry(lineOf([moved], context({ commandSet: true })), 1)).toMatchObject({
      position: 1,
      status: "waitingForSlot",
    });
  });
});

describe("a wsl share is refused by name on windows only", () => {
  it("a wsl share is refused by name on windows only", () => {
    for (const path of [
      "\\\\wsl.localhost\\Ubuntu\\home\\u\\repo",
      "\\\\WSL$\\Debian\\srv",
      "\\\\?\\UNC\\wsl.localhost\\x",
      "//wsl.localhost/Ubuntu/home/u/repo",
    ]) {
      const refusal = wslRefusal(path, "win32");
      expect(refusal, path).toContain(path);
      expect(refusal, path).toContain("add it as a WSL workspace so its distro verifies it");
      expect(wslRefusal(path, "linux"), path).toBeNull();
    }
    expect(wslRefusal("C:\\dev\\repo", "win32")).toBeNull();
    expect(wslRefusal("/home/u/repo", "linux")).toBeNull();
  });
});

describe("the push guard refuses bases, defaults and branches houston did not create", () => {
  const guard = (branch: string, patch: Partial<Parameters<typeof pushGuard>[0]> = {}) =>
    pushGuard({
      branch,
      baseRef: "main",
      defaultBranch: "trunk",
      managedBranches: new Set(["t3/abc"]),
      taskBranches: new Set(["houston/task/hou-4-fix"]),
      ...patch,
    });

  it("the push guard refuses bases, defaults and branches houston did not create", () => {
    expect(guard("main")).toContain("it is the base");
    expect(guard("main")).toContain("main");
    expect(guard("trunk")).toContain("it is the default branch");
    expect(guard("feature/x")).toContain("outside houston/ and t3/");
    expect(guard("houston/x")).toContain("Houston created no worktree on that branch");
    expect(guard("t3/abc")).toBeNull();
    expect(guard("houston/task/hou-4-fix")).toBeNull();
    // A Houston branch that is the base is still refused as the base.
    expect(guard("t3/abc", { baseRef: "t3/abc" })).toContain("it is the base");
    // An unknown default branch refuses rather than guesses.
    expect(guard("t3/abc", { defaultBranch: null })).toContain("default branch");
  });
});

describe("the hand-off follows the read, then the cache for the base, then houston", () => {
  const shown = (patch: Partial<NonNullable<Facts["handOff"]>> = {}) => ({
    mergeQueueRequired: false,
    autoMergeAllowed: false,
    queueEntry: null,
    autoMerge: null,
    letGo: null,
    ...patch,
  });
  const optional = [{ name: "lint", status: "success" as const, required: false }];

  it("the hand-off follows the read, then the cache for the base, then houston", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly facts: Facts;
      readonly cache?: Readonly<Record<string, "houston" | "autoMerge" | "mergeQueue">>;
      readonly expected: "houston" | "autoMerge" | "mergeQueue";
    }> = [
      {
        name: "the base requires github's merge queue",
        facts: facts({ handOff: shown({ mergeQueueRequired: true, autoMergeAllowed: true }) }),
        expected: "mergeQueue",
      },
      {
        name: "auto-merge allowed and one required check",
        facts: facts({ handOff: shown({ autoMergeAllowed: true }) }),
        expected: "autoMerge",
      },
      {
        name: "auto-merge allowed and no required check",
        facts: facts({ handOff: shown({ autoMergeAllowed: true }), checks: optional }),
        expected: "houston",
      },
      {
        name: "auto-merge not allowed",
        facts: facts({ handOff: shown() }),
        expected: "houston",
      },
      {
        name: "fields hidden: the cached mode for the same base",
        facts: facts({ handOff: null }),
        cache: { main: "mergeQueue" },
        expected: "mergeQueue",
      },
      {
        name: "fields hidden and nothing cached",
        facts: facts({ handOff: null }),
        expected: "houston",
      },
      {
        name: "fields hidden: a cache for another base is ignored",
        facts: facts({ handOff: null }),
        cache: { release: "mergeQueue" },
        expected: "houston",
      },
      {
        name: "a shown answer wins over the cache",
        facts: facts({ handOff: shown() }),
        cache: { main: "mergeQueue" },
        expected: "houston",
      },
    ];
    for (const value of cases) {
      expect(handOffMode(value.facts, "main", value.cache ?? {}), value.name).toBe(value.expected);
    }
    // A read that never happened or failed leaves the cache to answer.
    expect(handOffMode(null, "main", { main: "autoMerge" })).toBe("autoMerge");
    expect(handOffMode(null, "main", {})).toBe("houston");
  });
});

describe("the failure note names the files and the output tail", () => {
  it("the failure note names the files and the output tail", () => {
    const files = Array.from({ length: 22 }, (_, index) => `src/file-${index + 1}.ts`);
    const note = failureNote({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Fix the parser",
      headRef: "houston/7",
      failure: {
        kind: "conflict",
        message: "Rebasing onto main@0000090 stopped on a conflict in 22 files",
        headSha: sha(7),
        baseSha: sha(90),
        files,
        outputTail: "error: line 1\nerror: line 2",
        notifiedThreadId: null,
        at: "2026-10-30T10:00:00.000Z",
      },
    });
    expect(note).toContain("PR #7");
    expect(note).toContain("https://github.com/o/r/pull/7");
    expect(note).toContain("Rebasing onto main@0000090 stopped on a conflict in 22 files");
    for (const file of files.slice(0, 20)) expect(note).toContain(`- ${file}`);
    expect(note).not.toContain("src/file-21.ts");
    expect(note).not.toContain("src/file-22.ts");
    expect(note).toContain("- and 2 more");
    expect(note).toContain("```\nerror: line 1\nerror: line 2\n```");
    expect(note).toContain("Fix it on houston/7 and push.");
    expect(note).toContain(
      "The queue takes the new head back in line on its own; do not enqueue it again",
    );
    expect(note.trimEnd().endsWith("do not enqueue it again")).toBe(true);

    // No files and no output: neither section is written.
    const bare = failureNote({
      number: 8,
      url: "https://github.com/o/r/pull/8",
      title: null,
      headRef: "t3/eight",
      failure: {
        kind: "refused",
        message: "refusing to push to t3/eight: Houston created no worktree on that branch",
        headSha: sha(8),
        baseSha: null,
        files: [],
        outputTail: null,
        notifiedThreadId: null,
        at: "2026-10-30T10:00:00.000Z",
      },
    });
    expect(bare).not.toContain("```");
    expect(bare).not.toContain("- and");
    expect(bare).toContain("Fix it on t3/eight and push.");
  });
});
