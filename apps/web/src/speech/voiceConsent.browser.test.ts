import { EnvironmentId, type VoiceTranscriptionDestination } from "@houston-app/contracts";
import { expect, it } from "vite-plus/test";

import {
  bindAudioGrant,
  chooseAudioDestination,
  pendingCloudAudioChoice,
  readAudioGrant,
} from "./voiceConsent";

const environmentId = EnvironmentId.make("voice-host");
const local: VoiceTranscriptionDestination = { kind: "environment", environmentId };
const openai: VoiceTranscriptionDestination = { kind: "cloud", environmentId, provider: "openai" };
const xai: VoiceTranscriptionDestination = { kind: "cloud", environmentId, provider: "xai" };

const isolatedConsent = (): Disposable => ({
  [Symbol.dispose]() {
    chooseAudioDestination(null);
    window.localStorage.clear();
  },
});

it("keeps the previous destination until a cloud choice is acknowledged", () => {
  using _consent = isolatedConsent();
  chooseAudioDestination(local);
  const before = readAudioGrant();
  expect(before?.destination).toEqual(local);

  const acknowledge = pendingCloudAudioChoice(openai);
  expect(readAudioGrant()).toEqual(before);
  expect(bindAudioGrant(before!.id)()).toBe(true);

  acknowledge();
  expect(readAudioGrant()?.destination).toEqual(openai);
  expect(readAudioGrant()?.id).not.toBe(before!.id);
  expect(bindAudioGrant(before!.id)()).toBe(false);
});

it("never opts in a device that had no destination until the save is acknowledged", () => {
  using _consent = isolatedConsent();
  chooseAudioDestination(null);
  const acknowledge = pendingCloudAudioChoice(openai);
  expect(readAudioGrant()).toBeNull();
  acknowledge();
  expect(readAudioGrant()?.destination).toEqual(openai);
});

it("turning dictation Off during a save wins over the late acknowledgement", () => {
  using _consent = isolatedConsent();
  chooseAudioDestination(local);
  const acknowledge = pendingCloudAudioChoice(openai);
  chooseAudioDestination(null);
  acknowledge();
  expect(readAudioGrant()).toBeNull();
});

it("a late acknowledgement cannot activate a choice another save replaced", () => {
  using _consent = isolatedConsent();
  chooseAudioDestination(null);
  const first = pendingCloudAudioChoice(openai);
  const second = pendingCloudAudioChoice(xai);
  first();
  expect(readAudioGrant()).toBeNull();
  second();
  expect(readAudioGrant()?.destination).toEqual(xai);
});

it("binds a recording to the grant it started under, even when the same destination is reselected", () => {
  using _consent = isolatedConsent();
  chooseAudioDestination(openai);
  const grant = readAudioGrant()!;
  const stillGranted = bindAudioGrant(grant.id);
  expect(stillGranted()).toBe(true);
  chooseAudioDestination(openai);
  expect(stillGranted()).toBe(false);
});

it("leaves no acknowledgement marker behind once its choice is replaced", () => {
  using _consent = isolatedConsent();
  const acknowledge = pendingCloudAudioChoice(openai);
  acknowledge();
  expect(Object.keys(window.localStorage).filter((key) => key.includes(":saved:"))).toHaveLength(1);
  chooseAudioDestination(null);
  expect(Object.keys(window.localStorage).filter((key) => key.includes(":saved:"))).toHaveLength(0);
});
