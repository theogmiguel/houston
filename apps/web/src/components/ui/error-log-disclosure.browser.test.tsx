import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ErrorLogDisclosure } from "./error-log-disclosure";

describe("ErrorLogDisclosure", () => {
  it("marks the disclosure with a rotating chevron instead of the native marker", async () => {
    await using screen = await render(<ErrorLogDisclosure report="boom" />);

    const summary = screen.getByText("Show log").element().closest("summary")!;
    expect(getComputedStyle(summary).listStyleType).toBe("none");
    const chevron = summary.querySelector("svg")!;
    expect(chevron.classList.contains("lucide-chevron-right")).toBe(true);
    // Transform-family properties only: width, height and margin never animate.
    expect(getComputedStyle(chevron).transitionProperty).toBe(
      "transform, translate, scale, rotate",
    );
    expect(getComputedStyle(chevron).rotate).toBe("none");

    summary.click();
    await expect.poll(() => getComputedStyle(chevron).rotate).toBe("90deg");
  });
});
