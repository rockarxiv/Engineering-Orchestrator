import { z } from "zod";
import {
  MAX_MEMORY_NOTE_CHARS,
  MAX_SKILL_PROPOSALS,
  SKILL_PROPOSAL_SECTIONS,
  SkillProposalSchema,
  type MemoryScope,
  MEMORY_CONSOLIDATION_INTERVAL_MS,
  MEMORY_CONSOLIDATION_MIN_RUNS,
  MemoryConsolidationAnswerSchema,
  MemoryContainerDoneAnswerSchema,
  MemorySkillProposalsAnswerSchema,
  type MemoryContainerDoneAnswer,
  type MemoryConsolidationAnswer,
  type MemoryConsolidationOperations,
  type MemorySkillProposalsAnswer,
  type MemoryConsolidationTrigger,
  type MemoryEntryView,
} from "@eo/core";
import type { ScopeConsolidationState, ScopeTally } from "../db/repos/memoryConsolidationsRepo.js";

/**
 * Automatic memory consolidation, the pure half (EO-480, ARCHITECTURE.md,
 * "What an agent is given"): when a scope is due, what it is asked to
 * shrink to, what it is told, and the shape its answer is held to. The
 * database and the scheduling are `consolidator.ts`.
 */

/** A scope's caps, from the guardrails. */
export interface MemoryCaps {
  maxEntries: number;
  maxChars: number;
}

/**
 * How long a scope waits after a failed consolidation (EO-577): an hour
 * after the first failure in a row, four after the second, and a day
 * after the third and every one after it — rather than being asked again
 * on every look, holding the global slot each time for a call that keeps
 * failing the same way.
 */
export const CONSOLIDATION_BACKOFF_MS = [60 * 60 * 1000, 4 * 60 * 60 * 1000, 24 * 60 * 60 * 1000] as const;
/**
 * How many failures in a row make a scope's consolidation stuck: the
 * note on the project thread is posted at the one that makes it this
 * many (EO-577).
 */
export const CONSOLIDATION_STUCK_AFTER = 3;
/**
 * How long a consolidation refused for budget waits before it looks
 * again. Not doubled: what it waits for is the budget allowing — a new
 * day, or a person raising it — not for a backend to recover.
 */
export const CONSOLIDATION_BUDGET_RETRY_MS = 30 * 60 * 1000;
/** How long one whose entries changed under it waits: somebody is editing, and the next look will see what they left. */
export const CONSOLIDATION_CHANGED_RETRY_MS = 60 * 1000;
/**
 * The failure a consolidation stopped by pausing the engine is recorded
 * with (EO-514). Retried like one whose entries changed — after a minute,
 * never doubled — because nothing went wrong: the person paused EO, and
 * none starts again until they resume it.
 */
export const CONSOLIDATION_PAUSED_REASON = "paused";
/**
 * The failure a batch is recorded with when it gave way to pipeline work
 * (EO-577): an item became dispatchable, or a run started, between two
 * batches of a scope or as its call was about to take the slot. Like a
 * pause, nothing went wrong — the work comes first — so it is looked at
 * again after a minute and taken up once the pipeline is idle, and it
 * neither backs the scope off nor counts towards its being stuck.
 */
export const CONSOLIDATION_DEFERRED_REASON = "deferred";

/** Whether a failure is the backend's or the answer's — what backs a scope off and makes it stuck — rather than a wait for something else. */
function countsAsFailure(reason: string | null): boolean {
  return reason !== "budget" && reason !== "changed" && reason !== CONSOLIDATION_PAUSED_REASON && reason !== CONSOLIDATION_DEFERRED_REASON;
}

/** The scope's failures in a row since its last consolidation that was not one, newest first, that back it off (EO-577). */
export function consecutiveFailures(state: ScopeConsolidationState): ScopeConsolidationState["failuresSince"] {
  return state.failuresSince.filter((failure) => countsAsFailure(failure.reason));
}

/** Whether a scope has reached either cap. People's entries count toward it. */
export function reachesCap(tally: ScopeTally, caps: MemoryCaps): boolean {
  return tally.agentEntries + tally.personEntries >= caps.maxEntries || tally.agentChars + tally.personChars >= caps.maxChars;
}

/** Whether people's entries alone are over a cap — which consolidation records and leaves alone. */
export function peopleAloneOverCap(tally: ScopeTally, caps: MemoryCaps): boolean {
  return tally.personEntries >= caps.maxEntries || tally.personChars >= caps.maxChars;
}

/**
 * When a scope that failed may be asked again, or null when it has not
 * failed since it last succeeded. A budget refusal waits for the budget,
 * and a change, a pause or pipeline work for a minute; the rest back off
 * by how many there have been in a row (`CONSOLIDATION_BACKOFF_MS`).
 */
export function retryAt(state: ScopeConsolidationState): number | null {
  const last = state.failuresSince[0];
  if (!last) return null;
  if (last.reason === "budget") return last.finishedAt + CONSOLIDATION_BUDGET_RETRY_MS;
  if (!countsAsFailure(last.reason)) return last.finishedAt + CONSOLIDATION_CHANGED_RETRY_MS;
  const failures = consecutiveFailures(state).length;
  return last.finishedAt + CONSOLIDATION_BACKOFF_MS[Math.min(CONSOLIDATION_BACKOFF_MS.length, failures) - 1]!;
}

/**
 * Whether the message saying a scope's consolidation is stuck is owed now
 * (EO-577): its failures in a row have reached `CONSOLIDATION_STUCK_AFTER`
 * and none of them has had the note yet. Said once per run of failures —
 * a success, which ends the run, is what lets it be said again. The row
 * it is posted at, the newest of them; null when none is owed.
 */
export function stuckNoticeOwed(state: ScopeConsolidationState): ScopeConsolidationState["failuresSince"][number] | null {
  // Every failure since the last success, waits included: one that has
  // had the note is one whatever its reason.
  if (state.failuresSince.some((failure) => failure.stuckNoticed)) return null;
  const failures = consecutiveFailures(state);
  return failures.length >= CONSOLIDATION_STUCK_AFTER ? failures[0]! : null;
}

/**
 * The message saying a scope's consolidation is stuck
 * (EO-577): which scope, what it holds against its caps, how many times
 * in a row it has failed and why the last one did — and that nothing
 * else is held up by it.
 */
export function stuckNoticeBody(input: {
  scopeLabel: string;
  tally: ScopeTally;
  caps: MemoryCaps;
  failures: number;
  last: { reason: string | null; note: string | null };
  retryAt: number | null;
}): string {
  const { tally, caps } = input;
  const entries = tally.agentEntries + tally.personEntries;
  const chars = tally.agentChars + tally.personChars;
  const reason = input.last.reason ?? "error";
  const lines = [
    `Memory consolidation of ${input.scopeLabel} is stuck: it has failed ${input.failures} times in a row.`,
    "",
    `- **Size:** ${entries} entries against a cap of ${caps.maxEntries}, and ${chars.toLocaleString("en-US")} characters against a cap of ${caps.maxChars.toLocaleString("en-US")}.`,
    `- **Last failure:** \`${reason}\`${input.last.note ? ` — ${input.last.note}` : ""}`,
  ];
  if (input.retryAt !== null) lines.push(`- **Next attempt:** ${new Date(input.retryAt).toISOString().replace("T", " ").slice(0, 16)} UTC, and a day apart after that until one succeeds.`);
  lines.push(
    "",
    "The scope keeps working as it is: agents are still given its memory and can still write to it, and no delivery waits on this. Retiring or editing entries by hand in Memory makes it smaller in the meantime. This message is not repeated until a consolidation of the scope succeeds, which resolves it.",
  );
  return lines.join("\n");
}

/** What the scheduler should do about one scope now. */
export type ConsolidationDecision =
  | { kind: "consolidate"; trigger: MemoryConsolidationTrigger }
  /** Over a cap on people's entries alone, with nothing of the agents' left to fold: said once, and left. */
  | { kind: "skip"; note: string }
  | { kind: "none" };

/**
 * Whether the scope's last consolidation failed after the scope was last
 * settled: a run that stopped part-way, a batch failing after the batches
 * before it succeeded (EO-574), each of which settled the scope as it
 * left it and counted as its last consolidation. Such a run is asked
 * again once its backoff is over, as any failure is — not left waiting
 * for somebody to write to the scope, nor for another day and five runs.
 * A failure from before the scope was settled (a restore since, say) is
 * not one.
 */
export function failedSinceSettled(state: ScopeConsolidationState): boolean {
  const failed = state.failuresSince[0];
  return failed !== undefined && state.settled !== null && failed.finishedAt >= state.settled.at;
}

/**
 * Whether a scope over a cap is newly so, rather than left that way on
 * purpose: never settled, written to since it was last settled (by
 * anyone — an agent's note or a person's entry), or settled under other
 * caps (a guardrail was changed) — or one whose last consolidation
 * failed after it was settled. A scope a person restored, or one held
 * over by people's entries alone, that nobody has touched since is not.
 */
function newlyOverCap(state: ScopeConsolidationState, caps: MemoryCaps): boolean {
  if (state.settled === null || state.changedSinceSettled) return true;
  if (failedSinceSettled(state)) return true;
  const then = state.settled.caps;
  return then === null || then.maxEntries !== caps.maxEntries || then.maxChars !== caps.maxChars;
}

export function peopleOverCapNote(tally: ScopeTally, caps: MemoryCaps): string {
  return (
    `People's entries alone come to ${tally.personEntries} entries and ${tally.personChars.toLocaleString("en-US")} characters, ` +
    `over this scope's cap of ${caps.maxEntries} entries or ${caps.maxChars.toLocaleString("en-US")} characters. ` +
    `Consolidation never rewrites a person's entry, so they were left as written.`
  );
}

/**
 * Whether a scope is due a consolidation (EO-480).
 *
 * - Never while one is running for it, or while a failed one is backing
 *   off (`retryAt`).
 * - **Cap:** the scope has reached its entry or character cap — whoever's
 *   entries took it there — and is newly over it (`newlyOverCap`), and
 *   the agents' entries exceed what a consolidation would leave of them.
 *   When people's entries alone are over the cap and the agents' are
 *   already within that, there is nothing to fold: that is recorded once
 *   (`skip`), which settles the scope until it changes again.
 * - **Schedule:** more than 24 hours since it was last consolidated (or,
 *   never consolidated, since its oldest agent-written entry), and at
 *   least five runs given its memory since then.
 *
 * Both need an agent-written entry: a person's are never sent, so a scope
 * of only those has nothing to consolidate. `runsDeliveredSince` is asked
 * only when the day has passed, because it reads run events.
 */
export function consolidationDue(input: {
  tally: ScopeTally;
  state: ScopeConsolidationState;
  caps: MemoryCaps;
  now: number;
  runsDeliveredSince: (since: number) => number;
}): ConsolidationDecision {
  const { tally, state, caps, now } = input;
  if (state.running) return { kind: "none" };
  const retry = retryAt(state);
  if (retry !== null && now < retry) return { kind: "none" };

  if (reachesCap(tally, caps) && newlyOverCap(state, caps)) {
    const targets = consolidationTargets(tally, caps);
    if (tally.agentEntries > 0 && (tally.agentEntries > targets.entries || tally.agentChars > targets.chars)) return { kind: "consolidate", trigger: "cap" };
    if (peopleAloneOverCap(tally, caps)) return { kind: "skip", note: peopleOverCapNote(tally, caps) };
  }

  if (tally.agentEntries === 0) return { kind: "none" };
  // A run on the schedule that stopped part-way: its successful batches
  // made it the scope's last consolidation, so the day and the five runs
  // would be counted from them, and its failed batch never retried.
  if (failedSinceSettled(state)) return { kind: "consolidate", trigger: "schedule" };
  const since = state.lastConsolidatedAt ?? tally.oldestAgentAt;
  if (since === null || now - since <= MEMORY_CONSOLIDATION_INTERVAL_MS) return { kind: "none" };
  return input.runsDeliveredSince(since) >= MEMORY_CONSOLIDATION_MIN_RUNS ? { kind: "consolidate", trigger: "schedule" } : { kind: "none" };
}

/**
 * What a consolidation is asked to bring the agents' entries to. An aim,
 * not a test (EO-573): an answer that falls short of it but makes the
 * scope smaller is applied all the same.
 */
export interface ConsolidationTargets {
  /** The entries it aims for. */
  entries: number;
  /** The characters it aims for. */
  chars: number;
}

/**
 * One limit's target for the agents' entries.
 *
 * About half the cap less what people's entries take, so the scope lands
 * near half and is not consolidated again a few notes later. Where
 * people's entries take most of that, the agents keep up to a tenth of
 * the cap — but never more than the room left under it, so a
 * consolidation that reaches its aim never leaves a scope at or over a
 * cap people's entries alone do not reach. Only where they do reach it is
 * there no room at all; then the agents' share is held to that tenth, and
 * the cap cannot be met whatever is done with it.
 */
function targetFor(cap: number, people: number): number {
  const half = Math.floor(cap / 2) - people;
  const tenth = Math.ceil(cap / 10);
  const room = cap - 1 - people;
  if (room < 0) return tenth;
  return Math.max(0, Math.min(Math.max(half, tenth), room));
}

export function consolidationTargets(tally: ScopeTally, caps: MemoryCaps): ConsolidationTargets {
  return { entries: targetFor(caps.maxEntries, tally.personEntries), chars: targetFor(caps.maxChars, tally.personChars) };
}

/** An entry a consolidation was given, as far as its answer is checked against it. */
export interface SentEntry {
  id: string;
  body: string;
}

/** The agents' entries and characters an answer leaves, against what it was given. */
export interface ConsolidationChange {
  entriesBefore: number;
  entriesAfter: number;
  charsBefore: number;
  charsAfter: number;
}

/**
 * What applying an answer would leave of the entries it was given. Every
 * id it names is assumed to be one of them, named once — what
 * `consolidationAnswerSchema` holds it to.
 */
export function consolidationChange(sent: readonly SentEntry[], answer: MemoryConsolidationOperations): ConsolidationChange {
  const bodies = new Map(sent.map((entry) => [entry.id, entry.body.length]));
  const length = (id: string) => bodies.get(id) ?? 0;
  const charsBefore = sent.reduce((sum, entry) => sum + entry.body.length, 0);
  let charsAfter = charsBefore;
  let entriesAfter = sent.length;
  for (const retire of answer.retire) {
    charsAfter -= length(retire.id);
    entriesAfter -= 1;
  }
  for (const merge of answer.merge) {
    charsAfter += merge.body.length - merge.from.reduce((sum, id) => sum + length(id), 0);
    entriesAfter -= merge.from.length - 1;
  }
  for (const rewrite of answer.rewrite) charsAfter += rewrite.body.length - length(rewrite.id);
  return { entriesBefore: sent.length, entriesAfter, charsBefore, charsAfter };
}

/**
 * Whether an answer would grow the scope: leave as many entries as it
 * was given and more characters. One that removes an entry, or the same
 * entries in fewer or as many characters, does not (EO-573).
 */
export function growsScope(change: ConsolidationChange): boolean {
  return change.entriesAfter >= change.entriesBefore && change.charsAfter > change.charsBefore;
}

/**
 * The shape one consolidation's answer is held to (EO-573): retire, merge
 * and rewrite operations, each naming only entries it was given — never a
 * person's, which are never sent — and none of them twice, across all
 * three lists. An answer that would grow the scope is refused; one that
 * makes it smaller is accepted however far short of its target it falls,
 * and one that changes nothing is a valid no-op. Checked again when the
 * answer comes back (invariant 5); the lists reach the backend as JSON
 * Schema, the rest is checked here.
 *
 * The same for a batch, the whole set and the cross-batch pass's merge
 * call (EO-574). None of them carries skill proposals: those are asked
 * for in a call of their own (EO-575, `skillProposalsAnswerSchema`).
 */
export function consolidationAnswerSchema(sent: readonly SentEntry[]): z.ZodType<MemoryConsolidationAnswer> {
  const known = new Set(sent.map((entry) => entry.id));
  return MemoryConsolidationAnswerSchema.superRefine((answer, ctx) => checkOperations(sent, known, answer, ctx));
}

function checkOperations(sent: readonly SentEntry[], known: ReadonlySet<string>, answer: MemoryConsolidationOperations, ctx: z.RefinementCtx): void {
  const named = new Map<string, string>();
  const name = (id: string, path: (string | number)[]) => {
    const where = path.join(".");
    if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
    else if (named.has(id)) ctx.addIssue({ code: "custom", path, message: `names ${id} again, already named at ${named.get(id)}` });
    else named.set(id, where);
  };
  answer.retire.forEach((retire, at) => name(retire.id, ["retire", at, "id"]));
  answer.merge.forEach((merge, at) => merge.from.forEach((id, index) => name(id, ["merge", at, "from", index])));
  answer.rewrite.forEach((rewrite, at) => name(rewrite.id, ["rewrite", at, "id"]));
  const change = consolidationChange(sent, answer);
  if (growsScope(change)) {
    ctx.addIssue({
      code: "custom",
      path: [],
      message: `would grow the scope from ${change.charsBefore} to ${change.charsAfter} characters without removing an entry`,
    });
  }
}

/** What the skill proposal call's answer is checked against: the scope it is about, and the item each entry it was given came from. */
export interface ProposalFacts {
  scope: MemoryScope;
  /** Each given entry's source item, or null for one with none. */
  sourceItems: ReadonlyMap<string, string | null>;
}

/**
 * The shape the skill proposal call's answer is held to (EO-575): at most
 * three proposals in `SkillProposalSchema`, and the half of a proposal
 * that schema cannot say (invariant 5) — it is for the scope it was asked
 * about, its evidence is entries it was given and the items those came
 * from, an improvement is to the skill its slug names, and no two
 * proposals share a slug.
 */
export function skillProposalsAnswerSchema(given: readonly { id: string }[], facts: ProposalFacts): z.ZodType<MemorySkillProposalsAnswer> {
  const known = new Set(given.map((entry) => entry.id));
  return MemorySkillProposalsAnswerSchema.superRefine((answer, ctx) => checkSkillProposals(answer.skills, known, facts, ctx));
}

function checkSkillProposals(skills: readonly z.infer<typeof SkillProposalSchema>[], known: ReadonlySet<string>, facts: ProposalFacts, ctx: z.RefinementCtx): void {
  const slugs = new Set<string>();
  skills.forEach((skill, at) => {
    const path = ["skills", at];
    if (slugs.has(skill.slug)) ctx.addIssue({ code: "custom", path: [...path, "slug"], message: `proposes "${skill.slug}" twice` });
    slugs.add(skill.slug);
    if (skill.kind === "improvement" && skill.target !== skill.slug) {
      ctx.addIssue({ code: "custom", path: [...path, "slug"], message: `is an improvement to "${skill.target}", so its slug is "${skill.target}"` });
    }
    const unknown = skill.evidence.entryIds.filter((id) => !known.has(id));
    if (unknown.length > 0) ctx.addIssue({ code: "custom", path: [...path, "evidence", "entryIds"], message: `names entries it was not given: ${unknown.join(", ")}` });
    if (skill.scope.kind !== facts.scope.kind || skill.scope.id !== facts.scope.id) {
      ctx.addIssue({ code: "custom", path: [...path, "scope"], message: `is not the scope it was asked about, ${facts.scope.kind} ${facts.scope.id}` });
    }
    const items = new Set(skill.evidence.entryIds.flatMap((id) => facts.sourceItems.get(id) ?? []));
    const strangers = skill.evidence.itemIds.filter((id) => !items.has(id));
    if (strangers.length > 0) {
      ctx.addIssue({ code: "custom", path: [...path, "evidence", "itemIds"], message: `names items its evidence entries did not come from: ${strangers.join(", ")}` });
    }
  });
}

/** A workspace's own instructions file, as it is on disk. */
export interface RepositoryFile {
  name: string;
  /** Which workspace it is from, for a project's consolidation, which is given each of its workspaces' (EO-514). Absent for a workspace's own. */
  workspace?: string;
  text: string;
  /** Whether it was cut to fit. */
  truncated: boolean;
}

/** What a consolidation may answer and how it should choose — the rules every call that answers with operations is told. */
const OPERATION_RULES = [
  "Answer with the changes to make, not with the entries to keep. Name only what changes: an entry you do not mention stays exactly as it is, so never list an entry just to keep it. There are three operations:",
  "- `retire`: `{ id, reason }` — retire one entry, saying in a few words why.",
  "- `merge`: `{ from, body, contradictsRepositoryFile }` — fold two or more entries (`from` holds at least two ids) into one new entry whose text is `body`.",
  "- `rewrite`: `{ id, body, contradictsRepositoryFile }` — replace one entry's text with `body`.",
  "Every id you name must be one of the entries you are given, and each id may appear only once in the whole answer — in one retire, one merge's `from`, or one rewrite. An answer with nothing to change has all three lists empty; that is a valid answer.",
  "What to change:",
  "- Merge entries that say the same thing, or parts of one thing, into one.",
  `- Keep each entry you merge or rewrite to one fact, at most ${MAX_MEMORY_NOTE_CHARS} characters: an answer with a longer one is refused whole. An entry is delivered to an agent whole, so a topic digest that bundles unrelated facts reaches agents that need only one of them. Where a topic holds more than fits, split it into separate facts rather than exceed the limit — merge only the entries that state the same fact, and leave the others as they are or merge them into entries of their own.`,
  "- Retire what is stale, contradicted by a newer entry, or derivable from the code itself — what an agent would see by reading the repository. Between two entries that disagree, the newer one is current.",
  "- When you rewrite or merge, write relative dates and times (\"yesterday\", \"last week\", \"in two days\") as absolute dates, using the date each entry was written.",
  "- When the workspace's CLAUDE.md or AGENTS.md is given — for a project, those of each of its workspaces — treat it as current: an entry that disagrees with it is rewritten to agree, or retired. The one exception is an entry that is plainly newer than the file and says it corrects it; keep it, and flag it by setting contradictsRepositoryFile to true on the merge or rewrite that carries it — a rewrite may keep its text as it is to do only that. An entry already flagged stays flagged unless you change it. Never suggest editing the file.",
  "- Do not invent anything an entry does not say.",
  "- Your changes must make the entries smaller, in number or in characters, and never larger. Where you are given a target, aim for it, but any real reduction is useful, and a change you are unsure of is better left out.",
];

const MEMORY_TIDY_INTRO =
  "You tidy the memory an engineering tool keeps for its agents. Each entry is a note an agent wrote about a project or a workspace, for the next agent to read.";

/** What a consolidation is told: the operations and how to choose them, and nothing about skills (EO-575). */
export const MEMORY_CONSOLIDATE_SYSTEM = [MEMORY_TIDY_INTRO, ...OPERATION_RULES].join("\n");

/**
 * What the skill proposal call is told (EO-483, EO-575): asked on its own
 * once a consolidation of the scope has succeeded, over the scope's
 * entries as that consolidation left them.
 */
export const MEMORY_PROPOSE_SKILLS_SYSTEM = [
  "You read the memory an engineering tool keeps for its agents, and propose skills from it. Each entry is a note an agent wrote about a project or a workspace, for the next agent to read; the entries have just been tidied.",
  `Answer with up to ${MAX_SKILL_PROPOSALS} skills in \`skills\`. A skill is a procedure — how to run, debug or release something here, step by step — that an agent chooses by its description and reads when it needs it. Propose one only for a procedure that appears again and again across several entries, not for a single fact. When there is none, answer with \`skills\` empty; most of the time there is none.`,
  "- `kind` is `new`, or `improvement` when one of the existing skills you are shown already covers the procedure and the entries add to it or correct it. An improvement names that skill's slug in `target`, uses the same slug, and gives the skill's whole new body. A new skill never reuses an existing skill's slug.",
  "- `slug` is lowercase letters and digits with single hyphens. `name` is what a person calls it. `description` is one line saying when to use it: it is what a model chooses the skill by.",
  "- `scope` is exactly the scope you are told the entries are of.",
  "- `evidence.entryIds` are the ids of the given entries the procedure was seen in, and `evidence.itemIds` the items those entries came from, as each entry is labelled. The skill is created or changed as you propose it, with no person's approval, and its evidence entries leave memory for it, so name only entries that hold the procedure and nothing else worth keeping.",
  `- \`body\` is the SKILL.md body, in markdown, with these sections as headings: ${SKILL_PROPOSAL_SECTIONS.map((section) => `\`## ${section}\``).join(", ")} — when to use it, what to do, and how to know it worked.`,
  "- Never propose again what a person discarded, or a skill a person archived: not under the same slug, and not as the same procedure under another slug or in other words.",
  "- Do not invent anything an entry does not say.",
].join("\n");

/**
 * What the cross-batch pass's last call is told (EO-574): the same
 * operations and rules, over entries picked from across the scope's
 * batches as possible duplicates, and no skill proposals.
 */
export const MEMORY_CROSS_BATCH_MERGE_SYSTEM = [
  MEMORY_TIDY_INTRO,
  "The scope was tidied in batches, so entries that say the same thing may have been in different batches and never seen side by side. The entries you are given were picked from across those batches, in groups, as possible duplicates of one another. Merge those that do say the same thing, or parts of one thing; leave alone those that only look alike. A group is a suggestion: you may merge part of one, or entries from two.",
  ...OPERATION_RULES,
].join("\n");

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** An existing skill a proposal may improve: one in the scope, or a global one. */
export interface ExistingSkill {
  id: string;
  slug: string;
  description: string;
  /** `global`, or this scope. */
  scopeLabel: string;
  body: string;
}

/** A proposal a person discarded in the scope, or a skill a consolidation created there that a person archived: what the skill proposal call is told not to make again (EO-512, EO-719). */
export interface DiscardedProposal {
  slug: string;
  description: string;
}

/** The most of one existing skill's body the skill proposal call is shown. */
const EXISTING_SKILL_BODY_MAX_CHARS = 6_000;
/** The most existing skills the skill proposal call is shown. */
export const EXISTING_SKILLS_MAX = 30;

/**
 * Which part of a scope one call is given, when the scope is consolidated
 * in batches (EO-574): its place among them, and what the whole scope's
 * agents hold, so the model knows the rest exist and are not its to name.
 */
export interface ConsolidationBatchPart {
  index: number;
  count: number;
  scopeEntries: number;
  scopeChars: number;
}

/**
 * Each entry with its id, the day it was written, the item it came from
 * and its flag, oldest first — and, where `likelyDuplicates` says so, the
 * others it is likely a duplicate of (EO-576).
 */
function entryLines(entries: readonly MemoryEntryView[], likelyDuplicates?: ReadonlyMap<string, readonly string[]>): string[] {
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    const item = entry.source.type === "run" && entry.source.itemId !== null ? `; from item ${entry.source.itemId}` : "";
    const alike = likelyDuplicates?.get(entry.id) ?? [];
    const duplicate = alike.length > 0 ? `; likely a duplicate of ${alike.join(", ")}` : "";
    lines.push("", `### ${entry.id} (written ${isoDay(entry.createdAt)}${item}${entry.contradictsRepositoryFile ? "; already flagged as correcting the repository file" : ""}${duplicate})`, entry.body);
  }
  return lines;
}

/** What a call is told about the entries marked as likely duplicates, when any are. */
const LIKELY_DUPLICATES_NOTE =
  "Entries marked \"likely a duplicate of\" were found by EO, without reading them, to share most of their wording with the entries named. Read each such set first: merge those that say the same thing, keeping every fact any of them adds; leave apart those that only look alike.";

const charsOf = (entries: readonly { body: string }[]) => entries.reduce((sum, entry) => sum + entry.body.length, 0);

/** What a consolidation is told: today, the target, the entries with their ids and dates, and the workspace's file. */
export function consolidationInput(input: {
  scopeLabel: string;
  entries: readonly MemoryEntryView[];
  targets: { entries: number; chars: number };
  /** Which batch of the scope these entries are, when it is consolidated in more than one (EO-574). */
  batch?: ConsolidationBatchPart;
  repositoryFiles: readonly RepositoryFile[];
  /**
   * For each entry found to be a likely duplicate of others (EO-576,
   * `nearDuplicateGroups`), those others — all in this call, since a set
   * of likely duplicates always shares a batch. Marked on each entry.
   */
  likelyDuplicates?: ReadonlyMap<string, readonly string[]>;
  now: number;
}): string {
  const lines: string[] = [`Today is ${isoDay(input.now)}.`];
  if (input.batch) {
    const { batch } = input;
    lines.push(
      `These are ${input.entries.length} of the agent-written memory entries of ${input.scopeLabel}, ${charsOf(input.entries)} characters: batch ${batch.index} of ${batch.count}, chosen so that entries alike tend to share one.`,
      `The scope's agents hold ${batch.scopeEntries} entries in ${batch.scopeChars} characters; the others are consolidated in their own batches, so change only these.`,
      `Target for this batch: about ${input.targets.entries} entries and about ${input.targets.chars} characters in total, each entry you merge or rewrite at most ${MAX_MEMORY_NOTE_CHARS} characters. Any reduction towards it is kept.`,
    );
  } else {
    lines.push(
      `These are the agent-written memory entries of ${input.scopeLabel}: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`,
      `Target: about ${input.targets.entries} entries and about ${input.targets.chars} characters in total, each entry you merge or rewrite at most ${MAX_MEMORY_NOTE_CHARS} characters. Any reduction towards it is kept.`,
    );
  }
  const given = new Set(input.entries.map((entry) => entry.id));
  const marks = new Map<string, string[]>();
  for (const [id, others] of input.likelyDuplicates ?? []) {
    const here = others.filter((other) => given.has(other));
    if (given.has(id) && here.length > 0) marks.set(id, here);
  }
  if (marks.size > 0) lines.push(LIKELY_DUPLICATES_NOTE);
  lines.push("", "## Entries", ...entryLines(input.entries, marks));
  for (const file of input.repositoryFiles) {
    const whose = file.workspace === undefined ? "The workspace's" : `The workspace ${JSON.stringify(file.workspace)}'s`;
    lines.push("", `## ${whose} ${file.name}${file.truncated ? " (cut short to fit)" : ""}`, file.text);
  }
  return lines.join("\n");
}

/**
 * What the skill proposal call is told (EO-575): today, the scope as a
 * proposal names it, the scope's agent-written entries as a consolidation
 * just left them — each with its id, its day and the item it came from —
 * the skills a proposal may improve, and every proposal a person
 * discarded in the scope.
 */
export function skillProposalsInput(input: {
  scopeLabel: string;
  scope: MemoryScope;
  entries: readonly MemoryEntryView[];
  /** Existing skills in the scope or global, which a proposal may improve (EO-483). */
  skills: readonly ExistingSkill[];
  /** Proposals a person discarded in the scope, and consolidation-created skills a person archived there, newest first (EO-512, EO-719). */
  discarded: readonly DiscardedProposal[];
  now: number;
}): string {
  const lines: string[] = [
    `Today is ${isoDay(input.now)}.`,
    `These are the agent-written memory entries of ${input.scopeLabel}: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`,
    `The scope they are of, as a skill proposal's \`scope\` names it: ${JSON.stringify({ kind: input.scope.kind, id: input.scope.id })}.`,
    "",
    "## Entries",
    ...entryLines(input.entries),
  ];
  const skills = input.skills.slice(0, EXISTING_SKILLS_MAX);
  lines.push("", "## Existing skills", skills.length === 0 ? "None yet." : "A proposal may improve one of these; a new one may not reuse their slugs.");
  for (const skill of skills) {
    const cut = skill.body.length > EXISTING_SKILL_BODY_MAX_CHARS;
    lines.push("", `### ${skill.slug} (${skill.scopeLabel}${cut ? "; body cut short" : ""})`, skill.description, "", skill.body.slice(0, EXISTING_SKILL_BODY_MAX_CHARS));
  }
  // What a person already turned down. Without it the model has no
  // reason to know, and proposes the same skill again in new words.
  // Every one, uncapped: a discard left out is a procedure the model
  // is free to propose again under another slug. Each is one line of at
  // most a slug and a description's 300 characters.
  if (input.discarded.length > 0) {
    lines.push(
      "",
      "## Skill proposals a person discarded",
      "A person turned these down: discarded the proposal, or archived the skill a consolidation made. Do not propose them again — not under the same slug, and not as the same procedure under another slug or in other words. EO will not apply a proposal with one of these slugs.",
      "",
    );
    for (const proposal of input.discarded) lines.push(`- \`${proposal.slug}\`: ${proposal.description}`);
  }
  return lines.join("\n");
}

/**
 * What the cross-batch pass's last call is told (EO-574): the entries
 * picked as possible duplicates, with their full bodies, group by group.
 */
export function crossBatchMergeInput(input: { scopeLabel: string; groups: readonly (readonly MemoryEntryView[])[]; now: number }): string {
  const entries = input.groups.flat();
  const lines: string[] = [
    `Today is ${isoDay(input.now)}.`,
    `These are ${entries.length} of the agent-written memory entries of ${input.scopeLabel}, ${charsOf(entries)} characters, in ${input.groups.length} groups of possible duplicates. Each entry you merge or rewrite at most ${MAX_MEMORY_NOTE_CHARS} characters.`,
  ];
  input.groups.forEach((group, at) => lines.push("", `## Possible duplicates ${at + 1}`, ...entryLines(group)));
  return lines.join("\n");
}

// ── The end of a container's work (EO-596) ──────────────────────

/**
 * Whether a container scope is due its `container_done` consolidation
 * (EO-596): the work filed under the container has finished
 * (`finishedAt`, `containerWorkFinishedAt`), the scope holds an entry an
 * agent wrote — a person's are never sent, so a container of only those,
 * or of none, queues nothing — and nobody has restored one since that
 * finish, which is a person saying the container's entries are to stay.
 *
 * Never while one is running for the scope, nor while a failed one is
 * backing off (`retryAt`), as any consolidation. Once one has succeeded
 * the scope holds no agent's entry and is not due again; one that stopped
 * part-way leaves some, and is taken up again after its backoff. A finish
 * after the restore — an item filed under the container later, finished
 * in its turn — is a new end, and due.
 */
export function containerDoneDue(input: {
  tally: ScopeTally;
  state: ScopeConsolidationState;
  finishedAt: number | null;
  /** When a person last restored a `container_done` consolidation of the scope, or null. */
  restoredAt: number | null;
  now: number;
}): boolean {
  const { tally, state } = input;
  if (input.finishedAt === null || tally.agentEntries === 0 || state.running) return false;
  if (input.restoredAt !== null && input.restoredAt >= input.finishedAt) return false;
  const retry = retryAt(state);
  return retry === null || input.now >= retry;
}

/**
 * What a `container_done` consolidation is told (EO-596): the container's
 * work is over, its entries were written for that work alone, and only
 * what will still hold for the project goes on — as entries of the
 * project, one fact each. What is not kept is retired, so the answer
 * names only what is kept.
 */
export const MEMORY_CONTAINER_DONE_SYSTEM = [
  "You tidy the memory an engineering tool keeps for its agents. The entries you are given were written by agents for the work filed under one container item: what the items under it needed from one another while that work was in progress. That work is now finished, every item under it done, so the container's memory ends here.",
  "Answer with `keep`: the facts from these entries that will still be true, and still matter, to a later agent working on something else in the project now that this work is finished — how to build, run or test the project, a rule the whole project follows, a trap in how the code works. Each becomes an entry of the project. Every entry you do not draw a kept fact from is retired.",
  "- Each kept fact is `{ from, body }`: `from` holds the ids of the entries it is drawn from — one, or several that say parts of one thing — and `body` is the fact, standing on its own.",
  `- Keep each fact to one fact, at most ${MAX_MEMORY_NOTE_CHARS} characters: an answer with a longer one is refused whole. Two facts are two kept entries, so each can reach the run it bears on without the other.`,
  "- Leave out what was only true while the work was in progress: who was doing what, what was still to do, what was missing or wrong in the work, maps of code that was being written, findings about a change. They mattered to the items under the container, and nobody will need them now.",
  "- Every id you name must be one of the entries you are given, and each id may appear in only one kept fact's `from`. Keeping nothing is a valid answer, and retires them all.",
  "- When you rewrite, write relative dates and times (\"yesterday\", \"last week\") as absolute dates, using the date each entry was written.",
  "- Do not invent anything an entry does not say. A fact you are unsure will still hold is better left out.",
].join("\n");

/**
 * What a `container_done` consolidation is given (EO-596): today, which
 * container's work finished and which project its kept facts go to, and
 * the entries with their ids, dates and the items they came from — of a
 * batch where the scope is consolidated in more than one.
 */
export function containerDoneInput(input: {
  containerLabel: string;
  projectLabel: string;
  entries: readonly MemoryEntryView[];
  batch?: { index: number; count: number; scopeEntries: number };
  now: number;
}): string {
  const lines = [
    `Today is ${isoDay(input.now)}.`,
    `The work filed under ${input.containerLabel} is finished. What will still hold goes to ${input.projectLabel}; the rest is retired.`,
    input.batch
      ? `These are ${input.entries.length} of the ${input.batch.scopeEntries} agent-written entries of its memory: batch ${input.batch.index} of ${input.batch.count}. The others are in their own batches, so name only these.`
      : `These are the agent-written entries of its memory: ${input.entries.length} entries, ${charsOf(input.entries)} characters.`,
    "",
    "## Entries",
    ...entryLines(input.entries),
  ];
  return lines.join("\n");
}

/**
 * The shape a `container_done` answer is held to (EO-596): every id a
 * kept fact is drawn from is one of the entries it was given, and none is
 * drawn on by two. Checked again when the answer comes back (invariant 5).
 */
export function containerDoneAnswerSchema(sent: readonly SentEntry[]): z.ZodType<MemoryContainerDoneAnswer> {
  const known = new Set(sent.map((entry) => entry.id));
  return MemoryContainerDoneAnswerSchema.superRefine((answer, ctx) => {
    const named = new Map<string, string>();
    answer.keep.forEach((keep, at) =>
      keep.from.forEach((id, index) => {
        const path = ["keep", at, "from", index];
        if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `names an entry it was not given: ${id}` });
        else if (named.has(id)) ctx.addIssue({ code: "custom", path, message: `names ${id} again, already named at ${named.get(id)}` });
        else named.set(id, path.join("."));
      }),
    );
  });
}

/** Why an entry a `container_done` consolidation did not keep was retired. */
export const CONTAINER_DONE_RETIRE_REASON = "only true while the container's work was in progress";

/**
 * A `container_done` answer as operations (EO-596), so it is applied by
 * the one function every consolidation is (`applyConsolidation`, with the
 * project as where it writes): a fact drawn from several entries is a
 * merge, one drawn from one a rewrite, and every entry given that no kept
 * fact is drawn from is retired.
 */
export function containerDoneOperations(sent: readonly SentEntry[], answer: MemoryContainerDoneAnswer): MemoryConsolidationOperations {
  const kept = new Set(answer.keep.flatMap((keep) => keep.from));
  return {
    retire: sent.filter((entry) => !kept.has(entry.id)).map((entry) => ({ id: entry.id, reason: CONTAINER_DONE_RETIRE_REASON })),
    merge: answer.keep.filter((keep) => keep.from.length > 1).map((keep) => ({ from: keep.from, body: keep.body, contradictsRepositoryFile: false })),
    rewrite: answer.keep.filter((keep) => keep.from.length === 1).map((keep) => ({ id: keep.from[0]!, body: keep.body, contradictsRepositoryFile: false })),
  };
}
