import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProjectFileTree } from "./ProjectFileTree";

const rows = [
  { entry: { path: ".gitignore", kind: "file" } as ProjectEntry, depth: 0 },
  { entry: { path: "README.md", kind: "file" } as ProjectEntry, depth: 0 },
  { entry: { path: "src", kind: "directory" } as ProjectEntry, depth: 0 },
];

describe("ProjectFileTree", () => {
  it("draws each row with the file-type icon its tab uses", async () => {
    await using _screen = await render(
      <ProjectFileTree
        rows={rows}
        expandedPaths={new Set()}
        selectedPath={null}
        ariaLabel="repo files"
        onToggleDirectory={() => {}}
        onOpenFile={() => {}}
        onEntryContextMenu={() => {}}
        onEntryDragStart={() => {}}
        onEntryDragEnd={() => {}}
      />,
    );
    for (const path of [".gitignore", "README.md"]) {
      const row = document.querySelector(`[data-item-path="${path}"]`);
      expect(row?.querySelector("[data-pierre-icon]")).not.toBeNull();
    }
  });
});
