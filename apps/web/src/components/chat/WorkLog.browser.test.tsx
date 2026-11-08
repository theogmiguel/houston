import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TimelineRowTimestamp } from "./TimelineRowParts";
import { WorkLogBlock, WorkLogButton, WorkLogList } from "./WorkLog";

it("places the hover timestamp right after the label, not at the row's far edge", async () => {
  await using screen = await render(
    <div style={{ width: 600 }}>
      <WorkLogList>
        <WorkLogButton
          label="Worked for 20s"
          meta={
            <TimelineRowTimestamp createdAt="2026-03-17T19:12:28.000Z" timestampFormat="24-hour" />
          }
          trailing={<span data-testid="end">end</span>}
        />
      </WorkLogList>
    </div>,
  );

  const row = screen.getByRole("button", { name: /Worked for 20s/ }).element();
  await userEvent.hover(row);

  const timestamp = row.querySelector('[data-slot="tooltip-trigger"]')!;
  expect(timestamp).not.toBeNull();
  const label = [...row.querySelectorAll("div")].find(
    (node) => node.textContent === "Worked for 20s",
  )!;
  const gap = timestamp.getBoundingClientRect().left - label.getBoundingClientRect().right;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
  // The trailing slot keeps the row's end.
  const end = row.querySelector('[data-testid="end"]')!.getBoundingClientRect();
  expect(row.getBoundingClientRect().right - end.right).toBe(
    Number.parseFloat(getComputedStyle(row).paddingRight),
  );
  expect(end.left).toBeGreaterThan(timestamp.getBoundingClientRect().right + 100);
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

it("leaves the in-turn gap below the last row of an expanded group", async () => {
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
  expect(gap("last")).toBe("12px");
});
