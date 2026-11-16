/**
 * Shelf expansion and paging state shared by the thread sidebar and the layout
 * rail. Reusing the keys keeps one workspace's shelves open wherever they are
 * shown and remembers the choice across launches.
 */
export const SETTLED_TAIL_INITIAL_COUNT = 10;
export const SETTLED_TAIL_PAGE_COUNT = 25;
export const SETTLED_SHELF_EXPANDED_KEY = "houston:sidebar:settled-expanded";
export const SNOOZED_SHELF_EXPANDED_KEY = "houston:sidebar:snoozed-expanded";
export const WORKING_SHELF_EXPANDED_KEY = "houston:sidebar:working-expanded";
