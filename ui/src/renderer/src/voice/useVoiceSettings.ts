import { useState } from 'react'
import type { HoustonClient } from '../houston/client'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { VoiceDevice } from '../houston/generated/VoiceDevice'
import type { VoiceExternalModel } from '../houston/generated/VoiceExternalModel'
import type { VoiceModelState } from '../houston/generated/VoiceModelState'
import type { VoiceSettings } from '../houston/generated/VoiceSettings'
import type { CloudStt } from '../houston/generated/CloudStt'
import { clearVoiceIndicators, setVoiceLevel } from './store'

export function useVoiceSettings(client: HoustonClient | null) {
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings | null>(null)
  const [voiceCloudKeyPresent, setVoiceCloudKeyPresent] = useState(false)
  const [voiceKeyringError, setVoiceKeyringError] = useState<string | null>(null)
  const [voiceModels, setVoiceModels] = useState<VoiceModelState[]>([])
  const [voiceDevices, setVoiceDevices] = useState<VoiceDevice[]>([])
  const [voiceExternalModels, setVoiceExternalModels] = useState<VoiceExternalModel[]>([])
  const [voiceScanLimited, setVoiceScanLimited] = useState(false)

  function handleMessage(msg: ServerMsg): boolean {
    switch (msg.type) {
      case 'voice_settings':
        setVoiceSettings(msg.settings)
        setVoiceCloudKeyPresent(msg.cloud_key_present)
        setVoiceKeyringError(msg.keyring_error ?? null)
        setVoiceModels(msg.models)
        if (!msg.settings.enabled) clearVoiceIndicators()
        return true
      case 'voice_devices':
        setVoiceDevices(msg.devices)
        return true
      case 'voice_level':
        setVoiceLevel(msg.rms)
        return true
      case 'voice_models_found':
        setVoiceExternalModels(msg.files)
        setVoiceScanLimited(msg.limited)
        return true
      case 'voice_model_state':
        setVoiceModels((prev) => prev.some((model) => model.id === msg.model.id)
          ? prev.map((model) => model.id === msg.model.id ? msg.model : model)
          : [...prev, msg.model])
        return true
      default:
        return false
    }
  }

  const actions = {
    onVoiceSettingsSet: (next: VoiceSettings) => client?.voiceSettingsSet(next),
    onVoiceKeySet: (provider: CloudStt, key: string) => client?.voiceKeySet(provider, key),
    onVoiceKeyClear: (provider: CloudStt) => client?.voiceKeyClear(provider),
    onVoiceDevicesRefresh: () => client?.voiceDevicesGet(),
    onVoiceLevelMonitor: (enabled: boolean) => {
      if (!client) return
      client.voiceLevelMonitor(enabled)
      if (!enabled) setVoiceLevel(null)
    },
    onVoiceModelsScan: () => client?.voiceModelsScan(),
    onVoiceModelReuse: (modelId: string, path: string, copy: boolean) => client?.voiceModelReuse(modelId, path, copy),
    onVoiceModelDownload: (modelId: string) => client?.voiceModelDownload(modelId),
    onVoiceModelDelete: (modelId: string) => client?.voiceModelDelete(modelId)
  }
  return { voiceSettings, voiceCloudKeyPresent, voiceKeyringError, voiceModels,
    voiceDevices, voiceExternalModels, voiceScanLimited, handleMessage, actions }
}
