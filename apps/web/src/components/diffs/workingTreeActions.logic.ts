export interface WorkingTreeFileLike {
  readonly path: string;
  readonly staged?: boolean | undefined;
  readonly unstaged?: boolean | undefined;
  readonly untracked?: boolean | undefined;
  readonly conflicted?: boolean | undefined;
}

/** A conflicted path is resolved by editing it, so it offers neither stage nor unstage. */
export function stageActionForWorkingTreeFile(
  file: WorkingTreeFileLike | undefined,
): "stage" | "unstage" | null {
  if (!file || file.conflicted === true) return null;
  if (file.staged === true && file.unstaged !== true) return "unstage";
  return file.unstaged === true || file.untracked === true ? "stage" : null;
}

export function discardKindForWorkingTreeFile(
  file: WorkingTreeFileLike | undefined,
): "staged" | "unstaged" | "untracked" | null {
  if (!file || file.conflicted === true) return null;
  if (file.untracked === true) return "untracked";
  return file.staged === true && file.unstaged !== true ? "staged" : "unstaged";
}

export function stageAllPaths(
  files: ReadonlyArray<WorkingTreeFileLike>,
  action: "stage" | "unstage",
): string[] {
  return files
    .filter(
      (file) =>
        file.conflicted !== true &&
        (action === "unstage"
          ? file.staged === true
          : file.untracked === true || file.unstaged === true),
    )
    .map((file) => file.path);
}
