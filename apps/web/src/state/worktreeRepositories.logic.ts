export interface WorktreeRepositoryChoice {
  readonly key: string;
  readonly name: string;
  readonly root: string;
  readonly branch: string | null;
  readonly error?: string | undefined;
}

/** Above this many repositories the picker searches and starts with none chosen. */
export const WORKTREE_REPOSITORY_SEARCH_THRESHOLD = 8;

export const WORKTREE_REPOSITORY_SEND_BLOCK_REASON =
  "Choose at least one repository to start a worktree.";

/** A repository without a readable branch cannot be checked out, and says why. */
export function worktreeRepositoryDisabledReason(
  repository: WorktreeRepositoryChoice,
): string | null {
  if (repository.error !== undefined && repository.error.length > 0) {
    return `Could not read ${repository.name}: ${repository.root} (${repository.error})`;
  }
  if (repository.branch === null) return "No commits yet";
  return null;
}

export function selectableRepositoryKeys(
  repositories: ReadonlyArray<WorktreeRepositoryChoice>,
): readonly string[] {
  return repositories
    .filter((repository) => worktreeRepositoryDisabledReason(repository) === null)
    .map((repository) => repository.key);
}

export function defaultRepositorySelection(
  repositories: ReadonlyArray<WorktreeRepositoryChoice>,
): readonly string[] {
  return repositories.length > WORKTREE_REPOSITORY_SEARCH_THRESHOLD
    ? []
    : selectableRepositoryKeys(repositories);
}

/**
 * The remembered keys against the repositories that still exist: unknown or now disabled keys
 * are dropped, and a remembered set that lost every key falls back to the default.
 */
export function resolveRepositorySelection(input: {
  readonly remembered: readonly string[] | null;
  readonly repositories: ReadonlyArray<WorktreeRepositoryChoice>;
}): readonly string[] {
  const selectable = new Set(selectableRepositoryKeys(input.repositories));
  if (input.remembered === null) return defaultRepositorySelection(input.repositories);
  const rememberedKeys = new Set(input.remembered);
  const kept = input.repositories
    .filter((repository) => selectable.has(repository.key) && rememberedKeys.has(repository.key))
    .map((repository) => repository.key);
  if (input.remembered.length > 0 && kept.length === 0) {
    return defaultRepositorySelection(input.repositories);
  }
  return kept;
}

export function repositorySelectionLabel(selectedCount: number, totalCount: number): string {
  if (totalCount === 0 || selectedCount === 0) return "No repositories";
  if (selectedCount === totalCount) return "All repositories";
  return `${selectedCount} of ${totalCount} repositories`;
}

export function filterWorktreeRepositories(
  repositories: ReadonlyArray<WorktreeRepositoryChoice>,
  query: string,
): readonly WorktreeRepositoryChoice[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return repositories;
  return repositories.filter((repository) =>
    [repository.name, repository.key, repository.root, repository.branch ?? ""].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function usesRepositoryChoice(repositoryCount: number): boolean {
  return repositoryCount !== 1;
}

export function worktreeRepositorySendBlockReason(input: {
  readonly usesRepositoryChoice: boolean;
  readonly selectedCount: number;
}): string | null {
  return input.usesRepositoryChoice && input.selectedCount === 0
    ? WORKTREE_REPOSITORY_SEND_BLOCK_REASON
    : null;
}

export function repositoryKeysForSend(input: {
  readonly usesRepositoryChoice: boolean;
  readonly selectedKeys: readonly string[];
}): readonly string[] | undefined {
  return input.usesRepositoryChoice ? input.selectedKeys : undefined;
}

/** The typed base branch, else the checkout's branch, else each repository's own HEAD. */
export function resolveRepositoryBaseBranch(input: {
  readonly typed: string | null | undefined;
  readonly fallback: string | null | undefined;
}): string {
  const typed = input.typed?.trim();
  if (typed) return typed;
  const fallback = input.fallback?.trim();
  return fallback || "HEAD";
}
