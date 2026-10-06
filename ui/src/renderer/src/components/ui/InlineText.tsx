import type { TextProps } from './Text'
import { Text } from './Text'

/** Keeps a short text role on one line while using the shared Text primitive. */
export function InlineText(props: TextProps): React.JSX.Element {
  return <Text {...props} className={`whitespace-nowrap ${props.className ?? ''}`} />
}

export function InlineTextSpecimen(): React.JSX.Element {
  return <div data-testid="inline-text-specimen"><InlineText>Single-line sample</InlineText></div>
}
