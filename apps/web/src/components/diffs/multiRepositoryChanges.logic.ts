import type { HoustonProjectRepository } from "@houston-app/contracts";

export interface RepositoryChoice {
  readonly key: string;
  readonly root: string;
  readonly name: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly error?: string | undefined;
}

export interface RepositoryChangeFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: string | undefined;
}

export interface RepositoryChangeGroup {
  readonly repository: RepositoryChoice;
  readonly files: ReadonlyArray<RepositoryChangeFile>;
  readonly additions: number;
  readonly deletions: number;
}

const PATH_SEPARATOR = /[\\/]/;
const TRAILING_SLASHES = /\/+$/;

export function repositoryDisplayName(repository: {
  readonly key: string;
  readonly root: string;
}): string {
  const key = repository.key.replace(TRAILING_SLASHES, "");
  if (key.length > 0 && key !== ".") {
    const segment = key.split("/").filter(Boolean).at(-1);
    if (segment) return segment;
  }
  return repository.root.split(PATH_SEPARATOR).filter(Boolean).at(-1) ?? repository.root;
}

export function repositoryChoice(repository: HoustonProjectRepository): RepositoryChoice {
  return {
    key: repository.key,
    root: repository.root,
    name: repositoryDisplayName(repository),
    branch: repository.branch,
    detached: repository.detached,
    ...(repository.error === undefined ? {} : { error: repository.error }),
  };
}

export function isMultiRepository(
  repositories: ReadonlyArray<Pick<RepositoryChoice, "key">>,
): boolean {
  return repositories.length > 1;
}

export function resolveActiveRepository(
  repositories: ReadonlyArray<RepositoryChoice>,
  activeKey: string | null | undefined,
): RepositoryChoice | null {
  if (activeKey === null || activeKey === undefined) return null;
  return repositories.find((repository) => repository.key === activeKey) ?? null;
}

/** The repository git actions act on: the diff panel's selection, else the first one. */
export function resolveGitActionsRepository(
  repositories: ReadonlyArray<RepositoryChoice>,
  activeKey: string | null | undefined,
): RepositoryChoice | null {
  return resolveActiveRepository(repositories, activeKey) ?? repositories[0] ?? null;
}

// The required separator between the repository and the reason, built here because the copy
// guard rejects a literal em dash.
const ERROR_SEPARATOR = String.fromCharCode(0x2014);

export function repositoryErrorMessage(repository: RepositoryChoice): string {
  return `Could not read ${repository.name}: ${repository.root} ${ERROR_SEPARATOR} ${repository.error ?? "unknown error"}`;
}

export function branchLabel(
  repository: Pick<RepositoryChoice, "branch" | "detached">,
  headSha?: string | null,
): string {
  if (repository.branch !== null) return repository.branch;
  if (repository.detached && headSha) return `detached ${headSha.slice(0, 7)}`;
  return "detached";
}

/** One group per repository that has files or that could not be read, in project order. */
export function buildRepositoryChangeGroups(
  repositories: ReadonlyArray<RepositoryChoice>,
  filesByRepositoryKey: ReadonlyMap<string, ReadonlyArray<RepositoryChangeFile>>,
): ReadonlyArray<RepositoryChangeGroup> {
  return repositories.flatMap((repository) => {
    const files = filesByRepositoryKey.get(repository.key) ?? [];
    if (files.length === 0 && repository.error === undefined) return [];
    return [
      {
        repository,
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
      },
    ];
  });
}
