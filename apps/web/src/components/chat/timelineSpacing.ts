/**
 * The vertical rhythm of the timeline. A row leaves the in-turn gap below it, and the row before
 * a user message leaves the turn gap instead, so every turn opens the same distance below the
 * last thing the previous one showed. An answer's footer line sits in that distance, so an answer
 * leaves its own footer gaps below.
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
 * An answer carries its footer line, which leaves 22px below the text (6px above, 24px tall, 8px
 * pulled back). The row pays the 8px back and adds 12px, so the next row starts 14px below the
 * footer's buttons, close to the in-turn gap, instead of under them.
 */
export const FOOTER_GAP_CLASS = "pb-5";

/** As the footer gap, for an answer that a user message follows: 18px below the buttons. */
export const FOOTER_TURN_GAP_CLASS = "pb-6";

/**
 * A user message keeps the line of its time and buttons under the bubble. The row leaves 8px
 * below that line so the next row does not start against the buttons.
 */
export const USER_MESSAGE_GAP_CLASS = "pb-2";

export function turnOrInTurnGap(leadsToTurn: boolean | undefined): string {
  return leadsToTurn ? TURN_GAP_CLASS : IN_TURN_GAP_CLASS;
}
