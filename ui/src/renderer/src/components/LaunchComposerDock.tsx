import { lazy, Suspense } from 'react'
import type { HoustonClient } from '../houston/client'
import type { SessionSlot } from './sessionPresets'

const NewSessionComposer = lazy(() =>
  import('./NewSessionComposer').then((m) => ({ default: m.NewSessionComposer }))
)

export type ComposerMode = 'current-grid' | 'new-grid'
export type LaunchTarget = 'this-grid' | 'new-grid'
export interface LaunchPreview {
  slots: SessionSlot[]
  target: LaunchTarget
}

/** The preview the grid draws: only while the composer is open. */
export function visibleLaunchPreview(composer: ComposerMode | null, preview: LaunchPreview | null): LaunchPreview | undefined {
  return composer && preview ? preview : undefined
}

export function LaunchComposerDock({
  composer,
  workspace,
  settingsOpen,
  railOpen,
  workspaceName,
  gridName,
  client,
  connected,
  onPreviewChange,
  onLaunch,
  onClose
}: {
  composer: ComposerMode | null
  workspace: string
  settingsOpen: boolean
  railOpen: boolean
  workspaceName: string
  gridName: () => string | undefined
  client: HoustonClient | null
  connected: boolean
  onPreviewChange: (slots: SessionSlot[], target: LaunchTarget) => void
  onLaunch: (slots: SessionSlot[], target: LaunchTarget) => void
  onClose: () => void
}): React.JSX.Element | null {
  if (!composer || workspace === 'all' || settingsOpen || railOpen) return null
  return (
    <Suspense fallback={null}>
      <NewSessionComposer
        workspaceName={workspaceName}
        workspacePath={workspace}
        gridName={gridName() ?? 'Grid'}
        client={connected ? client : null}
        initialTarget={composer === 'new-grid' ? 'new-grid' : 'this-grid'}
        onPreviewChange={onPreviewChange}
        onLaunch={onLaunch}
        onCancel={onClose}
      />
    </Suspense>
  )
}
