import { InlineEditField } from "../ui/inline-edit-field";

export const EMPTY_THREAD_TITLE_MESSAGE = "A thread title cannot be empty.";

/** The inline editor for a thread title on a sidebar card; an empty title is refused. */
export function ThreadTitleInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  return (
    <InlineEditField
      initialValue={title}
      label="Thread title"
      scale="title"
      emptyMessage={EMPTY_THREAD_TITLE_MESSAGE}
      onCommit={(next) => {
        onCommit(next);
        return null;
      }}
      onCancel={onCancel}
    />
  );
}
