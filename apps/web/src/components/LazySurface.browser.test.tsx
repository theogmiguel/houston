import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { LazySurfaceBoundary, lazySurface } from "./LazySurface";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

it("shows a failed chunk in the surface's place, with a retry, not at the root", async () => {
  let loads = 0;
  // The first load fails as a chunk missing after a deploy does; the retry loads it.
  const surface = lazySurface<{ readonly name: string }>(() => {
    loads += 1;
    return loads === 1
      ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
      : Promise.resolve(({ name }: { readonly name: string }) => <p>{name} loaded</p>);
  });
  await using screen = await render(
    <RenderErrorBoundary fallback={<p>root error</p>}>
      <LazySurfaceBoundary
        surface={surface}
        props={{ name: "panel" }}
        label="panel"
        renderFrame={(content) => <section data-testid="frame">{content}</section>}
      />
    </RenderErrorBoundary>,
    { router: false },
  );

  await expect.element(screen.getByText("Could not load the panel.")).toBeVisible();
  expect(screen.container.querySelector('[data-testid="frame"]')).not.toBeNull();
  expect(screen.container.textContent).not.toContain("root error");

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.element(screen.getByText("panel loaded")).toBeVisible();
  expect(loads).toBe(2);
});
