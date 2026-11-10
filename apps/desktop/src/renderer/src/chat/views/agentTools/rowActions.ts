/**
 * A press on a catalogue row that is still on its way (EO-562): switching
 * a server or a skill on or off, archiving it, or locking a skill (EO-714). One at a time per row,
 * so a second press — or the row's other button — sends nothing until the
 * first has landed and the list has been read again.
 */
export type RowAction = "enable" | "disable" | "archive" | "lock" | "unlock";

/** What the row's switch says: what it is doing while it does it, and what it would do otherwise. */
export function toggleLabel(pending: RowAction | undefined, enabled: boolean): string {
  if (pending === "enable") return "Enabling…";
  if (pending === "disable") return "Disabling…";
  return enabled ? "Disable" : "Enable";
}
