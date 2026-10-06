import { useEffect, useRef, useState } from "react";
import type { TagInfo } from "../houston/generated/TagInfo";
import { MAX_TAG_NAME_LEN } from "../houston/generated/DEFAULTS";
import { ConfirmModal } from "./ConfirmModal";
import { Icon } from "./ui/Icon";
import { IconPencil, IconPlus, IconTrash } from "./icons";
import { Tooltip } from "./ui/Tooltip";
import { useFocusTrap } from "./dialogFocus";
import { TagChip } from "./tags";
import { TagColorPicker, tagRejection } from "./tagEditing";
import {
  TagFieldGroup,
  TagFieldLabel,
  TagFormActions,
  TagFormPreview,
  TagHint,
  TagList,
  TagListName,
  TagListRow,
  TagListUsage,
  TagRowIconButton,
  TagTextInput,
} from "./ui/TagList";
import { TagSwatchDot } from "./ui/TagSwatch";
import { Button, DialogActions, DialogBackdrop, DialogBody, DialogPanel, DialogTitle } from "./ui";

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
    <TagFieldGroup data-testid={testId}>
      <TagFieldLabel>
        {initial ? `Editing ${initial.name}` : "New tag"}
      </TagFieldLabel>
      <TagTextInput
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
      />
      <TagColorPicker color={color} onPick={setColor} />
      {reason !== null && name.trim() !== "" && (
        <TagHint role="status">{reason}</TagHint>
      )}
      <TagFormActions>
        {color !== null && (
          <TagFormPreview>
            <TagChip tag={{ id: initial?.id ?? 0, name: name.trim() || "tag", color }} />
          </TagFormPreview>
        )}
        <span className="flex-1" />
        <Button type="button" variant="legacy-ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Tooltip label={reason ?? undefined}>
          <Button
            type="button"
            data-testid="tag-form-submit"
            disabled={reason !== null}
            variant="legacy-primary"
            onClick={submit}
          >
            {submitLabel}
          </Button>
        </Tooltip>
      </TagFormActions>
    </TagFieldGroup>
  );
}

export interface TagUsage {
  panes: number;
  grids: number;
}

const NO_USAGE: TagUsage = { panes: 0, grids: 0 };

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function usageText(u: TagUsage, joiner = ", "): string {
  if (u.grids === 0) return plural(u.panes, "pane");
  if (u.panes === 0) return plural(u.grids, "grid");
  return `${plural(u.panes, "pane")}${joiner}${plural(u.grids, "grid")}`;
}

function TagRow({
  tag,
  count,
  isNew,
  onEdit,
  onDelete,
}: {
  tag: TagInfo;
  count: TagUsage;
  isNew: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <TagListRow
      isNew={isNew}
      data-testid="tag-manager-row"
      data-tag-id={tag.id}
      data-tag-new={isNew ? "true" : undefined}
    >
      <TagSwatchDot color={tag.color} size="row" />
      <TagListName>{tag.name}</TagListName>
      <TagListUsage>{usageText(count)}</TagListUsage>
      <Tooltip label={`Rename or recolour ${tag.name}`}>
        <TagRowIconButton aria-label={`Edit ${tag.name}`} data-testid="tag-edit" onClick={onEdit}>
          <Icon glyph={IconPencil} role="label" />
        </TagRowIconButton>
      </Tooltip>
      <Tooltip label={`Delete ${tag.name}`}>
        <TagRowIconButton danger aria-label={`Delete ${tag.name}`} data-testid="tag-delete" onClick={onDelete}>
          <Icon glyph={IconTrash} role="label" />
        </TagRowIconButton>
      </Tooltip>
    </TagListRow>
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
  usage: Map<number, TagUsage>;
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
      <DialogBackdrop onMouseDown={onClose}>
        <DialogPanel
          size="medium"
          surface="raised"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-manager-title"
          data-testid="tag-manager"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          <DialogTitle border="divider" id="tag-manager-title">
            Tags
          </DialogTitle>
          <DialogBody variant="bounded">
            <TagHint>
              Tags are shared across every workspace. Attach one to a tab from its
              right-click menu, then filter the rail by it with the funnel.
            </TagHint>
            <TagFieldGroup>
              <TagFieldLabel>
                {tags.length === 0
                  ? "Your tags"
                  : `Your tags · ${tags.length}`}
              </TagFieldLabel>
              {tags.length === 0 ? (
                <TagHint data-testid="tag-manager-empty">
                  No tags yet — code review, wait-human, whatever you need.
                </TagHint>
              ) : (
                <TagList>
                  {tags.map((t) => (
                    <TagRow
                      key={t.id}
                      tag={t}
                      count={usage.get(t.id) ?? NO_USAGE}
                      isNew={highlight !== null && t.name === highlight}
                      onEdit={() => {
                        setCreating(false);
                        setEditing(t.id);
                      }}
                      onDelete={() => setConfirmDelete(t)}
                    />
                  ))}
                </TagList>
              )}
            </TagFieldGroup>
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
          </DialogBody>
          <DialogActions variant="row">
            <Button
              type="button"
              data-testid="tag-manager-new"
              disabled={creating}
              variant="legacy-ghost"
              className="gap-[var(--space-1)]"
              onClick={() => {
                setEditing(null);
                setCreating(true);
              }}
            >
              <Icon glyph={IconPlus} role="ui" />
              New tag
            </Button>
            <span className="flex-1" />
            <Button
              type="button"
              data-testid="tag-manager-done"
              variant="legacy-primary"
              onClick={onClose}
            >
              Done
            </Button>
          </DialogActions>
        </DialogPanel>
      </DialogBackdrop>
      {confirmDelete && (
        <TagDeleteConfirm
          tag={confirmDelete}
          count={usage.get(confirmDelete.id) ?? NO_USAGE}
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
  count: TagUsage;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <ConfirmModal
      title="DELETE TAG"
      confirmLabel="Delete"
      message={
        count.panes + count.grids === 0
          ? `Delete the tag "${tag.name}"?`
          : `"${tag.name}" is on ${usageText(count, " and ")} — remove it from all of them?`
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
