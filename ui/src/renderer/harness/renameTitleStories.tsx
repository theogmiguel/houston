import React from 'react'
import { RenameTitle } from '../src/components/RenameTitle'

export function RenameTitleStory(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button[aria-label="Rename"]')
      buttons?.[buttons.length - 1]?.click()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div ref={ref} style={{ height: '100%', padding: 12, display: 'grid', gap: 12, alignContent: 'start', background: 'var(--content-bg)' }}>
      <div className="group" style={{ display: 'flex', alignItems: 'center', gap: 8, width: 320, containerType: 'inline-size' }}>
        <RenameTitle title="A pane title" onRename={() => {}} />
      </div>
      <div className="group" style={{ display: 'flex', alignItems: 'center', gap: 8, width: 320, containerType: 'inline-size' }}>
        <RenameTitle title="Edited title" onRename={() => {}} />
      </div>
    </div>
  )
}
