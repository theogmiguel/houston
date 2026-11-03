import type { VoiceInputState } from "@houston-app/client-runtime/voice-input";
import { MicIcon, MicOffIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useNavigate } from "@tanstack/react-router";
import type { useEnvironmentSpeechInput } from "~/speech/useEnvironmentSpeechInput";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RecordingStatus } from "../ui/voice-waveform";

type SpeechPresentation = {
  status: string | null;
  showsConfirm: boolean;
  confirmEnabled: boolean;
};

export function resolveSpeechPresentation(
  state: VoiceInputState<true>,
  progress: { downloaded: number; total: number } | null,
): SpeechPresentation {
  switch (state.phase) {
    case "idle":
      return { status: null, showsConfirm: false, confirmEnabled: false };
    case "error":
      return {
        status: state.error ?? "Voice input failed",
        showsConfirm: false,
        confirmEnabled: false,
      };
    case "preparing":
      return {
        status: progress
          ? `Downloading speech model ${Math.round((progress.downloaded / Math.max(1, progress.total)) * 100)}%`
          : "Preparing",
        showsConfirm: true,
        confirmEnabled: false,
      };
    case "recording":
      return { status: "Recording", showsConfirm: true, confirmEnabled: true };
    case "transcribing":
      return { status: "Transcribing", showsConfirm: true, confirmEnabled: false };
    case "post-processing":
      return { status: "Post-processing", showsConfirm: true, confirmEnabled: false };
  }
}

function ComposerSpeechStatus(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  level: number;
}) {
  const presentation = resolveSpeechPresentation(props.state, props.progress);
  if (!presentation.status) return null;
  const isRecording = props.state.phase === "recording";
  const isError = props.state.phase === "error";

  return (
    <div
      className="flex min-h-7 min-w-0 flex-1 items-center justify-end gap-2"
      role="status"
      aria-live={isRecording ? "off" : "polite"}
      aria-label={presentation.status}
    >
      {isRecording ? (
        <RecordingStatus level={props.level} />
      ) : (
        <Text as="span" tone={isError ? "danger" : "muted"} truncate={!isError} className="min-w-0">
          {presentation.status}
        </Text>
      )}
    </div>
  );
}

function ComposerSpeechCancelButton(props: {
  state: VoiceInputState<true>;
  shortcutLabel?: string | null;
  onCancel(): void;
}) {
  if (props.state.phase === "idle") return null;
  const label = props.state.phase === "error" ? "Dismiss voice input error" : "Cancel voice input";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onCancel}
            className="shrink-0"
          >
            <XIcon />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A disabled mic whose tooltip says why voice input is off here. */
export function ComposerSpeechUnavailableMic(props: { reason: string }) {
  return (
    <Tooltip>
      {/* A span trigger keeps the reason reachable on hover while the button is disabled. */}
      <TooltipTrigger render={<span className="flex h-full" />}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled
          aria-label={`Voice input unavailable: ${props.reason}`}
          className="shrink-0"
        >
          <MicOffIcon />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/** The dictation mic beside the composer's send button. */
export function ComposerSpeechMicButton(props: {
  state: VoiceInputState<true>;
  shortcutLabel?: string | null;
  disabled?: boolean;
  onStart(): void;
  onStop(): void;
  onCancel(): void;
}) {
  const navigate = useNavigate();
  const { phase } = props.state;
  const openSettings = phase === "error" && props.state.errorAction === "settings";
  const isRecording = phase === "recording";
  const isBusy = phase === "preparing" || phase === "transcribing" || phase === "post-processing";
  const label = openSettings
    ? "Open voice settings"
    : isRecording
      ? "Finish voice input"
      : phase === "preparing"
        ? "Cancel voice input"
        : isBusy
          ? "Transcribing"
          : "Start voice input";
  const showShortcut = (phase === "idle" || phase === "error" || isRecording) && !openSettings;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={isRecording}
            data-listening={isRecording || undefined}
            disabled={(props.disabled && phase === "idle") || phase === "transcribing"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (openSettings) {
                props.onCancel();
                void navigate({ to: "/settings/voice" });
              } else if (isRecording) {
                props.onStop();
              } else if (phase === "preparing") {
                props.onCancel();
              } else if (!isBusy) {
                props.onStart();
              }
            }}
            className="shrink-0"
          >
            {isBusy ? <Spinner size="sm" /> : <MicIcon />}
          </Button>
        }
      />
      <TooltipPopup side="top">
        {label}
        {showShortcut && props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Live transcript and voice status under the composer prompt while dictating. */
export function ComposerSpeechTray(props: {
  state: VoiceInputState<true>;
  progress: { downloaded: number; total: number } | null;
  level: ReturnType<typeof useEnvironmentSpeechInput>["level"];
  preview: { committed: string; tentative: string } | null;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  const level = useSyncExternalStore(props.level.subscribe, props.level.getSnapshot);
  if (props.state.phase === "idle" && !props.preview) return null;
  return (
    <div data-chat-composer-speech="true" className="flex flex-col gap-1 px-3 pb-2 sm:px-4">
      {props.preview ? (
        <div
          aria-label="Live transcription"
          className="max-h-32 overflow-y-auto"
          role="status"
          aria-live="polite"
        >
          <Text as="p" preserve breakWords>
            {props.preview.committed}
            <Text as="span" tone="muted">
              {props.preview.tentative}
            </Text>
          </Text>
        </div>
      ) : null}
      {props.state.phase === "idle" ? null : (
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <ComposerSpeechStatus state={props.state} progress={props.progress} level={level} />
          {props.state.phase === "post-processing" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onSkipPostProcessing}
            >
              Skip cleanup
            </Button>
          ) : null}
          <ComposerSpeechCancelButton
            state={props.state}
            shortcutLabel="Esc"
            onCancel={props.onCancel}
          />
        </div>
      )}
    </div>
  );
}
