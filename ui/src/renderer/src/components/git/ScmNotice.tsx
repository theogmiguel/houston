import { RepositoryNotice, type ScmNoticeTone } from '../ui'
import { IconAlertTriangle, IconInfo } from '../icons'
import { Icon } from '../ui/Icon'

export type { ScmNoticeTone } from '../ui'

export function ScmNotice({
  tone,
  testId,
  children
}: {
  tone: ScmNoticeTone
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <RepositoryNotice
      tone={tone}
      testId={testId}
      icon={<span aria-hidden className="inline-flex"><Icon glyph={tone === 'info' ? IconInfo : IconAlertTriangle} role="small" /></span>}
    >{children}</RepositoryNotice>
  )
}
