import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

it("keeps its trailing controls off the divider of a panel beside it", async () => {
  await using screen = await render(
    <WorkspacePageHeader besidePanel>
      <button type="button">Toggle right panel</button>
    </WorkspacePageHeader>,
  );

  const header = screen.container.querySelector("header") as HTMLElement;
  expect(Number.parseFloat(getComputedStyle(header).paddingRight)).toBe(8);
});
