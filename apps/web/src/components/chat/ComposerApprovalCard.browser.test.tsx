import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerApprovalCard } from "./ComposerApprovalCard";

const approval = {
  requestId: RuntimeRequestId.make("approval-opaque"),
  requestKind: "file-change" as const,
  createdAt: "2026-10-09T00:00:00.000Z",
  detail: "Changed files",
  responseCapability: "live" as const,
};

function approvalCard(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-composer-approval-card]");
  if (element === null) throw new Error("approval card missing");
  return element;
}

function alphaOf(color: string): number {
  const match = /^rgba?\(([^)]*)\)$/.exec(color.trim());
  const channelsText = match?.[1];
  if (channelsText === undefined) throw new Error(`unexpected color '${color}'`);
  const alpha = channelsText.split(/[,/]/)[3]?.trim();
  return alpha === undefined ? 1 : Number.parseFloat(alpha);
}

describe("ComposerApprovalCard surface", () => {
  it("paints an opaque warning wash over the composer in both themes", async () => {
    await using screen = await render(
      <ComposerApprovalCard
        approval={approval}
        density="comfortable"
        index={0}
        count={1}
        canOperateThread
        isResponding={false}
        onRespond={async () => undefined}
      />,
      { router: false },
    );
    const element = approvalCard(screen.container);
    const root = document.documentElement;

    root.classList.remove("dark");
    try {
      const light = getComputedStyle(element);
      expect(alphaOf(light.backgroundColor)).toBe(1);
      expect(light.backgroundImage).toContain("linear-gradient");

      root.classList.add("dark");
      const dark = getComputedStyle(element);
      expect(alphaOf(dark.backgroundColor)).toBe(1);
      expect(dark.backgroundImage).toContain("linear-gradient");
    } finally {
      root.classList.remove("dark");
    }
  });
});
