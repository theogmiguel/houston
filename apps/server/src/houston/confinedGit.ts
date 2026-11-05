// The one list of command-scope overrides that keeps the user's own git configuration from
// reaching past the checkout a Houston git command acts on; the merge queue and pull share it.
import * as VcsProcess from "../vcs/VcsProcess.ts";

/** Reaches the processes git starts too: no other branch, hook, tag, submodule or program. */
export const CONFINED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["rebase.updateRefs", "false"],
  ["core.hooksPath", "/dev/null"],
  ["commit.gpgSign", "false"],
  ["rerere.enabled", "false"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.followTags", "false"],
  ["push.recurseSubmodules", "no"],
  ["push.gpgSign", "false"],
  ["core.fsmonitor", "false"],
];

/** `env` plus `extra` and `CONFINED_GIT_CONFIG` appended after any inherited git config. */
export const confinedGitEnv = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  extra: ReadonlyArray<readonly [string, string]> = [],
): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of [...extra, ...CONFINED_GIT_CONFIG]) {
    Object.assign(next, VcsProcess.gitConfigEnv(next, key, value, platform));
  }
  return next;
};
