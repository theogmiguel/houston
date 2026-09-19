import { IconAlertTriangle, IconCheck, IconInfo, IconKeyboard, type IconComponent } from './icons'
import { ICON_ROLE_CLS } from './Icon'
import completedSoundUrl from '../assets/notify-completed.wav'
import errorSoundUrl from '../assets/notify-error.wav'
import needsInputSoundUrl from '../assets/notify-needs-input.wav'
import infoSoundUrl from '../assets/notify-info.wav'

export type NoticeSeverity = 'completed' | 'error' | 'needs-input' | 'info'

export const NOTICE_SEVERITY: Record<
  NoticeSeverity,
  { label: string; tone: string; Icon: IconComponent }
> = {
  completed: { label: 'Completed', tone: 'var(--online)', Icon: IconCheck },
  error: { label: 'Error', tone: 'var(--danger)', Icon: IconAlertTriangle },
  'needs-input': { label: 'Needs input', tone: 'var(--warning)', Icon: IconKeyboard },
  info: { label: 'Info', tone: 'var(--info)', Icon: IconInfo }
}

export const NOTICE_SEVERITY_SOUND: Record<NoticeSeverity, string> = {
  completed: completedSoundUrl,
  error: errorSoundUrl,
  'needs-input': needsInputSoundUrl,
  info: infoSoundUrl
}

export function severityForNotice(kind: string, agentKind?: string): NoticeSeverity {
  if (kind === 'agent-notice') {
    if (agentKind === 'finished') return 'completed'
    if (agentKind === 'error') return 'error'
    if (agentKind === 'needs-input') return 'needs-input'
    return 'info'
  }
  if (kind === 'task-ready') return 'completed'
  if (kind === 'task-failed') return 'error'
  return 'info'
}

export function NoticeSeverityChip({
  severity
}: {
  severity: NoticeSeverity
}): React.JSX.Element {
  const { label, tone, Icon } = NOTICE_SEVERITY[severity]
  return (
    <span
      className="inline-flex items-center gap-[3px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] shrink-0"
      style={{ color: tone }}
    >
      <Icon className={ICON_ROLE_CLS.label} />
      {label}
    </span>
  )
}
