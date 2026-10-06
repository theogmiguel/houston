import { Text } from './Text'

/** Visible focus states used by pane frames and headers. */
export function PaneFocusSpecimen(): React.JSX.Element {
  return (
    <div data-testid="pane-focus-specimen" className="grid grid-cols-3 gap-[var(--space-3)]">
      {(['none', 'dim', 'full'] as const).map((tier) => (
        <div key={tier} data-pane-focus-border={tier} className="rounded-[var(--tr-radius-md)] border p-[var(--space-3)]">
          <div data-pane-focus-head={tier} className="rounded-[var(--tr-radius-sm)] p-[var(--space-2)]"><Text tone="primary">{tier}</Text></div>
          <Text className="pane-title" tone="primary">Pane title</Text>
        </div>
      ))}
    </div>
  )
}
