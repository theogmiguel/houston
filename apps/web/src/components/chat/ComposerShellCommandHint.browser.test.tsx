import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerShellCommandHint } from "./ComposerShellCommandHint";

it("names the terminal as the target while the draft starts with !", async () => {
  await using _screen = await render(<ComposerShellCommandHint status="run" />);

  await expect
    .element(page.getByText("Runs in the terminal; not sent to the agent."))
    .toBeVisible();
});

it("shows nothing for an ordinary draft", async () => {
  await using screen = await render(<ComposerShellCommandHint status={null} />);

  expect(screen.container.textContent).toBe("");
});

it("explains what the thread is missing when it has no terminal", async () => {
  await using _screen = await render(
    <ComposerShellCommandHint
      status="unavailable"
      unavailableReason="A shell command needs a started thread. Send a message first."
    />,
  );

  await expect
    .element(page.getByText("A shell command needs a started thread. Send a message first."))
    .toBeVisible();
});
