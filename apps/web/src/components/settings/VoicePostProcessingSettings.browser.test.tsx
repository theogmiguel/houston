import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { VoicePostProcessingSettings } from "./VoicePostProcessingSettings";

const state = vi.hoisted(() => ({ cleanupEnabled: false }));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    environment: null,
    connectedEnvironments: [],
    target: null,
  })) as never,
}));
vi.mock(import("./useScopedModelAvailability"), () => ({
  useScopedModelDisabledReason: (() => () => null) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    speechPostProcessingEnabled: state.cleanupEnabled,
  })) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));

describe("VoicePostProcessingSettings advanced rows", () => {
  it("disables the correction cue and cleanup instructions while transcript cleanup is off", async () => {
    state.cleanupEnabled = false;
    await using screen = await render(<VoicePostProcessingSettings advanced />);

    await expect.element(screen.getByLabelText("Explicit correction cue")).toBeDisabled();
    await expect.element(screen.getByLabelText("Voice post-processing prompt")).toBeDisabled();
  });

  it("enables them once transcript cleanup is on", async () => {
    state.cleanupEnabled = true;
    await using screen = await render(<VoicePostProcessingSettings advanced />);

    await expect.element(screen.getByLabelText("Explicit correction cue")).toBeEnabled();
    await expect.element(screen.getByLabelText("Voice post-processing prompt")).toBeEnabled();
  });
});
