import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";
import {
  LAYOUT_LEARNED_KEY,
  LAYOUT_TOUR_KEY,
  LayoutLearningTips,
  LayoutOnboarding,
} from "./LayoutOnboarding";
import { useLayoutStore } from "./layoutStore";

const Host = () => (
  <>
    <div data-layout-strip="" />
    <LayoutOnboarding />
  </>
);

/** Puts the stores in a known state for one test and restores them when the test ends. */
function openSession(): Disposable {
  localStorage.removeItem(LAYOUT_TOUR_KEY);
  localStorage.removeItem(LAYOUT_LEARNED_KEY);
  useLayoutStore.getState().reset();
  return {
    [Symbol.dispose]() {
      useLayoutStore.getState().setOverviewOpen(false);
      localStorage.removeItem(LAYOUT_TOUR_KEY);
      localStorage.removeItem(LAYOUT_LEARNED_KEY);
    },
  };
}

describe("LayoutOnboarding", () => {
  it("walks the five steps from the introduction to the end and is not shown again", async () => {
    using _session = openSession();
    const first = await render(<Host />);
    await expect.element(page.getByRole("heading", { name: "Tabs, side by side" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show me" }));
    for (let step = 1; step <= 4; step++) {
      await expect.element(page.getByText(`${step} of 5`)).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Next" }));
    }
    await expect.element(page.getByText("5 of 5")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Got it" }));
    expect(localStorage.getItem(LAYOUT_TOUR_KEY)).toBe("true");
    expect(page.getByText(/of 5/).elements()).toHaveLength(0);
    await first[Symbol.asyncDispose]();

    await using _again = await render(<Host />);
    expect(page.getByRole("heading", { name: "Tabs, side by side" }).elements()).toHaveLength(0);
  });

  it("is dismissed for good by Got it on the introduction", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    await userEvent.click(page.getByRole("button", { name: "Got it" }));
    expect(localStorage.getItem(LAYOUT_TOUR_KEY)).toBe("true");
    expect(page.getByRole("heading", { name: "Tabs, side by side" }).elements()).toHaveLength(0);
  });

  it("can be skipped in the middle", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    await userEvent.click(page.getByRole("button", { name: "Show me" }));
    await userEvent.click(page.getByRole("button", { name: "Next" }));
    await userEvent.click(page.getByRole("button", { name: "Skip" }));
    expect(localStorage.getItem(LAYOUT_TOUR_KEY)).toBe("true");
  });

  it("does not count its own zoom-out as the overview tried", async () => {
    using _session = openSession();
    await using _screen = await render(<Host />);
    await userEvent.click(page.getByRole("button", { name: "Show me" }));
    for (let step = 1; step <= 3; step++) {
      await expect.element(page.getByText(`${step} of 5`)).toBeVisible();
      await userEvent.click(page.getByRole("button", { name: "Next" }));
    }
    await expect.element(page.getByText("4 of 5")).toBeVisible();
    expect(useLayoutStore.getState().overviewOpen).toBe(true);
    expect(page.getByText("Tried", { exact: true }).elements()).toHaveLength(0);
  });

  it("fits a narrow window", async () => {
    using _session = openSession();
    await page.viewport(360, 640);
    try {
      await using _screen = await render(<Host />);
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      expect(dialog.element().getBoundingClientRect().width).toBeLessThanOrEqual(360);
    } finally {
      await page.viewport(1280, 720);
    }
  });
});

describe("LayoutLearningTips", () => {
  it("lists the tips until the layout has been used", async () => {
    using _session = openSession();
    await using _screen = await render(<LayoutLearningTips />);
    await expect.element(page.getByText("Drag a tab to the right edge")).toBeVisible();
    await expect.element(page.getByText(/to see the layout keys/)).toBeVisible();
  });

  it("hides a tip once its lesson is learned", async () => {
    using _session = openSession();
    localStorage.setItem(LAYOUT_LEARNED_KEY, JSON.stringify(["split", "keys"]));
    await using screen = await render(<LayoutLearningTips />);
    expect(screen.container.textContent).toBe("");
  });
});
