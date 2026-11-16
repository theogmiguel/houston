import {
  EnvironmentId,
  ThreadId,
  type DesktopPreviewAnnotationVoiceEvent,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PreviewAnnotationSpeech } from "./PreviewAnnotationSpeech";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((tabId: string, event: DesktopPreviewAnnotationVoiceEvent) => void),
  update: vi.fn(async () => {}),
  speech: {
    available: true,
    state: { phase: "idle", error: null, errorAction: null },
    preview: null,
    freezesEditor: false,
    blocksSubmission: false,
    level: { subscribe: () => () => {}, getSnapshot: () => 0 },
    progress: null,
    setup: {},
    transcriptionEnvironmentId: null,
    status: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
    skipPostProcessing: vi.fn(),
  },
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    annotationVoice: {
      onEvent: (listener: typeof mocks.listener) => {
        mocks.listener = listener;
        return () => {
          mocks.listener = null;
        };
      },
      update: mocks.update,
    },
  },
}));
vi.mock("~/speech/useEnvironmentSpeechInput", () => ({
  useEnvironmentSpeechInput: () => mocks.speech,
}));
vi.mock("~/speech/useDictationShortcut", () => ({ useDictationShortcut: () => "Ctrl+Alt+V" }));
vi.mock("~/components/chat/VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null, useProject: () => null }));

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const event = (
  sessionId: string,
  action: DesktopPreviewAnnotationVoiceEvent["action"],
): DesktopPreviewAnnotationVoiceEvent => ({ sessionId, text: "note", cursor: 4, action });

it("acts only on gestures that carry this pick's session id and tab", async () => {
  mocks.speech.start.mockClear();
  mocks.speech.cancel.mockClear();
  mocks.update.mockClear();
  await using _screen = await render(
    <PreviewAnnotationSpeech
      threadRef={threadRef}
      tabId="tab-1"
      config={{ sessionId: "mine", shortcuts: [] }}
      keybindings={[]}
    />,
  );
  await act(() => {
    mocks.listener?.("tab-1", event("other", "start"));
    mocks.listener?.("tab-2", event("mine", "start"));
    mocks.listener?.("tab-1", event("other", "cancel"));
  });
  expect(mocks.speech.start).not.toHaveBeenCalled();
  expect(mocks.speech.cancel).not.toHaveBeenCalled();

  await act(() => mocks.listener?.("tab-1", event("mine", "start")));
  expect(mocks.speech.start).toHaveBeenCalledOnce();
});
