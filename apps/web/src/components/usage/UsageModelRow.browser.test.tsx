import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render } from "../../../test/render";
import { UsageModelRow } from "./UsageModelRow";

const MODEL: ModelTotals = {
  model: "claude-opus-5-5",
  provider: "claude",
  costUsd: 12,
  totalTokens: 1_000,
  tokens: {
    uncachedInputTokens: 100,
    cachedInputTokens: 800,
    cacheCreationTokens: 50,
    outputTokens: 50,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 1,
  tokenShare: 1,
};

it("keeps the row's whole-row click target inside the row", async () => {
  const onSelectModel = vi.fn();
  await using screen = await render(
    <div>
      <button
        id="above-the-table"
        style={{ display: "block", marginBottom: "20rem" }}
        type="button"
      >
        Above
      </button>
      <table>
        <tbody>
          <UsageModelRow
            loading={false}
            metric="cost"
            model={MODEL}
            onSelectModel={onSelectModel}
          />
        </tbody>
      </table>
    </div>,
  );

  const above = screen.container.querySelector<HTMLElement>("#above-the-table")!;
  const rect = above.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(hit?.id).toBe("above-the-table");

  const rowButton = screen.container.querySelector<HTMLButtonElement>("tbody button")!;
  await act(async () => rowButton.click());
  expect(onSelectModel).toHaveBeenCalledWith("claude:claude-opus-5-5");
});
