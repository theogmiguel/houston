import { useEffect, useRef, useState } from 'react'
import { Row } from '../ui/settingsPrimitives'
import { Button, LevelThresholdControl, Text, Stack } from '../ui'
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
      <Button type="button" variant="legacy-ghost" disabled>
        Downloading…
      </Button>
    )
  } else if (status.kind === 'downloaded') {
    desc = `Installed — ${formatBytes(status.size_bytes)} on disk.${selected ? ' This is the model dictation uses.' : ''}`
    action = (
      <Button
        type="button"
        variant="legacy-danger"
        armed={confirmDelete}
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
      </Button>
    )
  } else if (status.kind === 'failed') {
    danger = true
    desc = `${status.reason}${coolingCopy}`
    action = (
      <Button
        type="button"
        variant="legacy-ghost"
        disabled={cooldown !== null}
        data-testid="settings-voice-model-download"
        onClick={onDownload}
      >
        Download again
      </Button>
    )
  } else {
    desc = `Not downloaded — ${formatBytes(model.size_bytes)} to fetch. Dictation refuses to start without it and says so.${coolingCopy}`
    action = (
      <Button
        type="button"
        variant="legacy-ghost"
        disabled={cooldown !== null}
        data-testid="settings-voice-model-download"
        onClick={onDownload}
      >
        Download
      </Button>
    )
  }
  return (
    <Row title={model.display_name} desc={danger ? undefined : desc} indent>
      <Stack align="end" gap={1}>
        {action}
        {danger && (
          <Text weight="medium" size="small" as="div" tone="danger" leading="tight" style={{ maxWidth: 'var(--tr-voice-error-copy-width)', textAlign: 'right' }}>
            {desc}
          </Text>
        )}
      </Stack>
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
        <LevelThresholdControl
          value={voiceSettings.rms_floor}
          level={voiceLevel}
          defaultValue={DEFAULT_RMS_FLOOR}
          maxValue={0.25}
          maxLevel={0.5}
          meterTestId="settings-voice-meter"
          testId="settings-voice-rms-floor"
          onChange={onRmsFloorSet}
        />
      </Row>
    </>
  )
}
