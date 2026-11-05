// @effect-diagnostics nodeBuiltinImport:off -- launch arguments resolve against the process working directory.
import * as NodePath from "node:path";

export interface DesktopLaunchTargets {
  readonly webLinks: readonly string[];
  readonly workspaces: readonly string[];
}

export function isDeepLink(value: string, schemes: readonly string[]): boolean {
  try {
    const { protocol } = new URL(value);
    return schemes.some((scheme) => protocol === `${scheme}:`);
  } catch {
    return false;
  }
}

/** Resolves `houston <folder>`, relative paths against the launch directory. */
export function workspaceArgument(
  value: string,
  cwd: string,
  isDirectory: (path: string) => boolean,
): string | null {
  if (value.startsWith("-")) return null;
  const path = NodePath.isAbsolute(value) ? value : NodePath.resolve(cwd, value);
  return isDirectory(path) ? path : null;
}

/** Splits a process launch's arguments into links and folders, ignoring flags. */
export function resolveLaunchTargets(input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly schemes: readonly string[];
  readonly isDirectory: (path: string) => boolean;
}): DesktopLaunchTargets {
  const webLinks: string[] = [];
  const workspaces: string[] = [];
  let index = 1;
  while (index < input.args.length) {
    const value = input.args[index]!;
    if (value === "--channel") {
      index += 2;
      continue;
    }
    if (value.startsWith("--channel=") || value === "--print-target") {
      index += 1;
      continue;
    }
    if (isDeepLink(value, input.schemes)) {
      webLinks.push(value);
    } else {
      const workspace = workspaceArgument(value, input.cwd, input.isDirectory);
      if (workspace !== null) workspaces.push(workspace);
    }
    index += 1;
  }
  return { webLinks, workspaces };
}
