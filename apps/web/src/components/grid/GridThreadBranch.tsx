import { GitBranchIcon } from "lucide-react";

export function GridThreadBranch({
  branch,
  worktreePath,
}: {
  branch: string;
  worktreePath: string | null;
}) {
  return (
    <span className="ml-1 hidden shrink-0 items-center gap-1.5 text-(--t3) sm:flex">
      <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-40 truncate font-mono text-xs">{branch}</span>
      <span className="hidden whitespace-nowrap text-xs min-[900px]:inline">
        · {worktreePath ? "worktree" : "local"}
      </span>
    </span>
  );
}
