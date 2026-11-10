import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { DiffFileList } from "./diff-review-controls";

function badgeOf(row: Element): string {
  return row.querySelector("button > span:last-child")?.textContent ?? "";
}

describe("DiffFileList status badge", () => {
  it("shows A for an added file and no letter while its patch is still loading", async () => {
    await using screen = await render(
      <DiffFileList
        entries={[
          { path: "test/rate-limit.test.ts", status: "added", additions: 27, deletions: 0 },
          { path: "src/rate-limit.ts", status: undefined, additions: 4, deletions: 1 },
          { path: "src/index.ts", status: "modified", additions: 2, deletions: 2 },
        ]}
        selectedPath={null}
        onSelectFile={() => {}}
      />,
    );

    const rows = [...screen.container.querySelectorAll("button")];
    expect(rows.map((row) => badgeOf(row.parentElement!))).toEqual(["A", "", "M"]);
  });
});
