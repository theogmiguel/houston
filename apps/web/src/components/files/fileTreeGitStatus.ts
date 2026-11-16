import type { VcsWorkingTreeFileStatus, VcsStatusResult } from "@houston-app/contracts";

type WorkingTreeFile = VcsStatusResult["workingTree"]["files"][number];

const SEVERITY: Record<VcsWorkingTreeFileStatus, number> = {
  conflicted: 6,
  deleted: 5,
  modified: 4,
  renamed: 3,
  added: 2,
  untracked: 1,
};

export function treeGitStatus(
  path: string,
  directory: boolean,
  files: ReadonlyArray<WorkingTreeFile>,
): VcsWorkingTreeFileStatus | null {
  let worst: VcsWorkingTreeFileStatus | null = null;
  for (const file of files) {
    if (file.status === undefined) continue;
    const matches = directory ? file.path.startsWith(`${path}/`) : file.path === path;
    if (!matches) continue;
    if (worst === null || SEVERITY[file.status] > SEVERITY[worst]) worst = file.status;
  }
  return worst;
}

export const GIT_STATUS_LETTER: Record<VcsWorkingTreeFileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

export const GIT_STATUS_LABEL: Record<VcsWorkingTreeFileStatus, string> = {
  modified: "Modified",
  added: "Added",
  untracked: "Untracked",
  deleted: "Deleted",
  renamed: "Renamed",
  conflicted: "Conflict",
};

export function gitStatusColor(status: VcsWorkingTreeFileStatus): string {
  switch (status) {
    case "conflicted":
    case "deleted":
      return "var(--stop-ink)";
    case "added":
    case "untracked":
      return "var(--ok-ink)";
    default:
      return "var(--warn-ink)";
  }
}
