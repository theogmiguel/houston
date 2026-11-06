import { useId, useRef, useState } from "react";

import { cn } from "../../lib/utils";

export const EMPTY_THREAD_TITLE_MESSAGE = "A thread title cannot be empty.";

/**
 * The inline editor for a thread title. It selects the whole title on focus,
 * commits on Enter or blur and cancels on Escape, ignores both keys while an
 * input method is composing, and refuses an empty title with a message.
 */
export function ThreadTitleInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const [empty, setEmpty] = useState(false);
  const finished = useRef(false);
  const messageId = useId();

  const finish = (action: () => void) => {
    if (finished.current) return;
    finished.current = true;
    action();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <input
        autoFocus
        value={value}
        aria-invalid={empty || undefined}
        aria-describedby={empty ? messageId : undefined}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setValue(event.target.value);
          setEmpty(false);
        }}
        onBlur={() => {
          const next = value.trim();
          finish(next.length === 0 ? onCancel : () => onCommit(next));
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            const next = value.trim();
            if (next.length === 0) {
              setEmpty(true);
              return;
            }
            finish(() => onCommit(next));
          }
          if (event.key === "Escape") finish(onCancel);
        }}
        className={cn(
          "h-6 min-w-0 flex-1 rounded-(--r-ctl) border border-input bg-background px-1.5 text-xs text-foreground outline-none focus:border-ring",
          empty && "border-error-foreground focus:border-error-foreground",
        )}
      />
      {empty ? (
        <p id={messageId} role="alert" className="text-2xs text-error-foreground">
          {EMPTY_THREAD_TITLE_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}
