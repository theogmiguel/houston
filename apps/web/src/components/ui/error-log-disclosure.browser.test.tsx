import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

  it("is a content-wide ghost trigger with no border or fill at rest, filled on hover", async () => {
    await using screen = await render(
      <div style={{ width: 480 }}>
        <ErrorLogDisclosure report="boom" />
      </div>,
    );

    const details = screen.container.querySelector("details")!;
    const summary = screen.getByText("Show log").element().closest("summary")!;
    const style = getComputedStyle(summary);
    expect(style.borderTopWidth).toBe("0px");
    expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(details).borderTopWidth).toBe("0px");
    expect(summary.getBoundingClientRect().width).toBeLessThan(120);

    // The chevron stays on the card's text edge; only the hover fill reaches past it.
    const chevron = summary.querySelector("svg")!;
    expect(chevron.getBoundingClientRect().left).toBe(details.getBoundingClientRect().left);

    await userEvent.hover(summary);
    await expect.poll(() => getComputedStyle(summary).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("keeps the expanded log in its own bordered box under the trigger", async () => {
    await using screen = await render(<ErrorLogDisclosure report="boom" />);

    screen.getByText("Show log").element().closest("summary")!.click();
    const log = screen.getByText("boom").element();
    await expect.element(log).toBeVisible();
    expect(getComputedStyle(log).borderTopWidth).toBe("1px");
  });
});
