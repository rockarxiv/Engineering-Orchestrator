import type { Item } from "@eo/core";

/**
 * The comment an approval files under the card it approved, written and
 * read back in one place (EO-408).
 *
 * That comment is what marks a card as dealt with, and it has always
 * named what the approval made: "Approved. Created EO-12, EO-13." A card
 * whose rows link to the items they became needs those keys back, and the
 * thread is the only record of which approval created which items — so
 * the reader sits beside the writer, where changing one sentence without
 * the other is hard to do by accident. `approvalNote.test.ts` holds the
 * two to each other.
 */

/** What an approval says in the thread. Created items are named in the order they were created. */
export function approvalNote(applied: { created: readonly Item[]; changed: readonly Item[] }): string {
  const parts: string[] = [];
  if (applied.created.length > 0) parts.push(`Created ${applied.created.map((item) => item.key).join(", ")}.`);
  if (applied.changed.length > 0) parts.push(`Updated ${applied.changed.map((item) => item.key).join(", ")}.`);
  return parts.length > 0 ? `Approved. ${parts.join(" ")}` : "Approved.";
}

/** The keys an approval's comment says it created, in the order it created them. Empty for any other sentence. */
export function createdKeysIn(note: string): string[] {
  const named = /^Approved\. Created ([^.]+)\./.exec(note);
  return named ? named[1]!.split(", ").filter((key) => key !== "") : [];
}
