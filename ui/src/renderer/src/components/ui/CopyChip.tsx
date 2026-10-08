import { useState } from 'react'
import { Icon } from './Icon'
import { IconCheck, IconCopy } from '../icons'

export function CopyChipSpecimen(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <CopyChip value="feature/surfaces">feature/surfaces</CopyChip>
      <CopyChip value="a1b2c3d" className="font-mono">
        a1b2c3d
      </CopyChip>
    </div>
  )
}

export function CopyChip({
  value,
  children,
  className = '',
}: {
  value: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={`relative inline-flex max-w-full items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--hover-fill)] px-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover-strong)] ${className}`}
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1100)
      }}
      aria-label={copied ? 'Copied' : `Copy ${value}`}
    >
      <span className={`min-w-0 truncate transition-opacity duration-150 ${copied ? 'opacity-0' : 'opacity-100'}`}>
        {children}
      </span>
      <span
        className={`absolute inset-0 inline-flex items-center justify-center gap-1 transition-opacity duration-150 ${copied ? 'opacity-100' : 'opacity-0'}`}
        aria-live="polite"
      >
        <Icon glyph={IconCheck} role="small" />
        Copied
      </span>
      <span className={copied ? 'opacity-0' : 'opacity-60'}>
        <Icon glyph={IconCopy} role="small" />
      </span>
    </button>
  )
}
