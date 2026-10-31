import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerStashBadge } from "./ComposerStashBadge";

const badge = () => page.getByRole("button", { name: "Stashed prompts: 3. Open stash." });

it("keeps the composer clean while nothing is stashed", async () => {
  await using screen = await render(
    <ComposerStashBadge count={0} menuOpen={false} pulseKey={0} onToggleMenu={() => {}} />,
    { router: false },
  );

  expect(screen.container.querySelector('[data-prompt-stash-badge="true"]')).toBeNull();
});

it("labels the pill with its count and toggles the stash", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <ComposerStashBadge
          count={3}
          menuOpen={open}
          pulseKey={1}
          onToggleMenu={() => setOpen((current) => !current)}
        />
        <p role="status">{open ? "Stash open" : "Stash closed"}</p>
      </>
    );
  }
  await using _screen = await render(<Harness />, { router: false });

  await expect.element(badge()).toHaveAttribute("aria-expanded", "false");
  expect(badge().element().textContent).toBe("Stash3");
  expect(badge().element().getBoundingClientRect().height).toBe(24);

  await badge().click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Stash open");
  await expect.element(badge()).toHaveAttribute("aria-expanded", "true");
});
