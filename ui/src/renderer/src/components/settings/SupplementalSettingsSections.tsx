import type { Props } from '../SettingsView'
import type { SettingsSectionId } from '../../settingsSections'
import { DaemonSection } from './DaemonSection'
import { NotificationsSection } from './NotificationsSection'
import { PrivacySection } from './PrivacySection'
import { ShortcutsSection } from './ShortcutsSection'
import { VoiceSection } from './VoiceSection'

type SupplementalSettingsProps = Pick<Props,
  | 'keymapOverrides'
  | 'onKeymapOverrides'
  | 'desktopNotificationMode'
  | 'onDesktopNotificationMode'
  | 'inAppNotifications'
  | 'onInAppNotifications'
  | 'desktopNotificationDelivery'
  | 'voiceSettings'
  | 'voiceCloudKeyPresent'
  | 'voiceKeyringError'
  | 'voiceModels'
  | 'voiceDevices'
  | 'onVoiceLevelMonitor'
  | 'onVoiceSettingsSet'
  | 'onVoiceKeySet'
  | 'onVoiceKeyClear'
  | 'onVoiceDevicesRefresh'
  | 'onVoiceModelDownload'
  | 'onVoiceModelDelete'
  | 'historyCount'
  | 'onClearHistory'
  | 'historyIgnoreGlobs'
  | 'onHistoryIgnoreGlobsSet'
  | 'hostInfo'
  | 'onRevealSessionDb'
> & { section: SettingsSectionId }

export function SupplementalSettingsSections(props: SupplementalSettingsProps): React.JSX.Element | null {
  const { section } = props
  if (section === 'shortcuts') {
    return <ShortcutsSection keymapOverrides={props.keymapOverrides} onKeymapOverrides={props.onKeymapOverrides} />
  }
  if (section === 'notifications') {
    return <NotificationsSection
      desktopMode={props.desktopNotificationMode ?? 'off'}
      onDesktopMode={props.onDesktopNotificationMode ?? (() => {})}
      inApp={props.inAppNotifications ?? false}
      onInApp={props.onInAppNotifications ?? (() => {})}
      delivery={props.desktopNotificationDelivery ?? null}
    />
  }
  if (section === 'voice') {
    return <VoiceSection
      voiceSettings={props.voiceSettings}
      voiceCloudKeyPresent={props.voiceCloudKeyPresent}
      voiceKeyringError={props.voiceKeyringError}
      voiceModels={props.voiceModels}
      voiceDevices={props.voiceDevices}
      onVoiceLevelMonitor={props.onVoiceLevelMonitor}
      onVoiceSettingsSet={props.onVoiceSettingsSet}
      onVoiceKeySet={props.onVoiceKeySet}
      onVoiceKeyClear={props.onVoiceKeyClear}
      onVoiceDevicesRefresh={props.onVoiceDevicesRefresh}
      onVoiceModelDownload={props.onVoiceModelDownload}
      onVoiceModelDelete={props.onVoiceModelDelete}
      keymapOverrides={props.keymapOverrides}
    />
  }
  if (section === 'privacy') {
    return <PrivacySection
      historyCount={props.historyCount}
      onClearHistory={props.onClearHistory}
      historyIgnoreGlobs={props.historyIgnoreGlobs}
      onHistoryIgnoreGlobsSet={props.onHistoryIgnoreGlobsSet}
      hostInfo={props.hostInfo}
      onRevealSessionDb={props.onRevealSessionDb}
    />
  }
  if (section === 'daemon') return <DaemonSection />
  return null
}
