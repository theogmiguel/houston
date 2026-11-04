import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ExpandableText } from "./ExpandableText";

// Under the 180-character threshold, so only measuring the wrapped box can reveal the clip.
const SHORT_WRAPPING_TEXT =
  "Retest the service token against the catalog endpoint after access is granted.";

// Browser tests load no Tailwind build, so the clamp utility is defined here.
function clampStyle(): Disposable {
  const style = document.createElement("style");
  style.textContent =
    ".line-clamp-3{overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}";
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

describe("ExpandableText", () => {
  it("offers to expand short text that wraps past the clamp in a narrow container", async () => {
    using _clamp = clampStyle();
    await using screen = await render(
      <div style={{ width: "80px" }}>
        <ExpandableText text={SHORT_WRAPPING_TEXT} expandLabel="Show more" />
      </div>,
    );

    await expect.element(screen.getByRole("button", { name: "Show more" })).toBeVisible();
  });

  it("shows no toggle when the text fits", async () => {
    using _clamp = clampStyle();
    await using screen = await render(
      <div style={{ width: "600px" }}>
        <ExpandableText text="Fits on one line." expandLabel="Show more" />
      </div>,
    );

    await expect.element(screen.getByText("Fits on one line.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show more" }).query()).toBeNull();
  });
});
