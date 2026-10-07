export interface DelimitedTableProps {
  source: string
  delimiter?: string
  label?: string
}

function parseDelimited(source: string, delimiter: string): string[][] {
  return source
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells: string[] = []
      let cell = ""
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '"' && quoted && line[i + 1] === '"') {
          cell += '"'
          i++
        } else if (char === '"') quoted = !quoted
        else if (char === delimiter && !quoted) {
          cells.push(cell)
          cell = ""
        } else cell += char
      }
      cells.push(cell)
      return cells
    })
}

export function DelimitedTable({
  source,
  delimiter = source.includes("\t") && !source.includes(",") ? "\t" : ",",
  label = "Delimited file contents",
}: DelimitedTableProps): React.JSX.Element {
  const rows = parseDelimited(source, delimiter)
  const [head = [], ...body] = rows
  return (
    <div className="flex-1 min-h-0 overflow-auto" data-testid="delimited-table">
      <table aria-label={label} className="min-w-full border-separate border-spacing-0 text-[length:var(--tr-text-xs)]">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th
                key={i}
                scope="col"
                className="sticky top-0 whitespace-nowrap border-b border-[var(--divider)] bg-[var(--rail-bg)] px-2.5 py-1.5 text-left font-medium text-[var(--text-primary)]"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="hover:bg-[var(--hover-fill)]">
              {head.map((_, ci) => (
                <td
                  key={ci}
                  className={`whitespace-nowrap border-b border-[var(--divider)] px-2.5 py-1.5 text-[var(--text-secondary)] ${ci > 0 && /^-?[\d,.]+$/.test(row[ci] ?? "") ? "text-right font-mono tabular-nums" : ""}`}
                >
                  {row[ci] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DelimitedTableSpecimen(): React.JSX.Element {
  return (
    <div className="h-[var(--h-primitives-preview-short)]">
      <DelimitedTable source={"name,count\nalpha,12\nbeta,8"} />
    </div>
  )
}
