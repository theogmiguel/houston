import type { ProjectEntry } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

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

  it("shows per-entry Git status, dims ignored entries and handles F2 and Delete", async () => {
    const onStartRename = vi.fn();
    const onDeleteEntry = vi.fn();
    await using _screen = await render(
      <ProjectFileTree
        rows={[
          { entry: { path: "src", kind: "directory" }, depth: 0 },
          { entry: { path: "src/old.ts", kind: "file" }, depth: 1 },
          { entry: { path: "new.ts", kind: "file" }, depth: 0 },
          { entry: { path: "vendor", kind: "directory", ignored: true }, depth: 0 },
        ]}
        expandedPaths={new Set(["src"])}
        selectedPath={null}
        ariaLabel="repo files"
        gitFiles={[
          { path: "src/old.ts", insertions: 1, deletions: 0, status: "modified" },
          { path: "new.ts", insertions: 1, deletions: 0, status: "untracked" },
          { path: "gone.ts", insertions: 0, deletions: 1, status: "deleted" },
        ]}
        onToggleDirectory={() => {}}
        onOpenFile={() => {}}
        onEntryContextMenu={() => {}}
        onEntryDragStart={() => {}}
        onEntryDragEnd={() => {}}
        onStartRename={onStartRename}
        onDeleteEntry={onDeleteEntry}
      />,
    );
    expect(document.querySelector('[data-item-path="src"]')?.textContent).toContain("M");
    expect(document.querySelector('[data-item-path="new.ts"]')?.textContent).toContain("U");
    expect(getComputedStyle(document.querySelector('[data-item-path="vendor"]')!).opacity).toBe(
      "0.5",
    );

    const oldFile = document.querySelector<HTMLElement>('[data-item-path="src/old.ts"]')!;
    oldFile.focus();
    await userEvent.keyboard("{F2}");
    expect(onStartRename).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/old.ts", kind: "file" }),
    );
    await userEvent.keyboard("{Delete}");
    expect(onDeleteEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/old.ts", kind: "file" }),
    );
  });

  it("edits an inline new name and submits it with Enter", async () => {
    const onSubmit = vi.fn();
    await using _screen = await render(
      <ProjectFileTree
        rows={[{ entry: { path: "src", kind: "directory" }, depth: 0 }]}
        expandedPaths={new Set(["src"])}
        selectedPath={null}
        ariaLabel="repo files"
        editing={{
          mode: "create",
          path: "src",
          kind: "file",
          initialValue: "",
          depth: 1,
        }}
        onToggleDirectory={() => {}}
        onOpenFile={() => {}}
        onEntryContextMenu={() => {}}
        onEntryDragStart={() => {}}
        onEntryDragEnd={() => {}}
        onEditSubmit={onSubmit}
        onEditCancel={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>("[data-file-tree-editor] input")!;
    await userEvent.type(input, "new.ts{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("new.ts");
  });
});
