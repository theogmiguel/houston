import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { QuickComposerView } from "./QuickComposerView";
import type { QuickComposerProjectOption } from "./quickComposer.logic";

const projects: ReadonlyArray<QuickComposerProjectOption> = [
  {
    key: "env:houston",
    environmentId: "env" as QuickComposerProjectOption["environmentId"],
    projectId: "houston" as QuickComposerProjectOption["projectId"],
    title: "Houston",
    grids: [{ id: "grid-1", name: "Grid 1" }],
  },
];

function screenFor(onSubmit: Parameters<typeof QuickComposerView>[0]["onSubmit"]) {
  const onClose = vi.fn();
  return {
    onClose,
    screen: render(
      <QuickComposerView
        projects={projects}
        initialProjectKey={projects[0]!.key}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    ),
  };
}

async function typePrompt(prompt: string) {
  const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  expect(editor, "the quick composer renders the shared prompt editor").not.toBeNull();
  await userEvent.click(editor!);
  await userEvent.type(editor!, prompt);
}

it("closes the window when the server accepts the thread", async () => {
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  const { screen, onClose } = screenFor(onSubmit);
  await using _mounted = await screen;
  await typePrompt("Fix the flaky test");
  const start = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Start thread",
  );
  expect(start).toBeDefined();
  await act(async () => start!.click());
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: "Fix the flaky test", gridId: null }),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the text and shows the server's reason when it refuses", async () => {
  const onSubmit = vi.fn().mockResolvedValue({
    ok: false,
    message: "Provider refused the request: credentials rejected.",
  });
  const { screen, onClose } = screenFor(onSubmit);
  await using _mounted = await screen;
  await typePrompt("Fix the flaky test");
  const start = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Start thread",
  );
  expect(start).toBeDefined();
  await act(async () => start!.click());
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("credentials rejected");
  expect(document.querySelector('[data-testid="composer-editor"]')?.textContent).toContain(
    "Fix the flaky test",
  );
});
