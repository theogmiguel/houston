import type { VoiceExternalModel } from '../../houston/generated/VoiceExternalModel'
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
  onVoiceModelSelect?: (modelId: string) => void
  voiceExternalModels?: VoiceExternalModel[]
  voiceScanLimited?: boolean
  onVoiceModelsScan?: () => void
  onVoiceModelReuse?: (modelId: string, path: string, copy: boolean) => void
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

function modelDescription(model: VoiceModelState, selected: boolean): string {
  const status = model.status
  const size = formatBytes(model.size_bytes)
  if (model.unavailable_reason) return `${size}. ${model.unavailable_reason}`
  if (status.kind === 'downloading') return `Downloading — ${Math.round(status.progress * 100)}% of ${size}. The file is verified against its SHA-256 before it is installed.`
  if (status.kind === 'downloaded' || model.linked) {
    const installedSize = status.kind === 'downloaded' ? status.size_bytes : model.size_bytes
    const availability = status.kind === 'downloaded' ? '' : ' The external file is unavailable; remove this link or restore the file.'
    const active = selected ? ' This is the model dictation uses.' : ''
    return `${model.linked ? 'Linked externally' : 'Installed'} — ${formatBytes(installedSize)}.${availability}${active}`
  }
  const reason = status.kind === 'failed' ? `${size}. ${status.reason.trim()}` : `Not downloaded — ${size} to fetch. Dictation refuses to start without it and says so.`
  if (model.cooldown_remaining_ms == null) return reason
  return [reason, `Repeated failures — the next attempt is allowed in ${Math.ceil(model.cooldown_remaining_ms / 1000)}s.`].join(' ')
}

function ModelDeleteAction({ model, onDelete }: { model: VoiceModelState; onDelete: () => void }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const size = model.status.kind === 'downloaded' ? model.status.size_bytes : model.size_bytes
  function confirm(): void {
    if (armed) { setArmed(false); onDelete() } else { setArmed(true) }
  }
  return <Button type="button" variant="legacy-danger" armed={armed} data-testid="settings-voice-model-delete" onClick={confirm} onBlur={() => setArmed(false)}>
    {armed ? 'Click again to delete' : model.linked ? 'Remove link' : `Delete (frees ${formatBytes(size)})`}
  </Button>
}

function ModelInstallAction({ model, onDownload, onDelete }: {
  model: VoiceModelState; onDownload: () => void; onDelete: () => void
}): React.JSX.Element | null {
  if (model.unavailable_reason) return null
  if (model.status.kind === 'downloading') return <Button type="button" variant="legacy-ghost" disabled>Downloading…</Button>
  if (model.status.kind === 'downloaded' || model.linked) return <ModelDeleteAction model={model} onDelete={onDelete} />
  return <Button type="button" variant="legacy-ghost" disabled={model.cooldown_remaining_ms != null} data-testid="settings-voice-model-download" onClick={onDownload}>
    {model.status.kind === 'failed' ? 'Download again' : 'Download'}
  </Button>
}

function VoiceModelRow({ model, selected, onDownload, onDelete, onSelect }: {
  model: VoiceModelState; selected: boolean; onDownload: () => void; onDelete: () => void; onSelect?: () => void
}): React.JSX.Element {
  const desc = modelDescription(model, selected)
  const danger = model.status.kind === 'failed' && !model.linked && !model.unavailable_reason
  return <Row title={`${model.display_name}${selected ? ' · Active' : ''}`} desc={danger ? undefined : `${desc} ${model.guidance ?? ''}`} indent>
    <Stack align="end" gap={1}>
      {model.status.kind === 'downloaded' && !model.unavailable_reason && <Button type="button" variant="legacy-ghost" disabled={selected || !onSelect} onClick={onSelect}>
        {selected ? 'Active model' : 'Use model'}
      </Button>}
      <ModelInstallAction model={model} onDownload={onDownload} onDelete={onDelete} />
      {danger && <Text weight="medium" size="small" as="div" tone="danger" leading="tight" style={{ maxWidth: 'var(--tr-voice-error-copy-width)', textAlign: 'right' }}>{desc}</Text>}
    </Stack>
  </Row>
}

function ExternalModelRow({ file, model, onReuse }: {
  file: VoiceExternalModel; model: VoiceModelState | undefined; onReuse: VoiceModelRosterProps['onVoiceModelReuse']
}): React.JSX.Element {
  const desc = file.unsupported_reason ?? `${model?.display_name ?? file.model_id}: ${file.path}. SHA-256 matched. ${model?.unavailable_reason ?? 'Link keeps the external file; Copy uses Houston disk space. A fresh Download is available below.'}`
  const modelId = file.model_id
  return <Row title={file.unsupported_reason ? 'Parakeet · Unsupported' : `Found in ${file.source}`} desc={desc} indent>
    {modelId && !file.unsupported_reason && !model?.unavailable_reason && <Stack axis="horizontal" gap={1}>
      <Button type="button" variant="legacy-ghost" disabled={!onReuse} onClick={() => onReuse?.(modelId, file.path, false)}>Link</Button>
      <Button type="button" variant="legacy-ghost" disabled={!onReuse} onClick={() => onReuse?.(modelId, file.path, true)}>Copy</Button>
    </Stack>}
  </Row>
}

export function VoiceModelRoster({
  voiceModels,
  selectedModelId,
  onVoiceModelDownload,
  onVoiceModelDelete,
  onVoiceModelSelect,
  voiceExternalModels = [],
  voiceScanLimited,
  onVoiceModelsScan,
  onVoiceModelReuse
}: VoiceModelRosterProps): React.JSX.Element {
  return (
    <>
      <Row title="Local models" desc={`${selectedModelId ? `Active: ${voiceModels.find((m) => m.id === selectedModelId)?.display_name ?? selectedModelId}` : 'No local model selected'}. Houston disk usage: ${formatBytes(voiceModels.reduce((total, m) => total + (m.status.kind === 'downloaded' && !m.linked ? m.status.size_bytes : 0), 0))}. Downloads contact Hugging Face only when requested.`} indent>
        <Button type="button" variant="legacy-ghost" disabled={!onVoiceModelsScan} onClick={onVoiceModelsScan}>Find installed models</Button>
      </Row>
      {voiceScanLimited && <Row title="Scan limit reached" desc="Results are partial: the local scan stops at 4096 entries, 64 results, depth 6, 4 GiB hashed or 30 seconds." indent />}
      {voiceExternalModels.map((file) => <ExternalModelRow key={file.path} file={file} model={voiceModels.find((model) => model.id === file.model_id)} onReuse={onVoiceModelReuse} />)}
      {voiceModels.map((m) => (
        <VoiceModelRow
          key={m.id}
          model={m}
          selected={selectedModelId === m.id}
          onDownload={() => onVoiceModelDownload(m.id)}
          onDelete={() => onVoiceModelDelete(m.id)}
          onSelect={onVoiceModelSelect ? () => onVoiceModelSelect(m.id) : undefined}
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
