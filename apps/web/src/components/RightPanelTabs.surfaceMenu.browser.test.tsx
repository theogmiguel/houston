import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { SurfaceMenuItem } from "./RightPanelTabs";

it("shows the reason an unavailable surface is disabled in place of its shortcut", async () => {
  await using screen = await render(
    <Menu open>
      <MenuTrigger>Add</MenuTrigger>
      <MenuPopup>
        <SurfaceMenuItem
          available={false}
          disabledReason="This thread's branch has no pull request yet."
          inlineReason="No PR for this branch"
          shortcut="P"
          onClick={() => {}}
        >
          Pull request
        </SurfaceMenuItem>
        <SurfaceMenuItem available shortcut="D" onClick={() => {}}>
          Diff
        </SurfaceMenuItem>
      </MenuPopup>
    </Menu>,
  );

  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const pullRequest = rows.find((row) => row.textContent?.startsWith("Pull request"))!;
  const diff = rows.find((row) => row.textContent?.startsWith("Diff"))!;
  expect(pullRequest.querySelector('[data-slot="menu-reason"]')?.textContent).toBe(
    "No PR for this branch",
  );
  expect(pullRequest.textContent).not.toContain("P​");
  expect(diff.querySelector('[data-slot="menu-reason"]')).toBeNull();
  expect(diff.textContent).toContain("D");
  expect(screen.container).toBeDefined();
});
