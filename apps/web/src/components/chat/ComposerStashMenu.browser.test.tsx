import { useRef, useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { type PromptStashEntry } from "../../promptStashStore";
import { Dialog, DialogPopup } from "../ui/dialog";
import { ComposerStashMenu } from "./ComposerStashMenu";

function entry(id: string, overrides: Partial<PromptStashEntry> = {}): PromptStashEntry {
  return {
    id,
    createdAt: "2026-10-01T00:00:00.000Z",
    prompt: `${id} prompt`,
    attachments: [],
    droppedImageNames: [],
    ...overrides,
  };
}

function Menu({ entries }: { entries: ReadonlyArray<PromptStashEntry> }) {
  const composerFormRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={composerFormRef}>
        <textarea aria-label="Message" defaultValue="Unsent draft" />
      </form>
      <ComposerStashMenu
        composerFormRef={composerFormRef}
        entries={entries}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />
    </>
  );
}

const drawer = () => document.querySelector<HTMLElement>('[data-composer-stash-drawer="true"]')!;
const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-stash-entry]"));
const deleteCounts = () =>
  rows().map((row) => row.querySelectorAll('[aria-label="Delete stashed prompt"]').length);


function Composer({ dialog = false }: { dialog?: boolean }) {
  const composerFormRef = useRef<HTMLFormElement>(null);
  const [entries, setEntries] = useState(
    ["first", "second"].map((id) => ({
      id,
      createdAt: "2026-10-01T00:00:00.000Z",
      prompt: `${id} prompt`,
      attachments: [],
      droppedImageNames: [],
    })),
  );
  const [draft, setDraft] = useState("Unsent draft");
  const [open, setOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(dialog);
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <>
      <form ref={composerFormRef}>
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="button" onClick={() => setAnswer("Continue")}>
          Continue
        </button>
        <p role="status">{answer ? `Selected: ${answer}` : "Choose an answer"}</p>
      </form>
      <input aria-label="Search threads" />
      <button onClick={() => setOpen(true)}>Open stash</button>
      {open && (
        <ComposerStashMenu
          composerFormRef={composerFormRef}
          entries={entries}
          stashShortcutLabel="Ctrl+S"
          onRestore={(entry) => {
            setDraft(entry.prompt);
            setEntries((current) => current.filter(({ id }) => id !== entry.id));
            setOpen(false);
          }}
          onDelete={(entry) => {
            setEntries((current) => current.filter(({ id }) => id !== entry.id));
            if (entries.length === 1) setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup aria-label="Command palette">
          <input aria-label="Search commands" />
        </DialogPopup>
      </Dialog>
    </>
  );
}

const editor = () => page.getByRole("textbox", { name: "Message" });
const stash = () => page.getByRole("list", { name: "Stashed prompts" });
const press = (keys: string) => userEvent.keyboard(keys);
const focus = (element: Element) => act(async () => (element as HTMLElement).focus());

it("leaves dialog, unrelated input and question button shortcuts alone while the stash is open", async () => {
  await using _screen = await render(<Composer dialog />);
  const input = page.getByRole("textbox", { name: "Search commands" }).element();
  await focus(input);

  for (const key of [
    { key: "ArrowDown" },
    { key: "ArrowUp" },
    { key: "Enter" },
    { key: "Backspace", ctrlKey: true },
    { key: "Backspace", metaKey: true },
  ]) {
    const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented, key.key).toBe(false);
  }

  await press("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await expect.element(editor()).toHaveValue("Unsent draft");

  await focus(page.getByRole("textbox", { name: "Search threads" }).element());
  await press("{ArrowDown}{Enter}{Control>}{Backspace}{/Control}{Meta>}{Backspace}{/Meta}{Escape}");
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await expect.element(editor()).toHaveValue("Unsent draft");

  await focus(page.getByRole("button", { name: "Continue", exact: true }).element());
  await press("{Enter}");
  expect(page.getByRole("status").element().textContent).toBe("Selected: Continue");
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await press("{Control>}{Backspace}{/Control}{Meta>}{Backspace}{/Meta}");
  expect(stash().element().textContent).toContain("first prompt");
  expect(stash().element().textContent).toContain("second prompt");
  await expect.element(editor()).toHaveValue("Unsent draft");
});

it("names the drawer, its shortcut keys and every entry's attachments", async () => {
  await using _screen = await render(
    <Menu
      entries={[
        entry("first", {
          attachments: ["one", "two"].map((id) => ({
            id,
            name: `${id}.png`,
            mimeType: "image/png",
            sizeBytes: 1_024,
            dataUrl: "data:image/png;base64,AA==",
          })),
        }),
        entry("second", {
          prompt: "",
          files: ["a", "b", "c"].map((id) => ({
            id,
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 1_024,
            attachmentId: `upload-${id}`,
            environmentId: "local" as never,
          })),
        }),
      ]}
    />,
  );

  expect(drawer().textContent).toContain("Stashed prompts");
  expect(page.getByRole("button", { name: "Close stash" }).element()).toBeTruthy();
  const rowText = rows().map((row) => row.textContent);
  expect(rowText[0]).toContain("first prompt");
  expect(rowText[0]).toContain("2");
  expect(rowText[1]).toContain("(3 files)");
  expect(rowText[1]).toContain("3");
  expect(drawer().textContent).toContain("choose");
  expect(drawer().textContent).toContain("restore");
  expect(drawer().textContent).toContain("Backspace");
  expect(drawer().textContent).toContain("close");
});

it("offers Delete only on the highlighted entry", async () => {
  await using _screen = await render(
    <Menu entries={[entry("first"), entry("second")]} />,
  );

  expect(deleteCounts()).toEqual([1, 0]);

  await press("{ArrowDown}");

  expect(deleteCounts()).toEqual([0, 1]);
  expect(rows()[1]!.querySelector('[aria-label="Delete stashed prompt"]')).not.toBeNull();
});
