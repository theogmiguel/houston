export function BulletList({ items }: { items: string[] }): React.JSX.Element {
  return <ul className="list-disc pl-[var(--space-5)]">{items.map((item) => <li key={item}>{item}</li>)}</ul>
}

export function BulletListSpecimen(): React.JSX.Element {
  return <BulletList items={['Readiness reasons stay scannable.', 'Acceptance items keep their order.']} />
}
