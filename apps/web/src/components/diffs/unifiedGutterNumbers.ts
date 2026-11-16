import type { FileDiffMetadata } from "@pierre/diffs";

import { createOldLineResolver } from "./diffOldLineNumbers";

const OLD_NUMBER_ATTRIBUTE = "data-old-line-number";

/**
 * The viewer prints one number per unified row. This gives every row two gutters, old then new:
 * a deletion keeps its number on the old side, an addition on the new side, and an unchanged row
 * shows both. The number cells size their column to content, so the gutter widens by itself.
 * Idempotent: a row the viewer re-rendered is rebuilt from its own number each time.
 */
export function addOldLineNumbers(container: HTMLElement, fileDiff: FileDiffMetadata): void {
  const root = container.shadowRoot ?? container;
  // The viewer names its one-column layout "single"; split has a gutter per side already.
  if (root.querySelector('[data-diff-type="single"]') === null) return;
  const resolve = createOldLineResolver(fileDiff);
  for (const cell of root.querySelectorAll<HTMLElement>("[data-gutter] [data-column-number]")) {
    const lineType = cell.getAttribute("data-line-type") ?? "";
    const own = cell.querySelector<HTMLElement>("[data-line-number-content]");
    if (own === null) continue;
    const ownNumber = Number(own.textContent);
    if (!Number.isFinite(ownNumber) || ownNumber <= 0) continue;
    let old = cell.querySelector<HTMLElement>(`[${OLD_NUMBER_ATTRIBUTE}]`);
    if (old === null) {
      old = cell.ownerDocument.createElement("span");
      old.setAttribute(OLD_NUMBER_ATTRIBUTE, "");
      old.setAttribute("aria-hidden", "true");
      cell.insertBefore(old, own);
    }
    if (lineType === "change-deletion") {
      old.textContent = String(ownNumber);
      own.textContent = "";
    } else if (lineType === "change-addition") {
      old.textContent = "";
    } else {
      old.textContent = String(resolve(ownNumber));
    }
  }
}
