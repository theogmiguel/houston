import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { LazySurfaceBoundary, lazySurface } from "./LazySurface";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

it("shows a failed chunk in the surface's place and retries by reloading the page", async () => {
  let loads = 0;
  // A webview caches a failed module fetch, so every import of the chunk rejects again.
  const surface = lazySurface<{ readonly name: string }>(() => {
    loads += 1;
    return Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
  });
  const reload = vi.fn();
  await using screen = await render(
    <RenderErrorBoundary fallback={<p>root error</p>}>
      <p>root content</p>
      <LazySurfaceBoundary
        surface={surface}
        props={{ name: "panel" }}
        label="panel"
        renderFrame={(content) => <section data-testid="frame">{content}</section>}
        reload={reload}
      />
    </RenderErrorBoundary>,
    { router: false },
  );

  const frame = screen.getByTestId("frame");
  await expect.element(frame.getByText("Could not load the panel.")).toBeVisible();
  await expect.element(screen.getByText("root content")).toBeVisible();
  expect(screen.container.textContent).not.toContain("root error");

  await page.getByRole("button", { name: "Retry" }).click();
  expect(reload).toHaveBeenCalledTimes(1);
  await expect.element(frame.getByText("Could not load the panel.")).toBeVisible();
  await expect.element(screen.getByText("root content")).toBeVisible();
  expect(screen.container.textContent).not.toContain("root error");
  expect(loads).toBe(1);
});
