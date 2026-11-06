import { isHostPath } from "@houston-app/shared/path";

/** Shape check only: the server may run on another platform, and it rejects relative folders. */
export function worktreesDirectoryProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "~" || trimmed.startsWith("~\\") || isHostPath(trimmed)) {
    return null;
  }
  return `"${trimmed}" is a relative path; enter an absolute folder such as /home/you/worktrees, ~/worktrees or C:\\worktrees.`;
}
