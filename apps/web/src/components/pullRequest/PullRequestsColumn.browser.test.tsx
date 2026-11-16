import { createRef } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { PullRequestsColumn } from "./PullRequestsColumn";

const ROW_WIDTH = 1400;

it("keeps the open detail panel against the row's right edge and resizes it from its left edge", async () => {
  // The panel caps itself at 70% of the window; leave room for the 600px it asks for.
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1600, 900);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using _screen = await render(
    <div data-testid="row" className="flex h-[600px]" style={{ width: ROW_WIDTH }}>
      <PullRequestsColumn
        refreshing={false}
        onRefresh={() => {}}
        involvement="authored"
        state="open"
        host={undefined}
        hostMenuOptions={[]}
        onInvolvement={() => {}}
        onState={() => {}}
        onHost={() => {}}
        searchInput={null}
        sortMenu={null}
        filtersMenu={null}
        rightPanelControl={null}
        titlebarControls={null}
        rightPanelOpen
        maximizedAway={false}
        view="requests"
        onView={() => {}}
        queueCount={null}
        queueParked={false}
        listBody={<p>List</p>}
        queueBody={<p>Queue</p>}
        scrollRef={createRef<HTMLDivElement>()}
      />
      <PreviewPanelShell
        mode="inline"
        open
        widthStorageKey="test:pull-requests-column-panel-width"
        defaultWidth={600}
      >
        <p>Detail</p>
      </PreviewPanelShell>
    </div>,
    { router: false },
  );

  const row = page.getByTestId("row").element().getBoundingClientRect();
  const panel = () =>
    document.querySelector('[data-preview-panel-mode="inline"]')!.getBoundingClientRect();
  await expect.poll(() => panel().width).toBe(600);
  expect(panel().right).toBe(row.right);

  const before = panel().left;
  const handle = page.getByRole("separator", { name: "Resize panel" });
  (handle.element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowLeft}");
  // Widening moves the handle edge, not the far edge.
  await expect.poll(() => panel().left).toBe(before - 16);
  expect(panel().right).toBe(row.right);
});
