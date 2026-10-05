export function SettingsScope({ workspace, row = false }: { workspace: string | null; row?: boolean }): React.JSX.Element {
  return row ? (
    <span className="block [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">{workspace ? 'This workspace' : 'Choose a workspace to edit this setting.'}</span>
  ) : (
    <p data-testid="settings-workspace-scope" className="m-0 [font-size:var(--tr-text-small-size)] text-[var(--text-muted)]">{workspace ? <>Applying settings for <strong className="font-medium text-[var(--text-primary)]">{workspace}</strong></> : 'Select a workspace to edit its task settings.'}</p>
  )
}
