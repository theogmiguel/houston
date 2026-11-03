import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
} from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { VoiceModelDownloadProgress } from "../ui/voice-model-download-progress";

export function VoiceInputSetup(props: {
  environmentId: EnvironmentId | null;
  open: boolean;
  step: number;
  status: EnvironmentSpeechStatus | null;
  model: EnvironmentSpeechModel | null;
  downloading: boolean;
  cancelled: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onDownload(): void;
  onCancelDownload(): void;
  onStartRecording(): void;
}) {
  const navigate = useNavigate();
  const popupRef = useRef<HTMLDivElement>(null);
  const environment = useEnvironment(props.environmentId);
  const selectedMicrophone = useClientSettings((settings) => settings.voiceMicrophone);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const refreshMicrophones = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoadingMicrophones(true);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === "audioinput"));
      setMicrophoneError(null);
    } catch {
      setMicrophoneError("Could not list microphones. You can still use the system default.");
    }
    setLoadingMicrophones(false);
  };
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Enumerate hardware microphones when the setup dialog reaches its device step.
  useEffect(() => {
    if (!props.open || props.step !== 1) return;
    queueMicrotask(() => void refreshMicrophones());
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);
    return () => mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
  }, [props.open, props.step, refreshMicrophones]);
  const selectedIsUnavailable = Boolean(
    selectedMicrophone && !microphones.some((device) => device.deviceId === selectedMicrophone),
  );
  const selectedMicrophoneLabel = selectedMicrophone
    ? (microphones.find((device) => device.deviceId === selectedMicrophone)?.label ??
      "Selected microphone (Unavailable)")
    : "System default";
  const status = props.status?.supported ? props.status : null;
  const model = props.model;
  const openSettings = (hash: string) => {
    props.onOpenChange(false);
    void navigate({ to: "/settings/voice", hash });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Focus the dialog itself: the mic keeps the composer focused, so a button focused on open
          would inherit its keyboard focus ring after a click. Tab reaches the actions. */}
      <WizardPopup ref={popupRef} initialFocus={popupRef}>
        <WizardHeader
          title="Set up voice input"
          description={`Transcribe speech on ${environment?.label ?? "your transcription environment"} and use voice input across environments.`}
        >
          <WizardSteps steps={["Model", "Ready to dictate"]} currentStep={props.step} />
        </WizardHeader>
        <WizardPanel>
          {props.step === 0 ? (
            <section className="space-y-3">
              <Card>
                <div className="flex items-center justify-between gap-2">
                  <Text as="h3" weight="medium">
                    {status?.model ?? "English transcription model"}
                  </Text>
                  {status?.modelId === "handy-computer/parakeet-unified-en-0.6b-gguf" ? (
                    <Text as="span" variant="caption" tone="accent">
                      Recommended for English
                    </Text>
                  ) : null}
                </div>
                <Text as="p" tone="muted" className="mt-2">
                  Download the {status ? Math.round(status.size / 1024 / 1024) : 697} MB model to{" "}
                  {environment?.label ?? "your transcription environment"}. Microphone audio is sent
                  there for transcription. You can choose another environment in Voice settings.
                </Text>
                {props.downloading && status ? (
                  <div className="mt-4">
                    <VoiceModelDownloadProgress model={model} size={status.size} />
                  </div>
                ) : props.cancelled && !props.error ? (
                  <div className="mt-3">
                    <Text variant="caption" tone="muted" as="p" role="status">
                      Download cancelled. You can start again.
                    </Text>
                  </div>
                ) : null}
              </Card>
              {props.error ? (
                <Text variant="body" tone="danger" as="p" role="alert">
                  {props.error}
                </Text>
              ) : null}
            </section>
          ) : (
            <section className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="voice-setup-microphone">
                  <Text as="span" weight="medium">
                    Microphone
                  </Text>
                </label>
                <div className="flex items-center gap-2">
                  <Select
                    value={selectedMicrophone ? `device:${selectedMicrophone}` : "system-default"}
                    disabled={loadingMicrophones}
                    onValueChange={(value) => {
                      if (value)
                        void updateClientSettings({
                          voiceMicrophone:
                            value === "system-default" ? "" : value.slice("device:".length),
                        });
                    }}
                  >
                    <SelectTrigger
                      id="voice-setup-microphone"
                      size="sm"
                      aria-label="Microphone"
                      className="min-w-0 flex-1"
                    >
                      <SelectValue>{selectedMicrophoneLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="system-default">System default</SelectItem>
                      {selectedIsUnavailable ? (
                        <SelectItem value={`device:${selectedMicrophone}`}>
                          Selected microphone (Unavailable)
                        </SelectItem>
                      ) : null}
                      {microphones.map((device, index) => (
                        <SelectItem key={device.deviceId} value={`device:${device.deviceId}`}>
                          {device.label || `Microphone ${index + 1}`}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={loadingMicrophones}
                    aria-label="Refresh microphones"
                    onClick={() => void refreshMicrophones()}
                  >
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
                {selectedIsUnavailable ? (
                  <Text as="p" variant="caption" tone="danger">
                    The selected microphone is unavailable. Choose another or use the system
                    default.
                  </Text>
                ) : null}
                {microphoneError ? (
                  <Text as="p" role="alert" variant="caption" tone="muted">
                    {microphoneError}
                  </Text>
                ) : null}
              </div>
              <Text as="p" tone="muted">
                Speak and transcribe in multiple languages or translate into English, get names and
                technical terms right with the dictionary, fix recurring misspellings, and correct
                yourself as you speak.
              </Text>
            </section>
          )}
        </WizardPanel>
        <WizardFooter>
          {props.step === 0 ? (
            <>
              <Button variant="secondary" onClick={() => openSettings("local-voice-input")}>
                Choose another model or language
              </Button>
              {props.downloading ? (
                <Button variant="secondary" onClick={props.onCancelDownload}>
                  Cancel download
                </Button>
              ) : null}
              {!props.downloading ? (
                <Button disabled={!status} onClick={props.onDownload}>
                  {props.error ? "Retry download" : "Download model"}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => openSettings("")}>
                Customize in Voice settings
              </Button>
              <Button onClick={props.onStartRecording}>Start dictating</Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
