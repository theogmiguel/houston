import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { DiffStatLabel } from "./DiffStatLabel";

function colors(label: HTMLElement) {
  const [added, removed] = [...label.querySelectorAll("span")];
  return { added: getComputedStyle(added!).color, removed: getComputedStyle(removed!).color };
}

async function measure(additions: number, deletions: number) {
  const host = document.createElement("div");
  await using _screen = await render(
    <DiffStatLabel additions={additions} deletions={deletions} />,
    {
      container: host,
    },
  );
  return colors(host.querySelector<HTMLElement>("[role=group]")!);
}

it("paints a zero count in the muted colour and a non-zero count in its diff colour", async () => {
  const mixed = await measure(5, 0);
  const none = await measure(0, 0);
  const both = await measure(5, 3);

  expect(mixed.added).toBe(both.added);
  expect(both.removed).not.toBe(both.added);
  // "+5 -0": the zero side leaves the destructive colour and matches an all-zero stat.
  expect(mixed.removed).not.toBe(both.removed);
  expect(mixed.removed).toBe(none.removed);
  expect(none.added).toBe(none.removed);
  expect(none.added).not.toBe(both.added);
  const removedOnly = await measure(0, 3);
  expect(removedOnly.removed).toBe(both.removed);
  expect(removedOnly.added).toBe(none.added);
});
