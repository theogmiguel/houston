import { useState } from "react";

import { useT } from "~/i18n/useT";
import type { NeedsYouAnswerInputView, NeedsYouAnswerView } from "./needs-you-answer-model";
import { Button } from "./button";
import { Input } from "./input";
import { Skeleton } from "./skeleton";

function AnswerError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-2xs text-muted-foreground">
      {message}
    </p>
  );
}

function InputAnswer({ view }: { view: NeedsYouAnswerInputView }) {
  const t = useT();
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const submitReply = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    view.onReply(text);
    setDraft("");
    setReplying(false);
  };
  return (
    <>
      <p className="text-xs text-muted-foreground">{view.question.text}</p>
      <div className="flex flex-wrap items-center gap-1">
        {view.question.options.map((option) => (
          <Button
            key={option.value}
            size="xs"
            variant="outline"
            disabled={view.pending}
            aria-pressed={
              view.question.multiSelect ? view.selectedValues.includes(option.value) : undefined
            }
            onClick={() => view.onToggleOption(option.value)}
          >
            <span className="max-w-60 truncate">{option.label}</span>
          </Button>
        ))}
        {view.question.multiSelect ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={view.pending || view.selectedValues.length === 0}
            onClick={view.onSubmit}
          >
            {t("Send")}
          </Button>
        ) : view.question.allowCustomAnswer ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={view.pending}
            onClick={() => setReplying(true)}
          >
            {t("Reply…")}
          </Button>
        ) : null}
      </div>
      {replying ? (
        <Input
          size="compact"
          autoFocus
          value={draft}
          disabled={view.pending}
          aria-label={t("Reply…")}
          placeholder={t("Reply…")}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitReply();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft("");
              setReplying(false);
            }
          }}
        />
      ) : null}
      {view.error === null ? null : <AnswerError message={view.error} />}
    </>
  );
}

function ApprovalAnswer({ view }: { view: Extract<NeedsYouAnswerView, { kind: "approval" }> }) {
  const t = useT();
  const disabled = view.pending || !view.canRespond;
  return (
    <>
      <p className="truncate font-mono text-xs text-muted-foreground">{view.command}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" variant="outline" disabled={disabled} onClick={view.onApprove}>
          {t("Approve")}
        </Button>
        <Button size="xs" variant="ghost" disabled={disabled} onClick={view.onDeny}>
          {t("Deny")}
        </Button>
      </div>
      {view.error === null ? null : <AnswerError message={view.error} />}
    </>
  );
}

function FailedAnswer({ view }: { view: Extract<NeedsYouAnswerView, { kind: "failed" }> }) {
  const t = useT();
  return (
    <>
      <p className="text-xs text-muted-foreground">{view.reason}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" variant="outline" disabled={view.pending} onClick={view.onRetry}>
          {t("Retry")}
        </Button>
      </div>
      {view.error === null ? null : <AnswerError message={view.error} />}
    </>
  );
}

/** The answer block one open "Needs you" row shows under it. */
export function NeedsYouAnswerBlock({ view }: { view: NeedsYouAnswerView }) {
  return (
    <div className="flex flex-col gap-1.5 pb-2">
      {view.kind === "loading" ? (
        <>
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-6 w-24" />
        </>
      ) : view.kind === "input" ? (
        <InputAnswer view={view} />
      ) : view.kind === "approval" ? (
        <ApprovalAnswer view={view} />
      ) : (
        <FailedAnswer view={view} />
      )}
    </div>
  );
}
