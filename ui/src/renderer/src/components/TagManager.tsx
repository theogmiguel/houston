import { useEffect, useRef, useState } from "react";
import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAG_NAME_LEN } from "../houston/generated/DEFAULTS";
import { BTN_GHOST, BTN_PRIMARY } from "./buttonChrome";
import { ConfirmModal } from "./ConfirmModal";
import { Icon } from "./Icon";
import { IconPencil, IconPlus, IconTrash } from "./icons";
import { MODAL_SCRIM_CLS } from "./overlayChrome";
import { Tooltip } from "./Tooltip";
import { useFocusTrap } from "./dialogFocus";
import { TagChip } from "./tags";
import { TagColorPicker, tagRejection } from "./tagEditing";

const FIELD_CLS = "flex flex-col gap-[5px]";
const FIELD_LABEL_CLS =
  "block text-text-muted [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase";
const TEXT_INPUT_CLS =
  "w-full bg-background border border-border rounded-[var(--tr-radius-button)] text-text-primary [font:inherit] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] px-2.5 py-1.5";
const HINT_CLS =
  "text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.55]";
const ROW_ICON_BTN_CLS =
  "btn border-none bg-transparent rounded-[var(--tr-radius-input)] text-[var(--text-faint)] py-0 px-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary";
// A tag made from the rail lands here with the manager already open; the ring
// says which row is the new one and fades itself out, so nothing has to clear it.
const NEW_ROW_CLS =
  "motion-safe:animate-[tag-row-settle_1.4s_var(--animate-ease-panel)_forwards] outline outline-1 outline-[var(--accent)] -outline-offset-1";

/** Both editors are the same form; only the verb on its primary button differs. */
function TagForm({
  initial,
  tags,
  submitLabel,
  testId,
  onSubmit,
  onCancel,
}: {
  initial: TagInfo | null;
  tags: TagInfo[];
  submitLabel: string;
  testId: string;
  onSubmit: (name: string, color: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState<string | null>(initial?.color ?? null);
  const reason = tagRejection(name, color, tags, initial?.id ?? null);
  const submit = (): void => {
    if (reason !== null || color === null) return;
    onSubmit(name.trim(), color);
  };
  return (
    <div className={FIELD_CLS} data-testid={testId}>
      <label className={FIELD_LABEL_CLS}>
        {initial ? `Editing ${initial.name}` : "New tag"}
      </label>
      <input
        autoFocus
        type="text"
        value={name}
        maxLength={MAX_TAG_NAME_LEN}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        aria-label="Tag name"
        placeholder="Tag name"
        spellCheck={false}
        className={TEXT_INPUT_CLS}
      />
      <TagColorPicker color={color} onPick={setColor} />
      {reason !== null && name.trim() !== "" && (
        <div className={HINT_CLS} role="status">
          {reason}
        </div>
      )}
      <div className="flex items-center gap-2 pt-[2px]">
        {color !== null && (
          <span
            className="flex items-center [--tag-chip-max:150px]"
            data-testid="tag-form-preview"
          >
            <TagChip tag={{ id: initial?.id ?? 0, name: name.trim() || "tag", color }} />
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className={`btn ${BTN_GHOST}`} onClick={onCancel}>
          Cancel
        </button>
        <Tooltip label={reason ?? undefined}>
          <button
            type="button"
            data-testid="tag-form-submit"
            disabled={reason !== null}
            className={`btn ${BTN_PRIMARY} disabled:opacity-45 disabled:cursor-default`}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function TagRow({
  tag,
  count,
  isNew,
  onEdit,
  onDelete,
}: {
  tag: TagInfo;
  count: number;
  isNew: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`group flex items-center gap-2.5 px-2.5 h-[var(--h-row)] hover:bg-[var(--hover-fill)] ${isNew ? NEW_ROW_CLS : ""}`}
      data-testid="tag-manager-row"
      data-tag-id={tag.id}
      data-tag-new={isNew ? "true" : undefined}
    >
      <span
        aria-hidden
        className="w-[8px] h-[8px] rounded-full flex-none"
        style={{ background: tag.color }}
      />
      <span className="flex-1 min-w-0 truncate text-text-primary [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)]">
        {tag.name}
      </span>
      <span className="flex-none text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tabular-nums">
        {count} session{count === 1 ? "" : "s"}
      </span>
      <Tooltip label={`Rename or recolour ${tag.name}`}>
        <button
          type="button"
          aria-label={`Edit ${tag.name}`}
          data-testid="tag-edit"
          className={ROW_ICON_BTN_CLS}
          onClick={onEdit}
        >
          <Icon glyph={IconPencil} role="label" />
        </button>
      </Tooltip>
      <Tooltip label={`Delete ${tag.name}`}>
        <button
          type="button"
          aria-label={`Delete ${tag.name}`}
          data-testid="tag-delete"
          className={`${ROW_ICON_BTN_CLS} hover:text-danger`}
          onClick={onDelete}
        >
          <Icon glyph={IconTrash} role="label" />
        </button>
      </Tooltip>
    </div>
  );
}

export function TagManager({
  open,
  tags,
  usage,
  highlight = null,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  open: boolean;
  tags: TagInfo[];
  usage: Map<number, number>;
  /** Name of a tag just made elsewhere, marked once so the eye can find it. */
  highlight?: string | null;
  onCreate: (name: string, color: string) => void;
  onUpdate: (tag: number, name: string, color: string) => void;
  onDelete: (tag: number) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TagInfo | null>(null);
  useEffect(() => {
    if (open) return;
    setEditing(null);
    setCreating(false);
    setConfirmDelete(null);
  }, [open]);
  const trapTab = useFocusTrap(
    dialogRef,
    "input:not([disabled]), button:not([disabled])",
  );
  if (!open) return null;

  const editingTag = tags.find((t) => t.id === editing) ?? null;
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    trapTab(e);
  };

  return (
    <>
      <div className={MODAL_SCRIM_CLS} onMouseDown={onClose}>
        <div
          ref={dialogRef}
          className="pop w-[420px] max-w-[92vw] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-2,0_24px_64px_rgba(0,0,0,0.55),0_2px_8px_rgba(0,0,0,0.4))] motion-safe:animate-[panel-in_var(--animate-t-panel)_var(--animate-ease-panel)] [.anim-out_&]:motion-safe:animate-[panel-out_var(--animate-t-fast)_var(--animate-ease-panel)_forwards]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-manager-title"
          data-testid="tag-manager"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <div
            className="px-3.5 py-[11px] border-b border-divider [font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] [letter-spacing:var(--tr-text-subhead-tracking)] text-text-primary"
            id="tag-manager-title"
          >
            Tags
          </div>
          <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
            <div className={HINT_CLS}>
              Tags are shared across every workspace. Attach one to a tab from its
              right-click menu, then filter the rail by it with the funnel.
            </div>
            <div className={FIELD_CLS}>
              <label className={FIELD_LABEL_CLS}>
                {tags.length === 0
                  ? "Your tags"
                  : `Your tags · ${tags.length}`}
              </label>
              {tags.length === 0 ? (
                <div className={HINT_CLS} data-testid="tag-manager-empty">
                  No tags yet — code review, wait-human, whatever you need.
                </div>
              ) : (
                <div className="flex flex-col rounded-[var(--tr-radius-button)] border border-border overflow-hidden [&>*+*]:border-t [&>*+*]:border-divider">
                  {tags.map((t) => (
                    <TagRow
                      key={t.id}
                      tag={t}
                      count={usage.get(t.id) ?? 0}
                      isNew={highlight !== null && t.name === highlight}
                      onEdit={() => {
                        setCreating(false);
                        setEditing(t.id);
                      }}
                      onDelete={() => setConfirmDelete(t)}
                    />
                  ))}
                </div>
              )}
            </div>
            {editingTag && (
              <TagForm
                initial={editingTag}
                tags={tags}
                submitLabel="Save"
                testId="tag-edit-form"
                onSubmit={(name, color) => {
                  onUpdate(editingTag.id, name, color);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            )}
            {creating && (
              <TagForm
                initial={null}
                tags={tags}
                submitLabel="Create"
                testId="tag-new-form"
                onSubmit={(name, color) => {
                  onCreate(name, color);
                  setCreating(false);
                }}
                onCancel={() => setCreating(false)}
              />
            )}
          </div>
          <div className="flex gap-2 justify-end items-center px-5 pb-5">
            <button
              type="button"
              data-testid="tag-manager-new"
              disabled={creating}
              className={`btn ${BTN_GHOST} mr-auto inline-flex items-center gap-[var(--space-1)] disabled:opacity-45 disabled:cursor-default`}
              onClick={() => {
                setEditing(null);
                setCreating(true);
              }}
            >
              <Icon glyph={IconPlus} role="ui" />
              New tag
            </button>
            <button
              type="button"
              data-testid="tag-manager-done"
              className={`btn ${BTN_PRIMARY}`}
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </div>
      </div>
      {confirmDelete && (
        <TagDeleteConfirm
          tag={confirmDelete}
          count={usage.get(confirmDelete.id) ?? 0}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            onDelete(confirmDelete.id);
            if (editing === confirmDelete.id) setEditing(null);
            setConfirmDelete(null);
          }}
        />
      )}
    </>
  );
}

function TagDeleteConfirm({
  tag,
  count,
  onConfirm,
  onCancel,
}: {
  tag: TagInfo;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <ConfirmModal
      title="DELETE TAG"
      confirmLabel="Delete"
      message={
        count === 0
          ? `Delete the tag "${tag.name}"?`
          : `"${tag.name}" is on ${count} session${count === 1 ? "" : "s"} — remove it from all of them?`
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
