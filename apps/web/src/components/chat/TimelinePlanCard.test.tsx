import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TimelinePlanCard } from "./TimelinePlanCard";

const steps = [
  { id: "read", text: "Read the package manifest", status: "completed" },
  { id: "edit", text: "Add a clamp helper", status: "running" },
  { id: "test", text: "Run the tests", status: "pending" },
] as const;

describe("TimelinePlanCard", () => {
  it("draws the working arc while the plan's run is active", () => {
    const html = renderToStaticMarkup(<TimelinePlanCard steps={steps} active />);

    expect(html).toContain("data-streaming-glyph");
  });

  it("stops the spinner once the run is finished or interrupted", () => {
    const html = renderToStaticMarkup(<TimelinePlanCard steps={steps} active={false} />);

    expect(html).not.toContain("data-streaming-glyph");
    expect(html).toContain("Add a clamp helper");
  });
});
