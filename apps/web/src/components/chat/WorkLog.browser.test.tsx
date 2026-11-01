import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { WorkLogButton, WorkLogList } from "./WorkLog";

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
