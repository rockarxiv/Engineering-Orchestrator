/**
 * The archived items (KAN-33). A root of its own, not under `itemsKey`
 * (EO-560): the board's list is invalidated on every item change and
 * after every write, and a prefix match took this list with it each time
 * — a second `items:listArchived` nobody on screen had asked for. What
 * changes the archive invalidates it by name.
 */
export const archivedKey = ["items-archived"] as const;
