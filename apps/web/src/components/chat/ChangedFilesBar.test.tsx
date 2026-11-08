import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChangedFilesBar } from "./ChangedFilesBar";

const summary = {
  files: [
    { path: "src/a.ts", kind: "modified", additions: 4, deletions: 1 },
    { path: "src/b.ts", kind: "added", additions: 2, deletions: 0 },
  ],
  filesTotal: { count: 3, additions: 7, deletions: 2 },
};

describe("ChangedFilesBar", () => {
  it("names the turn's file count and totals", () => {
    const html = renderToStaticMarkup(
      <ChangedFilesBar summary={summary} onReview={() => {}} onUndo={() => {}} onKeep={() => {}} />,
    );
    expect(html).toContain("3 files changed");
    expect(html).toContain("+7");
    expect(html).toContain("-2");
    expect(html).toContain("Undo all");
    expect(html).toContain("Keep all");
    expect(html).toContain("Review");
  });

  it("renders nothing when the checkpoint has no files", () => {
    const html = renderToStaticMarkup(
      <ChangedFilesBar summary={{ files: [] }} onReview={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("disables the bulk actions when the caller cannot undo or keep", () => {
    const html = renderToStaticMarkup(<ChangedFilesBar summary={summary} onReview={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Undo all<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Keep all<\/button>/);
  });
});
