/**
 * Stops a pointer gesture from painting a text selection until the returned
 * release runs. Safari and other WebKit engines honour only the prefixed
 * `-webkit-user-select`, so both spellings are set.
 */
export function suppressTextSelection(element: HTMLElement): () => void {
  const style = element.style;
  const previous = {
    standard: style.getPropertyValue("user-select"),
    prefixed: style.getPropertyValue("-webkit-user-select"),
  };
  element.ownerDocument.getSelection()?.removeAllRanges();
  style.setProperty("user-select", "none");
  style.setProperty("-webkit-user-select", "none");
  return () => {
    restore(style, "user-select", previous.standard);
    restore(style, "-webkit-user-select", previous.prefixed);
  };
}

function restore(style: CSSStyleDeclaration, property: string, value: string): void {
  if (value.length > 0) style.setProperty(property, value);
  else style.removeProperty(property);
}
