import { describe, expect, it } from "vite-plus/test";

import { headline } from "../rules.ts";
import {
  type CiCheckRead,
  type CiState,
  ciDecision,
  emptyCiState,
  mergeOrder,
  remoteChangesOutsideHouston,
  verifyGate,
} from "./rules.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

const read = (name: string, patch: Partial<CiCheckRead> = {}): CiCheckRead => ({
  name,
  status: "passed",
  url: `https://github.com/o/r/actions/runs/7/job/${name}`,
  runId: 7,
  runCompleted: true,
  ...patch,
});

describe("night shift landing rules", () => {
  it("the verify gate needs a passing verdict for every claim", () => {
    const claims = [
      { plan: 1, claim: 0 },
      { plan: 1, claim: 1 },
      { plan: 2, claim: 0 },
    ];
    const pass = (plan: number, claim: number) => ({ plan, claim, passed: true });
    expect(verifyGate({ claims, verdicts: [pass(1, 0), pass(1, 1), pass(2, 0)] })).toBe("passed");
    expect(verifyGate({ claims, verdicts: [pass(1, 0), pass(2, 0)] })).toBe("pending");
    // One failing verdict fails the gate even with every other claim passing.
    expect(
      verifyGate({
        claims,
        verdicts: [pass(1, 0), pass(1, 1), pass(2, 0), { plan: 1, claim: 1, passed: false }],
      }),
    ).toBe("failed");
    expect(verifyGate({ claims, verdicts: [] })).toBe("pending");
  });

  it("the ci decision re-runs a flaky failure once and notes the rest", () => {
    const flaky = ["e2e"];
    const decide = (state: CiState, reads: ReadonlyArray<CiCheckRead>, head = HEAD, refused = []) =>
      ciDecision({ head, reads, flakyChecks: flaky, state, rerunRefused: refused });

    // All passing: the gate passes and nothing is done.
    const green = decide(emptyCiState, [read("lint"), read("e2e")]);
    expect(green.gate).toBe("passed");
    expect(green.actions).toEqual([]);
    // Nothing reported yet is pending.
    expect(decide(emptyCiState, []).gate).toBe("pending");

    // A flaky check failing while its workflow run still has jobs in progress waits.
    const inProgress = decide(emptyCiState, [
      read("e2e", { status: "failed", runCompleted: false }),
    ]);
    expect(inProgress.actions).toEqual([]);
    expect(inProgress.gate).toBe("failed");
    expect(inProgress.state).toEqual(emptyCiState);

    // Once the run completed: one re-run, announced by one ci message.
    const rerun = decide(emptyCiState, [read("e2e", { status: "failed" })]);
    expect(rerun.actions).toEqual([{ kind: "rerun", head: HEAD, check: "e2e", runId: 7 }]);
    // The same read again re-runs nothing more.
    expect(decide(rerun.state, [read("e2e", { status: "failed" })]).actions).toEqual([
      {
        kind: "note",
        head: HEAD,
        check: "e2e",
        url: "https://github.com/o/r/actions/runs/7/job/e2e",
      },
    ]);

    // A re-run GitHub refused counts as a failure.
    const refusedRerun = ciDecision({
      head: HEAD,
      reads: [read("e2e", { status: "failed" })],
      flakyChecks: flaky,
      state: rerun.state,
      rerunRefused: [`${HEAD}|e2e`],
    });
    expect(refusedRerun.actions.map((action) => action.kind)).toEqual(["note"]);

    // A real failure: one note per head and check, never repeated.
    const real = decide(emptyCiState, [read("lint", { status: "failed" })]);
    expect(real.actions).toEqual([
      {
        kind: "note",
        head: HEAD,
        check: "lint",
        url: "https://github.com/o/r/actions/runs/7/job/lint",
      },
    ]);
    expect(decide(real.state, [read("lint", { status: "failed" })]).actions).toEqual([]);

    // At most two notes per pull request; the third failure is left for the morning, once.
    const second = decide(real.state, [read("types", { status: "failed" })]);
    expect(second.actions.map((action) => action.kind)).toEqual(["note"]);
    const third = decide(second.state, [read("lint", { status: "failed" })], NEXT);
    expect(third.actions).toEqual([{ kind: "leftForMorning", head: NEXT, check: "lint" }]);
    expect(third.state.leftForMorning).toBe(true);
    const fourth = decide(third.state, [read("docs", { status: "failed" })], NEXT);
    expect(fourth.actions).toEqual([]);
    expect(fourth.gate).toBe("failed");
  });

  it("headline and merge order", () => {
    expect(headline(7, 2)).toBe("7 pull requests, 2 open decisions");
    expect(headline(1, 1)).toBe("1 pull request, 1 open decision");
    expect(headline(0, 0)).toBe("0 pull requests, 0 open decisions");

    // #12's plan depends on #10's: #12 comes after it; the rest keep entry order.
    const order = mergeOrder({
      pullRequests: [
        { number: 12, plans: [3] },
        { number: 11, plans: [2] },
        { number: 10, plans: [1] },
      ],
      planDependencies: new Map([[3, [1]]]),
    });
    expect(order).toEqual([11, 10, 12]);
    // No dependencies: entry order.
    expect(
      mergeOrder({
        pullRequests: [
          { number: 5, plans: [1] },
          { number: 4, plans: [2] },
        ],
        planDependencies: new Map(),
      }),
    ).toEqual([5, 4]);
    // A cycle never drops a pull request.
    expect(
      mergeOrder({
        pullRequests: [
          { number: 1, plans: [1] },
          { number: 2, plans: [2] },
        ],
        planDependencies: new Map([
          [1, [2]],
          [2, [1]],
        ]),
      }).toSorted(),
    ).toEqual([1, 2]);
  });

  it("remote changes outside houston are listed", () => {
    const sha = (char: string) => char.repeat(40);
    const changes = remoteChangesOutsideHouston({
      before: {
        "refs/heads/main": sha("1"),
        "refs/heads/t3/fix-ws": sha("2"),
        "refs/heads/old": sha("3"),
      },
      after: {
        "refs/heads/main": sha("4"),
        "refs/heads/t3/fix-ws": sha("5"),
        "refs/heads/new": sha("6"),
      },
      pushes: [{ branch: "t3/fix-ws", newSha: sha("5") }],
      queue: [],
    });
    // Houston's push is not listed; main moved with no queue merge, a deleted branch and a new
    // branch nobody recorded are, each with its ref and SHAs.
    expect(changes).toEqual([
      { ref: "refs/heads/main", oldSha: sha("1"), newSha: sha("4") },
      { ref: "refs/heads/new", oldSha: null, newSha: sha("6") },
      { ref: "refs/heads/old", oldSha: sha("3"), newSha: null },
    ]);
    // A merge the queue log records in the window explains main.
    expect(
      remoteChangesOutsideHouston({
        before: { "refs/heads/main": sha("1") },
        after: { "refs/heads/main": sha("4") },
        pushes: [],
        queue: [{ kind: "merge", refName: "main", newSha: sha("4") }],
      }),
    ).toEqual([]);
    // A queue push of another commit does not explain the move.
    expect(
      remoteChangesOutsideHouston({
        before: { "refs/heads/t3/a": sha("1") },
        after: { "refs/heads/t3/a": sha("4") },
        pushes: [{ branch: "t3/a", newSha: sha("9") }],
        queue: [{ kind: "push", refName: "t3/a", newSha: sha("8") }],
      }),
    ).toEqual([{ ref: "refs/heads/t3/a", oldSha: sha("1"), newSha: sha("4") }]);
  });
});
