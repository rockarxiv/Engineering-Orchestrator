import {
  acceptanceCriteriaOf,
  checkMemoryNote,
  MAX_EXTRACTED_NOTES,
  MAX_MEMORY_NOTE_CHARS,
  MEMORY_EXTRACTED_EVENT,
  MEMORY_EXTRACT_TIMEOUT_MS,
  MEMORY_NOTE_DEFINITION,
  MEMORY_NOTE_PROJECT_SCOPE,
  MEMORY_NOTE_REPLACES,
  MEMORY_NOTE_TOOL_NAME,
  MemoryExtractionSchema,
  MIN_EXTRACTION_PROSE_WORDS,
  parsedResultOf,
  type Agent,
  type Comment,
  type Item,
  type MemoryEntryView,
  type MemoryExtractedEvent,
  type Run,
  type RunEvent,
  type SideCallFailureReason,
  type SpecShape,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { activeMemoriesIn, getItemType, listCommentsForItem, listRunEvents, listRunsForItem } from "../db/repos/index.js";
import type { SideCaller } from "../sideCalls/sideCall.js";
import { noteScopes, writeMemoryNote } from "./memoryNote.js";
import { recordFor } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * Extraction after a run (EO-479, ARCHITECTURE.md, "What an agent is
 * given").
 *
 * Most runs never call `memory_note`, so when one ends EO asks a small
 * model, once, what in it will still be true on the next run. One
 * `memory_extract` side call on the run's backend, inside the run, while
 * it settles — after the item's transition and before the run's slot is
 * given back — with a 60-second limit. Its notes, at most five, are
 * written as active entries with the run as their source and marked as
 * extracted. A failed call writes nothing and is not asked again; nothing
 * here can change where the item went.
 */

/** The run statuses an extraction is made for: the run ended on its own terms. */
const EXTRACTED_STATUSES: ReadonlySet<Run["status"]> = new Set(["succeeded", "failed", "awaiting_input"]);

/** Why no extraction was asked for. */
export type ExtractionSkip = "not_ended" | "interrupted" | "preview" | "noted_itself" | "little_prose" | "no_scopes";

export type ExtractionOutcome =
  | { kind: "skipped"; reason: ExtractionSkip }
  | { kind: "failed"; reason: SideCallFailureReason; message: string }
  /**
   * The call was answered, and the answer held no notes (EO-511). Kept
   * apart from `written` so that a model answering "none" is not
   * mistaken for one whose notes were written — the one is the model's
   * judgement, and a run that learned something and got this is a miss.
   */
  | { kind: "nothing_to_save" }
  /** At least one note was answered: these were written, and these were refused with their reasons. */
  | { kind: "written"; entryIds: string[]; dropped: string[] };

/**
 * The run event an outcome is recorded as (EO-511), or null for one that
 * asked nothing: a skipped extraction made no call, and every run that
 * ends is not to carry a line saying so.
 */
export function extractionEvent(outcome: ExtractionOutcome): MemoryExtractedEvent | null {
  switch (outcome.kind) {
    case "skipped":
      return null;
    case "failed":
      return { type: MEMORY_EXTRACTED_EVENT, outcome: "failed", entryIds: [], dropped: [], reason: `${outcome.reason}: ${outcome.message}` };
    case "nothing_to_save":
      return { type: MEMORY_EXTRACTED_EVENT, outcome: "nothing_to_save", entryIds: [], dropped: [], reason: null };
    case "written":
      return { type: MEMORY_EXTRACTED_EVENT, outcome: "written", entryIds: outcome.entryIds, dropped: outcome.dropped, reason: null };
  }
}

/** What a run produced, as extraction reads it. */
export interface RunProduce {
  /** The final answer: the parsed result, or the last thing the agent said when there is none. */
  finalAnswer: string | null;
  /** The comments the run posted, in order. */
  comments: string[];
  /** The tools it called, each once, in the order first called. */
  toolNames: string[];
  /** Whether it called `memory_note` itself. */
  calledMemoryNote: boolean;
}

function toolCallName(event: RunEvent): string | null {
  if (event.type !== "tool_call") return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const name = (payload as Record<string, unknown>)["name"];
  return typeof name === "string" && name !== "" ? name : null;
}

function outputText(event: RunEvent): string | null {
  if (event.type !== "output") return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const text = (payload as Record<string, unknown>)["text"];
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

/** Every string in a parsed answer, depth first — the prose a structured answer carries. */
function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const element of value) stringsIn(element, into);
  else if (typeof value === "object" && value !== null) for (const element of Object.values(value)) stringsIn(element, into);
  return into;
}

/** What a run produced, read off its row, its events and the comments it posted. */
export function runProduce(db: Db, run: Run): RunProduce {
  const events = listRunEvents(db, run.id);
  const toolNames: string[] = [];
  for (const event of events) {
    const name = toolCallName(event);
    if (name !== null && !toolNames.includes(name)) toolNames.push(name);
  }
  const parsed = parsedResultOf(run.result);
  const lastOutput = events.map(outputText).filter((text): text is string => text !== null).at(-1) ?? null;
  const finalAnswer = parsed === null || parsed === undefined ? lastOutput : typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  const comments = listCommentsForItem(db, run.itemId)
    .filter((comment) => comment.runId === run.id && comment.authorType === "agent")
    .map((comment) => comment.body);
  return { finalAnswer, comments, toolNames, calledMemoryNote: toolNames.includes(MEMORY_NOTE_TOOL_NAME) };
}

/** How many words of prose a run produced: the strings in its final answer and the comments it posted. */
export function proseWords(run: Run, produce: RunProduce): number {
  const parsed = parsedResultOf(run.result);
  const answer = parsed === null || parsed === undefined ? (produce.finalAnswer === null ? [] : [produce.finalAnswer]) : stringsIn(parsed);
  return [...answer, ...produce.comments].reduce((sum, text) => sum + (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0), 0);
}

/** Whether a run is one extraction is asked about, and if not, why not. Pure. */
export function extractionSkip(run: Run, item: Pick<Item, "previewAt">, produce: RunProduce, scopes: readonly MemoryScopeInfo[]): ExtractionSkip | null {
  if (run.interruption !== null) return "interrupted";
  if (!EXTRACTED_STATUSES.has(run.status)) return "not_ended";
  if (item.previewAt !== null) return "preview";
  if (produce.calledMemoryNote) return "noted_itself";
  if (scopes.length === 0) return "no_scopes";
  if (proseWords(run, produce) < MIN_EXTRACTION_PROSE_WORDS) return "little_prose";
  return null;
}

/**
 * What the small model is told (EO-511, EO-592), measured on both
 * backends' small models with `extraction.live.test.ts` — run it again
 * before changing a word.
 *
 * What a note is comes from core (`MEMORY_NOTE_DEFINITION`), word for
 * word, because agents writing their own notes are given the same
 * definition. Around it this says only what is particular to reading
 * someone else's run: where to look, that a fact is often said in
 * passing, how many notes and how long, and how to treat what memory
 * already holds.
 *
 * The wording EO-511 measured listed "a requirement the code or what it
 * produces must meet" as a note and was never shown the item, so a run
 * that listed what was wrong with the change under way had every finding
 * written as a rule: all ten entries extracted from such runs on
 * EO-581..588 were about the diff under review or restated the story's
 * criteria. Nothing here, nor in the input, asks what role ran or what it
 * decided — the item is shown, and the definition draws the line.
 *
 * Its last paragraph (EO-594) says how a correction names the entry it
 * corrects, so EO retires it rather than leaving both active; the input
 * shows each entry's id and whether a person wrote it, whose entry is
 * never replaced.
 */
export const MEMORY_EXTRACT_SYSTEM = [
  "You read an AI agent's finished run and pick out what it learned that the next agent on the same project should be told. You are shown the item the run worked on — its title, description and acceptance criteria — so that you can tell the work under way from what is true of the project.",
  "",
  MEMORY_NOTE_DEFINITION,
  "",
  "Look for notes in everything the run said — its final answer, its comments, and what people said on the item. A run often states such a fact only in passing, while saying what it did and why; it is still a fact about the project, and still a note. A run that lists what is wrong with the work under way is talking about this item, not the project: leave out every one of those findings, and keep only a fact among them that a later agent would need after this item is finished.",
  "",
  `Many runs teach nothing worth keeping, and then the answer is no notes. When the run does state a fact of the kind above that memory does not hold, write it. At most ${MAX_EXTRACTED_NOTES} notes, each one self-contained fact a later agent could act on without having seen this run, at most ${MAX_MEMORY_NOTE_CHARS} characters: what is true and, where the run says, why.`,
  "",
  'A note: "Locale strings live in `i18n/en.json`, and the build fails on a key used in code but missing there, so add the key in the same change."',
  'Not a note: "Added the export endpoint and its tests." — that is what this run did.',
  'Not a note: "The settings page has a dark-mode toggle." — that is what the code says.',
  "",
  `Each note has a scope: "${MEMORY_NOTE_PROJECT_SCOPE}" for what is true across the whole project, the id of one of the listed workspaces for what is true only of that workspace, or the id of the listed container, where there is one, for what is only true while the work filed under it is in progress — what the other items under it will need after this one is finished, and nobody will once all of it is.`,
  "",
  "You are shown what memory already holds. Do not repeat an entry, or say again in other words what one already says; a fact memory does not hold is still a note, even beside one that it does. Write a note that corrects an existing entry only when this run plainly shows the entry is wrong, and say what is true now.",
  "",
  `A note that corrects an entry names that entry's id in ${MEMORY_NOTE_REPLACES}, and EO retires the entry when it writes the note. Name only an entry written by an agent, never one written by a person. Every other note's ${MEMORY_NOTE_REPLACES} is empty.`,
].join("\n");

function authorOf(comment: Comment): string {
  return comment.authorType === "human" ? "a person" : comment.authorType;
}

/** The item a run worked on, as extraction shows it (EO-592). */
export interface ExtractionItem {
  title: string;
  /** The item's body, or null where it has none. */
  description: string | null;
  acceptanceCriteria: readonly string[];
}

/** An item as extraction shows it: its title, body and the criteria its type declares. */
export function extractionItem(item: Pick<Item, "title" | "body" | "spec">, shape?: SpecShape): ExtractionItem {
  const description = item.body?.trim() ?? "";
  return { title: item.title, description: description === "" ? null : description, acceptanceCriteria: acceptanceCriteriaOf(item, shape) };
}

/**
 * The result key a run reported, where its answer named one — the
 * `result` field any action's answer may carry, and the one the
 * supervisor's default routes on (`reportedResultKey`) — or null. Shown
 * beside how the run ended and never read here, so nothing in memory
 * turns on what a run decided.
 */
export function reportedResult(run: Pick<Run, "result">): string | null {
  const parsed = parsedResultOf(run.result);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const reported = (parsed as Record<string, unknown>)["result"];
  return typeof reported === "string" && reported.trim() !== "" ? reported : null;
}

/** The input an extraction call is given. */
export function extractionInput(input: {
  agentName: string;
  action: string;
  status: Run["status"];
  /** The result key the run reported, or null where it named none. */
  resultKey: string | null;
  item: ExtractionItem;
  produce: RunProduce;
  humanComments: readonly string[];
  scopes: readonly MemoryScopeInfo[];
  existing: readonly MemoryEntryView[];
}): string {
  const { produce } = input;
  const scopeLines = input.scopes.map((info) =>
    info.scope.kind === "project"
      ? `- "${MEMORY_NOTE_PROJECT_SCOPE}": the project ${info.name}`
      : info.scope.kind === "workspace"
        ? `- "${info.scope.id}": the workspace ${info.name}`
        : `- "${info.scope.id}": the container ${info.name}, while the work filed under it is in progress`,
  );
  const nameOf = (entry: MemoryEntryView) => {
    const info = input.scopes.find((candidate) => candidate.scope.kind === entry.scope.kind && candidate.scope.id === entry.scope.id);
    return entry.scope.kind === "project" ? MEMORY_NOTE_PROJECT_SCOPE : (info?.scope.id ?? entry.scope.id);
  };
  // What memory holds comes first and the run last, followed by what is
  // asked (EO-511), so the last thing a small model reads before it
  // answers is the run rather than a long list of what is already known.
  // The item sits between them (EO-592): what it asks for is read before
  // the run that worked on it, so a run restating it can be told apart.
  return [
    "# Where a note may go",
    "",
    ...scopeLines,
    "",
    "# What memory already holds",
    "",
    // Each with its id, and who wrote it (EO-594): a note correcting one
    // names it in `replaces`, and only an agent's may be named.
    ...(input.existing.length > 0
      ? input.existing.map((entry) => `<entry id="${entry.id}" scope="${nameOf(entry)}" by="${entry.source.type === "person" ? "a person" : "an agent"}">\n${entry.body}\n</entry>`)
      : ["(nothing yet)"]),
    "",
    "# The item the run worked on",
    "",
    `Title: ${input.item.title}`,
    "",
    "## Its description",
    "",
    input.item.description ?? "(none)",
    "",
    "## Its acceptance criteria",
    "",
    ...(input.item.acceptanceCriteria.length > 0 ? input.item.acceptanceCriteria.map((criterion) => `- ${criterion}`) : ["(none)"]),
    "",
    "# What people said on the item since this agent last ran",
    "",
    ...(input.humanComments.length > 0 ? input.humanComments.map((body) => `<comment>\n${body}\n</comment>`) : ["(nothing)"]),
    "",
    "# The run",
    "",
    `${input.agentName} ran the action "${input.action}". It ended: ${input.status}${input.resultKey === null ? "" : `, reporting the result "${input.resultKey}"`}.`,
    "",
    "## The comments it posted",
    "",
    ...(produce.comments.length > 0 ? produce.comments.map((body) => `<comment>\n${body}\n</comment>`) : ["(none)"]),
    "",
    "## The tools it used",
    "",
    produce.toolNames.length > 0 ? produce.toolNames.join(", ") : "(none)",
    "",
    "## Its final answer",
    "",
    produce.finalAnswer ?? "(none)",
    "",
    "# Your answer",
    "",
    "A note for each fact this run states that a later agent would need after this item is finished and that memory does not already hold — or no notes, when there is none.",
  ].join("\n");
}

/**
 * The human comments on the item since this agent last ran — before this
 * run — up to now. All of them when it never ran here before.
 */
function humanCommentsSince(db: Db, run: Run, agentId: Uuid): string[] {
  const prior = listRunsForItem(db, run.itemId)
    .filter((candidate) => candidate.id !== run.id && candidate.agentId === agentId && candidate.endedAt !== null && candidate.endedAt <= (run.startedAt ?? Number.POSITIVE_INFINITY))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || (a.id < b.id ? -1 : 1))
    .at(-1);
  return listCommentsForItem(db, run.itemId)
    .filter((comment) => comment.authorType === "human")
    .filter((comment) => prior?.endedAt == null || comment.createdAt > prior.endedAt)
    .map((comment) => `${authorOf(comment)}: ${comment.body}`);
}

/**
 * Extracts memory from a run that has ended, or says why it did not.
 *
 * Never throws: a failure of any kind is an outcome, and the run and its
 * item are already where they were going. `sideCall` writes the
 * `side_calls` row; a failed one is not retried.
 */
export async function extractMemory(input: {
  db: Db;
  run: Run;
  item: Item;
  agent: Agent;
  /** The backend the run was on. */
  backend: string;
  /** The scopes the run could write to — the ones its turns were given. */
  scopes: readonly MemoryScopeInfo[];
  sideCall: SideCaller["sideCall"];
  /**
   * Where the notes are written: whichever record holds the item's
   * project (EO-482). This database's own where absent, which is a solo
   * desktop and every test that is not about organisation mode.
   */
  record?: Pick<ItemRecord, "writeMemory">;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ExtractionOutcome> {
  const { db, run, item, agent, scopes } = input;
  let produce: RunProduce;
  try {
    produce = runProduce(db, run);
  } catch (error) {
    return { kind: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const skip = extractionSkip(run, item, produce, scopes);
  if (skip !== null) return { kind: "skipped", reason: skip };

  let question: string;
  try {
    question = extractionInput({
      agentName: agent.name,
      action: run.action,
      status: run.status,
      resultKey: reportedResult(run),
      item: extractionItem(item, getItemType(db, item.typeId)?.specShape),
      produce,
      humanComments: humanCommentsSince(db, run, agent.id),
      scopes,
      existing: activeMemoriesIn(
        db,
        scopes.map((info) => info.scope),
      ),
    });
  } catch (error) {
    return { kind: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const projectId = (scopes.find((info) => info.scope.kind === "project")?.scope.id as Uuid | undefined) ?? null;
  let answer;
  try {
    answer = await input.sideCall({
      purpose: "memory_extract",
      backend: input.backend,
      schema: MemoryExtractionSchema,
      system: MEMORY_EXTRACT_SYSTEM,
      input: question,
      itemId: item.id,
      projectId,
      timeoutMs: MEMORY_EXTRACT_TIMEOUT_MS,
      insideRunId: run.id,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // `sideCall` never throws; this keeps a caller's wrapper from making
    // the settle fail either.
    return { kind: "failed", reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (!answer.ok) return { kind: "failed", reason: answer.reason, message: answer.message };
  if (answer.value.notes.length === 0) return { kind: "nothing_to_save" };

  // Each note is held to the rules `memory_note` is (invariant 5): a
  // scope the run could write to, something to say, the limit, and only
  // active agent-written entries of those scopes named in `replaces`
  // (EO-594). One that fails is dropped with its reason, and writes and
  // retires nothing, rather than failing the rest — and so is one that
  // says word for word what its scope already holds, unless it names
  // entries it replaces: that is a correction or a fold, whose whole
  // point may be to retire an entry saying the same (EO-594 review), and
  // the write's own rules decide it.
  const key = (scope: { kind: string; id: string }, body: string) => `${scope.kind}:${scope.id}:${body}`;
  /** What memory holds now, by text: the ids of the active entries saying each, kept in step as notes are written and retire what they replace. */
  const held = new Map<string, Set<string>>();
  const hold = (entry: MemoryEntryView) => {
    const at = key(entry.scope, entry.body);
    held.set(at, (held.get(at) ?? new Set()).add(entry.id));
  };
  const existing = activeMemoriesIn(
    db,
    scopes.map((info) => info.scope),
  );
  for (const entry of existing) hold(entry);
  const keyOf = new Map(existing.map((entry) => [entry.id, key(entry.scope, entry.body)]));
  const entryIds: string[] = [];
  const dropped: string[] = [];
  for (const note of answer.value.notes.slice(0, MAX_EXTRACTED_NOTES)) {
    const checked = checkMemoryNote(note, noteScopes(scopes));
    if (checked.ok && checked.replaces.length === 0 && (held.get(key(checked.scope, checked.body))?.size ?? 0) > 0) {
      dropped.push("Memory already holds this, word for word.");
      continue;
    }
    const written = await writeMemoryNote({
      record: input.record ?? recordFor(db),
      args: note,
      scopes,
      runId: run.id,
      item,
      extracted: true,
      ...(input.now ? { now: input.now() } : {}),
    });
    if (!written.ok) {
      dropped.push(written.problem);
      continue;
    }
    entryIds.push(written.entry.id);
    // What it replaced is retired now, and no longer what memory holds.
    for (const id of checked.ok ? checked.replaces : []) {
      const at = keyOf.get(id);
      if (at !== undefined) held.get(at)?.delete(id);
    }
    hold(written.entry);
    keyOf.set(written.entry.id, key(written.entry.scope, written.entry.body));
  }
  return { kind: "written", entryIds, dropped };
}
