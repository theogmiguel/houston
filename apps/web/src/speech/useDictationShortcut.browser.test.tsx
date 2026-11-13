import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@houston-app/shared/keybindings";
import type { VoiceInputState } from "@houston-app/client-runtime/voice-input";

import { act, render } from "../../test/render";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

function createSpeech() {
  return {
    available: true,
    state: { phase: "idle", error: null, errorAction: null } as VoiceInputState,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}
function Editors({
  main,
  comment,
  showComment = true,
}: {
  main: ReturnType<typeof createSpeech>;
  comment: ReturnType<typeof createSpeech>;
  showComment?: boolean;
}) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: main,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return (
    <>
      <textarea aria-label="Main" />
      {showComment ? <Comment speech={comment} /> : null}
    </>
  );
}
function Comment({ speech }: { speech: ReturnType<typeof createSpeech> }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: ref,
  });
  return <textarea ref={ref} aria-label="Comment" />;
}
const key = (type: "keydown" | "keyup", value = "v") =>
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key: value,
      code: value === "v" ? "KeyV" : "Escape",
      ctrlKey: value === "v",
      altKey: value === "v",
      bubbles: true,
      cancelable: true,
    }),
  );

function setup() {
  settings.mode = "toggle";
  const main = createSpeech();
  const comment = createSpeech();
  return {
    main,
    comment,
    view: (props?: { key?: string; showComment?: boolean; background?: boolean }) => (
      <BackgroundThreadContext value={props?.background ?? false}>
        <Editors
          main={main}
          comment={comment}
          key={props?.key}
          showComment={props?.showComment ?? true}
        />
      </BackgroundThreadContext>
    ),
  };
}

it("dictates into the focused comment instead of the main composer", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.comment.start).toHaveBeenCalledOnce();
  expect(fixture.main.start).not.toHaveBeenCalled();
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.main.start).toHaveBeenCalledOnce();
});

function Pane({
  speech,
  ownsWindowShortcuts,
}: {
  speech: ReturnType<typeof createSpeech>;
  ownsWindowShortcuts: boolean;
}) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    ownsWindowShortcuts,
  });
  return null;
}

it("dictates into the focused layout pane, not the first pane mounted", async () => {
  settings.mode = "toggle";
  const first = createSpeech();
  const focused = createSpeech();
  await using _screen = await render(
    <>
      <Pane speech={first} ownsWindowShortcuts={false} />
      <Pane speech={focused} ownsWindowShortcuts />
    </>,
  );
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(focused.start).toHaveBeenCalledOnce();
  expect(first.start).not.toHaveBeenCalled();
});

it("a focused comment still takes dictation over the focused layout pane", async () => {
  settings.mode = "toggle";
  const pane = createSpeech();
  const comment = createSpeech();
  await using screen = await render(
    <>
      <Pane speech={pane} ownsWindowShortcuts />
      <Comment speech={comment} />
    </>,
  );
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(pane.start).not.toHaveBeenCalled();
});

it("stops and cancels the recording owner even after focus moves", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  fixture.comment.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(fixture.view());
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
    key("keydown", "Escape");
  });
  expect(fixture.comment.stop).toHaveBeenCalledOnce();
  expect(fixture.comment.cancel).toHaveBeenCalledOnce();
  expect(fixture.main.start).not.toHaveBeenCalled();
});

it("finishes hold dictation on release", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.comment.start).toHaveBeenCalledOnce();
  expect(fixture.comment.stop).toHaveBeenCalledOnce();
});

it("leaves dictation and Escape to the modal over a background thread", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view({ background: true }));
  await act(() => {
    expect(key("keydown")).toBe(true);
    key("keyup");
  });
  expect(fixture.main.start).not.toHaveBeenCalled();
  fixture.main.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(fixture.view({ background: true }));
  await act(() => {
    expect(key("keydown")).toBe(true);
    expect(key("keydown", "Escape")).toBe(true);
  });
  expect(fixture.main.stop).not.toHaveBeenCalled();
  expect(fixture.main.cancel).not.toHaveBeenCalled();
  await screen.rerender(fixture.view());
  await act(() => key("keydown"));
  expect(fixture.main.stop).toHaveBeenCalledOnce();
});

it("finishes a held recording after its thread moves behind a modal", async () => {
  const fixture = setup();
  settings.mode = "hold";
  await using screen = await render(fixture.view());
  await act(() => key("keydown"));
  await screen.rerender(fixture.view({ background: true }));
  await act(() => key("keyup"));
  expect(fixture.main.start).toHaveBeenCalledOnce();
  expect(fixture.main.stop).toHaveBeenCalledOnce();
});

it("does not stop a later session when the editor closes during preparation", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  let resolve!: () => void;
  fixture.comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  await screen.rerender(fixture.view({ showComment: false }));
  await act(async () => resolve());
  expect(fixture.comment.stop).not.toHaveBeenCalled();
});

it("does not finish a new recording when a cancelled hold start resolves", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  let resolve!: () => void;
  fixture.comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  fixture.comment.state = { phase: "preparing", error: null, errorAction: null };
  await act(() => key("keydown", "Escape"));
  fixture.comment.state = { phase: "idle", error: null, errorAction: null };
  await act(() => key("keydown"));
  await act(async () => resolve());
  expect(fixture.comment.start).toHaveBeenCalledTimes(2);
  expect(fixture.comment.cancel).toHaveBeenCalledOnce();
  expect(fixture.comment.stop).not.toHaveBeenCalled();
});

function Single({ speech }: { speech: ReturnType<typeof createSpeech> }) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return null;
}

it("leaves the browser shortcut alone when dictation is unavailable", async () => {
  settings.mode = "toggle";
  const speech = { ...createSpeech(), available: false };
  await using _screen = await render(<Single speech={speech} />);
  expect(key("keydown")).toBe(true);
  expect(speech.start).not.toHaveBeenCalled();
});

it("stops on a new press when the OS omitted keyup, but ignores autorepeat", async () => {
  settings.mode = "toggle";
  const speech = createSpeech();
  await using screen = await render(<Single speech={speech} />);
  expect(key("keydown")).toBe(false);
  expect(speech.start).toHaveBeenCalledOnce();
  speech.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(<Single speech={{ ...speech }} />);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      altKey: true,
      repeat: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(speech.stop).not.toHaveBeenCalled();
  key("keydown");
  expect(speech.stop).toHaveBeenCalledOnce();
});

it("finishes a released hold after startup even if the chord was pressed again while preparing", async () => {
  settings.mode = "hold";
  const speech = createSpeech();
  let finishStart!: () => void;
  speech.start.mockReturnValue(
    new Promise<void>((resolve) => {
      finishStart = resolve;
    }),
  );
  await using screen = await render(<Single speech={speech} />);
  key("keydown");
  speech.state = { phase: "preparing", error: null, errorAction: null };
  await screen.rerender(<Single speech={{ ...speech }} />);
  key("keyup");
  key("keydown");
  key("keyup");
  await act(async () => finishStart());
  expect(speech.start).toHaveBeenCalledOnce();
  expect(speech.stop).toHaveBeenCalledOnce();
});

function PreviewChord({
  speech,
  previewFocus,
}: {
  speech: ReturnType<typeof createSpeech>;
  previewFocus: boolean;
}) {
  useDictationShortcut({
    // The chord is bound only where a preview editor has the keyboard.
    keybindings: compileResolvedKeybindingsConfig([
      { key: "mod+alt+v", command: "composer.dictation", when: "previewFocus && editableFocus" },
    ]),
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    previewFocus,
  });
  return null;
}

it("leaves a preview-only chord alone without previewFocus", async () => {
  settings.mode = "toggle";
  const speech = createSpeech();
  await using _screen = await render(<PreviewChord speech={speech} previewFocus={false} />);
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(speech.start).not.toHaveBeenCalled();
});

it("resolves the chord as an editable preview focus under previewFocus", async () => {
  settings.mode = "toggle";
  const speech = createSpeech();
  await using _screen = await render(<PreviewChord speech={speech} previewFocus />);
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(speech.start).toHaveBeenCalledOnce();
});
