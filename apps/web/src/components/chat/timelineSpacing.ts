/**
 * The vertical rhythm of the timeline. A row leaves the in-turn gap below it, and the row before
 * a user message leaves the turn gap instead, so every turn opens the same distance below the
 * last thing the previous one showed.
 */

/** 12px between work rows, the answer and its cards within a turn. */
export const IN_TURN_GAP_CLASS = "pb-3";

/** The in-turn gap, for a row that opens a block below a row that leaves less (a footer line). */
export const IN_TURN_GAP_ABOVE_CLASS = "pt-3";

/** 32px between the end of one turn and the next user message. */
export const TURN_GAP_CLASS = "pb-8";

/** Rows packed into one block (a group of work rows, a run of user messages) leave 4px. */
export const PACKED_GAP_CLASS = "pb-1";

/**
 * An answer carries its footer line, which already leaves 22px below the text (6px above, 24px
 * tall, 8px pulled back). This pays the 8px back, so the next row of any kind (a user message,
 * a status line, a work row) starts below the footer's buttons instead of under them; before a
 * user message it also tops the gap up to 32px.
 */
export const FOOTER_GAP_CLASS = "pb-2";

export function turnOrInTurnGap(leadsToTurn: boolean | undefined): string {
  return leadsToTurn ? TURN_GAP_CLASS : IN_TURN_GAP_CLASS;
}
