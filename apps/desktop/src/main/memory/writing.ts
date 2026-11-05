import {
  eoToolName,
  MAX_MEMORY_NOTE_CHARS,
  MEMORY_NOTE_DEFINITION,
  MEMORY_NOTE_PROJECT_SCOPE,
  MEMORY_NOTE_REPLACES,
  MEMORY_NOTE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  MEMORY_USED_FIELD,
} from "@eo/core";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * How an agent is told to write memory (EO-593, ARCHITECTURE.md §7.5).
 *
 * EO's own words, appended to every turn that is served `memory_note`
 * whatever the agent's instructions say — so an agent a person made with
 * their own instructions is told what the shipped ones are, and no role's
 * prompt carries a paragraph of its own about memory. Keyed on the grant
 * and the scopes, never on a role or an action (invariant 13).
 *
 * What a note is comes from `MEMORY_NOTE_DEFINITION`, word for word: the
 * one definition the extractor applies too, so what an agent is asked to
 * write and what EO draws out of its run afterwards cannot drift apart.
 *
 * When to name the entries a note replaces (EO-594) is said here too: a
 * note that corrects an entry, or says again what one already says,
 * names it, and EO retires it as superseded — so a correction and what
 * it corrects are never both delivered, and a fact is not noted twice.
 * And what to do with the entries `memory_note` answers with (EO-611):
 * nothing shows an agent what memory holds before it writes, so the
 * answer does, and the agent writes again if it repeated one.
 *
 * And which of the entries it was given an answer relied on (EO-597):
 * where the answer's schema has a `memoryUsed` field, the agent lists
 * them there, and EO counts each entry's uses beside its deliveries. Said
 * of the field rather than of an action, so it is true of whatever answer
 * the turn is asked for (invariant 13).
 *
 * The same text on both backends, because it is a section of the context
 * EO builds rather than a feature of either (invariant 12). The tool is
 * named as the memory section names `memory_read` — `eoToolName`, the one
 * spelling every provider advertises an `eo` tool under.
 */

export const MEMORY_WRITING_SECTION_HEADING = "## Writing memory";

const MEMORY_NOTE = eoToolName(MEMORY_NOTE_TOOL_NAME);
const MEMORY_READ = eoToolName(MEMORY_READ_TOOL_NAME);

/**
 * One line per scope a note may name, project first, as `checkMemoryNote`
 * accepts them.
 *
 * A container's line (EO-596) says when that scope is the one: what is
 * true only while the work filed under the container is in progress —
 * what the other items under it need after this one is finished, and
 * nobody will once all of it is — and what becomes of it at the end, so
 * an agent is not tempted to put such a fact in the project's scope for
 * good, nor a lasting one in a scope that ends.
 */
function scopeLines(scopes: readonly MemoryScopeInfo[]): string[] {
  return [
    ...scopes.filter((info) => info.scope.kind === "project").map((info) => `- \`${MEMORY_NOTE_PROJECT_SCOPE}\` — what is true across the whole project, ${info.name}.`),
    ...scopes.filter((info) => info.scope.kind === "workspace").map((info) => `- \`${info.scope.id}\` — what is true only of the workspace ${info.name}.`),
    ...scopes
      .filter((info) => info.scope.kind === "container")
      .map(
        (info) =>
          `- \`${info.scope.id}\` — what is only true while the work filed under ${info.name} is in progress: what the other items under it will need after this one is finished, and nobody will once all of it is. When every item under it is finished, EO moves what still holds to the project and retires the rest.`,
      ),
  ];
}

/**
 * The block, for a turn given these scopes. Null when there are none: the
 * `eo` server lists `memory_note` only for a turn with a scope to write
 * to, and a block about a tool the agent was not served would be the
 * thing invariant 12 forbids. Not null when every scope is empty — that
 * is when a first note is most worth writing.
 */
export function renderMemoryWritingSection(scopes: readonly MemoryScopeInfo[]): string | null {
  if (scopes.length === 0) return null;
  const limit = MAX_MEMORY_NOTE_CHARS.toLocaleString("en-US");
  return [
    MEMORY_WRITING_SECTION_HEADING,
    "",
    `You can write to this memory with \`${MEMORY_NOTE}\`. A note takes effect at once: later runs on other items are given it, and a person can edit or retire it.`,
    "",
    MEMORY_NOTE_DEFINITION,
    "",
    `One fact per note, in at most ${limit} characters. Two facts are two notes, so each can reach the run it bears on without the other.`,
    "",
    "Give each note the scope it is true of:",
    ...scopeLines(scopes),
    "",
    "Write only what you checked — a command you ran, a file you read, an answer a person gave — not what you suspect or expect. A note is believed by agents that cannot ask you where it came from.",
    "",
    `A note that corrects an entry memory holds, or says again what one already says, names that entry's id in \`${MEMORY_NOTE_REPLACES}\`. EO retires the entries it names when it writes the note, so the correction and what it corrects are not both given to later runs, and a fact is not kept twice; a person can restore one. Write the note to stand on its own, saying what is true now. Name only entries an agent wrote, in the scopes above — never a person's: say in your note what is true now, and leave theirs to them. An entry's id is beside it in the memory section, and in \`${MEMORY_READ}\`'s listing.`,
    "",
    `The note is written whatever else memory holds, and \`${MEMORY_NOTE}\`'s answer names the active entries in its scope closest to it, with their ids and bodies. Where one of them says the same as your note, or your note corrects it, write the note again as the answer says, naming in \`${MEMORY_NOTE_REPLACES}\` that entry and the note you just wrote. Where none does, or it is a person's, do nothing more.`,
    "",
    `Where your answer has a \`${MEMORY_USED_FIELD}\` field, list in it the id of every memory entry you were given and relied on in this work — one that changed what you did or saved you finding something out — and leave it empty where none did. Name only entries you were given; EO drops any other id. EO counts these, so an entry given to many runs and relied on by none is seen and can be retired.`,
    "",
    "Nothing about this run is a note: what it did or found, its progress, and its answer belong in your answer or on the item's thread, where they are read while they matter.",
  ].join("\n");
}
