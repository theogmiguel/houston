import type { ProjectEntry } from "@t3tools/contracts";

export interface ProjectFileTreeRow {
  readonly entry: ProjectEntry;
  readonly depth: number;
}

/** Root entries keep depth 0; each slash adds a level. */
export function fileTreeDepth(path: string): number {
  return path.split("/").length - 1;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function searchMatches(path: string, query: string): boolean {
  return path.toLowerCase().includes(query.toLowerCase());
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index++) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

/**
 * Flattens loaded entries into the board's row order. A search matches paths
 * without requiring their ancestors to be expanded, so a deep result stays
 * reachable while an empty expansion set still lists the root.
 */
export function projectFileTreeRows(
  entries: ReadonlyArray<ProjectEntry>,
  expandedPaths: ReadonlySet<string>,
  query: string,
): ReadonlyArray<ProjectFileTreeRow> {
  const trimmed = query.trim();
  const searching = trimmed.length > 0;
  const visiblePaths = new Set<string>();
  if (searching) {
    const knownPaths = new Set(entries.map((entry) => entry.path));
    for (const entry of entries) {
      if (!searchMatches(entry.path, trimmed)) continue;
      visiblePaths.add(entry.path);
      for (const ancestor of ancestorsOf(entry.path)) {
        if (knownPaths.has(ancestor)) visiblePaths.add(ancestor);
      }
    }
  }

  const children = new Map<string, ProjectEntry[]>();
  for (const entry of entries) {
    const parent = parentDirectory(entry.path);
    const list = children.get(parent);
    if (list) list.push(entry);
    else children.set(parent, [entry]);
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const leftDirectory = left.kind === "directory";
      const rightDirectory = right.kind === "directory";
      if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
      return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
    });
  }

  const rows: ProjectFileTreeRow[] = [];
  const walk = (parent: string) => {
    for (const entry of children.get(parent) ?? []) {
      if (searching && !visiblePaths.has(entry.path)) continue;
      rows.push({ entry, depth: fileTreeDepth(entry.path) });
      if (entry.kind === "directory" && (searching || expandedPaths.has(entry.path))) {
        walk(entry.path);
      }
    }
  };
  walk("");
  return rows;
}

/** Directory paths that may be expanded by "expand all"; ignored folders stay closed. */
export function expandableDirectoryPaths(entries: ReadonlyArray<ProjectEntry>): string[] {
  return entries
    .filter((entry) => entry.kind === "directory" && !entry.ignored)
    .map((entry) => entry.path);
}

/** Ancestors of a selected file, for revealing it in the tree. */
export function ancestorDirectoryPaths(path: string): string[] {
  return ancestorsOf(path);
}
