// Pasted text comes from untrusted sources (CI logs, PR files). An embedded ESC or C1 control
// could close the paste early (`ESC[201~`) and let the rest run as typed input, so every C0
// control except tab, newline and carriage return, DEL and every C1 control is dropped.
const UNSAFE_PASTE_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text.replace(UNSAFE_PASTE_CONTROLS, '')}\x1b[201~`
}
