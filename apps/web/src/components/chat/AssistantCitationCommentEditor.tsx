import { ASSISTANT_CITATION_MAX_COMMENT_LENGTH, type AssistantCitation } from "@t3tools/contracts";
import { useState, type Ref } from "react";

import { Button } from "../ui/button";

export function AssistantCitationCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDraftChange,
}: {
  citation: AssistantCitation;
  inputRef?: Ref<HTMLTextAreaElement>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDraftChange?: (comment: string) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    if (!commentTooLong) onSubmit(comment);
  };
  const submitAndSend = () => {
    if (commentTooLong) return;
    if (onSubmitAndSend) {
      onSubmitAndSend(comment);
    } else {
      onSubmit(comment);
    }
  };

  return (
    <div
      data-citation-comment-editor="true"
      className="grid gap-2 rounded-(--r-group) bg-(--raised) p-2.5 px-3 text-headline shadow-(--shadow-2)"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="line-clamp-3 border-(--line-strong) border-l-2 pl-2 text-(--t3) text-xs">
        “{citation.text}”
      </p>
      <textarea
        ref={inputRef}
        aria-label="Comment on selected text"
        aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        className="field-sizing-content block max-h-40 min-h-9 w-full resize-none rounded-(--r-ctl) bg-(--field) px-2.25 py-1.75 text-headline outline-none placeholder:text-(--t3) focus-visible:ring-1 focus-visible:ring-(--accent-ink) focus-visible:ring-inset"
        value={comment}
        onChange={(event) => {
          setComment(event.currentTarget.value);
          onDraftChange?.(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              submitAndSend();
            } else {
              submit();
            }
          }
        }}
      />
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          size="xs"
          disabled={commentTooLong}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
}
