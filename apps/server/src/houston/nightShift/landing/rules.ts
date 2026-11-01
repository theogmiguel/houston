// The landing rules that decide an outcome without I/O: the gates, the CI decision, the merge
// order and the audit of remote heads.
import type { NightGateState, NightRemoteChange } from "@t3tools/contracts/houston/nightShift";

export interface ClaimRef {
  /** The plan entry's id. */
  readonly plan: number;
  /** The claim's index in that plan, from 0. */
  readonly claim: number;
}

/** The Verify gate: failed on any failing verdict, passed when every claim of the pull request's
 * plans has a passing one, pending otherwise (no claims at all is pending too). */
export const verifyGate = (input: {
  readonly claims: ReadonlyArray<ClaimRef>;
  readonly verdicts: ReadonlyArray<ClaimRef & { readonly passed: boolean }>;
}): NightGateState => {
  if (input.verdicts.some((verdict) => !verdict.passed)) return "failed";
  if (input.claims.length === 0) return "pending";
  const passed = new Set(input.verdicts.map((verdict) => `${verdict.plan}:${verdict.claim}`));
  return input.claims.every((claim) => passed.has(`${claim.plan}:${claim.claim}`))
    ? "passed"
    : "pending";
};

/** One check as a CI read reports it, with its workflow run when GitHub Actions ran it. */
export interface CiCheckRead {
  readonly name: string;
  readonly status: "passed" | "failed" | "pending";
  readonly url: string | null;
  readonly runId: number | null;
  /** Whether the check's workflow run has no job in progress. */
  readonly runCompleted: boolean;
}

/** What Houston already did for a pull request's CI; keys are `<head>|<check>`. */
export interface CiState {
  readonly reruns: ReadonlyArray<string>;
  readonly noted: ReadonlyArray<string>;
  /** Failure notes sent for the pull request, across heads. */
  readonly notes: number;
  readonly leftForMorning: boolean;
}

export const emptyCiState: CiState = { reruns: [], noted: [], notes: 0, leftForMorning: false };

/** Failure notes one pull request gets before the rest are left for the morning. */
export const CI_NOTES_PER_PULL_REQUEST = 2;

export type CiAction =
  | {
      readonly kind: "rerun";
      readonly head: string;
      readonly check: string;
      readonly runId: number;
    }
  | {
      readonly kind: "note";
      readonly head: string;
      readonly check: string;
      readonly url: string | null;
    }
  | { readonly kind: "leftForMorning"; readonly head: string; readonly check: string };

/** The CI gate and each failed check's action: a known flaky check is re-run once per head after
 * its workflow run completed; any other failure gets one note per head and check, at most two per
 * pull request, then one "left for the morning". A refused re-run counts as a failure. */
export const ciDecision = (input: {
  readonly head: string;
  readonly reads: ReadonlyArray<CiCheckRead>;
  readonly flakyChecks: ReadonlyArray<string>;
  readonly state: CiState;
  /** `<head>|<check>` keys whose re-run GitHub refused. */
  readonly rerunRefused: ReadonlyArray<string>;
}) => {
  const reruns = [...input.state.reruns];
  const noted = [...input.state.noted];
  let notes = input.state.notes;
  let leftForMorning = input.state.leftForMorning;
  const actions: Array<CiAction> = [];
  for (const read of input.reads) {
    if (read.status !== "failed") continue;
    const key = `${input.head}|${read.name}`;
    const flaky = input.flakyChecks.includes(read.name);
    const refused = input.rerunRefused.includes(key);
    if (flaky && !reruns.includes(key) && !refused) {
      if (!read.runCompleted || read.runId === null) continue;
      reruns.push(key);
      actions.push({ kind: "rerun", head: input.head, check: read.name, runId: read.runId });
      continue;
    }
    if (noted.includes(key)) continue;
    if (notes < CI_NOTES_PER_PULL_REQUEST) {
      noted.push(key);
      notes += 1;
      actions.push({ kind: "note", head: input.head, check: read.name, url: read.url });
    } else if (!leftForMorning) {
      leftForMorning = true;
      actions.push({ kind: "leftForMorning", head: input.head, check: read.name });
    }
  }
  const gate: NightGateState =
    input.reads.length === 0
      ? "pending"
      : input.reads.some((read) => read.status === "failed")
        ? "failed"
        : input.reads.some((read) => read.status === "pending")
          ? "pending"
          : "passed";
  return { gate, actions, state: { reruns, noted, notes, leftForMorning } satisfies CiState };
};

/** The suggested merge order: a pull request comes after each one carrying a plan its plans
 * depend on, otherwise in entry order; a cycle keeps entry order. */
export const mergeOrder = (input: {
  readonly pullRequests: ReadonlyArray<{
    readonly number: number;
    readonly plans: ReadonlyArray<number>;
  }>;
  readonly planDependencies: ReadonlyMap<number, ReadonlyArray<number>>;
}): ReadonlyArray<number> => {
  const owners = new Map<number, number>();
  for (const pr of input.pullRequests) for (const plan of pr.plans) owners.set(plan, pr.number);
  const after = new Map<number, Set<number>>();
  for (const pr of input.pullRequests) {
    const needs = new Set<number>();
    for (const plan of pr.plans) {
      for (const dependency of input.planDependencies.get(plan) ?? []) {
        const owner = owners.get(dependency);
        if (owner !== undefined && owner !== pr.number) needs.add(owner);
      }
    }
    after.set(pr.number, needs);
  }
  const order: Array<number> = [];
  const placed = new Set<number>();
  while (order.length < input.pullRequests.length) {
    const ready = input.pullRequests.find(
      (pr) =>
        !placed.has(pr.number) && [...after.get(pr.number)!].every((need) => placed.has(need)),
    );
    // A cycle: the first unplaced pull request in entry order goes next.
    const next = ready ?? input.pullRequests.find((pr) => !placed.has(pr.number))!;
    order.push(next.number);
    placed.add(next.number);
  }
  return order;
};

/** Remote heads created, moved or deleted since the start that no Houston push of the run and no
 * merge queue push or merge in the window explains. */
export const remoteChangesOutsideHouston = (input: {
  readonly before: Readonly<Record<string, string>>;
  readonly after: Readonly<Record<string, string>>;
  readonly pushes: ReadonlyArray<{ readonly branch: string; readonly newSha: string }>;
  readonly queue: ReadonlyArray<{
    readonly kind: string;
    readonly refName: string | null;
    readonly newSha: string | null;
  }>;
}): ReadonlyArray<NightRemoteChange> => {
  const refs = [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])].toSorted();
  const queueMerged = input.queue.some((row) => row.kind === "merge");
  return refs
    .filter((ref) => input.before[ref] !== input.after[ref])
    .filter((ref) => {
      const now = input.after[ref];
      const branch = ref.replace(/^refs\/heads\//, "");
      if (now === undefined) {
        // GitHub deletes a merged head branch: one Houston or the queue pushed, once the queue merged.
        const pushed =
          input.pushes.some((push) => push.branch === branch) ||
          input.queue.some((row) => row.kind === "push" && row.refName === branch);
        return !(pushed && queueMerged);
      }
      const byHouston = input.pushes.some((push) => push.branch === branch && push.newSha === now);
      const byQueue = input.queue.some(
        (row) =>
          (row.kind === "merge" || row.kind === "push") &&
          row.refName === branch &&
          row.newSha === now,
      );
      return !byHouston && !byQueue;
    })
    .map((ref) => ({
      ref,
      oldSha: input.before[ref] ?? null,
      newSha: input.after[ref] ?? null,
    }));
};
