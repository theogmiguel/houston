import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly current: ReadonlyArray<string>;
  readonly resolve: (tags: ReadonlyArray<string> | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Edits a thread's tags as one comma-separated list. Resolves null when dismissed. */
export function requestThreadTags(
  current: ReadonlyArray<string>,
): Promise<ReadonlyArray<string> | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { current, resolve } }));
}

function finish(tags: ReadonlyArray<string> | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(tags);
}

export function ThreadTagsDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- resolves a pending tag edit with null when the host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ThreadTagsDialog /> : null;
}

const MAX_TAG_LENGTH = 64;

function parseTags(value: string): ReadonlyArray<string> | string {
  const tags = [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
  const tooLong = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (tooLong !== undefined) {
    return `A tag must be at most ${MAX_TAG_LENGTH} characters; "${tooLong}" is ${tooLong.length}.`;
  }
  const multiline = tags.find((tag) => /[\p{Cc}]/u.test(tag));
  if (multiline !== undefined) {
    return "A tag must be a single line of text.";
  }
  return tags;
}

function ThreadTagsDialog() {
  const request = useRequest((state) => state.request)!;
  const id = useId();
  const [value, setValue] = useState(request.current.join(", "));
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const tags = parseTags(value);
            if (typeof tags === "string") {
              setError(tags);
              return;
            }
            finish(tags);
          }}
        >
          <DialogHeader>
            <DialogTitle>Thread tags</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-tags`}>Tags</Label>
              <Input
                id={`${id}-tags`}
                autoFocus
                value={value}
                placeholder="private, demo"
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
              <p>Separate tags with commas. Tags match exactly, ignoring case and outer spaces.</p>
              {error === null ? null : <p>{error}</p>}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Save tags</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
