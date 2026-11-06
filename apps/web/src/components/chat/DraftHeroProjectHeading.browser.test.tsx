import "~/index.css";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";

/** The 800x900 capture viewport for one test, restoring the previous size on dispose. */
async function narrowViewport(): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(800, 900);
  return { [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height) };
}

function hero(name: string) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center px-12">
      <DraftHeroProjectHeading>
        <button type="button">{name}</button>
      </DraftHeroProjectHeading>
    </div>
  );
}

describe("DraftHeroProjectHeading", () => {
  it("keeps the project name inline in the heading at 800px", async () => {
    await using _viewport = await narrowViewport();
    await using screen = await render(hero("atlas-api"));

    const heading = screen.getByRole("heading").element();
    const lead = screen.getByText("What should we build in").element();
    const name = screen.getByRole("button", { name: "atlas-api" }).element();
    expect(heading.textContent).toBe("What should we build inatlas-api?");

    const leadBox = lead.getBoundingClientRect();
    const nameBox = name.getBoundingClientRect();
    // One line: the name shares the sentence's baseline row and follows it.
    expect(Math.abs(nameBox.top - leadBox.top)).toBeLessThan(6);
    expect(nameBox.left).toBeGreaterThan(leadBox.right);
    expect(heading.getBoundingClientRect().height).toBeLessThan(48);
    // The name takes the heading's own size, not a smaller subtitle size.
    expect(getComputedStyle(name).fontSize).toBe(getComputedStyle(heading).fontSize);
  });

  it("wraps a very long name below the sentence instead of overflowing", async () => {
    await using _viewport = await narrowViewport();
    await using screen = await render(
      hero("a-very-long-project-name-that-cannot-share-the-line-with-the-sentence"),
    );

    const heading = screen.getByRole("heading").element();
    expect(heading.scrollWidth).toBeLessThanOrEqual(heading.clientWidth);
  });
});
