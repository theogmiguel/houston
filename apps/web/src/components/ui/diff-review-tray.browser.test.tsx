import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

import { render } from "../../../test/render";

import { DiffReviewTray } from "./diff-review-tray";

const target = DraftId.make("diff-review-tray-test");

function reviewComment(id: string) {
  return {
    id,
    sectionId: "unstaged",
    sectionTitle: "Uncommitted",
    filePath: "src/app.ts",
    startIndex: 0,
    endIndex: 1,
    rangeLabel: "L1 to L2",
    text: "Keep this around",
    diff: "@@ -1,2 +1,2 @@\n-old\n+new\n",
  };
}

function setup(): Disposable {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  return { [Symbol.dispose]: reset };
}

describe("diff review tray", () => {
  it("undoes every comment this batch added to the composer", async () => {
    using _drafts = setup();
    useComposerDraftStore.getState().addReviewComment(target, reviewComment("comment-1"));
    useComposerDraftStore.getState().addReviewComment(target, reviewComment("comment-2"));
    const onDismiss = vi.fn();
    await using screen = await render(
      <DiffReviewTray
        composerDraftTarget={target}
        commentIds={["comment-1", "comment-2"]}
        onDismiss={onDismiss}
      />,
      { router: false },
    );

    await expect.element(screen.getByText("2 comments added to the composer")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? []).toEqual(
      [],
    );
    await expect
      .element(screen.getByText("2 comments added to the composer"))
      .not.toBeInTheDocument();
  });

  it("keeps the comments when the reader keeps reviewing", async () => {
    using _drafts = setup();
    useComposerDraftStore.getState().addReviewComment(target, reviewComment("comment-1"));
    const onDismiss = vi.fn();
    await using screen = await render(
      <DiffReviewTray
        composerDraftTarget={target}
        commentIds={["comment-1"]}
        onDismiss={onDismiss}
      />,
      { router: false },
    );

    await expect.element(screen.getByText("1 comment added to the composer")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Keep reviewing" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toHaveLength(
      1,
    );
  });
});
