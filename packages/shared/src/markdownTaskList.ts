const TASK_LIST_CHECKBOX = /^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/;

/** Offset of the `[ ]` marker on the first line of the list item starting at `listItemStart`. */
export function taskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(TASK_LIST_CHECKBOX);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}

const SET_MARKDOWN_TASK_CHECKED_PATTERN = /[ xX]/;

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !SET_MARKDOWN_TASK_CHECKED_PATTERN.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
