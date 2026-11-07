import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { GridRightPanelPin } from "./GridRightPanelPin";

const appRegion = (element: Element) =>
  getComputedStyle(element).getPropertyValue("-webkit-app-region");

it("keeps the pin and the owner title out of the header's window drag region", async () => {
  await using screen = await render(
    <TooltipProvider delay={0}>
      <div data-drag-region="deep" className="drag-region flex h-9 items-center">
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <GridRightPanelPin
            threadTitle="Fix the login race"
            pinned={false}
            onPinnedChange={() => {}}
          />
        </div>
      </div>
    </TooltipProvider>,
    { router: false },
  );

  const header = screen.container.querySelector("[data-drag-region]")!;
  expect(appRegion(header)).toBe("drag");
  const pin = screen.container.querySelector("[data-grid-right-panel-pin] button")!;
  const owner = screen.container.querySelector("[data-grid-right-panel-owner]")!;
  expect(appRegion(pin), "pin button").toBe("no-drag");
  expect(appRegion(owner), "owner title").toBe("no-drag");
});
