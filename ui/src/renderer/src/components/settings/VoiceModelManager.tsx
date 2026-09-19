import { useEffect, useRef, useState } from 'react'
import { Row } from '../settingsPrimitives'
import { BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER } from '../buttonChrome'
import { useVoiceLevel } from '../../voice/store'
import { DEFAULT_RMS_FLOOR } from '../../houston/generated/DEFAULTS'
import type { VoiceModelState } from '../../houston/generated/VoiceModelState'
import type { VoiceSettings } from '../../houston/generated/VoiceSettings'

export interface VoiceModelRosterProps {
  voiceModels: VoiceModelState[]
  selectedModelId: string | null
  onVoiceModelDownload: (modelId: string) => void
  onVoiceModelDelete: (modelId: string) => void
}

export interface VoiceLevelMeterProps {
  voiceSettings: Pick<VoiceSettings, 'enabled' | 'rms_floor'>
  onRmsFloorSet: (rmsFloor: number) => void
  onVoiceLevelMonitor: (enabled: boolean) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function VoiceModelRow({
  model,
  selected,
  onDownload,
  onDelete
}: {
  model: VoiceModelState
  selected: boolean
  onDownload: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const status = model.status
  const cooldown = model.cooldown_remaining_ms ?? null
  const coolingCopy =
    cooldown === null
      ? ''
      : ` Repeated failures — the next attempt is allowed in ${Math.ceil(cooldown / 1000)}s.`
  let desc: string
  let action: React.ReactNode = null
  let danger = false
  if (status.kind === 'downloading') {
    desc = `Downloading — ${Math.round(status.progress * 100)}% of ${formatBytes(model.size_bytes)}. The file is verified against its SHA-256 before it is installed.`
    action = (
      <button type="button" className={`btn ${BTN_GHOST}`} disabled>
        Downloading…
      </button>
    )
  } else if (status.kind === 'downloaded') {
    desc = `Installed — ${formatBytes(status.size_bytes)} on disk.${selected ? ' This is the model dictation uses.' : ''}`
    action = (
      <button
        type="button"
        className={`btn ${BTN_GHOST} ${BTN_GHOST_DANGER_HOVER} ${confirmDelete ? BTN_GHOST_DANGER_ARM : ''}`}
        data-testid="settings-voice-model-delete"
        onClick={() => {
          if (confirmDelete) {
            setConfirmDelete(false)
            onDelete()
          } else {
            setConfirmDelete(true)
          }
        }}
        onBlur={() => setConfirmDelete(false)}
      >
        {confirmDelete ? 'Click again to delete' : `Delete (frees ${formatBytes(status.size_bytes)})`}
      </button>
    )
  } else if (status.kind === 'failed') {
    danger = true
    desc = `${status.reason}${coolingCopy}`
    action = (
      <button
        type="button"
        className={`btn ${BTN_GHOST}`}
        disabled={cooldown !== null}
        data-testid="settings-voice-model-download"
        onClick={onDownload}
      >
        Download again
      </button>
    )
  } else {
    desc = `Not downloaded — ${formatBytes(model.size_bytes)} to fetch. Dictation refuses to start without it and says so.${coolingCopy}`
    action = (
      <button
        type="button"
        className={`btn ${BTN_GHOST}`}
        disabled={cooldown !== null}
        data-testid="settings-voice-model-download"
        onClick={onDownload}
      >
        Download
      </button>
    )
  }
  return (
    <Row title={model.display_name} desc={danger ? undefined : desc} indent>
      <div className="flex flex-col items-end gap-1">
        {action}
        {danger && (
          <div className="max-w-[280px] text-right [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--danger)]">
            {desc}
          </div>
        )}
      </div>
    </Row>
  )
}

export function VoiceModelRoster({
  voiceModels,
  selectedModelId,
  onVoiceModelDownload,
  onVoiceModelDelete
}: VoiceModelRosterProps): React.JSX.Element {
  return (
    <>
      {voiceModels.map((m) => (
        <VoiceModelRow
          key={m.id}
          model={m}
          selected={selectedModelId === m.id}
          onDownload={() => onVoiceModelDownload(m.id)}
          onDelete={() => onVoiceModelDelete(m.id)}
        />
      ))}
    </>
  )
}

export function VoiceLevelMeter({
  voiceSettings,
  onRmsFloorSet,
  onVoiceLevelMonitor
}: VoiceLevelMeterProps): React.JSX.Element {
  const voiceLevel = useVoiceLevel()
  const onVoiceLevelMonitorRef = useRef(onVoiceLevelMonitor)
  onVoiceLevelMonitorRef.current = onVoiceLevelMonitor
  useEffect(() => {
    if (!voiceSettings.enabled) return
    let open = false
    const sync = (): void => {
      const want = document.visibilityState !== 'hidden'
      if (want === open) return
      open = want
      onVoiceLevelMonitorRef.current(want)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      if (open) onVoiceLevelMonitorRef.current(false)
    }
  }, [voiceSettings.enabled])

  return (
    <>
      <Row
        title="Voice detection"
        desc={
          voiceSettings.enabled
            ? 'Set the marker just under where the bar settles while you speak — audio under it counts as noise, so too far right drops speech silently. The mic is live while this page is open.'
            : 'Turn dictation on to see the live level. Audio quieter than the marker is treated as room noise and never transcribed.'
        }
      >
        <div className="w-[200px] flex flex-col gap-1.5">
          <div
            className="relative h-2 rounded-full overflow-hidden bg-[color-mix(in_srgb,var(--text-muted)_22%,transparent)]"
            data-testid="settings-voice-meter"
            aria-hidden
          >
            <div
              className="h-full w-full origin-left [transition:transform_60ms_linear]"
              style={{
                transform: `scaleX(${Math.min(1, (voiceLevel ?? 0) / 0.5)})`,
                background:
                  (voiceLevel ?? 0) >= voiceSettings.rms_floor
                    ? 'var(--success, #4ade80)'
                    : 'var(--text-muted)'
              }}
            />
            <div
              className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-[var(--text-primary)]"
              style={{
                left: `${Math.min(100, (voiceSettings.rms_floor / 0.5) * 100)}%`
              }}
            />
          </div>
          <input
            type="range"
            className="w-full"
            data-testid="settings-voice-rms-floor"
            min={0}
            max={0.25}
            step={0.001}
            value={voiceSettings.rms_floor}
            onChange={(e) => onRmsFloorSet(Number(e.target.value))}
          />
          <div className="flex items-center justify-between [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)] tabular-nums">
            <span>
              threshold {voiceSettings.rms_floor.toFixed(3)}
              {voiceSettings.rms_floor === DEFAULT_RMS_FLOOR ? ' (default)' : ''}
            </span>
            {voiceSettings.rms_floor === DEFAULT_RMS_FLOOR ? (
              <span>{voiceLevel === null ? 'no signal' : voiceLevel.toFixed(3)}</span>
            ) : (
              <button
                type="button"
                className={`btn ${BTN_GHOST} px-1.5 py-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]`}
                onClick={() => onRmsFloorSet(DEFAULT_RMS_FLOOR)}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </Row>
    </>
  )
}
