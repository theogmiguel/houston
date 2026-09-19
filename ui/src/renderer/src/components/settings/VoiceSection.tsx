import { useEffect, useRef, useState } from 'react'
import { BTN_GHOST } from '../buttonChrome'
import { dictationShortcut, effectiveLabel } from '../../keymap'
import type { KeymapOverrides } from '../../houston/client'
import { setSettingsSection } from '../../settingsNav'
import { useVoicePageError } from '../../voice/store'
import { Select } from '../Select'
import { Toggle } from '../settingsPrimitives'
import { VoiceLevelMeter, VoiceModelRoster } from './VoiceModelManager'
import type { CloudStt } from '../../houston/generated/CloudStt'
import type { VoiceDevice } from '../../houston/generated/VoiceDevice'
import type { VoiceModelState } from '../../houston/generated/VoiceModelState'
import type { VoiceSettings } from '../../houston/generated/VoiceSettings'
import { Row, SectionHead, SubHead } from './shared'

const DEFAULT_VOICE_MODEL_ID = 'ggml-small'

// Mirrors voice/capture.rs's MAX_UTTERANCE_SECS (300s) — keep the two in sync.
const VOICE_MAX_UTTERANCE_MINUTES = 5

const VOICE_VOCABULARY_PLACEHOLDER =
  'Houston, HoustonSwarm, pane, workspace, Claude, Codex, MCP, tsx, bun'

const VOICE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'pt', label: 'Portuguese' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' }
]

type VoiceEngine = VoiceSettings['engine'] | undefined

function voiceEngineState(
  voiceSettings: VoiceSettings | null,
  voiceModels: VoiceModelState[],
  voiceCloudKeyPresent: boolean
): {
  voiceEngine: VoiceEngine
  voiceModelLabel: string
  voiceEngineReady: boolean | undefined
} {
  const voiceEngine = voiceSettings?.engine
  const voiceLocalModel =
    voiceEngine?.kind === 'local' ? voiceModels.find((m) => m.id === voiceEngine.model_id) : undefined
  const voiceModelLabel = voiceLocalModel?.display_name ?? 'selected'
  const voiceEngineReady =
    voiceSettings?.engine.kind === 'cloud'
      ? voiceCloudKeyPresent
      : voiceLocalModel?.status.kind === 'downloaded'
  return { voiceEngine, voiceModelLabel, voiceEngineReady }
}

function dictationEnabledDesc(
  enabled: boolean,
  voiceEngineReady: boolean | undefined,
  voiceEngine: VoiceEngine,
  voiceModelLabel: string
): string {
  if (!enabled) return 'Off. Nothing is recorded, no microphone is opened, and none is opened at startup.'
  if (voiceEngineReady) {
    return 'On. Turning this off closes the microphone stream immediately — nothing is held open while dictation is off.'
  }
  if (voiceEngine?.kind === 'local') {
    return `On, but nothing can be transcribed yet — the ${voiceModelLabel} model is not downloaded, so holding the key will be refused. Download it below.`
  }
  return 'On, but nothing can be transcribed yet — the cloud engine has no API key, so holding the key will be refused. Add one below.'
}

function voiceDeviceOptions(
  voiceDevices: VoiceDevice[],
  currentDevice: string | null | undefined
): { value: string; label: string }[] {
  const known = voiceDevices.map((d) => ({
    value: d.id,
    label: `${d.label}${d.is_default ? ' (default)' : ''}`
  }))
  const missing =
    currentDevice != null && !voiceDevices.some((d) => d.id === currentDevice)
      ? [{ value: currentDevice, label: `${currentDevice} (not present)` }]
      : []
  return [{ value: '', label: 'System default' }, ...known, ...missing]
}

function VoiceNotReadyBanner({
  voiceEngine,
  voiceModelLabel
}: {
  voiceEngine: VoiceEngine
  voiceModelLabel: string
}): React.JSX.Element {
  return (
    <div
      data-testid="settings-voice-not-ready"
      className="mb-[10px] rounded-[8px] border border-[var(--warning)] bg-[var(--card-bg)] px-3 py-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.45] text-[var(--warning)]"
    >
      Dictation is on but cannot run yet:{' '}
      {voiceEngine?.kind === 'local'
        ? `the ${voiceModelLabel} model is not downloaded.`
        : 'the cloud engine has no API key.'}{' '}
      Holding the dictation key will be refused until that is fixed.
    </div>
  )
}

function VoiceKeyRow({
  voiceKeyringError,
  voiceCloudKeyPresent,
  onVoiceKeySet,
  onVoiceKeyClear
}: {
  voiceKeyringError: string | null
  voiceCloudKeyPresent: boolean
  onVoiceKeySet: (provider: CloudStt, key: string) => void
  onVoiceKeyClear: (provider: CloudStt) => void
}): React.JSX.Element {
  const [voiceKeyDraft, setVoiceKeyDraft] = useState('')
  return (
    <Row
      title="Groq API key"
      desc={
        voiceKeyringError
          ? `Your OS keychain is not answering, so Houston cannot tell whether a key is stored: ${voiceKeyringError}. Saving a key now would not stick — fix the keychain first.`
          : voiceCloudKeyPresent
            ? 'Key set. Stored in your OS keychain, never in Houston’s settings — the mask below is a placeholder. Type a new key to replace it'
            : 'No key. Without one the cloud engine never reaches the network; dictation refuses to start and says so.'
      }
      indent
    >
      <div
        className="flex items-center gap-2"
        data-testid="voice-key-row"
        data-keyring={voiceKeyringError ? 'unreachable' : 'ok'}
      >
        <input
          type="password"
          className="w-[200px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[5px] px-2"
          spellCheck={false}
          autoComplete="off"
          aria-label="Groq API key"
          placeholder={voiceCloudKeyPresent && !voiceKeyringError ? '••••••••••••••••' : 'gsk_…'}
          value={voiceKeyDraft}
          onChange={(e) => setVoiceKeyDraft(e.target.value)}
        />
        <button
          type="button"
          className={`btn ${BTN_GHOST}`}
          disabled={voiceKeyDraft.trim() === ''}
          onClick={() => {
            onVoiceKeySet('groq', voiceKeyDraft.trim())
            setVoiceKeyDraft('')
          }}
        >
          Save key
        </button>
        <button
          type="button"
          className={`btn ${BTN_GHOST}`}
          disabled={!voiceCloudKeyPresent}
          onClick={() => onVoiceKeyClear('groq')}
        >
          Remove key
        </button>
      </div>
    </Row>
  )
}

function VoiceEngineGroup({
  voiceSettings,
  voiceModels,
  voiceEngine,
  voiceEngineReady,
  voiceModelLabel,
  voiceCloudKeyPresent,
  voiceKeyringError,
  onVoiceSettingsSet,
  onVoiceModelDownload,
  onVoiceModelDelete,
  onVoiceKeySet,
  onVoiceKeyClear
}: {
  voiceSettings: VoiceSettings
  voiceModels: VoiceModelState[]
  voiceEngine: VoiceEngine
  voiceEngineReady: boolean | undefined
  voiceModelLabel: string
  voiceCloudKeyPresent: boolean
  voiceKeyringError: string | null
  onVoiceSettingsSet: (settings: VoiceSettings) => void
  onVoiceModelDownload: (modelId: string) => void
  onVoiceModelDelete: (modelId: string) => void
  onVoiceKeySet: (provider: CloudStt, key: string) => void
  onVoiceKeyClear: (provider: CloudStt) => void
}): React.JSX.Element {
  return (
    <>
      <Row
        title="Enable dictation"
        desc={dictationEnabledDesc(voiceSettings.enabled, voiceEngineReady, voiceEngine, voiceModelLabel)}
      >
        <Toggle
          on={voiceSettings.enabled}
          onChange={(v) => onVoiceSettingsSet({ ...voiceSettings, enabled: v })}
        />
      </Row>
      <Row
        title="Engine"
        desc="Local runs offline. Cloud is better at Brazilian Portuguese, but sends your audio to Groq."
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-engine"
          value={voiceSettings.engine.kind}
          options={[
            { value: 'local', label: 'Local (whisper.cpp, offline)' },
            { value: 'cloud', label: 'Cloud (Groq whisper-large-v3)' }
          ]}
          onChange={(v) =>
            onVoiceSettingsSet({
              ...voiceSettings,
              engine:
                v === 'cloud'
                  ? { kind: 'cloud', provider: 'groq' }
                  : { kind: 'local', model_id: DEFAULT_VOICE_MODEL_ID }
            })
          }
        />
      </Row>
      {voiceSettings.engine.kind === 'local' && (
        <VoiceModelRoster
          voiceModels={voiceModels}
          selectedModelId={voiceSettings.engine.kind === 'local' ? voiceSettings.engine.model_id : null}
          onVoiceModelDownload={onVoiceModelDownload}
          onVoiceModelDelete={onVoiceModelDelete}
        />
      )}
      {voiceSettings.engine.kind === 'cloud' && (
        <VoiceKeyRow
          voiceKeyringError={voiceKeyringError}
          voiceCloudKeyPresent={voiceCloudKeyPresent}
          onVoiceKeySet={onVoiceKeySet}
          onVoiceKeyClear={onVoiceKeyClear}
        />
      )}
      <Row
        title="Output"
        desc="Original transcribes what you said; English translates in the same pass."
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-output"
          value={voiceSettings.output_mode}
          options={[
            { value: 'original', label: 'Original (as spoken)' },
            { value: 'english', label: 'English (translated)' }
          ]}
          onChange={(v) =>
            onVoiceSettingsSet({ ...voiceSettings, output_mode: v as VoiceSettings['output_mode'] })
          }
        />
      </Row>
      <Row
        title="Tell the agent it is a translation"
        desc={
          voiceSettings.output_mode === 'english'
            ? 'Prefixes each pane’s first dictation with a note saying the text is translated Portuguese and the reply should come back in PT-BR — nothing is written to the agent’s own config.'
            : 'Only applies with Output set to English — under Original there is no translation to declare.'
        }
        indent
      >
        <Toggle
          on={voiceSettings.agent_preamble}
          disabled={voiceSettings.output_mode !== 'english'}
          onChange={(v) => onVoiceSettingsSet({ ...voiceSettings, agent_preamble: v })}
        />
      </Row>
    </>
  )
}

function VoiceCaptureGroup({
  voiceSettings,
  voiceDevices,
  keymapOverrides,
  onVoiceSettingsSet,
  onVoiceLevelMonitor,
  onVoiceDevicesRefresh
}: {
  voiceSettings: VoiceSettings
  voiceDevices: VoiceDevice[]
  keymapOverrides: KeymapOverrides
  onVoiceSettingsSet: (settings: VoiceSettings) => void
  onVoiceLevelMonitor: (enabled: boolean) => void
  onVoiceDevicesRefresh: () => void
}): React.JSX.Element {
  return (
    <>
      <Row
        title="Activation"
        desc={`Hold records while the key is down; Toggle uses separate presses, capped at ${VOICE_MAX_UTTERANCE_MINUTES} min.`}
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-capture-mode"
          value={voiceSettings.capture_mode}
          options={[
            { value: 'hold', label: 'Hold to talk' },
            { value: 'toggle', label: 'Toggle on / off' }
          ]}
          onChange={(v) =>
            onVoiceSettingsSet({ ...voiceSettings, capture_mode: v as VoiceSettings['capture_mode'] })
          }
        />
      </Row>
      <Row
        title="Dictation key"
        desc={`${effectiveLabel(dictationShortcut, keymapOverrides)} while a terminal has focus. Rebind it in Shortcuts.`}
      >
        <button type="button" className={`btn ${BTN_GHOST}`} onClick={() => setSettingsSection('shortcuts')}>
          Open Shortcuts
        </button>
      </Row>
      <Row
        title="Microphone"
        desc={
          voiceSettings.mic_policy === 'persistent'
            ? 'Held open the whole time dictation is enabled, so recording starts with no clipped first syllable. Closes when dictation is turned off, never opens at startup, and records nothing until you hold the key.'
            : 'Opened only while the key is held — nothing is held open, but the slower start can clip the first syllable.'
        }
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-mic-policy"
          value={voiceSettings.mic_policy}
          options={[
            { value: 'persistent', label: 'Held open while enabled' },
            { value: 'on_keypress', label: 'Opened on keypress' }
          ]}
          onChange={(v) =>
            onVoiceSettingsSet({ ...voiceSettings, mic_policy: v as VoiceSettings['mic_policy'] })
          }
        />
      </Row>
      <VoiceLevelMeter
        voiceSettings={voiceSettings}
        onRmsFloorSet={(rmsFloor) => onVoiceSettingsSet({ ...voiceSettings, rms_floor: rmsFloor })}
        onVoiceLevelMonitor={onVoiceLevelMonitor}
      />
      <Row
        title="Input device"
        desc={
          voiceDevices.length === 0
            ? 'Nothing enumerated yet — Refresh asks the audio host. An unplugged device reads as unavailable, never silently swapped.'
            : 'An unplugged device reads as unavailable, never silently swapped.'
        }
      >
        <div className="flex items-center gap-2">
          <Select
            className="w-[200px]"
            data-testid="settings-voice-device"
            value={voiceSettings.input_device ?? ''}
            options={voiceDeviceOptions(voiceDevices, voiceSettings.input_device)}
            onChange={(v) => onVoiceSettingsSet({ ...voiceSettings, input_device: v === '' ? null : v })}
          />
          <button type="button" className={`btn ${BTN_GHOST}`} onClick={onVoiceDevicesRefresh}>
            Refresh
          </button>
        </div>
      </Row>
      <Row
        title="Spoken language"
        desc="Auto-detect works; pinning a language is better for short utterances."
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-language"
          value={voiceSettings.input_language ?? ''}
          options={[
            { value: '', label: 'Auto-detect' },
            ...VOICE_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))
          ]}
          onChange={(v) => onVoiceSettingsSet({ ...voiceSettings, input_language: v === '' ? null : v })}
        />
      </Row>
      <Row
        title="Insertion"
        desc="Direct pastes at the prompt; Enter stays yours. Confirm first waits for you."
      >
        <Select
          className="w-[200px]"
          data-testid="settings-voice-insert-mode"
          value={voiceSettings.insert_mode}
          options={[
            { value: 'direct', label: 'Direct' },
            { value: 'confirm_first', label: 'Confirm first' }
          ]}
          onChange={(v) =>
            onVoiceSettingsSet({ ...voiceSettings, insert_mode: v as VoiceSettings['insert_mode'] })
          }
        />
      </Row>
      <Row
        title="Vocabulary"
        desc="Product names and jargon the model would otherwise mishear. Comma-separated."
      >
        <textarea
          className="w-[240px] bg-[var(--content-bg)] border border-[var(--border)] rounded-md text-[var(--text-primary)] font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] py-[6px] px-2 resize-y"
          rows={3}
          spellCheck={false}
          aria-label="Vocabulary"
          placeholder={VOICE_VOCABULARY_PLACEHOLDER}
          value={voiceSettings.vocabulary}
          onChange={(e) => onVoiceSettingsSet({ ...voiceSettings, vocabulary: e.target.value })}
        />
      </Row>
    </>
  )
}

export interface VoiceSectionProps {
  voiceSettings: VoiceSettings | null
  voiceCloudKeyPresent: boolean
  voiceKeyringError: string | null
  voiceModels: VoiceModelState[]
  voiceDevices: VoiceDevice[]
  onVoiceLevelMonitor: (enabled: boolean) => void
  onVoiceSettingsSet: (settings: VoiceSettings) => void
  onVoiceKeySet: (provider: CloudStt, key: string) => void
  onVoiceKeyClear: (provider: CloudStt) => void
  onVoiceDevicesRefresh: () => void
  onVoiceModelDownload: (modelId: string) => void
  onVoiceModelDelete: (modelId: string) => void
  keymapOverrides: KeymapOverrides
}

export function VoiceSection({
  voiceSettings,
  voiceCloudKeyPresent,
  voiceKeyringError,
  voiceModels,
  voiceDevices,
  onVoiceLevelMonitor,
  onVoiceSettingsSet,
  onVoiceKeySet,
  onVoiceKeyClear,
  onVoiceDevicesRefresh,
  onVoiceModelDownload,
  onVoiceModelDelete,
  keymapOverrides
}: VoiceSectionProps): React.JSX.Element {
  const voicePageError = useVoicePageError()
  const { voiceEngine, voiceModelLabel, voiceEngineReady } = voiceEngineState(
    voiceSettings,
    voiceModels,
    voiceCloudKeyPresent
  )
  const voiceDevicesRefreshRef = useRef(onVoiceDevicesRefresh)
  voiceDevicesRefreshRef.current = onVoiceDevicesRefresh
  useEffect(() => {
    voiceDevicesRefreshRef.current()
  }, [])

  return (
    <>
      <SectionHead
        title="Dictation"
        lede={
          <>
            Hold a key, speak, release — the text lands at the focused pane&apos;s prompt with a
            trailing space and is never submitted for you. Transcription runs on this machine by
            default; the cloud engine is opt-in and needs a key.
          </>
        }
      />
      {voiceSettings?.enabled && !voiceEngineReady && (
        <VoiceNotReadyBanner voiceEngine={voiceEngine} voiceModelLabel={voiceModelLabel} />
      )}
      {voicePageError && (
        <div
          data-testid="settings-voice-error"
          className="mb-[10px] rounded-[8px] border border-[var(--danger)] bg-[var(--card-bg)] px-3 py-2 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.45] text-[var(--danger)]"
        >
          {voicePageError}
        </div>
      )}
      <div className="">
        {voiceSettings === null ? (
          <Row title="Loading…" desc="Asking the daemon for the Voice settings." />
        ) : (
          <>
            <SubHead>Engine</SubHead>
            <VoiceEngineGroup
              voiceSettings={voiceSettings}
              voiceModels={voiceModels}
              voiceEngine={voiceEngine}
              voiceEngineReady={voiceEngineReady}
              voiceModelLabel={voiceModelLabel}
              voiceCloudKeyPresent={voiceCloudKeyPresent}
              voiceKeyringError={voiceKeyringError}
              onVoiceSettingsSet={onVoiceSettingsSet}
              onVoiceModelDownload={onVoiceModelDownload}
              onVoiceModelDelete={onVoiceModelDelete}
              onVoiceKeySet={onVoiceKeySet}
              onVoiceKeyClear={onVoiceKeyClear}
            />
            <SubHead>Capture</SubHead>
            <VoiceCaptureGroup
              voiceSettings={voiceSettings}
              voiceDevices={voiceDevices}
              keymapOverrides={keymapOverrides}
              onVoiceSettingsSet={onVoiceSettingsSet}
              onVoiceLevelMonitor={onVoiceLevelMonitor}
              onVoiceDevicesRefresh={onVoiceDevicesRefresh}
            />
          </>
        )}
      </div>
    </>
  )
}
