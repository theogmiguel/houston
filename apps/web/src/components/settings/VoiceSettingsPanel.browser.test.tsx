import { PrimaryConnectionTarget } from "@houston-app/client-runtime/connection";
import {
  EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "../../hooks/useSettings";
import {
  useEnvironmentSpeechInput,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";
import { toastManager } from "../ui/toast";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

vi.mock(import("../../speech/useEnvironmentSpeechInput"), { spy: true });

type SpeechInput = ReturnType<typeof useEnvironmentSpeechInput>;
type Destination = ReturnType<typeof useVoiceTranscriptionDestination>;

function connect(id: string) {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make(id),
    label: "Test environment",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null };
  const destination = {
    environmentId: target.environmentId,
    label: target.label,
    grantId: "test",
    needsDestination: false,
    refusal: null,
    prepared,
  } as unknown as Destination;
  return { target, destination };
}

const baseModel: EnvironmentSpeechModel = {
  id: "tiny",
  name: "Tiny",
  description: "",
  size: 100,
  languages: ["en"],
  accuracy: 1,
  speed: 1,
  recommended: false,
  supportsStreaming: false,
  supportsTranslation: false,
  supportsLanguageDetection: false,
  active: true,
  state: "installed",
};

function readyStatus(model: EnvironmentSpeechModel, extra: object = {}) {
  return {
    supported: true,
    state: "ready",
    modelId: model.id,
    model: model.name,
    size: model.size,
    supportsStreaming: false,
    supportsTranslation: false,
    acceleration: "cpu",
    modelUnloadTimeout: "never",
    gpuDevices: [],
    ...extra,
  } satisfies EnvironmentSpeechStatus;
}

function voiceApi(
  status: object,
  models: (url: URL) => Response | Promise<Response>,
): ReturnType<typeof vi.spyOn> {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, window.location.href);
    if (url.pathname === "/api/voice/status") return Promise.resolve(Response.json(status));
    if (url.pathname === "/api/voice/models") return Promise.resolve(models(url));
    return original(input, init);
  });
}

const scoped = (key = "panel") => (
  <SettingsScopeProvider search={{}} onChange={() => {}}>
    <VoiceSettingsPanel key={key} />
  </SettingsScopeProvider>
);

it("preserves the model test transcript when its model is filtered out", async () => {
  const { target, destination } = connect("voice-filter");
  const status = readyStatus(baseModel);
  using _network = voiceApi(status, (url) =>
    Response.json({
      models: [
        baseModel,
        {
          ...baseModel,
          id: "both",
          name: "Bilingual",
          active: false,
          languages: ["en", "fr"],
          ...(url.searchParams.has("benchmarks")
            ? {
                benchmark: {
                  accuracy: {
                    en: { grade: "A-", errorPercent: 4 },
                    fr: { grade: "B+", errorPercent: 5.5 },
                  },
                  secondsPer30s: 2.1,
                },
              }
            : {}),
        },
      ],
    }),
  );
  const transcript = "Keep this transcript.";
  await vi.mocked(useVoiceTranscriptionDestination).withImplementation(
    () => destination,
    async () => {
      await vi.mocked(useEnvironmentSpeechInput).withImplementation(
        (input) =>
          ({
            available: true,
            status,
            transcriptionEnvironmentId: target.environmentId,
            transcriptionEnvironmentLabel: target.label,
            setup: {
              open: false,
              step: 0,
              model: null,
              downloading: false,
              cancelled: false,
              error: null,
              setOpen: () => {},
              download: async () => {},
              cancelDownload: async () => {},
              startRecording: async () => {},
            },
            state: { phase: "idle", error: null, errorAction: null },
            preview: null,
            level: { getSnapshot: () => 0, subscribe: () => () => {} },
            preparing: false,
            blocksSubmission: false,
            freezesEditor: false,
            start: async () => {
              input.commitDraft(transcript, { start: transcript.length, end: transcript.length });
            },
            submitAfterDictation: () => {},
            stop: async () => {},
            cancel: () => {},
            skipPostProcessing: () => {},
          }) as unknown as SpeechInput,
        async () => {
          await using screen = await render(scoped());
          const testModel = screen.getByRole("button", { name: "Test model", exact: true });
          await expect.element(testModel).toBeVisible();
          await userEvent.click(testModel);
          const result = screen.getByRole("status", { name: "Test transcript" });
          await expect.element(result).toHaveTextContent(transcript);

          const search = screen.getByRole("textbox", { name: "Search transcription models" });
          await userEvent.fill(search, "no matching model");
          await expect.element(screen.getByText("No models match.")).toBeVisible();
          await userEvent.clear(search);
          await userEvent.fill(screen.getByRole("textbox", { name: "Search languages" }), "fr");
          const french = screen.getByRole("button", { name: "French", exact: true });
          await userEvent.click(french);
          await expect.element(screen.getByText("Bilingual", { exact: true })).toBeVisible();
          await expect.element(screen.getByText("B+", { exact: true })).toBeVisible();
          expect(screen.container.querySelector("#transcription-test")).toHaveAttribute("hidden");
          await userEvent.click(french);
          await expect.element(result).toBeVisible();
          await vi.waitFor(() =>
            expect(
              screen.container.querySelector('[aria-label="Test transcript"]')?.textContent,
            ).toBe(transcript),
          );
        },
      );
    },
  );
});

it("recovers from a failed download progress poll without notifying, but reports a failed initial load", async () => {
  const { destination } = connect("voice-progress");
  const model = { ...baseModel, active: false, state: "downloading" as const };
  const unavailable = () => new Response(null, { status: 503 });
  const readModels = vi
    .fn((_withBenchmarks: boolean) => unavailable())
    .mockImplementationOnce(() => Response.json({ models: [model] }))
    .mockImplementationOnce(unavailable)
    .mockImplementationOnce(() => Response.json({ models: [{ ...model, state: "installed" }] }));
  using _network = voiceApi({ ...readyStatus(model), state: "missing-model" }, (url) =>
    readModels(url.searchParams.has("benchmarks")),
  );
  using notify = vi.spyOn(toastManager, "add").mockReturnValue("test");
  await vi.mocked(useVoiceTranscriptionDestination).withImplementation(
    () => destination,
    async () => {
      await using screen = await render(scoped("first"));
      await expect.element(screen.getByRole("button", { name: "Use model" })).toBeVisible();
      expect(readModels.mock.calls.map(([withBenchmarks]) => withBenchmarks)).toEqual([
        true,
        false,
        false,
      ]);
      expect(notify).not.toHaveBeenCalled();
      await screen.rerender(scoped("reopened"));
      await vi.waitFor(() =>
        expect(notify).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Could not load transcription models" }),
        ),
      );
    },
  );
});

it("names a selected model that is no longer in the catalog and the default it fell back to", async () => {
  const { destination } = connect("voice-fallback");
  const fallback = { ...baseModel, id: "default", name: "Default Model" };
  using _network = voiceApi(readyStatus(fallback, { unavailableModelId: "retired/model-q8" }), () =>
    Response.json({ models: [fallback] }),
  );
  await vi.mocked(useVoiceTranscriptionDestination).withImplementation(
    () => destination,
    async () => {
      await using screen = await render(scoped());
      const notice = screen.getByRole("status").filter({ hasText: "retired/model-q8" });
      await expect.element(notice).toBeVisible();
      const text = notice.element().textContent;
      expect(text).toContain("Default Model");
      expect(text).toContain("no longer available");
    },
  );
});

it.each([
  ["speech-models", "voice-transcription-destination"],
  ["local-voice-input", "voice-transcription-destination"],
  ["transcription-environment", "voice-transcription-destination"],
  ["speech-hardware", "voice-transcription-destination"],
  ["transcription-test", "voice-transcription-destination"],
  ["speech-correction-word", "speech-post-processing"],
  ["speech-post-processing-model", "speech-post-processing"],
])(
  "searching for disabled %s focuses its opt-in without enabling it",
  async (target, prerequisite) => {
    window.localStorage.clear();
    chooseAudioDestination(null);
    chooseTranscriptCleanup(false);
    await using screen = await render(scoped(), { router: `/#${target}` });
    await vi.waitFor(() => expect(document.activeElement?.id).toBe(prerequisite));
    await expect
      .element(screen.getByRole("combobox", { name: "Transcribe with" }))
      .toHaveTextContent("Off");
    await expect
      .element(screen.getByRole("switch", { name: "Clean up transcripts with a provider" }))
      .not.toBeChecked();
  },
);

it("keeps a missing destination selected without claiming it cannot transcribe", async () => {
  __setClientSettingsForTests(getClientSettings());
  using cleanup = new DisposableStack();
  cleanup.defer(() => chooseAudioDestination(null));
  chooseAudioDestination({ kind: "environment", environmentId: EnvironmentId.make("missing") });
  await using screen = await render(scoped());
  await expect
    .element(screen.getByRole("combobox", { name: "Transcribe with" }))
    .toHaveTextContent("Chosen environment (unavailable)");
  await expect.element(screen.getByText(/can't transcribe audio/)).not.toBeInTheDocument();
});

it("shows the model's effective language and restores the saved preference when supported again", async () => {
  const previous = getClientSettings();
  using cleanup = new DisposableStack();
  cleanup.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...previous, speechLanguage: "fr" });
  await using screen = await render(<SpeechLanguageSelect model={{ languages: ["en"] }} />);
  const picker = screen.getByRole("combobox", { name: "Transcription language" });
  await expect.element(picker).toHaveTextContent("English (French unavailable)");
  await screen.rerender(
    <SpeechLanguageSelect model={{ languages: ["en", "de"], supportsLanguageDetection: true }} />,
  );
  await expect.element(picker).toHaveTextContent("Auto-detect (French unavailable)");
  await screen.rerender(<SpeechLanguageSelect model={{ languages: ["en", "fr"] }} />);
  await expect.element(picker).toHaveTextContent("French");
  expect(getClientSettings().speechLanguage).toBe("fr");
});

it("keeps punctuation in a saved dictionary term and its alias", async () => {
  const previous = getClientSettings();
  using cleanup = new DisposableStack();
  cleanup.defer(() => __setClientSettingsForTests(previous));
  __setClientSettingsForTests({ ...previous, speechCustomWords: [] });
  await using screen = await render(scoped());
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add a word or phrase to the dictionary" }),
    "O'Reilly{Enter}",
  );
  expect(getClientSettings().speechCustomWords[0]?.term).toBe("O'Reilly");
  await userEvent.click(screen.getByRole("button", { name: "Add an alias for O'Reilly" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Alias for O'Reilly" }),
    '"Oh Really"{Enter}',
  );
  expect(getClientSettings().speechCustomWords).toEqual([
    { term: "O'Reilly", aliases: ['"Oh Really"'] },
  ]);
});

it("refuses a dictionary addition past the entry limit, naming the limit, the count and the request", async () => {
  const previous = getClientSettings();
  using cleanup = new DisposableStack();
  cleanup.defer(() => __setClientSettingsForTests(previous));
  const full = Array.from({ length: 99 }, (_, index) => ({ term: `term${index}`, aliases: [] }));
  __setClientSettingsForTests({ ...previous, speechCustomWords: full });
  await using screen = await render(scoped());
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add a word or phrase to the dictionary" }),
    "alpha, beta{Enter}",
  );
  const alert = screen.getByRole("alert");
  await expect.element(alert).toBeVisible();
  const text = alert.element().textContent;
  for (const part of ['"alpha, beta"', "101 entries", "at most 100", "has 99"])
    expect(text).toContain(part);
  expect(getClientSettings().speechCustomWords).toHaveLength(99);
  await userEvent.clear(
    screen.getByRole("textbox", { name: "Add a word or phrase to the dictionary" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Add a word or phrase to the dictionary" }),
    "alpha{Enter}",
  );
  expect(getClientSettings().speechCustomWords).toHaveLength(100);
});
