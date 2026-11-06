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

it("draws a change without a diff body as the bordered card, with the open icon inside on the right", async () => {
  await using screen = await render(
    <TimelineFileChangeCard item={fileChange()} workspaceRoot="/work" onOpenDiff={() => {}} />,
    { router: false },
  );
  const section = screen.container.querySelector<HTMLElement>("section")!;
  const style = getComputedStyle(section);
  expect(style.borderTopWidth).toBe("1px");
  expect(style.borderTopColor).toBe(resolveColor("var(--contrast-card-border)"));
  expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.borderTopLeftRadius).toBe(resolveRadius("var(--r-group)"));

  // The open icon sits inside the card, at its right edge.
  const open = screen.getByRole("button", { name: "Open diff" }).element();
  const box = section.getBoundingClientRect();
  const openBox = open.getBoundingClientRect();
  expect(openBox.right).toBeLessThanOrEqual(box.right);
  expect(box.right - openBox.right).toBeLessThan(12);
  expect(openBox.left).toBeGreaterThan(box.left + box.width / 2);
});

it("matches the changed-files card's border and radius", async () => {
  await using screen = await render(
    <TimelineFileChangeCard
      item={fileChange({ diffStr: "@@ -1,1 +1,2 @@\n context\n+added\n" })}
      workspaceRoot="/work"
    />,
    { router: false },
  );
  const style = getComputedStyle(screen.container.querySelector<HTMLElement>("section")!);
  expect(style.borderTopWidth).toBe("1px");
  expect(style.borderTopColor).toBe(resolveColor("var(--contrast-card-border)"));
});
