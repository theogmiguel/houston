import type { ProjectEntry } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ancestorDirectoryPaths, projectFileTreeRows } from "./projectFileTreeRows";

const entries: readonly ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src/layout", kind: "directory" },
  { path: "src/layout/layoutStore.ts", kind: "file" },
  { path: "src/layout/zones.ts", kind: "file" },
  { path: "src/server", kind: "directory" },
  { path: "src/server/ws.ts", kind: "file" },
];

describe("projectFileTreeRows", () => {
  it("lists directories before files and only walks expanded directories", () => {
    const collapsed = projectFileTreeRows(entries, new Set(), "");
    expect(collapsed.map((row) => row.entry.path)).toEqual(["src", "README.md"]);
    expect(collapsed[0]?.depth).toBe(0);

    const expanded = projectFileTreeRows(entries, new Set(["src", "src/layout"]), "");
    expect(expanded.map((row) => row.entry.path)).toEqual([
      "src",
      "src/layout",
      "src/layout/layoutStore.ts",
      "src/layout/zones.ts",
      "src/server",
      "README.md",
    ]);
    expect(expanded.find((row) => row.entry.path === "src/layout/layoutStore.ts")?.depth).toBe(2);
  });

  it("keeps a deep search result and its ancestors visible", () => {
    const rows = projectFileTreeRows(entries, new Set(), "layoutstore");
    expect(rows.map((row) => row.entry.path)).toEqual(["src", "src/layout", "src/layout/layoutStore.ts"]);
  });

  it("returns the ancestor directories for a reveal", () => {
    expect(ancestorDirectoryPaths("src/layout/layoutStore.ts")).toEqual(["src", "src/layout"]);
  });
});
