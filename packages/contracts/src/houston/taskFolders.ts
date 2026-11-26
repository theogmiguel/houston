import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * One repository checkout inside a task folder. `key` is the repository's path relative to the
 * project root (`"."` for the root itself); `projectPath` is the project's own checkout and
 * `worktreePath` the one inside the task folder.
 */
export const HoustonTaskFolderRepository = Schema.Struct({
  key: TrimmedNonEmptyString,
  projectPath: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});
export type HoustonTaskFolderRepository = typeof HoustonTaskFolderRepository.Type;

/**
 * The folder a worktree thread of a multi-repository project works in. It mirrors the project:
 * each chosen repository sits at the same relative path, on the thread's branch name. Keyed by
 * folder path because subagents, forks and reused worktrees share one path across threads.
 */
export const HoustonTaskFolderRecord = Schema.Struct({
  folderPath: TrimmedNonEmptyString,
  realPath: TrimmedNonEmptyString,
  projectId: ProjectId,
  projectRoot: TrimmedNonEmptyString,
  repositories: Schema.Array(HoustonTaskFolderRepository),
  createdAt: Schema.String,
});
export type HoustonTaskFolderRecord = typeof HoustonTaskFolderRecord.Type;
