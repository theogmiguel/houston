import type { OrchestrationV2TurnItem } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

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

function resolveRadius(value: string): string {
  const probe = document.createElement("span");
  probe.style.borderTopLeftRadius = value;
  document.body.append(probe);
  const radius = getComputedStyle(probe).borderTopLeftRadius;
  probe.remove();
  return radius;
}

function resolveColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

it("draws a change as the shared compact row, with Open diff inside on the right", async () => {
  await using screen = await render(
    <TimelineFileChangeCard
      item={fileChange()}
      workspaceRoot="/work/atlas-api"
      onOpenDiff={() => {}}
    />,
    { router: false },
  );
  const section = screen.container.querySelector<HTMLElement>(
    'section[aria-label="Diff for atlas-api/CHANGELOG.md"]',
  )!;
  const row = section.querySelector<HTMLElement>("[data-timeline-changes] > div")!;
  const style = getComputedStyle(row);
  expect(style.borderTopWidth).toBe("1px");
  expect(style.borderTopColor).toBe(resolveColor("var(--border)"));
  expect(style.borderTopLeftRadius).toBe(resolveRadius("var(--r-ctl)"));
  expect(style.height).toBe("28px");

  // The open action sits inside the row, at its right edge.
  const open = screen.getByRole("button", { name: "Open diff" }).element();
  const box = row.getBoundingClientRect();
  const openBox = open.getBoundingClientRect();
  expect(openBox.right).toBeLessThanOrEqual(box.right);
  expect(box.right - openBox.right).toBeLessThan(12);
  expect(openBox.left).toBeGreaterThan(box.left + box.width / 2);
});

it("lists the changed file as a chip with the same radius and height", async () => {
  await using screen = await render(
    <TimelineFileChangeCard item={fileChange()} workspaceRoot="/work/atlas-api" />,
    { router: false },
  );
  const chip = screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open diff for atlas-api/CHANGELOG.md"]',
  )!;
  const style = getComputedStyle(chip);
  expect(style.borderTopLeftRadius).toBe(resolveRadius("var(--r-ctl)"));
  expect(style.height).toBe("28px");
  expect(chip.textContent).toContain("atlas-api/CHANGELOG.md");
});

it("keeps the inline diff behind the shared row and qualifies it with its own line numbers", async () => {
  await using screen = await render(
    <TimelineFileChangeCard
      item={fileChange({ diffStr: "@@ -1,1 +1,2 @@\n context\n+added\n" })}
      workspaceRoot="/work/atlas-api"
    />,
    { router: false },
  );
  const row = screen.container.querySelector<HTMLElement>("[data-timeline-changes] > div")!;
  expect(getComputedStyle(row).borderTopLeftRadius).toBe(resolveRadius("var(--r-ctl)"));
  await expect.element(screen.getByText("context")).toBeVisible();
  await expect.element(screen.getByText("added")).toBeVisible();
});
