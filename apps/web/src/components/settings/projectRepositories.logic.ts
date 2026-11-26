import {
  HOUSTON_PROJECT_REPOSITORY_LIMITS,
  type HoustonProjectRepository,
  type HoustonProjectRepositoryNotice,
} from "@houston-app/contracts";

/** The tracked-folder count where the counter turns warn, before the hard limit. */
export const TRACKED_FOLDER_WARNING_THRESHOLD = 112;

const LINE_BREAK = /\r?\n/u;

const NOTICE_LIMIT_LABELS: Record<HoustonProjectRepositoryNotice["limit"], string> = {
  repositories: "repository",
  submodulesPerRepository: "submodule",
  scannedEntries: "scanned directory entry",
};

export interface ProjectRepositoryLists {
  readonly found: ReadonlyArray<HoustonProjectRepository>;
  readonly tracked: ReadonlyArray<HoustonProjectRepository>;
}

export function splitProjectRepositories(
  repositories: ReadonlyArray<HoustonProjectRepository>,
): ProjectRepositoryLists {
  const found: Array<HoustonProjectRepository> = [];
  const tracked: Array<HoustonProjectRepository> = [];
  for (const repository of repositories) {
    if (repository.kind === "tracked") tracked.push(repository);
    else found.push(repository);
  }
  return { found, tracked };
}

/**
 * A single-repository project keeps its settings compact: no lists until it covers more than one
 * repository, tracks a folder elsewhere, ignores something, reports a discovery bound or holds an
 * unreadable entry.
 */
export function showRepositoryLists(input: {
  readonly repositories: ReadonlyArray<HoustonProjectRepository>;
  readonly trackedCount: number;
  readonly ignoredCount: number;
  readonly noticeCount: number;
}): boolean {
  return (
    input.repositories.length !== 1 ||
    input.trackedCount > 0 ||
    input.ignoredCount > 0 ||
    input.noticeCount > 0 ||
    input.repositories.some((repository) => repository.error !== undefined)
  );
}

export interface TrackedFolderCounter {
  readonly count: number;
  readonly limit: number;
  readonly visible: boolean;
  readonly tone: "default" | "warning";
  readonly label: string;
}

export function trackedFolderCounter(count: number): TrackedFolderCounter {
  const limit = HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders;
  const normalized = Math.max(0, count);
  return {
    count: normalized,
    limit,
    visible: normalized >= TRACKED_FOLDER_WARNING_THRESHOLD,
    tone: normalized >= TRACKED_FOLDER_WARNING_THRESHOLD ? "warning" : "default",
    label: `${normalized} of ${limit} added folders`,
  };
}

/** The reason the add action is inert, or null while a folder may still be added. */
export function addTrackedFolderDisabledReason(count: number): string | null {
  const limit = HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders;
  if (count < limit) return null;
  return `Cannot add a folder: ${count} of ${limit} added folders`;
}

/** Splits textarea text into the stored pattern list: trimmed, empty lines dropped, deduplicated. */
export function parseIgnorePatterns(text: string): ReadonlyArray<string> {
  const patterns: Array<string> = [];
  for (const line of text.split(LINE_BREAK)) {
    const pattern = line.trim();
    if (pattern.length > 0 && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

export function ignorePatternsText(patterns: ReadonlyArray<string>): string {
  return patterns.join("\n");
}

/** True when the saved patterns and the textarea differ after trimming, dropping blanks and dedupe. */
export function ignorePatternsDirty(saved: ReadonlyArray<string>, draft: string): boolean {
  const next = parseIgnorePatterns(draft);
  if (next.length !== saved.length) return true;
  return next.some((pattern, index) => pattern !== saved[index]);
}

export function repositoryBranchLabel(repository: HoustonProjectRepository): string {
  if (repository.error !== undefined) return "Unreadable";
  if (repository.detached) return "detached";
  return repository.branch ?? "detached";
}

export function repositoryReadError(repository: HoustonProjectRepository): string | null {
  if (repository.error === undefined) return null;
  return `Could not read ${repository.key}: ${repository.root} (${repository.error})`;
}

export function repositoryNoticeMessage(notice: HoustonProjectRepositoryNotice): string {
  return `Repository discovery hit the ${NOTICE_LIMIT_LABELS[notice.limit]} limit of ${notice.limitValue} with ${notice.actual} found; ${notice.requested} was not returned.`;
}

/** The message of a repository RPC failure; the server already names the bound, count and folder. */
export function repositoryFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The project repositories request failed.";
}
