import type { VoiceInputState } from "@houston-app/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerSpeechMicButton, ComposerSpeechPreview } from "./ComposerSpeechButton";

const state = (phase: VoiceInputState["phase"]): VoiceInputState => ({
  phase,
  error: null,
  errorAction: null,
});

function renderMic(
  phase: VoiceInputState["phase"],
  handlers: Partial<{ onStop(): void; onSkip(): void }> = {},
) {
  return render(
    <TooltipProvider delay={0}>
      <ComposerSpeechMicButton
        inline
        state={state(phase)}
        onStart={() => {}}
        onStop={handlers.onStop ?? (() => {})}
        onCancel={() => {}}
        onSkipPostProcessing={handlers.onSkip ?? (() => {})}
      />
    </TooltipProvider>,
    { router: false },
  );
}

it("shows four bars and the clock instead of the mic glyph while recording", async () => {
  const onStop = vi.fn();
  await using _screen = await renderMic("recording", { onStop });
  const button = page.getByRole("button", { name: "Finish voice input" });
  await expect.element(button).toHaveAttribute("aria-pressed", "true");
  const bars = button.element().querySelectorAll("[data-voice-bars] > span");
  expect(bars).toHaveLength(4);
  expect(button.element().querySelector("svg")).toBeNull();
  await expect.element(page.getByText("0:00")).toBeVisible();
  await userEvent.click(button);
  expect(onStop).toHaveBeenCalledOnce();
});

it("animates the bars with transform only", async () => {
  await using _screen = await renderMic("recording");
  const bar = document.querySelector("[data-voice-bars] > span") as HTMLElement;
  const style = getComputedStyle(bar);
  expect(style.animationName).toBe("voice-bar");
  expect(style.transitionProperty).not.toMatch(/width|height/);
});

it("draws no tray row or cancel button while recording", async () => {
  await using _screen = await renderMic("recording");
  expect(document.querySelector("[data-chat-composer-speech]")).toBeNull();
  expect(page.getByRole("button", { name: "Cancel voice input" }).elements()).toHaveLength(0);
});

it("names Transcribing beside a spinner while transcribing", async () => {
  await using _screen = await renderMic("transcribing");
  await expect.element(page.getByText("Transcribing")).toBeVisible();
  expect(page.getByRole("button", { name: "Skip cleanup" }).elements()).toHaveLength(0);
});

it("keeps Skip cleanup beside the word while post-processing", async () => {
  const onSkip = vi.fn();
  await using _screen = await renderMic("post-processing", { onSkip });
  await expect.element(page.getByText("Post-processing")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Skip cleanup" }));
  expect(onSkip).toHaveBeenCalledOnce();
});

it("renders the live transcription in the muted ink after the draft", async () => {
  await using _screen = await render(
    <ComposerSpeechPreview preview={{ committed: "hello ", tentative: "wor" }} />,
    { router: false },
  );
  await expect
    .element(page.getByRole("status", { name: "Live transcription" }))
    .toHaveTextContent("hello wor");
});
