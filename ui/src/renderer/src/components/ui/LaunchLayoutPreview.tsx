export function LaunchPresetOutline({ count }: { count: number }): React.JSX.Element {
  const columns = count <= 1 ? 1 : 2
  const rows = Math.ceil(count / columns)
  const gap = 2
  const width = 34
  const height = 22
  const cellHeight = (height - gap * (rows - 1)) / rows
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="flex-none fill-none stroke-[var(--text-muted)] [stroke-width:1.2]">
      {Array.from({ length: count }, (_, index) => {
        const row = Math.floor(index / columns)
        const col = index % columns
        const rowCount = Math.min(columns, count - row * columns)
        const cellW = (width - gap * (rowCount - 1)) / rowCount
        return <rect key={index} x={col * (cellW + gap) + 0.6} y={row * (cellHeight + gap) + 0.6} width={cellW - 1.2} height={cellHeight - 1.2} rx="2" />
      })}
    </svg>
  )
}

export function LaunchPresetOutlineSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]">{[1, 2, 4].map((count) => <LaunchPresetOutline key={count} count={count} />)}</div>
}
