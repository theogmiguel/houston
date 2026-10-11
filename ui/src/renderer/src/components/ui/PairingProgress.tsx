import { Text } from './Text'

export function PairingProgress({ listening, waiting, confirmed = false }: { listening: boolean; waiting: boolean; confirmed?: boolean }): React.JSX.Element {
  const steps = [
    { done: listening, text: listening ? 'Remote access is on' : 'Turn on remote access' },
    { done: confirmed, text: waiting ? 'Scan the code with the phone camera · Waiting for the phone…' : 'Scan the code with the phone camera' },
    { done: confirmed, text: confirmed ? 'Confirmed on the phone' : 'Confirm on the phone' }
  ]
  return (
    <ol aria-label="Connection progress" aria-live="polite" className="m-0 grid list-none gap-[var(--space-3)] p-0">
      {steps.map((step, index) => (
        <li key={index} aria-current={!confirmed && index === (listening ? 1 : 0) ? 'step' : undefined} className="flex items-start gap-[var(--space-2)]">
          <Text size="small" tone={step.done ? 'ok' : 'muted'} aria-label={step.done ? 'Complete' : `Step ${index + 1}`}>{step.done ? '✓' : index + 1}</Text>
          <Text size="small" tone="secondary">{step.text}</Text>
        </li>
      ))}
    </ol>
  )
}

export function PairingProgressSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-4)]"><PairingProgress listening={false} waiting={false} /><PairingProgress listening waiting /><PairingProgress listening waiting={false} confirmed /></div>
}
