import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { WorkLogBlock, WorkLogButton, WorkLogList } from "./WorkLog";

it("keeps the row's end padding between the trailing timestamp and the hover edge", async () => {
  await using screen = await render(
    <WorkLogList>
      <WorkLogButton
        label="Worked for 20s"
        trailing={
          <TimelineRowTimestamp createdAt="2026-03-17T19:12:28.000Z" timestampFormat="24-hour" />
        }
      />
    </WorkLogList>,
  );

  const row = screen.getByRole("button", { name: /Worked for 20s/ }).element();
  await userEvent.hover(row);

  const timestamp = row.querySelector('[data-slot="tooltip-trigger"]');
  expect(timestamp).not.toBeNull();

  const rowRight = row.getBoundingClientRect().right;
  const timestampRight = timestamp!.getBoundingClientRect().right;
  const paddingRight = Number.parseFloat(getComputedStyle(row).paddingRight);
  expect(rowRight - timestampRight).toBe(paddingRight);
});

it("draws a work row as quiet text: no border, no resting fill, a fill on hover only", async () => {
  await using screen = await render(
    <WorkLogList>
      <WorkLogButton label="Worked for 20s" />
    </WorkLogList>,
  );
  const row = screen.getByRole("button", { name: /Worked for 20s/ }).element();
  const rest = getComputedStyle(row);
  expect(rest.borderTopWidth).toBe("0px");
  expect(rest.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(Number.parseFloat(getComputedStyle(row.firstElementChild!).fontSize)).toBeLessThanOrEqual(
    13,
  );
  await userEvent.hover(row);
  await expect.poll(() => getComputedStyle(row).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

it("leaves a message-sized gap below the last row of an expanded group", async () => {
  await using screen = await render(
    <div>
      <WorkLogBlock layout="group-content" continues>
        <span>inside</span>
      </WorkLogBlock>
      <WorkLogBlock layout="group-content" endsGroup>
        <span>last</span>
      </WorkLogBlock>
    </div>,
  );

  const gap = (label: string) =>
    getComputedStyle(screen.getByText(label).element().parentElement!).paddingBottom;
  expect(gap("inside")).toBe("0px");
  expect(gap("last")).toBe("16px");
});
