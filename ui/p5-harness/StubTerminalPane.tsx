export function TerminalPane(): React.JSX.Element {
  return (
    <div className="term-wrap" data-stub-terminal="">
      <div
        className="term-host [.layout.dragging_&]:pointer-events-none [.layout.resizing_&]:pointer-events-none"
        aria-label="Terminal"
      />
    </div>
  )
}

export type RegisterOutput = (id: number, sink: unknown) => () => void
export type TermActions = {
  hasSelection(): boolean
  copy(): void
  paste(): void
  clear(): void
  find(): void
  copyOutput(choice: unknown): void
  toast(text: string): void
}
