import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ancestorDirectoryPaths, projectFileTreeRows } from "./projectFileTreeRows";

const entries: readonly ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src/grid", kind: "directory" },
  { path: "src/grid/gridStore.ts", kind: "file" },
  { path: "src/grid/splitTree.ts", kind: "file" },
  { path: "src/server", kind: "directory" },
  { path: "src/server/ws.ts", kind: "file" },
];

describe("projectFileTreeRows", () => {
  it("lists directories before files and only walks expanded directories", () => {
    const collapsed = projectFileTreeRows(entries, new Set(), "");
    expect(collapsed.map((row) => row.entry.path)).toEqual(["src", "README.md"]);
    expect(collapsed[0]?.depth).toBe(0);

    const expanded = projectFileTreeRows(entries, new Set(["src", "src/grid"]), "");
    expect(expanded.map((row) => row.entry.path)).toEqual([
      "src",
      "src/grid",
      "src/grid/gridStore.ts",
      "src/grid/splitTree.ts",
      "src/server",
      "README.md",
    ]);
    expect(expanded.find((row) => row.entry.path === "src/grid/gridStore.ts")?.depth).toBe(2);
  });

  it("keeps a deep search result and its ancestors visible", () => {
    const rows = projectFileTreeRows(entries, new Set(), "gridstore");
    expect(rows.map((row) => row.entry.path)).toEqual([
      "src",
      "src/grid",
      "src/grid/gridStore.ts",
    ]);
  });

  it("returns the ancestor directories for a reveal", () => {
    expect(ancestorDirectoryPaths("src/grid/gridStore.ts")).toEqual(["src", "src/grid"]);
  });
});
