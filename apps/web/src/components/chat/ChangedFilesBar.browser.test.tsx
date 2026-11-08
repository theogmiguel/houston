import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { useState } from "react";

import { ChangedFilesBar, ChangedFilesList } from "./ChangedFilesBar";

const summary = {
  files: [{ path: "src/a.ts", kind: "modified", additions: 4, deletions: 1 }],
  filesTotal: { count: 1, additions: 4, deletions: 1 },
};

it("fills only Review; Undo all and Keep all stay transparent", async () => {
  const host = document.createElement("div");
  await using _screen = await render(
    <ChangedFilesBar summary={summary} onReview={() => {}} onUndo={() => {}} onKeep={() => {}} />,
    { container: host },
  );
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((node) => node.textContent === name)!;
  const fill = (name: string) => getComputedStyle(button(name)).backgroundColor;

  expect(fill("Undo all")).toBe("rgba(0, 0, 0, 0)");
  expect(fill("Keep all")).toBe("rgba(0, 0, 0, 0)");
  expect(fill("Review")).not.toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(button("Review")).borderTopColor).toBe("rgba(0, 0, 0, 0)");
  expect(button("Review").getBoundingClientRect().height).toBe(
    button("Undo all").getBoundingClientRect().height,
  );
});

function Expandable() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      {expanded ? <ChangedFilesList summary={summary} onReview={() => {}} /> : null}
      <ChangedFilesBar
        summary={summary}
        onReview={() => {}}
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
    </div>
  );
}

it("the count toggles the file list, one row per file with its own totals", async () => {
  const host = document.createElement("div");
  await using _screen = await render(<Expandable />, { container: host });
  expect(host.querySelector("[data-changed-files-list]")).toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  toggle.click();
  await vi.waitFor(() => expect(host.querySelector("[data-changed-files-list]")).not.toBeNull());
  const rows = host.querySelectorAll("[data-changed-files-list] li");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.textContent).toContain("a.ts");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});
