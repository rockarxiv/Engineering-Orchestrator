import { checkMemoryNote, MEMORY_NOTE_REPLACES, type Item, type MemoryEntryView, type MemoryNoteScope, type Uuid } from "@eo/core";
import type { ItemRecord } from "../record/record.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * Writing what an agent noted (EO-479, ARCHITECTURE.md, "What an agent is
 * given").
 *
 * The `eo` server validates a `memory_note` call and answers; it cannot
 * write, because it opens the database read-only. The supervisor reads
 * the acceptance off the run's event stream and comes here, where the
 * rules are applied again against the scopes the run works in *now*
 * (invariant 5) and the entry is written with the run and its item as its
 * source. Extraction after a run writes its notes through the same door.
 */

/** The scopes a run may write to, in the shape the note rules take them. */
export function noteScopes(scopes: readonly MemoryScopeInfo[]): MemoryNoteScope[] {
  return scopes.map((info) => ({ kind: info.scope.kind, id: info.scope.id, name: info.name }));
}

/**
 * What `memory_note`'s answer says of the active entries closest to the
 * note (EO-611), in the one text both backends show an agent. The note is
 * already written, and the agent decides what to do about these. Writing
 * again has to name the note just written as well as the entry it repeats,
 * or the fact ends up held twice in the two notes, so its id is given.
 */
export function closestEntriesAnswer(noteId: string, closest: readonly MemoryEntryView[]): string {
  if (closest.length === 0) return "No active entry in that scope is close to it.";
  return [
    "These active entries in that scope are close to it, closest first:",
    ...closest.map((entry) => `- \`${entry.id}\`${entry.source.type === "person" ? " (by a person)" : ""}: ${entry.body.replaceAll("\n", "\n  ")}`),
    `Where one says the same as your note, or your note corrects it, write the note again with \`${MEMORY_NOTE_REPLACES}\` naming that id and \`${noteId}\`, this note's own, so the fact is kept once. An entry by a person cannot be replaced: leave it to them. Where none does, your note stands as it is.`,
  ].join("\n");
}

/** The arguments of a call, read as a note — anything that is not an object is a note with nothing in it. */
function asNote(args: unknown): { scope: unknown; text: unknown; replaces: unknown } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { scope: undefined, text: undefined, replaces: undefined };
  const record = args as Record<string, unknown>;
  return { scope: record["scope"], text: record["text"], replaces: record[MEMORY_NOTE_REPLACES] };
}

/**
 * Writes one note as an active entry, or says why it did not.
 *
 * Through whichever record holds the item's project (EO-482): this
 * database for a solo desktop or a project kept on one, and the
 * organisation's record for a project somebody moved there — where a
 * record that cannot be reached means the note was not saved, and the
 * answer says so. Nothing is written here in that case.
 *
 * `extracted` marks a note EO drew out of the run after it ended, rather
 * than one the agent wrote with the tool.
 *
 * A note that `replaces` entries (EO-594) retires them as superseded in
 * the transaction that writes it, each held to being an active entry an
 * agent wrote in one of `scopes`; one that is not refuses the note, and
 * nothing is written.
 */
export async function writeMemoryNote(input: {
  record: Pick<ItemRecord, "writeMemory">;
  args: unknown;
  scopes: readonly MemoryScopeInfo[];
  runId: Uuid;
  item: Item;
  extracted?: boolean;
  now?: number;
}): Promise<{ ok: true; entry: MemoryEntryView } | { ok: false; problem: string }> {
  const checked = checkMemoryNote(asNote(input.args), noteScopes(input.scopes));
  if (!checked.ok) return checked;
  return input.record.writeMemory({
    op: "note",
    item: input.item,
    runId: input.runId,
    scope: checked.scope,
    body: checked.body,
    ...(input.extracted ? { extracted: true } : {}),
    ...(checked.replaces.length === 0 ? {} : { replaces: checked.replaces, scopes: input.scopes.map((info) => info.scope) }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
