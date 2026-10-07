import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { IconTag } from '../icons'
import { Button } from '../ui/Button'
import { TAG_POPOVER_CLS } from '../ui/TagPopoverChrome'

export function DisabledSettingPrompt({
  anchor,
  onShowTags,
  onClose,
}: {
  anchor: HTMLElement
  onShowTags: () => void
  onClose: () => void
}): React.JSX.Element {
  const [position, setPosition] = useState({ left: 0, top: 0 })
  useEffect(() => {
    const place = (): void => {
      const rect = anchor.getBoundingClientRect(),
        width = 288,
        height = 190
      setPosition({
        left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(rect.top - 4, window.innerHeight - height - 8)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const away = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !anchor.contains(event.target) &&
        !document.querySelector('[data-testid="tags-disabled-prompt"]')?.contains(event.target)
      )
        onClose()
    }
    document.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', away, true)
    }
  }, [anchor, onClose])
  return (
    <section
      role="dialog"
      aria-label="Tags are turned off"
      data-testid="tags-disabled-prompt"
      className={TAG_POPOVER_CLS.prompt}
      style={position}
    >
      <h3 className={TAG_POPOVER_CLS.promptTitle}>Tags are turned off</h3>
      <p className={TAG_POPOVER_CLS.promptCopy}>
        Grid cards don't show tags, so filtering by them would hide grids for reasons you can't see. Turn tags on to
        filter by them.
      </p>
      <div className={TAG_POPOVER_CLS.promptPreview}>
        <span className={TAG_POPOVER_CLS.promptPreviewLabel}>Cards will show</span>
        <span className={TAG_POPOVER_CLS.promptSwatches}>
          {['#a78bfa', '#7cb7ff', '#22d3ee'].map((color) => (
            <span key={color} className={TAG_POPOVER_CLS.promptSwatch} style={{ color }}>
              <Icon glyph={IconTag} role="small" />
            </span>
          ))}
        </span>
      </div>
      <div className={TAG_POPOVER_CLS.promptActions}>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Not now
        </Button>
        <Button variant="primary" size="sm" onClick={onShowTags}>
          Show tags
        </Button>
      </div>
    </section>
  )
}
