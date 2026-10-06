import { useEffect, useRef, useState } from "react";
import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAG_NAME_LEN, TAG_PALETTE } from "../houston/generated/DEFAULTS";
import {
  TagEditorActions,
  TagEditorButton,
  TagEditorCaption,
  TagEditorInput,
  TagEditorPopover,
  TagEditorPreviewRow,
  TagEditorTitle,
} from "./ui/TagEditor";
import { TagChip } from "./tags";
import { TagSwatchButton, TagSwatchGrid } from "./ui/TagSwatch";
import { Tooltip } from "./ui/Tooltip";

export function TagColorPicker({
  color,
  onPick,
}: {
  color: string | null;
  onPick: (color: string) => void;
}): React.JSX.Element {
  return (
    <TagSwatchGrid>
      {TAG_PALETTE.map((c) => (
        <Tooltip key={c} label={c}>
          <TagSwatchButton
            color={c}
            selected={color === c}
            aria-label={`Color ${c}`}
            data-testid="tag-swatch"
            data-color={c}
            onClick={() => onPick(c)}
          />
        </Tooltip>
      ))}
    </TagSwatchGrid>
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
    <TagEditorPopover
      popRef={popRef}
      style={{ top: `min(${state.y}px, calc(100vh - var(--h-tag-editor-placement)))`, left: `min(${state.x}px, calc(100vw - var(--w-tag-editor-edge)))` }}
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
      <TagEditorTitle>{state.tag ? "Edit tag" : "New tag"}</TagEditorTitle>
      <TagEditorInput
        inputRef={inputRef}
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
      />
      <TagEditorCaption>Color</TagEditorCaption>
      <TagColorPicker color={color} onPick={setColor} />
      {color !== null && (
        <TagEditorPreviewRow>
          <TagEditorCaption inline>Preview</TagEditorCaption>
          <TagChip tag={{ id: 0, name: trimmed || "tag", color }} />
        </TagEditorPreviewRow>
      )}
      <TagEditorActions>
        <TagEditorButton variant="ghost" onClick={onCancel}>
          Cancel
        </TagEditorButton>
        <Tooltip label={reason ?? ""}>
          <TagEditorButton
            variant="primary"
            data-testid="tag-editor-save"
            disabled={reason !== null}
            onClick={() => {
              if (reason !== null || color === null) return;
              onSave(trimmed, color, state.tag);
            }}
          >
            {state.tag ? "Save" : "Create"}
          </TagEditorButton>
        </Tooltip>
      </TagEditorActions>
    </TagEditorPopover>
  );
}
