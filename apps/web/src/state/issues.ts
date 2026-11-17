import { createIssueEnvironmentAtoms } from "@houston-app/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueAssigneeCandidate,
  IssueLabelCandidate,
  IssueListInput,
  IssueListResult,
  IssueScopeRef,
} from "@houston-app/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface MergedIssueListView {
  /** One answer per environment that has one, in target order. */
  readonly answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>;
  /** The first environment that failed outright; the others may still have answered. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/**
 * The same listing read across every connected environment at once, as the pull-request page
 * does: React cannot subscribe to a list of atoms whose length changes, so the fan-out lives in
 * one derived atom keyed by the targets. An environment that fails contributes nothing rather
 * than blanking the page.
 */
const mergedIssueListFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: Array<readonly [EnvironmentId, IssueListResult]> = [];
    let error: string | null = null;
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting;
      if (result._tag === "Failure" && error === null) {
        error = formatEnvironmentQueryError(result.cause);
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push([target.environmentId, value]);
    }
    return { answers, error, isPending };
  }).pipe(Atom.withLabel(`web-issues:list:${key}`)),
);

const EMPTY_ISSUE_LIST = Atom.make({
  answers: [] as ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  error: null as string | null,
  isPending: false,
}).pipe(Atom.withLabel("web-issues:list:empty"));

export function useIssueList(targets: ReadonlyArray<IssueListTarget>): MergedIssueListView {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LIST : mergedIssueListFamily(key));
  const refresh = () => {
    for (const target of JSON.parse(key) as ReadonlyArray<IssueListTarget>) {
      appAtomRegistry.refresh(issueEnvironment.list(target));
    }
  };
  return { ...view, refresh };
}

export interface IssueCandidatesTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueScopeRef;
}

/** What a list filter can offer: the labels and people of every scope asked, each named once. */
export interface MergedIssueCandidates {
  readonly labels: ReadonlyArray<IssueLabelCandidate>;
  readonly assignees: ReadonlyArray<IssueAssigneeCandidate>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly truncated: boolean;
}

const NO_ISSUE_CANDIDATES: MergedIssueCandidates = {
  labels: [],
  assignees: [],
  error: null,
  isPending: false,
  truncated: false,
};

const emptyIssueCandidates = Atom.make(NO_ISSUE_CANDIDATES).pipe(
  Atom.withLabel("web-issues:candidates:empty"),
);

/** Fans out like the merged listing: a scope that fails leaves the others' answers in place. */
const mergedIssueCandidatesFamily = Atom.family((key: string) =>
  Atom.make((get): MergedIssueCandidates => {
    const labels = new Map<string, IssueLabelCandidate>();
    const assignees = new Map<string, IssueAssigneeCandidate>();
    let error: string | null = null;
    let isPending = false;
    let truncated = false;
    for (const target of JSON.parse(key) as ReadonlyArray<IssueCandidatesTarget>) {
      const result = get(issueEnvironment.candidates(target));
      isPending ||= result.waiting;
      if (result._tag === "Failure" && error === null) {
        error = formatEnvironmentQueryError(result.cause);
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value === null) continue;
      truncated ||= value.truncated;
      for (const label of value.labels) if (!labels.has(label.name)) labels.set(label.name, label);
      for (const actor of value.assignees)
        if (!assignees.has(actor.login)) assignees.set(actor.login, actor);
    }
    return {
      labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
      assignees: [...assignees.values()].sort((a, b) => a.login.localeCompare(b.login)),
      error,
      isPending,
      truncated,
    };
  }).pipe(Atom.withLabel(`web-issues:candidates:${key}`)),
);

/** The labels and people of every scope a list filter covers; no targets reads nothing. */
export function useIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  return useAtomValue(
    targets.length === 0
      ? emptyIssueCandidates
      : mergedIssueCandidatesFamily(JSON.stringify(targets)),
  );
}
