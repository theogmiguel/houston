import type { OrchestrationV2TurnItem } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { TimelineFileChangeCard } from "./TimelineFileChangeCard";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

// Composed fixture: only the fields the card reads are populated.
function fileChange(extra: Partial<FileChangeItem> = {}): FileChangeItem {
  return {
    type: "file_change",
    fileName: "/work/atlas-api/CHANGELOG.md",
    additions: 5,
    deletions: 0,
    ...extra,
  } as FileChangeItem;
}

function resolveColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

const noBorder = (style: CSSStyleDeclaration) =>
  style.borderTopWidth === "0px" && style.borderBottomWidth === "0px";

it("draws a change without a diff body as a borderless row that fills on hover and focus", async () => {
  await using screen = await render(
    <TimelineFileChangeCard item={fileChange()} workspaceRoot="/work" onOpenDiff={() => {}} />,
    { router: false },
  );
  const section = screen.container.querySelector<HTMLElement>("section")!;
  const path = screen.getByText("work/atlas-api/CHANGELOG.md").element();
  const icon = section.querySelector("svg")!;
  expect(section.dataset.fileChangeVariant).toBe("reference");

  // Rest: no border, no fill, no lift; icon and path in the muted ink.
  const rest = getComputedStyle(section);
  expect(noBorder(rest)).toBe(true);
  expect(rest.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(rest.boxShadow).toBe("none");
  expect(getComputedStyle(path).color).toBe(resolveColor("var(--houston)"));
  expect(getComputedStyle(icon).color).toBe(resolveColor("var(--houston)"));
  // The icon sits on the prose edge: the row's own padding is cancelled by its negative margin.
  const contentLeft = icon.getBoundingClientRect().left;
  expect(contentLeft).toBeCloseTo(
    section.getBoundingClientRect().left + Number.parseFloat(rest.paddingLeft),
    1,
  );
  expect(Number.parseFloat(rest.marginLeft)).toBe(-Number.parseFloat(rest.paddingLeft));

  // Hover: the row fills and the path takes the default ink.
  await userEvent.hover(path);
  await expect.poll(() => getComputedStyle(section).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => getComputedStyle(path).color).toBe(resolveColor("var(--t1)"));
  expect(noBorder(getComputedStyle(section))).toBe(true);

  // Keyboard focus: same fill and ink, with the button's focus ring kept.
  await userEvent.unhover(path);
  await expect.poll(() => getComputedStyle(section).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  await userEvent.tab();
  const button = screen.getByRole("button", { name: "Open diff" }).element();
  expect(document.activeElement).toBe(button);
  await expect.poll(() => getComputedStyle(section).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect.poll(() => getComputedStyle(path).color).toBe(resolveColor("var(--t1)"));
  const focus = getComputedStyle(button);
  expect(focus.outlineStyle).toBe("solid");
  expect(Number.parseFloat(focus.outlineWidth)).toBe(2);
});

it("keeps the bordered card when the change carries a diff body", async () => {
  await using screen = await render(
    <TimelineFileChangeCard
      item={fileChange({ diffStr: "@@ -1,1 +1,2 @@\n context\n+added\n" })}
      workspaceRoot="/work"
    />,
    { router: false },
  );
  const section = screen.container.querySelector<HTMLElement>("section")!;
  expect(section.dataset.fileChangeVariant).toBe("card");
  expect(getComputedStyle(section).borderTopWidth).toBe("1px");
});
