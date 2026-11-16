import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@houston-app/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { QuickComposerView } from "./QuickComposerView";
import type { QuickComposerProjectOption } from "./quickComposer.logic";

const settings = vi.hoisted(() => ({ sendShortcut: "enter" as ClientSettings["sendShortcut"] }));

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (value: ClientSettings) => unknown) => {
    const value = { ...DEFAULT_CLIENT_SETTINGS, sendShortcut: settings.sendShortcut };
    return selector ? selector(value) : value;
  }) as never,
}));

function useSendShortcut(sendShortcut: ClientSettings["sendShortcut"]): Disposable {
  settings.sendShortcut = sendShortcut;
  return {
    [Symbol.dispose]: () => {
      settings.sendShortcut = "enter";
    },
  };
}

const projects: ReadonlyArray<QuickComposerProjectOption> = [
  {
    key: "env:houston",
    environmentId: "env" as QuickComposerProjectOption["environmentId"],
    projectId: "houston" as QuickComposerProjectOption["projectId"],
    title: "Houston",
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
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Fix the flaky test" }));
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

it("starts the thread on Enter with the default send shortcut", async () => {
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  const { screen } = screenFor(onSubmit);
  await using _mounted = await screen;
  await typePrompt("Fix the flaky test");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("keeps Enter as a line break and starts the thread on Ctrl+Enter when the send shortcut is Ctrl+Enter", async () => {
  using _shortcut = useSendShortcut("mod-enter");
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  const { screen } = screenFor(onSubmit);
  await using _mounted = await screen;
  await typePrompt("Fix the flaky test");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Ctrl/Cmd+Enter starts the thread");
});
