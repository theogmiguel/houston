// @effect-diagnostics nodeBuiltinImport:off - Packaging runs before any Effect runtime exists.
/** Walks a staged `node_modules` tree the way Node's resolver does, to split it between archives. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface PackageTreeReader {
  /** Dependency names a package declares, or undefined when no package lives at `dir`. */
  readonly readDependencies: (dir: string) => ReadonlyArray<string> | undefined;
}

export const fileSystemPackageTreeReader: PackageTreeReader = {
  readDependencies: (dir) => {
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8"));
    } catch {
      return undefined;
    }
    // Peers count: the installer places them beside the package that needs them.
    return ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) => {
      const entries = manifest[field];
      return entries !== null && typeof entries === "object" ? Object.keys(entries) : [];
    });
  },
};

/** Top-level `<stageDir>/node_modules` names the roots reach; a nested copy counts as its holder. */
export function collectTopLevelClosure(input: {
  readonly stageDir: string;
  readonly roots: Iterable<string>;
  readonly reader?: PackageTreeReader;
}): Set<string> {
  const reader = input.reader ?? fileSystemPackageTreeReader;
  const stageDir = NodePath.resolve(input.stageDir);
  const topLevel = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ readonly from: string; readonly name: string }> = [];
  for (const name of input.roots) queue.push({ from: stageDir, name });

  while (queue.length > 0) {
    const { from, name } = queue.pop()!;
    for (let dir = from; ; dir = NodePath.dirname(dir)) {
      const candidate = NodePath.join(dir, "node_modules", name);
      const dependencies = reader.readDependencies(candidate);
      if (dependencies !== undefined) {
        if (dir === stageDir) topLevel.add(name);
        if (!visited.has(candidate)) {
          visited.add(candidate);
          for (const dependency of dependencies) queue.push({ from: candidate, name: dependency });
        }
        break;
      }
      // An optional or platform-filtered dependency is simply absent from the stage.
      if (dir === stageDir || NodePath.dirname(dir) === dir) break;
    }
  }
  return topLevel;
}

/** Windows runs the server from its own archive; a package both sides reach stays in both. */
export function splitArchivePackages(input: {
  readonly stageDir: string;
  readonly desktopRoots: Iterable<string>;
  readonly serverRoots: Iterable<string>;
  readonly reader?: PackageTreeReader;
}): { readonly serverOnly: string[]; readonly desktopOnly: string[] } {
  const desktop = collectTopLevelClosure({ ...input, roots: input.desktopRoots });
  const server = collectTopLevelClosure({ ...input, roots: input.serverRoots });
  return {
    serverOnly: [...server].filter((name) => !desktop.has(name)).sort(),
    desktopOnly: [...desktop].filter((name) => !server.has(name)).sort(),
  };
}
