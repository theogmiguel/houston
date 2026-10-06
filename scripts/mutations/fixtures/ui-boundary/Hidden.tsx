export function Hidden({ on }: { on: boolean }): React.JSX.Element {
  return <div className={`flex ${on ? 'items-center' : 'shadow-lg'} bg-red-500`}>hidden</div>
}
