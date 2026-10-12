import { GLYPH_FOR_VERB } from '../verbGlyphs'
import { Icon } from './Icon'
import { Button } from './Button'

const LABELS: Record<keyof typeof GLYPH_FOR_VERB, string> = {
  notifications: 'Notifications',
  about: 'About',
  'toggle-file-tree': 'Toggle file tree',
  'wrap-lines': 'Wrap lines',
  'reveal-in-file-manager': 'Reveal in file manager',
  'measure-memory': 'Measure process memory',
  overview: 'Overview'
}

export function VerbGlyphSpecimen(): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-[var(--space-2)] p-[var(--space-4)]">
    {(Object.keys(GLYPH_FOR_VERB) as (keyof typeof GLYPH_FOR_VERB)[]).map((verb) => <Button key={verb} variant="secondary"><Icon glyph={GLYPH_FOR_VERB[verb]} role="ui" />{LABELS[verb]}</Button>)}
  </div>
}
