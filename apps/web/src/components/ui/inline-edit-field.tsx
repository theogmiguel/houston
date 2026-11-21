import { useId, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "~/i18n/useT";
import { cn } from "../../lib/utils";

/** Characters before `maxChars` at which the counter appears: a warning, never on a short name. */
export const INLINE_EDIT_COUNTER_LEAD = 8;

/** The text the field stands in for: a workspace heading, a thread title, or the phone's bar. */
export type InlineEditScale = "heading" | "title" | "bar";

// The field takes the box of the text it replaces: inputs inherit font and colour, the negative
// margin gives the padding back, and one ring marks it as editable without moving anything.
const INLINE_EDIT_INPUT_CLS =
  "-mx-1 min-w-0 flex-1 rounded-(--r-badge) bg-(--sel) px-1 outline-none ring-1 ring-input focus-visible:ring-ring";
const INLINE_EDIT_INVALID_CLS = "ring-error-foreground focus-visible:ring-error-foreground";
const INLINE_EDIT_SCALE_CLS: Record<InlineEditScale, string> = {
  heading: "h-5 text-xs font-normal text-sidebar-foreground",
  title: "h-5 text-sm leading-5 font-medium text-foreground",
  bar: "h-8 text-sm font-medium text-foreground",
};
const INLINE_EDIT_MESSAGE_ROW_CLS = "flex min-w-0 items-baseline gap-2 text-2xs";
const INLINE_EDIT_HINT_CLS = "min-w-0 truncate text-secondary-label";
const INLINE_EDIT_ERROR_CLS = "min-w-0 text-error-foreground";
const INLINE_EDIT_COUNTER_CLS = "ml-auto shrink-0 tabular-nums text-secondary-label";
const INLINE_EDIT_COUNTER_OVER_CLS = "text-error-foreground";

export interface InlineEditOptions {
  initialValue: string;
  /** Saves the trimmed value; returns why it was refused (the field stays open), or null. */
  onCommit: (value: string) => string | null;
  onCancel: () => void;
  /** The longest value accepted; a counter appears as the value nears it. */
  maxChars?: number | undefined;
  /** The refusal for an empty value on Enter. Without it, an empty value cancels. */
  emptyMessage?: string | undefined;
}

export interface InlineEdit {
  inputProps: {
    value: string;
    autoFocus: true;
    dir: "auto";
    "aria-invalid": true | undefined;
    "aria-describedby": string | undefined;
    onChange: (event: { target: { value: string } }) => void;
    onFocus: (event: { currentTarget: HTMLInputElement }) => void;
    onBlur: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
  invalid: boolean;
  message: string | null;
  messageId: string;
  counter: { length: number; max: number } | null;
}

/**
 * One contract for every inline name: select on focus, save on Enter or blur, cancel on Escape,
 * settle once, ignore keys mid-composition, and keep a refused value open with its reason.
 */
export function useInlineEdit({
  initialValue,
  onCommit,
  onCancel,
  maxChars,
  emptyMessage,
}: InlineEditOptions): InlineEdit {
  const t = useT();
  const [value, setValue] = useState(initialValue);
  const [refusal, setRefusal] = useState<string | null>(null);
  const settled = useRef(false);
  const messageId = useId();

  const length = value.trim().length;
  const over = maxChars !== undefined && length > maxChars;
  const limitMessage = over
    ? t("A name is at most {max} characters; this one has {length}.", { max: maxChars, length })
    : null;
  const message = refusal ?? limitMessage;
  const counter =
    maxChars !== undefined && length >= maxChars - INLINE_EDIT_COUNTER_LEAD
      ? { length, max: maxChars }
      : null;

  const settle = (action: () => void) => {
    if (settled.current) return;
    settled.current = true;
    action();
  };
  // A blur only saves what Enter would; a value Enter would refuse is left open on blur, and an
  // empty one goes back to what it was.
  const save = (fromBlur: boolean) => {
    if (settled.current) return;
    const next = value.trim();
    if (next.length === 0) {
      if (emptyMessage !== undefined && !fromBlur) setRefusal(emptyMessage);
      else settle(onCancel);
      return;
    }
    if (over || (fromBlur && refusal !== null)) return;
    const refused = onCommit(next);
    if (refused === null) settled.current = true;
    else setRefusal(refused);
  };

  return {
    inputProps: {
      value,
      autoFocus: true,
      dir: "auto",
      "aria-invalid": message !== null ? true : undefined,
      "aria-describedby": message !== null || counter !== null ? messageId : undefined,
      onChange: (event) => {
        setValue(event.target.value);
        setRefusal(null);
      },
      onFocus: (event) => event.currentTarget.select(),
      onBlur: () => save(true),
      onKeyDown: (event) => {
        // The row around the field has its own Enter, Escape and arrow keys.
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key !== "Enter" && event.key !== "Escape") return;
        // The key's default would click whatever takes focus once the field unmounts.
        event.preventDefault();
        if (event.key === "Enter") save(false);
        else settle(onCancel);
      },
    },
    invalid: message !== null,
    message,
    messageId,
    counter,
  };
}

export function InlineEditInput({
  edit,
  label,
  scale,
}: {
  edit: InlineEdit;
  label: string;
  scale: InlineEditScale;
}) {
  return (
    <input
      {...edit.inputProps}
      aria-label={label}
      data-inline-edit=""
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        INLINE_EDIT_INPUT_CLS,
        INLINE_EDIT_SCALE_CLS[scale],
        edit.invalid && INLINE_EDIT_INVALID_CLS,
      )}
    />
  );
}

/** Whether `InlineEditMessage` has anything to show, for a caller that wraps it. */
export function hasInlineEditMessage(edit: InlineEdit, hint?: string | undefined): boolean {
  return edit.message !== null || hint !== undefined || edit.counter !== null;
}

/** The line under the field: the refusal, else the hint, with the counter at its end. */
export function InlineEditMessage({ edit, hint }: { edit: InlineEdit; hint?: string | undefined }) {
  if (!hasInlineEditMessage(edit, hint)) return null;
  const shownHint = edit.message === null ? hint : undefined;
  const counterOver = edit.counter !== null && edit.counter.length > edit.counter.max;
  return (
    <div id={edit.messageId} className={INLINE_EDIT_MESSAGE_ROW_CLS}>
      {edit.message !== null ? (
        <span role="alert" className={INLINE_EDIT_ERROR_CLS}>
          {edit.message}
        </span>
      ) : shownHint !== undefined ? (
        <span data-inline-edit-hint="" className={INLINE_EDIT_HINT_CLS}>
          {shownHint}
        </span>
      ) : null}
      {edit.counter === null ? null : (
        <span
          data-inline-edit-counter=""
          className={cn(INLINE_EDIT_COUNTER_CLS, counterOver && INLINE_EDIT_COUNTER_OVER_CLS)}
        >
          {edit.counter.length}/{edit.counter.max}
        </span>
      )}
    </div>
  );
}

/** The field and its message line stacked, for a place with room under the text. */
export function InlineEditField({
  label,
  scale,
  hint,
  ...options
}: InlineEditOptions & { label: string; scale: InlineEditScale; hint?: string | undefined }) {
  const edit = useInlineEdit(options);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <InlineEditInput edit={edit} label={label} scale={scale} />
      <InlineEditMessage edit={edit} hint={hint} />
    </div>
  );
}
