import { scopedProjectKey, scopeProjectRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, HoustonProjectRepository, ProjectId } from "@houston-app/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

import { projectRepositories } from "./projectRepositories";
import { useEnvironmentQuery } from "./query";
import {
  repositoryKeysForSend,
  repositorySelectionLabel,
  resolveRepositorySelection,
  selectableRepositoryKeys,
  usesRepositoryChoice,
  WORKTREE_REPOSITORY_SEARCH_THRESHOLD,
  type WorktreeRepositoryChoice,
} from "./worktreeRepositories.logic";

export const PROJECT_REPOSITORY_CHOICE_STORAGE_KEY = "houston:project-repository-choice:v1";

const ProjectRepositoryChoiceStorage = Schema.Record(Schema.String, Schema.Array(Schema.String));
const decodeChoiceStorage = Schema.decodeUnknownOption(ProjectRepositoryChoiceStorage);
type StoredChoices = Readonly<Record<string, readonly string[]>>;

type ChoiceStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<() => void>();
let cachedChoices: StoredChoices | null = null;

function resolveStorage(): ChoiceStorage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function readChoices(): StoredChoices {
  if (cachedChoices !== null) return cachedChoices;
  try {
    const raw = resolveStorage()?.getItem(PROJECT_REPOSITORY_CHOICE_STORAGE_KEY);
    const decoded = raw === undefined || raw === null ? null : decodeChoiceStorage(JSON.parse(raw));
    cachedChoices = decoded !== null && decoded._tag === "Some" ? decoded.value : {};
  } catch {
    cachedChoices = {};
  }
  return cachedChoices;
}

function writeChoices(choices: StoredChoices): void {
  cachedChoices = choices;
  try {
    resolveStorage()?.setItem(PROJECT_REPOSITORY_CHOICE_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage can be full or forbidden; the choice still applies for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribeToProjectRepositoryChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readProjectRepositoryChoice(projectKey: string): readonly string[] | null {
  return readChoices()[projectKey] ?? null;
}

export function writeProjectRepositoryChoice(
  projectKey: string,
  repositoryKeys: readonly string[],
): void {
  const choices = readChoices();
  writeChoices({ ...choices, [projectKey]: [...repositoryKeys] });
}

/** Tests reset the module cache so one case's localStorage reads do not leak into the next. */
export function resetProjectRepositoryChoiceCacheForTests(): void {
  cachedChoices = null;
  listeners.clear();
}

export interface WorktreeRepositoriesState {
  readonly repositories: ReadonlyArray<WorktreeRepositoryChoice>;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
  readonly usesRepositoryChoice: boolean;
  readonly searchable: boolean;
  readonly selectedKeys: readonly string[];
  readonly setSelectedKeys: (repositoryKeys: readonly string[]) => void;
  readonly selectAll: () => void;
  readonly selectNone: () => void;
  readonly summaryLabel: string;
  readonly repositoryKeysForSend: readonly string[] | undefined;
}

const PATH_SEPARATOR = /[\\/]/;

function repositoryName(repository: HoustonProjectRepository): string {
  if (repository.key !== ".") return repository.key;
  const segments = repository.root.split(PATH_SEPARATOR).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? repository.key;
}

function toChoice(repository: HoustonProjectRepository): WorktreeRepositoryChoice {
  return {
    key: repository.key,
    name: repositoryName(repository),
    root: repository.root,
    branch: repository.branch,
    ...(repository.error === undefined ? {} : { error: repository.error }),
  };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/**
 * A project's repository checklist and its remembered choice. A single-repository project never
 * uses the choice, matching the composer's base-branch picker.
 */
export function useWorktreeRepositories(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
}): WorktreeRepositoriesState {
  const projectKey =
    input.projectId === null
      ? null
      : scopedProjectKey(scopeProjectRef(input.environmentId, input.projectId));
  const repositoryQuery =
    input.enabled && input.projectId !== null
      ? projectRepositories.list({
          environmentId: input.environmentId,
          input: { projectId: input.projectId },
        })
      : null;
  const query = useEnvironmentQuery(repositoryQuery);
  const repositories = (query.data?.repositories ?? []).map(toChoice);
  const remembered = useSyncExternalStore(
    subscribeToProjectRepositoryChoice,
    () => (projectKey === null ? null : readProjectRepositoryChoice(projectKey)),
    () => null,
  );
  const selectedKeys =
    projectKey === null ? [] : resolveRepositorySelection({ remembered, repositories });
  const choiceIsUsed =
    input.enabled && query.data !== null && usesRepositoryChoice(repositories.length);

  const updateSelection = (repositoryKeys: readonly string[]) => {
    if (projectKey === null) return;
    const selectable = new Set(selectableRepositoryKeys(repositories));
    const wanted = new Set(repositoryKeys);
    writeProjectRepositoryChoice(
      projectKey,
      repositories
        .filter((repository) => selectable.has(repository.key) && wanted.has(repository.key))
        .map((repository) => repository.key),
    );
  };

  // Keeps the stored per-project choice free of repository keys the project no longer has.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- writes the sanitized choice to localStorage while the project's repositories are loaded
  useEffect(() => {
    if (projectKey === null || remembered === null) return;
    if (!sameKeys(remembered, selectedKeys)) {
      writeProjectRepositoryChoice(projectKey, selectedKeys);
    }
  }, [projectKey, remembered, selectedKeys]);

  const selectAll = () => updateSelection(selectableRepositoryKeys(repositories));
  const selectNone = () => updateSelection([]);

  return {
    repositories,
    isLoading: repositoryQuery !== null && query.isPending,
    error: query.error,
    refresh: query.refresh,
    usesRepositoryChoice: choiceIsUsed,
    searchable: repositories.length > WORKTREE_REPOSITORY_SEARCH_THRESHOLD,
    selectedKeys,
    setSelectedKeys: updateSelection,
    selectAll,
    selectNone,
    summaryLabel: repositorySelectionLabel(selectedKeys.length, repositories.length),
    repositoryKeysForSend: repositoryKeysForSend({
      usesRepositoryChoice: choiceIsUsed,
      selectedKeys,
    }),
  };
}
