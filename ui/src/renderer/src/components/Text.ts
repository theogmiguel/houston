export type TextRole =
  | 'display'
  | 'title'
  | 'heading'
  | 'subhead'
  | 'body'
  | 'ui'
  | 'small'
  | 'label'

export const TEXT_ROLE_CLS: Readonly<Record<TextRole, string>> = Object.freeze({
  display:
    '[font-family:var(--tr-text-display-family)] [font-size:var(--tr-text-display-size)] ' +
    '[font-weight:var(--tr-text-display-weight)]',
  title:
    '[font-size:var(--tr-text-title-size)] [font-weight:var(--tr-text-title-weight)] ' +
    '[letter-spacing:var(--tr-text-title-tracking)]',
  heading:
    '[font-size:var(--tr-text-heading-size)] [font-weight:var(--tr-text-heading-weight)] ' +
    '[letter-spacing:var(--tr-text-heading-tracking)]',
  subhead:
    '[font-size:var(--tr-text-subhead-size)] [font-weight:var(--tr-text-subhead-weight)] ' +
    '[letter-spacing:var(--tr-text-subhead-tracking)]',
  body:
    '[font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] ' +
    '[line-height:var(--tr-text-body-leading)]',
  ui:
    '[font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] ' +
    '[line-height:var(--tr-text-ui-leading)]',
  small:
    '[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ' +
    '[line-height:var(--tr-text-small-leading)]',
  label:
    '[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] ' +
    '[letter-spacing:var(--tr-text-label-tracking)] ' +
    '[text-transform:var(--tr-text-label-transform)]'
})
