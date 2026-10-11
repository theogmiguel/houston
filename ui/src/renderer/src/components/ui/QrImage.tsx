/// A QR code rendered from SVG markup, on the white field cameras need in either theme.
export function QrImage({ svg, label }: { svg: string; label: string }): React.JSX.Element {
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt={label}
      width={176}
      height={176}
      className="block h-[176px] w-[176px] flex-none rounded-[var(--tr-radius-sm)] border border-[var(--divider)] bg-white"
    />
  )
}
