export function SettingsScope({ workspace, scope = 'workspace' }: { workspace: string | null; scope?: 'workspace' | 'inherited' | 'global' }): React.JSX.Element {
  return (
    <span className="block [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">{scope === 'global' ? 'All workspaces' : scope === 'inherited' ? 'Inherited from all workspaces' : workspace ? 'This workspace' : 'Choose a workspace to edit this setting.'}</span>
  )
}
