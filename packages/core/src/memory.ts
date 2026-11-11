// Memory (EO-478, ARCHITECTURE.md, "What an agent is given").
//
// What an agent learns that is worth the next run knowing, kept as
// entries in EO's own database at three scopes — a project, one of its
// workspaces, and a container item whose work is in progress (EO-596) —
// rather than as a file in a repository. Every entry
// has a source, nothing is ever deleted (an edit or a retirement leaves
// the old row behind, retired), and a dispatch is given the entries that
// bear on its task rather than all of them.
//
// The schemas here are the boundary: the `memory:*` IPC channels, the
// answer a selection side call is held to, and the run event that says
// what a dispatch was given.

import { z } from "zod";
import { SKILL_SLUG_MAX_LENGTH, SKILL_SLUG_PATTERN } from "./skillSlugs.js";

/**
 * Where an entry is true: across a whole project, of one workspace in it,
 * or — `container` (EO-596) — only while the work filed under one
 * container item is in progress: what the items under it need from one
 * another, and nobody will once all of it is finished. A container
 * scope's id is the container item's. It is given to runs on the items
 * filed under that container and to no other, and when every one of them
 * is finished one consolidation (`container_done`) moves what still holds
 * to the project and retires the rest.
 */
export const MEMORY_SCOPE_KINDS = ["project", "workspace", "container"] as const;
export const MemoryScopeKindSchema = z.enum(MEMORY_SCOPE_KINDS);
export type MemoryScopeKind = z.infer<typeof MemoryScopeKindSchema>;

/** One scope: a project's id, a workspace's, or a container item's. */
export const MemoryScopeSchema = z.object({
  kind: MemoryScopeKindSchema,
  id: z.string().min(1),
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/** What a container scope is called (EO-596): its item's key and title, as the memory section heads it. */
export function containerScopeName(item: { key: string; title: string }): string {
  return `${item.key} ${item.title}`;
}

/**
 * Why an entry stopped being delivered. A closed set, because each is a
 * different thing a person reading the history needs told apart:
 *
 * - `edited` — somebody wrote a newer version; that version is the
 *   active row now, and this one is what it said before.
 * - `retired` — a person took it out of use.
 * - `consolidated` — EO folded it into a shorter set (EO-480), named by
 *   `consolidationId`.
 * - `moved_to_skill` — a consolidation's skill proposal was applied, and
 *   what this entry said is in that skill now (EO-483, EO-719). Tagged with
 *   the proposing consolidation's id, so restoring that consolidation
 *   brings it back.
 * - `superseded` — an agent's note named it as the entry it corrects or
 *   says again (EO-594), and was written in its place in the same
 *   transaction; that note's `supersededIds` names it. Only an entry an
 *   agent wrote is ever superseded, and a restore brings it back.
 */
export const MEMORY_RETIREMENT_REASONS = ["edited", "retired", "consolidated", "moved_to_skill", "superseded"] as const;
export const MemoryRetirementReasonSchema = z.enum(MEMORY_RETIREMENT_REASONS);
export type MemoryRetirementReason = z.infer<typeof MemoryRetirementReasonSchema>;

/**
 * Who wrote an entry: a person, or an agent's run on an item.
 *
 * A person's id is null on a solo installation, where there is one
 * person and nobody to tell them apart from. A run's entry is either a
 * note the agent wrote (`memory_note`) or one EO extracted from the run
 * after it ended, and `extracted` tells the two apart. A run's ids go null if the
 * item is deleted: the entry is the project's and outlives the item it
 * was learned on, but the source still says it was a run.
 */
export const MemorySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), personId: z.string().nullable() }),
  z.object({
    type: z.literal("run"),
    runId: z.string().nullable(),
    itemId: z.string().nullable(),
    /**
     * True when EO drew the entry out of what the run produced after it
     * ended (EO-479), rather than the agent writing it with `memory_note`.
     * Absent on a note the agent wrote itself.
     */
    extracted: z.literal(true).optional(),
  }),
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** One entry, as every reader sees it. */
export const MemoryEntryViewSchema = z.object({
  id: z.string(),
  scope: MemoryScopeSchema,
  body: z.string(),
  source: MemorySourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Null while the entry is active — delivered to dispatches and listed first. */
  retiredAt: z.number().nullable(),
  retiredReason: MemoryRetirementReasonSchema.nullable(),
  /** The consolidation that retired it, or that wrote it (EO-480). */
  consolidationId: z.string().nullable(),
  /**
   * A consolidation kept this entry although it disagrees with the
   * workspace's CLAUDE.md or AGENTS.md, because the entry is plainly newer
   * and says it corrects the file (EO-480). The file is never edited; this
   * is what tells a person the two disagree.
   */
  contradictsRepositoryFile: z.boolean(),
});
export type MemoryEntryView = z.infer<typeof MemoryEntryViewSchema>;

/**
 * One entry as it travels between a record and a replica (EO-482,
 * ARCHITECTURE.md, "The record").
 *
 * The view, and the project the entry belongs to. A workspace is a path
 * on somebody's disk and never travels, so a record holding a workspace's
 * entries has no workspace row to ask which project they are of; the
 * entry says so itself. Null only for a workspace with no project, whose
 * memory has no record to belong to.
 *
 * And the version an edit replaced (EO-545), and the entries a note
 * superseded (EO-594), so a replica holds an entry's history as its
 * record does. Defaulted, so an entry from a record or a queue written
 * before the fields existed still parses.
 */
export const RecordMemorySchema = MemoryEntryViewSchema.extend({
  projectId: z.string().nullable(),
  replacesId: z.string().nullable().default(null),
  supersededIds: z.array(z.string()).default([]),
});
export type RecordMemory = z.infer<typeof RecordMemorySchema>;

/**
 * The most an entry may hold. Generous — a paragraph is the usual size —
 * and there so one pasted log cannot be a scope's whole budget.
 */
export const MAX_MEMORY_ENTRY_CHARS = 4_000;

/** What a person writes: something to say, and not more than an entry holds. */
export const MemoryBodySchema = z.string().trim().min(1).max(MAX_MEMORY_ENTRY_CHARS);

export const MemoryListRequestSchema = z.object({
  scope: MemoryScopeSchema,
  /** Retired rows as well, newest first after the active ones. The history a person restores from. */
  includeRetired: z.boolean().optional(),
});
/**
 * How often an entry was given to a run, and how often a run said it
 * relied on it (EO-597, ARCHITECTURE.md §7.5).
 *
 * `deliveries` counts the runs whose `memory_delivered` events name the
 * entry; `uses` the runs whose `memory_used` event does — what an answer
 * listed in `memoryUsed`, less what the run was not given. Runs, not
 * events: a run given the entry twice was given it once. An entry given
 * often and never used is what these are for.
 */
export const MemoryUsageSchema = z.object({
  deliveries: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
});
export type MemoryUsage = z.infer<typeof MemoryUsageSchema>;

/** One entry as the Memory section lists it: the view, and its usage. */
export const MemoryListEntrySchema = MemoryEntryViewSchema.extend(MemoryUsageSchema.shape);
export type MemoryListEntry = z.infer<typeof MemoryListEntrySchema>;

export const MemoryListResponseSchema = z.object({ entries: z.array(MemoryListEntrySchema) });

export const MemoryAddRequestSchema = z.object({ scope: MemoryScopeSchema, body: MemoryBodySchema });
export const MemoryEditRequestSchema = z.object({ id: z.string().min(1), body: MemoryBodySchema });
export const MemoryEntryRequestSchema = z.object({ id: z.string().min(1) });

/**
 * What a write answers with: the entry as it now stands, or why nothing
 * was written — the id names no entry, an edit or a retirement was asked
 * of an entry already retired, a restore of one that is active, or the
 * scope names no project or workspace.
 */
export const MemoryWriteResultSchema = z.union([
  z.object({ ok: z.literal(true), entry: MemoryEntryViewSchema }),
  z.object({ ok: z.literal(false), problem: z.string() }),
]);
export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

// ── Delivery ─────────────────────────────────────────────────────

/**
 * At or under this many characters of candidates, a dispatch is given
 * every one of them and nothing is asked. A guardrail setting
 * (`GuardConfigView.memoryDeliveryChars`); this is its default, and also
 * what the fallback delivers up to when selection fails.
 */
export const DEFAULT_MEMORY_DELIVERY_CHARS = 4_000;

/** The most entries a selection may pick. */
export const MAX_SELECTED_MEMORIES = 8;

/** How long a selection may take before the dispatch goes on without it. */
export const MEMORY_SELECT_TIMEOUT_MS = 20_000;

/**
 * The answer a `memory_select` side call is held to: the ids of the
 * entries that will clearly help, at most eight, possibly none.
 */
export const MemorySelectionSchema = z.object({
  ids: z.array(z.string()).max(MAX_SELECTED_MEMORIES),
});
export type MemorySelection = z.infer<typeof MemorySelectionSchema>;

/**
 * How a dispatch's memory was chosen.
 *
 * - `all` — the candidates fitted under the threshold and every one was
 *   delivered; nothing was asked.
 * - `selected` — a selection side call picked them.
 * - `fallback` — selection was needed and did not run (it failed, timed
 *   out, or was refused), so the newest entries up to the threshold were
 *   delivered instead.
 * - `none` — there were no candidates.
 */
export const MEMORY_SELECTION_MODES = ["all", "selected", "fallback", "none"] as const;
export const MemorySelectionModeSchema = z.enum(MEMORY_SELECTION_MODES);
export type MemorySelectionMode = z.infer<typeof MemorySelectionModeSchema>;

/** The run event that records what a dispatch was given. */
export const MEMORY_DELIVERED_EVENT = "memory_delivered";

/**
 * Its payload: which entries, and whether selection ran. `reason` is the
 * side call's own sentence on a fallback, so "why did this run get the
 * newest entries?" has an answer in the run's log.
 */
export const MemoryDeliveredEventSchema = z.object({
  type: z.literal(MEMORY_DELIVERED_EVENT),
  entryIds: z.array(z.string()),
  candidateCount: z.number().int().nonnegative(),
  mode: MemorySelectionModeSchema,
  selectionRan: z.boolean(),
  reason: z.string().nullable(),
});
export type MemoryDeliveredEvent = z.infer<typeof MemoryDeliveredEventSchema>;

// ── What a run relied on (EO-597) ────────────────────────────────

/**
 * The answer field a run lists the entries it relied on in, by id.
 *
 * Optional: an answer that leaves it out says nothing about memory, which
 * is not the same as saying none was used, and no run is held back for
 * it. On the answer schemas that carry it — `implement` and `review`.
 */
export const MEMORY_USED_FIELD = "memoryUsed";

export const MemoryUsedSchema = z
  .array(z.string())
  .optional()
  .describe("The ids of the memory entries you were given and relied on in this work. Leave out any you were not given.");

/** The run event that records which delivered entries a run said it relied on. */
export const MEMORY_USED_EVENT = "memory_used";

/**
 * Its payload. `entryIds` are the answer's ids the run was given — by a
 * `memory_delivered` event of its own, or of an earlier run on the same
 * thread, whose memory is in the conversation it carries on — and they
 * are what is counted. `droppedIds` are the ones it was not given, kept
 * here so a run that names entries it never saw says so in its log rather
 * than vanishing from the count.
 */
export const MemoryUsedEventSchema = z.object({
  type: z.literal(MEMORY_USED_EVENT),
  entryIds: z.array(z.string()),
  droppedIds: z.array(z.string()),
});
export type MemoryUsedEvent = z.infer<typeof MemoryUsedEventSchema>;

// ── The `memory_read` tool ───────────────────────────────────────

export const MEMORY_READ_TOOL_NAME = "memory_read";

/**
 * A scope a turn may read with `memory_read`, as the `eo` server is told
 * it: the scope, and the name the memory section shows for it.
 */
export const MemoryReadScopeSchema = MemoryScopeSchema.extend({
  name: z.string(),
});
export type MemoryReadScope = z.infer<typeof MemoryReadScopeSchema>;

// ── The `memory_note` tool (EO-479) ──────────────────────────────

/**
 * The tool an agent writes to memory with, mid-run.
 *
 * Named here for the reason `ATTACHMENT_ADD_TOOL_NAME` is: the service
 * advertises it, the main process writes what the agent asks of it over
 * the agent write bridge (`agent-writes.ts`), an `allowedTools` entry
 * grants it, and extraction asks whether a run called it. `eoServer.mjs` repeats it and its test pins the two.
 */
export const MEMORY_NOTE_TOOL_NAME = "memory_note";

/**
 * What a note's scope says for the run's project. A workspace is named by
 * its id — and so may the project be: an agent shown the project's scope
 * id in its memory section writes that as often as it writes this word
 * (EO-543), and both mean the one project the run works in.
 */
export const MEMORY_NOTE_PROJECT_SCOPE = "project";

/**
 * The most a note may say. A quarter of what an entry may hold
 * (`MAX_MEMORY_ENTRY_CHARS`), because a person writes those and an agent
 * writes these mid-run: a note is one fact, not a report.
 */
export const MAX_MEMORY_NOTE_CHARS = 1_000;

/**
 * What a note is, and what is not one (EO-592) — the one definition,
 * used word for word by the extractor's prompt (`MEMORY_EXTRACT_SYSTEM`
 * in `memory/extraction.ts`) and by the memory instructions EO gives an
 * agent that may write memory, so changing it changes both.
 *
 * Written for a reader on an item, in no pack's words: "the work under
 * way" is whatever the item's runs are doing, and "after this item is
 * finished" is the test that tells it apart from what is true of the
 * project. Its two examples are real entries: the first was extracted
 * from a run that listed what was wrong with a change, and was fixed
 * within the hour; the second is a trap that holds for as long as the
 * code it names. Measured on both backends' small models by
 * `extraction.live.test.ts` — run it again before changing a word.
 */
export const MEMORY_NOTE_DEFINITION = [
  "A note is worth writing when a later agent, working on something else in this project, would get something wrong or lose time without it, and would not see it just by reading the code: how to build, run or test the project, and what the usual commands miss; a rule the whole project follows, for any change, not only this one; files that are generated, and from what; a trap that cost time; a decision a person made about how work is done here.",
  "",
  "The test a note must pass: would a later agent need this after this item is finished? What stops being true, or stops mattering, once the item is finished is not a note.",
  "",
  'So none of these is a note. What is wrong, missing or still to do in the work under way — a defect found in it, a gap it leaves, a check it fails, a fix it still needs — however it is worded, as a rule ("ensure…", "must…") or not: it is put right before the item is finished, or said in the run\'s answer. Anything that restates what the item asks for — its description or its acceptance criteria, in the same words or others: the item already says it. What the work did or changed, its progress, how many tests passed, and the item\'s status. What reading the code shows, such as what the code now says or where something is defined.',
  "",
  "Nor is a gap the work leaves when it is finished — something it was not asked to do, or left out, that is now missing — or something in the project that is wrong and should be put right, such as a comment or document that says the wrong thing, which a note would only work around. Say either in the run's answer, where whoever reads the work next can judge it: in memory it would be read by agents and seen by nobody. A trap in how the code works, which nobody has said should change, is still a note.",
  "",
  'Not a note: "Ensure module-created items remain trial-scoped, or refuse before writing." — a defect in the change under way, gone once it is fixed.',
  'A note: "deleteConversationItem must delete the conversation\'s rows before its first await; tests expect them gone when the call returns." — a trap for anyone touching that code, after this item as before it.',
].join("\n");

/**
 * The argument a note names the entries it replaces by (EO-594): the ids
 * of the entries it corrects, or says again. `memory_note` takes it, and
 * so does each note an extraction answers with.
 */
export const MEMORY_NOTE_REPLACES = "replaces";

/** One scope a run may write to, with the name it is shown under. */
export interface MemoryNoteScope {
  kind: MemoryScopeKind;
  id: string;
  name: string;
}

/**
 * Whether a note may be written, and where — the rules the main process
 * applies to a `memory_note` call handed over the agent write bridge
 * (EO-543), and that extraction applies to each note it proposes.
 *
 * `scope` is `project`, the project's own id, or the id of a workspace or
 * a container (EO-596) in `scopes`; anything else is a scope the run does
 * not work in — so a container's id is refused for a run on an item that
 * is not filed under it. The text is trimmed, must
 * say something, and may be at most `MAX_MEMORY_NOTE_CHARS`. `replaces`,
 * where given, is a list of entry ids (EO-594), answered once each and
 * trimmed; whether each names an active entry an agent wrote, in a scope
 * the run works in, is the database's to say (`noteMemory`), in the
 * transaction that retires them. A refusal is a sentence the agent can
 * act on.
 */
export function checkMemoryNote(
  note: { scope: unknown; text: unknown; replaces?: unknown },
  scopes: readonly MemoryNoteScope[],
): { ok: true; scope: MemoryScope; body: string; replaces: string[] } | { ok: false; problem: string } {
  if (typeof note.scope !== "string" || note.scope.trim() === "") {
    return { ok: false, problem: `A note needs a scope: "${MEMORY_NOTE_PROJECT_SCOPE}", or the id of a workspace or container this run works in.` };
  }
  if (typeof note.text !== "string" || note.text.trim() === "") return { ok: false, problem: "A note needs some text. Nothing was written." };
  const replaces = noteReplaces(note.replaces);
  if (replaces === null) {
    return { ok: false, problem: `\`${MEMORY_NOTE_REPLACES}\` is a list of the ids of memory entries this note replaces, each a non-empty string. Nothing was written.` };
  }
  const body = note.text.trim();
  if (body.length > MAX_MEMORY_NOTE_CHARS) {
    return {
      ok: false,
      problem: `The note is ${body.length.toLocaleString("en-US")} characters, and a note may be at most ${MAX_MEMORY_NOTE_CHARS.toLocaleString("en-US")}. Nothing was written; shorten it to the one fact worth keeping.`,
    };
  }
  const wanted = note.scope.trim();
  const scope =
    wanted === MEMORY_NOTE_PROJECT_SCOPE
      ? scopes.find((candidate) => candidate.kind === "project")
      : scopes.find((candidate) => candidate.id === wanted);
  if (!scope) {
    const others = scopes.filter((candidate) => candidate.kind !== "project");
    const choices = [
      ...(scopes.some((candidate) => candidate.kind === "project") ? [`"${MEMORY_NOTE_PROJECT_SCOPE}"`] : []),
      ...others.map((candidate) => `"${candidate.id}" (${candidate.name})`),
    ];
    return {
      ok: false,
      problem:
        choices.length === 0
          ? "This run has no memory to write to. Nothing was written."
          : `"${wanted}" is not a scope this run works in, so nothing was written. Use ${choices.join(" or ")}.`,
    };
  }
  return { ok: true, scope: { kind: scope.kind, id: scope.id }, body, replaces };
}

/** A note's `replaces`, trimmed and each id once — empty where absent, null where it is not a list of ids. */
function noteReplaces(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.trim() === "") return null;
    if (!ids.includes(id.trim())) ids.push(id.trim());
  }
  return ids;
}

// ── Extraction after a run (EO-479) ──────────────────────────────

/** How long the `memory_extract` side call may take. It runs while the run settles, so it is bounded. */
export const MEMORY_EXTRACT_TIMEOUT_MS = 60_000;

/** The most notes one extraction may write. */
export const MAX_EXTRACTED_NOTES = 5;

/** Below this many words of prose a run produced, there is nothing to extract from and nothing is asked. */
export const MIN_EXTRACTION_PROSE_WORDS = 50;

/**
 * The answer a `memory_extract` side call is held to: at most five
 * notes, each a scope as `memory_note` takes one and its text, or none.
 * A note's length is checked per note (`checkMemoryNote`) rather than
 * here, so one long note is dropped instead of failing the whole answer.
 *
 * Each note names the entries it replaces, as `memory_note` may (EO-594),
 * and is held to the same rules: an id that is not an active entry an
 * agent wrote, in a scope the run works in, drops that note and writes
 * nothing of it. Defaulted to none rather than optional, so the JSON
 * Schema a backend is held to lists it as required (as a strict
 * structured output needs) while an answer without it still parses.
 */
export const MemoryExtractionSchema = z.object({
  notes: z
    .array(
      z.object({
        scope: z.string(),
        text: z.string(),
        replaces: z.array(z.string()).default([]),
      }),
    )
    .max(MAX_EXTRACTED_NOTES),
});
export type MemoryExtraction = z.infer<typeof MemoryExtractionSchema>;

/**
 * The run event that records how a run's extraction ended (EO-511),
 * appended to the run's log once the call returns: so "this run learned
 * nothing worth keeping" stays told apart from "its notes were written"
 * and from "the call failed" after extraction is over. Not written for a
 * run extraction was never asked about — nothing was asked.
 */
export const MEMORY_EXTRACTED_EVENT = "memory_extracted";

/**
 * - `written` — the answer held at least one note; `entryIds` are the
 *   ones written and `dropped` the reasons the rest were refused, which
 *   may be all of them.
 * - `nothing_to_save` — the call was answered, and the answer held no
 *   notes.
 * - `failed` — the call did not answer; `reason` says why.
 * - `follow_ups_only` — no call makes this any more. Older runs' events
 *   hold it, and `run_events` is append-only (invariant 3).
 */
export const MEMORY_EXTRACTION_OUTCOMES = ["written", "nothing_to_save", "failed", "follow_ups_only"] as const;
export const MemoryExtractionOutcomeSchema = z.enum(MEMORY_EXTRACTION_OUTCOMES);
export type MemoryExtractionOutcome = z.infer<typeof MemoryExtractionOutcomeSchema>;

export const MemoryExtractedEventSchema = z.object({
  type: z.literal(MEMORY_EXTRACTED_EVENT),
  outcome: MemoryExtractionOutcomeSchema,
  entryIds: z.array(z.string()),
  dropped: z.array(z.string()),
  /** A failed call's reason and sentence, as `reason: sentence`; null otherwise. */
  reason: z.string().nullable(),
});
export type MemoryExtractedEvent = z.infer<typeof MemoryExtractedEventSchema>;

// ── The learning review (EO-717) ─────────────────────────────────

/**
 * How long the learning review may take: the one turn on a fork of the
 * run's thread, from the fork being asked for to its last event. It runs
 * while the run settles, holding the run's slot, so it is bounded; past
 * this it is stopped and recorded as `failed`.
 */
export const LEARNING_REVIEW_TIMEOUT_MS = 5 * 60_000;

/**
 * The run event that records how a run's learning review ended (EO-717),
 * appended to the run's log once the review — or the extraction it fell
 * back to — has returned. Not written for a run the review was never
 * asked about: one cancelled, interrupted, on a preview, or with no
 * memory scope. A run that called `memory_note` itself is asked about
 * skills alone (EO-731), and its event says so.
 */
export const LEARNING_REVIEW_EVENT = "learning_review";

/**
 * - `written` — the review turn wrote at least one note or skill;
 *   `entryIds` are the entries it wrote and `skillIds` the skills.
 * - `nothing_to_save` — the turn ended and wrote nothing.
 * - `failed` — the fork was opened and its turn did not end well: it
 *   failed, was stopped at `LEARNING_REVIEW_TIMEOUT_MS`, or EO shut down
 *   under it. `entryIds` are any notes written before it stopped.
 * - `fell_back` — the thread could not be forked (no thread, a lost one,
 *   a backend that cannot fork, or the fork refused). After a full
 *   review `memory_extract` ran instead and its `memory_extracted` event
 *   says how that went; after a skill-only one nothing ran in its place,
 *   since extraction writes memory alone and the run wrote its own.
 */
export const LEARNING_REVIEW_OUTCOMES = ["written", "nothing_to_save", "failed", "fell_back"] as const;
export const LearningReviewOutcomeSchema = z.enum(LEARNING_REVIEW_OUTCOMES);
export type LearningReviewOutcome = z.infer<typeof LearningReviewOutcomeSchema>;

/**
 * Which learning review a run was asked for (EO-731):
 * - `full` — memory and skills: served `memory_read`, `memory_note` and
 *   the skill tools.
 * - `skills_only` — the skill half alone, for a run that called
 *   `memory_note` itself: served `memory_read` and the skill tools, and
 *   not `memory_note`.
 */
export const LEARNING_REVIEW_KINDS = ["full", "skills_only"] as const;
export const LearningReviewKindSchema = z.enum(LEARNING_REVIEW_KINDS);
export type LearningReviewKind = z.infer<typeof LearningReviewKindSchema>;

export const LearningReviewEventSchema = z.object({
  type: z.literal(LEARNING_REVIEW_EVENT),
  outcome: LearningReviewOutcomeSchema,
  /** Which review it was (EO-731). Defaulted for an event written before there was more than one: those were all full. */
  review: LearningReviewKindSchema.default("full"),
  /** The memory entries the review turn wrote, in the order written. */
  entryIds: z.array(z.string()),
  /**
   * The skills the review turn created or changed (EO-718), each once, in
   * the order first written. Every one of those writes is a
   * `skill_versions` row naming the run. Defaulted for an event written
   * before reviews wrote skills.
   */
  skillIds: z.array(z.string()).default([]),
  /** Why it failed or fell back, in a sentence; null otherwise. */
  reason: z.string().nullable(),
  /** The fork's thread, where one was opened; null on a fallback. Never the item's own thread. */
  forkThreadId: z.string().nullable(),
  /**
   * How the backend copied the thread (EO-732): `prediction` for Codex's
   * cache-keeping fork, `plain` for its ordinary one. Absent where no
   * fork was opened, on Claude, which has one way to fork, and on events
   * written before EO-732, so those events read as they always did.
   */
  forkMode: z.enum(["prediction", "plain"]).optional(),
  /** Why Codex fell back to the plain fork, in its own words. Absent otherwise. */
  forkFallbackReason: z.string().optional(),
});
export type LearningReviewEvent = z.infer<typeof LearningReviewEventSchema>;

// ── Consolidation (EO-480) ───────────────────────────────────────

/**
 * The most active entries one scope holds before it is consolidated. A
 * guardrail setting (`GuardConfigView.memoryScopeMaxEntries`); this is its
 * default.
 */
export const DEFAULT_MEMORY_SCOPE_MAX_ENTRIES = 200;

/**
 * The most characters of active entries one scope holds before it is
 * consolidated. A guardrail setting (`GuardConfigView.memoryScopeMaxChars`);
 * this is its default.
 */
export const DEFAULT_MEMORY_SCOPE_MAX_CHARS = 40_000;

/** How long after a scope's last consolidation the scheduled one may come round. */
export const MEMORY_CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How many runs must have been given a scope's memory since its last consolidation for the scheduled one. */
export const MEMORY_CONSOLIDATION_MIN_RUNS = 5;

/**
 * How long one of consolidation's side calls may take — a batch, either
 * call of the cross-batch pass, or the skill proposal call after them —
 * waiting for its concurrency slot included (EO-577). It holds the global
 * slot for all of it, but it starts only when the pipeline is idle, so
 * the wait for the slot is nearly nothing. Three minutes (EO-591): in
 * line with `MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS` at the speed the
 * slowest model writes (about 125 tokens a second), so neither limit
 * cuts a call off at half of what the other allows — at 90 seconds a
 * batch was cut off at 11,000 tokens, and one that passed took 88.7.
 */
export const MEMORY_CONSOLIDATE_TIMEOUT_MS = 180 * 1000;

/**
 * The most output tokens one of consolidation's side calls may write
 * before it is cut off and recorded as a timeout (EO-577). A batch is at
 * most about 15,000 characters of entries, and an answer naming only
 * what changes is a fraction of that; the answers that never came back
 * ran to 35,000 to 77,000 tokens. Held by EO (`sideCalls/sideCall.ts`),
 * the same on both backends, counting the answer's streamed words as
 * one token a byte of UTF-8 — every token of a byte-level tokenizer, as
 * both backends' models use, stands for at least one byte, so the count
 * is never below the tokens actually written, however much code,
 * punctuation or non-Latin text the answer holds — or the output tokens the backend
 * reports, whichever is larger. Reasoning a backend never streams is
 * bounded by the time limit and by those reports alone.
 */
export const MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS = 24_000;

/**
 * Why a consolidation was queued.
 *
 * - `cap` — the scope reached its entry or character cap.
 * - `schedule` — a day has passed since the last one and at least five
 *   runs have been given the scope's memory since.
 * - `manual` — a person asked for it (`memory:consolidateNow`, EO-589),
 *   whether or not the scope was due and however it was backing off.
 * - `container_done` — every item filed under a container has finished
 *   (EO-596): its container scope's entries are told the work is over,
 *   what will still hold is written to the project as new entries, and
 *   the rest are retired as `consolidated`. Queued once per finish, and
 *   only for a container scope holding an entry an agent wrote.
 */
export const MEMORY_CONSOLIDATION_TRIGGERS = ["cap", "schedule", "manual", "container_done"] as const;
export const MemoryConsolidationTriggerSchema = z.enum(MEMORY_CONSOLIDATION_TRIGGERS);
export type MemoryConsolidationTrigger = z.infer<typeof MemoryConsolidationTriggerSchema>;

/**
 * Where a consolidation stands.
 *
 * - `running` — its side call is waiting for a slot or being answered.
 * - `succeeded` — it retired what it replaced and wrote what it returned.
 * - `failed` — its side call failed or answered outside its schema, and
 *   memory was left as it was. Asked again later, with backoff.
 * - `skipped` — there was nothing it may rewrite: the scope is over a cap
 *   on the strength of people's entries alone, which are never rewritten.
 * - `restored` — it succeeded, and a person has since put back the set
 *   from before it.
 */
export const MEMORY_CONSOLIDATION_STATUSES = ["running", "succeeded", "failed", "skipped", "restored"] as const;
export const MemoryConsolidationStatusSchema = z.enum(MEMORY_CONSOLIDATION_STATUSES);
export type MemoryConsolidationStatus = z.infer<typeof MemoryConsolidationStatusSchema>;

/** One consolidation, as a reader sees it. */
export const MemoryConsolidationViewSchema = z.object({
  /** Also the id every entry it retired or wrote is tagged with. */
  id: z.string(),
  scope: MemoryScopeSchema,
  trigger: MemoryConsolidationTriggerSchema,
  status: MemoryConsolidationStatusSchema,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** When a person put back the set from before it. */
  restoredAt: z.number().nullable(),
  /** The entries it retired. */
  retiredIds: z.array(z.string()),
  /** The entries it wrote. */
  writtenIds: z.array(z.string()),
  /** What a person should know: why it failed or was skipped, or that people's entries alone exceed a cap. */
  note: z.string().nullable(),
});
export type MemoryConsolidationView = z.infer<typeof MemoryConsolidationViewSchema>;

/** The most a consolidation's reason for retiring an entry may say. */
export const MAX_MEMORY_RETIRE_REASON_CHARS = 300;

/**
 * The operations a `memory_consolidate` side call answers with (EO-573):
 * what changes, and nothing else. An entry it does not name stays exactly
 * as it is. The checks one particular call adds — every id one it was
 * given, none named twice, and an answer that does not grow the scope —
 * are `consolidationAnswerSchema` in the main process.
 */

/** Retire one entry it was given, saying why: stale, contradicted, a duplicate, or derivable from the code. */
export const MemoryConsolidationRetireSchema = z.object({
  id: z.string(),
  reason: z.string().trim().min(1).max(MAX_MEMORY_RETIRE_REASON_CHARS),
});
export type MemoryConsolidationRetire = z.infer<typeof MemoryConsolidationRetireSchema>;

/**
 * What a merge or rewrite may say: one fact, as a note may (EO-591). A
 * merge that would run longer bundles facts selection can only deliver
 * whole, so the answer that holds one is refused as `schema`; the prompt
 * tells the model to split a topic into separate facts instead.
 */
const consolidatedBody = z.string().trim().min(1).max(MAX_MEMORY_NOTE_CHARS);
/** It disagrees with the workspace's CLAUDE.md or AGENTS.md and is kept because it is plainly newer and says it corrects the file. */
const contradictsRepositoryFile = z.boolean();

/** Fold two or more entries it was given into one new one, which keeps the age and source of the newest it replaces. */
export const MemoryConsolidationMergeSchema = z.object({
  /** The ids of the given entries it replaces: at least two. */
  from: z.array(z.string()).min(2),
  body: consolidatedBody,
  contradictsRepositoryFile,
});
export type MemoryConsolidationMerge = z.infer<typeof MemoryConsolidationMergeSchema>;

/** Replace one entry it was given with a new wording, which keeps that entry's age and source. */
export const MemoryConsolidationRewriteSchema = z.object({
  id: z.string(),
  body: consolidatedBody,
  contradictsRepositoryFile,
});
export type MemoryConsolidationRewrite = z.infer<typeof MemoryConsolidationRewriteSchema>;

/** The three lists of an answer: what applying one takes. All three empty is a valid answer that changes nothing. */
export const MemoryConsolidationOperationsSchema = z.object({
  retire: z.array(MemoryConsolidationRetireSchema),
  merge: z.array(MemoryConsolidationMergeSchema),
  rewrite: z.array(MemoryConsolidationRewriteSchema),
});
export type MemoryConsolidationOperations = z.infer<typeof MemoryConsolidationOperationsSchema>;

/**
 * What the cross-batch pass's first call answers with (EO-574): groups of
 * entries that may say the same thing, read off their ids and first lines
 * alone. Only candidates — a second call, given their full bodies,
 * decides what to merge. Every id one it was given and none named twice
 * are `mergeCandidatesSchema` in the main process.
 */
export const MemoryMergeCandidatesSchema = z.object({
  groups: z.array(
    z.object({
      /** Entries that look like they say the same thing, or parts of one thing: at least two. */
      ids: z.array(z.string()).min(2),
    }),
  ),
});
export type MemoryMergeCandidates = z.infer<typeof MemoryMergeCandidatesSchema>;

// ── Skill proposals (EO-483) ─────────────────────────────────────

/** The most skills one skill proposal call may propose (EO-575). */
export const MAX_SKILL_PROPOSALS = 3;

/** The most a proposal's description may say: one line, which is what the model chooses a skill by. */
export const MAX_SKILL_PROPOSAL_DESCRIPTION_CHARS = 300;

/** The most a proposed SKILL.md body may hold. */
export const MAX_SKILL_PROPOSAL_BODY_CHARS = 12_000;

/** The sections every proposed body has, in this order of importance: when to use it, what to do, how to know it worked. */
export const SKILL_PROPOSAL_SECTIONS = ["Trigger", "Steps", "Verification"] as const;

/** Whether a markdown body has a heading of its own for `section` — `## Trigger`, at any level. */
export function hasSkillSection(body: string, section: string): boolean {
  return new RegExp(`^#{1,6}[ \\t]+${section}[ \\t]*:?[ \\t]*$`, "im").test(body);
}

/** Where a procedure was seen: the entries it was given that hold it, and the items those entries were written on. */
export const SkillProposalEvidenceSchema = z.object({
  entryIds: z.array(z.string()).min(1),
  itemIds: z.array(z.string()),
});
export type SkillProposalEvidence = z.infer<typeof SkillProposalEvidenceSchema>;

const proposalFields = {
  /** The skill's slug: what a model invokes, and the folder it is delivered in. For an improvement, its target's. */
  slug: z.string().max(SKILL_SLUG_MAX_LENGTH).regex(SKILL_SLUG_PATTERN, "must be lowercase letters and digits with single hyphens between them"),
  /** What a person calls it. */
  name: z.string().trim().min(1).max(80),
  /** One line, and the trigger the model chooses the skill by. */
  description: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SKILL_PROPOSAL_DESCRIPTION_CHARS)
    .refine((text) => !/[\r\n]/.test(text), "must be one line"),
  /** The memory scope that was being consolidated. */
  scope: MemoryScopeSchema,
  evidence: SkillProposalEvidenceSchema,
  /**
   * The SKILL.md draft below its frontmatter, which EO writes from the
   * slug and description so the two cannot disagree. It has a Trigger, a
   * Steps and a Verification section.
   */
  body: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SKILL_PROPOSAL_BODY_CHARS)
    .superRefine((body, ctx) => {
      for (const section of SKILL_PROPOSAL_SECTIONS) {
        if (!hasSkillSection(body, section)) ctx.addIssue({ code: "custom", message: `has no "## ${section}" section` });
      }
    }),
};

/**
 * One skill a consolidation proposes, from a procedure that keeps
 * appearing in a scope's memory: a new skill, or an improvement to one
 * that exists — in the same scope, or a global one — named by its slug
 * in `target`. An improvement without a target is not one.
 *
 * Applied as it arrives, with no person's approval (EO-719): a skill is
 * instructions, which agents may write (invariant 11). What answers for
 * it is the skill's version history, a person's lock, and archiving it —
 * which, for a skill a consolidation created, keeps its scope and slug
 * from being created again.
 */
export const SkillProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), ...proposalFields }),
  z.object({
    kind: z.literal("improvement"),
    /** The slug of the existing skill it improves. */
    target: z.string().min(1),
    ...proposalFields,
  }),
]);
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

/**
 * A proposal's fingerprint: its scope, its slug and its description
 * normalised — lowercased, with punctuation and runs of space folded —
 * so the same proposal worded a little differently has the same one.
 * Kept on every proposal's row.
 *
 * A discarded one is not matched by it (EO-512): a person who discarded
 * a proposal turned down its scope and slug, and a model rewords a
 * description freely, so a discard holds back every later proposal with
 * that scope and slug whatever its description says.
 */
export function skillProposalFingerprint(proposal: { scope: MemoryScope; slug: string; description: string }): string {
  const description = proposal.description
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${proposal.scope.kind}:${proposal.scope.id}:${proposal.slug.trim().toLowerCase()}:${description}`;
}

/**
 * What became of a proposal: `saved` once a consolidation applied it
 * (EO-719). `open` and `discarded` are only on rows written before then,
 * when a person answered Save or Discard; a `discarded` one still holds
 * its scope and slug back.
 */
export const SKILL_PROPOSAL_STATUSES = ["open", "saved", "discarded"] as const;
export const SkillProposalStatusSchema = z.enum(SKILL_PROPOSAL_STATUSES);
export type SkillProposalStatus = z.infer<typeof SkillProposalStatusSchema>;

/**
 * A consolidation's answer: its operations, and nothing else (EO-575).
 * Skill proposals are not in it — they are asked for in a call of their
 * own once a consolidation has succeeded (`MemorySkillProposalsAnswerSchema`),
 * so a scope's answer never has to carry whole SKILL.md drafts beside its
 * changes.
 */
export const MemoryConsolidationAnswerSchema = MemoryConsolidationOperationsSchema;
export type MemoryConsolidationAnswer = MemoryConsolidationOperations;

/**
 * One fact a `container_done` consolidation keeps (EO-596): the container
 * entries it is drawn from — one, or several saying parts of one thing —
 * and what it says, written to the project as a new entry. At most
 * `MAX_MEMORY_NOTE_CHARS`, as a merge or rewrite is.
 */
export const MemoryContainerKeepSchema = z.object({
  /** The ids of the given entries it is drawn from: at least one. */
  from: z.array(z.string()).min(1),
  body: consolidatedBody,
});
export type MemoryContainerKeep = z.infer<typeof MemoryContainerKeepSchema>;

/**
 * What a `container_done` consolidation answers with (EO-596): the facts
 * that will still hold now the container's work is finished, each to be
 * written to the project. Every entry it was given that no kept fact is
 * drawn from is retired. Empty is a valid answer — nothing outlasts the
 * work — and retires them all. The checks one call adds — every id one it
 * was given, none named twice — are `containerDoneAnswerSchema` in the
 * main process.
 */
export const MemoryContainerDoneAnswerSchema = z.object({
  keep: z.array(MemoryContainerKeepSchema),
});
export type MemoryContainerDoneAnswer = z.infer<typeof MemoryContainerDoneAnswerSchema>;

/**
 * What the skill proposal call answers with (EO-575): up to three skills,
 * from procedures that keep appearing in a scope's memory, asked after a
 * consolidation of the scope has succeeded. Empty when there are none,
 * which is most of the time. The checks one particular call adds — its
 * scope, evidence it was given, one slug once — are
 * `skillProposalsAnswerSchema` in the main process.
 */
export const MemorySkillProposalsAnswerSchema = z.object({
  skills: z.array(SkillProposalSchema).max(MAX_SKILL_PROPOSALS),
});
export type MemorySkillProposalsAnswer = z.infer<typeof MemorySkillProposalsAnswerSchema>;

/** Puts back the set from before a consolidation: what it retired comes back, and what it wrote is retired. */
export const MemoryRestoreConsolidationRequestSchema = z.object({ consolidationId: z.string().min(1) });
export const MemoryRestoreConsolidationResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    consolidation: MemoryConsolidationViewSchema,
    restored: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
    /**
     * Every entry the restore changed (EO-546): those it made active again
     * — what the consolidation retired, and evidence a skill it proposed
     * took (`moved_to_skill`), which is in neither of its id lists — and
     * those it retired. Defaulted, so an answer from a record written
     * before the field existed still parses.
     */
    changedIds: z.array(z.string()).default([]),
  }),
  z.object({ ok: z.literal(false), problem: z.string() }),
]);
export type MemoryRestoreConsolidationResult = z.infer<typeof MemoryRestoreConsolidationResultSchema>;

/**
 * One consolidation as a list of them reads it (EO-545): the view, and
 * its figures counted — how many entries it replaced (retired) and
 * produced (wrote), and whether a person has put back the set from
 * before it.
 */
export const MemoryConsolidationSummarySchema = MemoryConsolidationViewSchema.extend({
  replacedCount: z.number().int().nonnegative(),
  producedCount: z.number().int().nonnegative(),
  restored: z.boolean(),
});
export type MemoryConsolidationSummary = z.infer<typeof MemoryConsolidationSummarySchema>;

/** The figures a list of consolidations carries, counted off the view. */
export function summariseConsolidation(view: MemoryConsolidationView): MemoryConsolidationSummary {
  return { ...view, replacedCount: view.retiredIds.length, producedCount: view.writtenIds.length, restored: view.restoredAt !== null };
}

/** A scope's consolidations, newest first: what a person restores from. */
export const MemoryConsolidationsRequestSchema = z.object({
  scope: MemoryScopeSchema.describe("The scope: kind project, workspace or container, and its id — as memories_search answers it."),
});
export const MemoryConsolidationsResponseSchema = z.object({
  consolidations: z.array(MemoryConsolidationSummarySchema),
  /**
   * Whether a consolidation of the scope is waiting its turn (`queued`) or
   * going (`running`) in this process now, or neither (EO-589): what the
   * Memory section's Consolidate now button is disabled for. Null where no
   * engine runs here, and for a scope an organisation's record
   * consolidates. Defaulted, so an answer from before it still parses.
   */
  pending: z.enum(["queued", "running"]).nullable().default(null),
});

/**
 * A person asking for one scope to be consolidated now (EO-589), rather
 * than waiting for it to be due — `memory_consolidate_now`'s channel too.
 */
export const MemoryConsolidateNowRequestSchema = z.object({
  scope: MemoryScopeSchema.describe("The scope: kind project, workspace or container, and its id — as memories_search answers it."),
});

/**
 * Why a request to consolidate a scope now queued nothing (EO-589).
 *
 * - `paused` — the engine is paused, and no consolidation starts while it is.
 * - `no_agent_entries` — the scope holds no active entry an agent wrote; a
 *   person's are never consolidated.
 * - `unknown_scope` — no project, workspace or container has that id.
 * - `held_by_record` — the scope's project is held by an organisation's
 *   record, which consolidates it; this desktop leaves it alone (EO-482).
 * - `unavailable` — no engine runs in this process, or it is stopping.
 */
export const MEMORY_CONSOLIDATE_NOW_REFUSALS = ["paused", "no_agent_entries", "unknown_scope", "held_by_record", "unavailable"] as const;
export const MemoryConsolidateNowRefusalSchema = z.enum(MEMORY_CONSOLIDATE_NOW_REFUSALS);
export type MemoryConsolidateNowRefusal = z.infer<typeof MemoryConsolidateNowRefusalSchema>;

/**
 * What came of asking for a scope to be consolidated now (EO-589), as a
 * sentence (`message`) and as a typed result:
 *
 * - `started` — it is running now.
 * - `queued` — it starts once what it is `behind` is done: pipeline work
 *   waiting or going (it starts once the pipeline is idle), or another
 *   scope's consolidation (they run one at a time).
 * - `already` — one of the scope is already `queued` or `running`, and
 *   nothing was added.
 * - `refused` — nothing was queued, for `reason`.
 *
 * How it ended is `memory:consolidations`, once it has.
 */
export const MemoryConsolidateNowResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started"), message: z.string() }),
  z.object({ outcome: z.literal("queued"), behind: z.enum(["pipeline", "consolidation"]), message: z.string() }),
  z.object({ outcome: z.literal("already"), state: z.enum(["queued", "running"]), message: z.string() }),
  z.object({ outcome: z.literal("refused"), reason: MemoryConsolidateNowRefusalSchema, message: z.string() }),
]);
export type MemoryConsolidateNowResult = z.infer<typeof MemoryConsolidateNowResultSchema>;

/**
 * A place in a scope's consolidations, newest first: the one a page ended
 * on (EO-545). Strictly older than it is the next page.
 */
export const MemoryConsolidationCursorSchema = z.object({ startedAt: z.number(), id: z.string() });
export type MemoryConsolidationCursor = z.infer<typeof MemoryConsolidationCursorSchema>;

/** The most consolidations one page of `record:memoryConsolidations` answers. */
export const MAX_RECORD_CONSOLIDATIONS_PAGE = 200;

/**
 * A page of a scope's consolidations, as a replica asks its record for
 * them (EO-545): from the newest, or from strictly older than `before`.
 * A record from before paging ignores both and answers its first page,
 * which says there is no next one.
 */
export const RecordMemoryConsolidationsRequestSchema = MemoryConsolidationsRequestSchema.extend({
  before: MemoryConsolidationCursorSchema.optional(),
  limit: z.number().int().positive().max(MAX_RECORD_CONSOLIDATIONS_PAGE).optional(),
});

/**
 * The same list as a record answers a replica (EO-482), a page at a
 * time: the views alone, as they have always travelled, so a record and
 * a desktop a release apart still understand each other. The desktop
 * counts the figures, and reads every page.
 */
export const RecordMemoryConsolidationsResponseSchema = z.object({
  consolidations: z.array(MemoryConsolidationViewSchema),
  /**
   * Where the next page starts, or null on the last (EO-545). Defaulted,
   * so a record that answers the whole list in one page — or one from
   * before paging — reads as the last page.
   */
  next: MemoryConsolidationCursorSchema.nullable().default(null),
});

// ── Searching and reading entries (EO-545) ───────────────────────

/**
 * Where an entry stands, as a search filters on it: delivered
 * (`active`), retired by a person, by an edit, into a skill or by a note
 * that superseded it (`retired`), or retired by a consolidation folding it into fewer
 * (`consolidated`). One of the three for every entry; `retiredReason`
 * says which kind of `retired` it was.
 */
export const MEMORY_ENTRY_STATES = ["active", "retired", "consolidated"] as const;
export const MemoryEntryStateSchema = z.enum(MEMORY_ENTRY_STATES);
export type MemoryEntryState = z.infer<typeof MemoryEntryStateSchema>;

/** The state an entry is in, from its retirement. */
export function memoryEntryState(entry: { retiredAt: number | null; retiredReason: MemoryRetirementReason | null }): MemoryEntryState {
  if (entry.retiredAt === null) return "active";
  return entry.retiredReason === "consolidated" ? "consolidated" : "retired";
}

/**
 * The shortest word approximate search matches on. The index is of
 * three-character pieces of text, so a shorter word has none to look up.
 */
export const MEMORY_SEARCH_MIN_WORD_CHARS = 3;

/** The most a search query may say. */
export const MAX_MEMORY_SEARCH_QUERY_CHARS = 500;

/**
 * A query's words as approximate search reads them: runs of letters and
 * digits, folded to lower case, and only those long enough to match on.
 */
export function memorySearchWords(query: string): string[] {
  const words = query.normalize("NFKC").toUpperCase().toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => Array.from(word).length >= MEMORY_SEARCH_MIN_WORD_CHARS))];
}

/**
 * Which entries `memory:search` answers with (EO-545). Every filter is
 * optional, and every one given must hold. With none, every entry EO
 * holds, retired ones included, newest first.
 */
export const MemorySearchRequestSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(MAX_MEMORY_SEARCH_QUERY_CHARS)
    .refine((query) => memorySearchWords(query).length > 0, {
      message: `query needs at least one word of ${MEMORY_SEARCH_MIN_WORD_CHARS} or more letters or digits; for a shorter one, use where with contains on body.`,
    })
    .optional()
    .describe(
      "Approximate text search over entry bodies: finds part of a word (windo finds Windows), other forms of it (rerun finds reruns) " +
        "and small misspellings. Matches are ranked best first by bm25 and carry a score; without it, newest first.",
    ),
  scopeKind: MemoryScopeKindSchema.optional().describe("Only entries of this kind of scope: project, workspace or container."),
  scopeId: z.string().min(1).optional().describe("Only entries in the scope with this id — a project's id, a workspace's or a container item's."),
  scopeName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Only entries in a scope with this name, ignoring case: a project's name, or a workspace's as EO shows it."),
  projectId: z.string().min(1).optional().describe("Only entries of this project: its own scope and its workspaces'."),
  sourceKind: z.enum(["person", "run"]).optional().describe("Only entries a person wrote, or only entries from an agent's run."),
  runId: z.string().min(1).optional().describe("Only entries from this run."),
  itemId: z.string().min(1).optional().describe("Only entries from runs on this item."),
  extracted: z
    .boolean()
    .optional()
    .describe("true for only the entries EO drew out of a run after it ended; false for every other entry."),
  state: MemoryEntryStateSchema.optional().describe(
    "Only entries in this state: active (delivered to runs), retired (by a person, an edit, a skill or a note that superseded it) or consolidated (retired by a consolidation).",
  ),
  contradictsRepositoryFile: z
    .boolean()
    .optional()
    .describe("true for only the entries a consolidation kept although they disagree with the workspace's CLAUDE.md or AGENTS.md."),
  createdSince: z.number().int().nonnegative().optional().describe("Only entries created at or after this moment, in epoch milliseconds."),
  createdUntil: z.number().int().nonnegative().optional().describe("Only entries created before this moment, in epoch milliseconds."),
  updatedSince: z.number().int().nonnegative().optional().describe("Only entries last changed at or after this moment, in epoch milliseconds."),
  updatedUntil: z.number().int().nonnegative().optional().describe("Only entries last changed before this moment, in epoch milliseconds."),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

/**
 * Who wrote an entry, as a search answers it: `MemorySourceSchema`, with
 * the run's item named by its key as well as its id. Null key and ids
 * once the item is deleted.
 */
export const MemorySearchSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), personId: z.string().nullable() }),
  z.object({ type: z.literal("run"), runId: z.string().nullable(), itemId: z.string().nullable(), itemKey: z.string().nullable() }),
]);
export type MemorySearchSource = z.infer<typeof MemorySearchSourceSchema>;

/** One entry as a search, or a read of one, answers it (EO-545). */
export const MemorySearchEntrySchema = z.object({
  id: z.string(),
  /** The scope, with what EO calls it — null for a workspace or container this database has no row of. */
  scope: MemoryScopeSchema.extend({ name: z.string().nullable() }),
  /** The project the entry belongs to: its own scope's, its workspace's, or its container item's. */
  projectId: z.string().nullable(),
  body: z.string(),
  source: MemorySearchSourceSchema,
  /** Drawn out of a run after it ended (EO-479), rather than written by an agent or a person. */
  extracted: z.boolean(),
  state: MemoryEntryStateSchema,
  retiredAt: z.number().nullable(),
  retiredReason: MemoryRetirementReasonSchema.nullable(),
  consolidationId: z.string().nullable(),
  contradictsRepositoryFile: z.boolean(),
  /** The earlier version this one replaced through an edit; null for an entry no edit wrote. */
  replacesId: z.string().nullable(),
  /**
   * The entries this note replaced (EO-594): retired as `superseded` when
   * it was written, and named here for good, a restore of one since
   * included. Empty for every entry that named none.
   */
  supersededIds: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** How many runs were given it, and how many said they relied on it (EO-597). */
  deliveries: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
  /** How well it matched the query, higher better: bm25's, negated. Present only when a query was given. */
  score: z.number().optional(),
});
export type MemorySearchEntry = z.infer<typeof MemorySearchEntrySchema>;

export const MemorySearchResponseSchema = z.object({ entries: z.array(MemorySearchEntrySchema) });

export const MemoryGetRequestSchema = z.object({ id: z.string().min(1).describe("The entry's id, as memories_search answers it.") });

/**
 * One entry in full, with its history (EO-545): the earlier versions it
 * replaced through edits, newest first and each the one the version
 * before it replaced; the entries it superseded as a note (EO-594), as it
 * named them; the consolidation that wrote it, if one did; and the newest
 * consolidation that retired it, if one did — restored since, where
 * `restored` says so.
 */
export const MemoryGetResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    entry: MemorySearchEntrySchema,
    replaced: z.array(MemorySearchEntrySchema),
    superseded: z.array(MemorySearchEntrySchema),
    producedBy: MemoryConsolidationSummarySchema.nullable(),
    retiredBy: MemoryConsolidationSummarySchema.nullable(),
  }),
  z.object({ ok: z.literal(false), problem: z.string() }),
]);
export type MemoryGetResponse = z.infer<typeof MemoryGetResponseSchema>;

// ── Organisation mode (EO-482) ───────────────────────────────────

/**
 * A write to memory, as a desktop asks it of the record that holds the
 * project (EO-482, ARCHITECTURE.md, "The record").
 *
 * Asking rather than telling, for `record:createItem`'s reason: a project
 * the record holds has its memory there, and an entry written to a
 * replica would be one the organisation never receives. So each of these
 * is a round trip, and a record that cannot be reached means nothing was
 * written.
 *
 * - `note` — an agent's note, or one extraction drew out of a run, with
 *   the run and its item as its source. The record holds it to
 *   `checkMemoryNote` against the item's own project, and each entry it
 *   `replaces` (EO-594) to being an active entry an agent wrote of that
 *   project — which of its workspaces the run works in is the device's
 *   word, and the device has held it to that before asking.
 * - `add`, `edit`, `retire`, `restore` — a person's, as the `memory:*`
 *   channels take them. The record names the person from the device that
 *   asked. `add` carries the project, because a workspace's entries are
 *   held where the workspace itself is not.
 */
export const RecordMemoryWriteSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("note"),
    itemId: z.string().min(1),
    scope: MemoryScopeSchema,
    body: z.string().max(MAX_MEMORY_ENTRY_CHARS),
    extracted: z.boolean().default(false),
    replaces: z.array(z.string().min(1)).default([]),
  }),
  z.object({ op: z.literal("add"), scope: MemoryScopeSchema, projectId: z.string().min(1), body: MemoryBodySchema }),
  z.object({ op: z.literal("edit"), id: z.string().min(1), body: MemoryBodySchema }),
  z.object({ op: z.literal("retire"), id: z.string().min(1) }),
  z.object({ op: z.literal("restore"), id: z.string().min(1) }),
]);
export type RecordMemoryWrite = z.infer<typeof RecordMemoryWriteSchema>;

/**
 * What the record answers a write with: the answer the caller is owed,
 * and every row it changed, so the desktop that asked holds them at once
 * rather than on its next pull.
 */
export const RecordMemoryWriteAnswerSchema = z.object({
  result: MemoryWriteResultSchema,
  changed: z.array(RecordMemorySchema).default([]),
});
export type RecordMemoryWriteAnswer = z.infer<typeof RecordMemoryWriteAnswerSchema>;

/** Undoing a consolidation on the record, answered with the rows it changed. */
export const RecordMemoryRestoreAnswerSchema = z.object({
  result: MemoryRestoreConsolidationResultSchema,
  changed: z.array(RecordMemorySchema).default([]),
});
export type RecordMemoryRestoreAnswer = z.infer<typeof RecordMemoryRestoreAnswerSchema>;
