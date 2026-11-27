/** Agent text is untrusted, so the block never renders more than this from one field. */
export const NEEDS_YOU_TEXT_MAX = 240;

const WHITESPACE = /\s+/g;
const FAILED_FALLBACK = "The last run failed.";

export interface NeedsYouAnswerOption {
  readonly label: string;
  readonly value: string;
}

export interface NeedsYouAnswerQuestion {
  readonly id: string;
  readonly text: string;
  readonly header: string | null;
  readonly options: ReadonlyArray<NeedsYouAnswerOption>;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
}

export interface NeedsYouAnswerProgress {
  readonly index: number;
  readonly total: number;
}

export interface NeedsYouAnswerLoadingView {
  readonly kind: "loading";
}

export interface NeedsYouAnswerInputView {
  readonly kind: "input";
  readonly requestId: string;
  readonly question: NeedsYouAnswerQuestion;
  readonly progress: NeedsYouAnswerProgress;
  readonly selectedValues: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onToggleOption: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onReply: (text: string) => void;
}

export interface NeedsYouAnswerApprovalView {
  readonly kind: "approval";
  readonly requestId: string;
  readonly command: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly canRespond: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}

export interface NeedsYouAnswerFailedView {
  readonly kind: "failed";
  readonly reason: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
}

export type NeedsYouAnswerView =
  | NeedsYouAnswerLoadingView
  | NeedsYouAnswerInputView
  | NeedsYouAnswerApprovalView
  | NeedsYouAnswerFailedView;

/** Remounts the block when the question changes, not when its pending or error state does. */
export function needsYouAnswerKey(view: NeedsYouAnswerView): string {
  switch (view.kind) {
    case "input":
      return `input:${view.requestId}:${view.question.id}`;
    case "approval":
      return `approval:${view.requestId}`;
    case "failed":
      return `failed:${view.reason}`;
    case "loading":
      return "loading";
  }
}

/** Collapses whitespace and caps agent text so a block cannot grow without bound. */
export function boundNeedsYouText(text: string, max = NEEDS_YOU_TEXT_MAX): string {
  const collapsed = text.replace(WHITESPACE, " ").trim();
  const characters = Array.from(collapsed);
  return characters.length <= max ? collapsed : `${characters.slice(0, max).join("")}…`;
}

/** The failure line a thread row's answer block shows. */
export function needsYouFailureReason(thread: {
  readonly runtime: { readonly lastError: string | null } | null;
}): string {
  const error = thread.runtime?.lastError?.trim();
  return boundNeedsYouText(error && error.length > 0 ? error : FAILED_FALLBACK);
}
