import type { NewThreadHandler } from "../hooks/useHandleNewThread";
import { isPhoneViewport } from "../mobile/usePhone";
import { openDraftInLayout, type DraftOpenNavigation } from "../threads/openDraftInLayout";
import { openGridDraft, type GridDraftOptions, type OpenedGridDraft } from "./newThreadDraft";

/**
 * Opens a draft that starts like `openGridDraft` and shows it where threads are shown: a tab of
 * the layout off a phone, the grid's pane on one (the caller navigates there).
 */
export async function openGridDraftWhereShown(
  input: GridDraftOptions,
  handleNewThread: NewThreadHandler,
  navigation: DraftOpenNavigation,
): Promise<{ readonly opened: OpenedGridDraft | null; readonly inLayout: boolean }> {
  const opened = await openGridDraft(input, handleNewThread);
  if (opened === null || isPhoneViewport()) return { opened, inLayout: false };
  await openDraftInLayout(navigation, opened.draftId);
  return { opened, inLayout: true };
}
