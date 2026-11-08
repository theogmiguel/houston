import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { render } from "../../../test/render";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@
 const keep = 1;
-const removed = "old";
+const added = "new";
+const added2 = 2;
 const tail = 2;
`;

function descendants(root: ParentNode): Element[] {
  return [...root.querySelectorAll("*")].flatMap((element) => [
    element,
    ...(element.shadowRoot ? descendants(element.shadowRoot) : []),
  ]);
}

let mounted = 0;

async function mount() {
  const id = `gutters-${(mounted += 1)}`;
  const fileDiff = parsePatchFiles(PATCH, id)[0]!.files[0]!;
  const box = document.createElement("div");
  box.style.cssText = "width:399px;height:400px";
  const screen = await render(
    <StyledDiffCodeView
      className="h-full"
      items={[{ id, type: "diff", fileDiff, version: 1 }]}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        overflow: "scroll",
        theme: resolveDiffThemeName("light"),
        themeType: "light",
      }}
    />,
    { container: box },
  );
  await expect
    .poll(() => descendants(box).some((e) => e.hasAttribute("data-old-line-number")), {
      timeout: 20_000,
    })
    .toBe(true);
  return { screen, box };
}

/** Old and new numbers of every gutter row, in order. */
function gutterRows(box: HTMLElement) {
  return descendants(box)
    .filter((e) => e.hasAttribute("data-column-number"))
    .map((cell) => ({
      type: cell.getAttribute("data-line-type"),
      old: cell.querySelector("[data-old-line-number]")?.textContent ?? null,
      next: cell.querySelector("[data-line-number-content]")?.textContent ?? null,
    }));
}

describe("the unified diff gutter", () => {
  it("shows an old and a new line number on every row", async () => {
    const { screen, box } = await mount();
    await using _screen = screen;

    expect(gutterRows(box)).toEqual([
      { type: "context", old: "10", next: "10" },
      { type: "change-deletion", old: "11", next: "" },
      { type: "change-addition", old: "", next: "11" },
      { type: "change-addition", old: "", next: "12" },
      { type: "context", old: "12", next: "13" },
    ]);
  });

  it("lays the old number out left of the new one", async () => {
    const { screen, box } = await mount();
    await using _screen = screen;

    const cell = descendants(box).find(
      (e) => e.getAttribute("data-line-type") === "context" && e.hasAttribute("data-column-number"),
    )!;
    const old = cell.querySelector("[data-old-line-number]")!.getBoundingClientRect();
    const next = cell.querySelector("[data-line-number-content]")!.getBoundingClientRect();
    expect(old.right).toBeLessThanOrEqual(next.left);
    expect(old.width).toBeGreaterThan(0);
  });
});
