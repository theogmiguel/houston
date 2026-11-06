import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ChangedFilesBar } from "./ChangedFilesBar";

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
