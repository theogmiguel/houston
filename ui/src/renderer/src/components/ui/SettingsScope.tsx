export function SettingsScope({ workspace, row = false, scope = 'workspace' }: { workspace: string | null; row?: boolean; scope?: 'workspace' | 'inherited' | 'global' }): React.JSX.Element {
  return row ? (
    <span className="block [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">{scope === 'global' ? 'All workspaces' : scope === 'inherited' ? 'Inherited from all workspaces' : workspace ? 'This workspace' : 'Choose a workspace to edit this setting.'}</span>
  ) : (
    <p data-testid="settings-workspace-scope" className="m-0 [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{workspace ? <>Applying settings for <strong className="font-medium text-[var(--text-primary)]">{workspace}</strong></> : 'Select a workspace to edit its task settings.'}</p>
  )
}
