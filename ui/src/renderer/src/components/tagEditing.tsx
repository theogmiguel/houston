import { useEffect, useRef, useState } from "react";
import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAG_NAME_LEN, TAG_PALETTE } from "../houston/generated/DEFAULTS";
import { BTN_GHOST, BTN_PRIMARY } from "./buttonChrome";
import { CONTROL_SIZE_SQUARE_CLS } from "./controlSize";
import { TagChip } from "./tags";
import { Tooltip } from "./Tooltip";

export function TagColorPicker({
  color,
  onPick,
}: {
  color: string | null;
  onPick: (color: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-[7px]" data-testid="tag-color-picker">
      {TAG_PALETTE.map((c) => (
        <Tooltip key={c} label={c}>
          <button
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            data-testid="tag-swatch"
            data-color={c}
            onClick={() => onPick(c)}
            className={`${CONTROL_SIZE_SQUARE_CLS.mini} rounded-full cursor-default ${
              color === c
                ? "outline outline-1 outline-offset-2 outline-[var(--text-primary)]"
                : "hover:brightness-110"
            }`}
            style={{ background: c }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

/** Why this tag cannot be saved, in the user's words, or null when it can.
 *  `excludeId` is the tag being edited, which may keep its own name. */
export function tagRejection(
  name: string,
  color: string | null,
  tags: TagInfo[],
  excludeId: number | null,
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Name a tag first";
  const len = [...trimmed].length;
  if (len > MAX_TAG_NAME_LEN)
    return `"${trimmed}" is ${len} characters — over the ${MAX_TAG_NAME_LEN}-character cap (MAX_TAG_NAME_LEN)`;
  if (
    tags.some(
      (t) =>
        t.id !== excludeId && t.name.toLowerCase() === trimmed.toLowerCase(),
    )
  )
    return `A tag named "${trimmed}" already exists`;
  if (color === null) return "Pick a color";
  return null;
}

export interface TagEditorState {
  x: number;
  y: number;
  tag: TagInfo | null;
}

export function TagEditor({
  state,
  tags,
  onSave,
  onCancel,
}: {
  state: TagEditorState;
  tags: TagInfo[];
  onSave: (name: string, color: string, editing: TagInfo | null) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(state.tag?.name ?? "");
  const [color, setColor] = useState<string | null>(state.tag?.color ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  // A click anywhere else dismisses the popover, like the menu that opened it.
  // pointerdown, not click: a drag starting outside must not strand it either.
  useEffect(() => {
    const away = (e: PointerEvent): void => {
      if (!popRef.current?.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onCancel]);

  const trimmed = name.trim();
  const reason = tagRejection(trimmed, color, tags, state.tag?.id ?? null);

  return (
    <div
      ref={popRef}
      className="fixed z-[var(--z-context)] w-[252px] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] p-[12px] flex flex-col gap-[10px]"
      style={{ top: Math.min(state.y, window.innerHeight - 260), left: Math.min(state.x, window.innerWidth - 268) }}
      role="dialog"
      aria-label={state.tag ? "Edit tag" : "New tag"}
      data-testid="tag-editor"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <strong className="[font-size:var(--tr-text-small-size)] [font-weight:650] text-[var(--text-primary)]">
        {state.tag ? "Edit tag" : "New tag"}
      </strong>
      <input
        ref={inputRef}
        type="text"
        value={name}
        maxLength={MAX_TAG_NAME_LEN}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !reason && color) {
            onSave(trimmed, color, state.tag);
          }
        }}
        placeholder="Tag name"
        aria-label="Tag name"
        className="w-full h-7 px-2 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] outline-none focus-visible:border-[var(--border-hover)]"
      />
      <div className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.04em]">
        Color
      </div>
      <TagColorPicker color={color} onPick={setColor} />
      {color !== null && (
        <div className="flex items-center gap-[6px]">
          <span className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase tracking-[0.04em]">
            Preview
          </span>
          <TagChip tag={{ id: 0, name: trimmed || "tag", color }} />
        </div>
      )}
      <div className="flex justify-end gap-[8px]">
        <button
          type="button"
          className={`btn ${BTN_GHOST} px-[12px] py-[5px] rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold`}
          onClick={onCancel}
        >
          Cancel
        </button>
        <Tooltip label={reason ?? ""}>
          <button
            type="button"
            data-testid="tag-editor-save"
            disabled={reason !== null}
            className={`btn ${BTN_PRIMARY} px-[12px] py-[5px] rounded-[var(--tr-radius-button)] [font-size:var(--tr-text-small-size)] font-semibold disabled:opacity-45 disabled:cursor-default`}
            onClick={() => {
              if (reason !== null || color === null) return;
              onSave(trimmed, color, state.tag);
            }}
          >
            {state.tag ? "Save" : "Create"}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
