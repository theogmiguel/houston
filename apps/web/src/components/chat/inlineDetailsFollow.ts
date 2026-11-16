/** The last inline details card rect, handed from the cell that lost focus to the next one. */
export interface InlineDetailsHandoff {
  readonly threadKey: string | null;
  readonly rect: DOMRect | null;
}

let handoff: InlineDetailsHandoff = { threadKey: null, rect: null };

export const readInlineDetailsHandoff = () => handoff;

export const recordInlineDetailsHandoff = (threadKey: string, rect: DOMRect) => {
  handoff = { threadKey, rect };
};

/** A card that closes where it is must not make the next opening animate. */
export const clearInlineDetailsHandoff = () => {
  handoff = { threadKey: null, rect: null };
};
