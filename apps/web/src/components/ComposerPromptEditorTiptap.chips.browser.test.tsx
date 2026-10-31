import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { createRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { render } from "../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

function Composer({ value }: { value: string }) {
  const [prompt, setPrompt] = useState(value);
  return (
    <>
      <output data-prompt={prompt} />
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={prompt}
        cursor={prompt.length}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={(next) => setPrompt(next)}
        onPaste={() => {}}
      />
    </>
  );
}

async function promptAfterRemoval(label: string) {
  await using screen = await render(
    <Composer
      value={`Summarize ${formatInlineContextReference({
        kind: "thread",
        contextId: "thread_notes",
        label: "Release notes",
      })} now`}
    />,
  );
  const remove = screen.getByRole("button", { name: label });
  await expect.element(remove).toBeVisible();
  await userEvent.click(remove.element());
  return screen.container.querySelector("output")?.dataset.prompt;
}

it("removes a context chip from the draft", async () => {
  expect(await promptAfterRemoval("Remove context: Release notes")).toBe("Summarize now");
});

it("keeps a citation out of the prompt text while retaining its record", async () => {
  await using screen = await render(
    <Composer value={`See ${serializeAssistantCitation(citation)} `} />,
  );
  const chip = screen.container.querySelector<HTMLElement>('[data-composer-citation-chip="true"]');
  expect(chip).not.toBeNull();
  expect(getComputedStyle(chip!).display).toBe("none");
  expect(screen.container.querySelector("output")?.dataset.prompt).toContain("hello");
});
