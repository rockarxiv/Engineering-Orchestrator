import {
  eoToolName,
  LEARNING_REVIEW_EVENT,
  MAX_MEMORY_NOTE_CHARS,
  MEMORY_NOTE_DEFINITION,
  MEMORY_NOTE_REPLACES,
  MEMORY_NOTE_TOOL_NAME,
  MEMORY_READ_TOOL_NAME,
  SKILL_CREATE_TOOL_NAME,
  SKILL_FILE_REMOVE_TOOL_NAME,
  SKILL_FILE_WRITE_TOOL_NAME,
  SKILL_PATCH_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
  type Item,
  type LearningReviewEvent,
  type LearningReviewKind,
  type Run,
} from "@eo/core";
import { extractionSkip, type ExtractionSkip, type RunProduce } from "./extraction.js";
import type { MemoryScopeInfo } from "./selection.js";
import { scopeLines } from "./writing.js";

/**
 * The learning review (EO-717, after Nous Research's Hermes Agent).
 *
 * When a run ends, EO forks the run's own thread and sends this one turn
 * on the fork. The fork has everything the run saw — every file it read,
 * every command, every correction — so it can judge what is worth
 * keeping far better than `memory_extract`, a side call that reads a
 * summary. The fork is a copy: the item's thread is not written to, and
 * the next dispatch resumes the original without this turn.
 *
 * The full review is served `memory_read`, `memory_note` and the skill
 * tools (EO-718, `reviewSkills.ts`) and no other write
 * (`AgentWriteBridgeAddress.writes`). Where the thread cannot be forked,
 * `memory_extract` runs instead, as it did before this, and no skill is
 * written for that run.
 *
 * A run that called `memory_note` itself gets the skill half alone
 * (EO-731): it already wrote its notes, so the fork is served
 * `memory_read` and the skill tools and not `memory_note`, and is asked
 * about skills only. Where its thread cannot be forked nothing runs in
 * its place, since `memory_extract` writes memory alone.
 */

/**
 * Why no review was asked for: the runs `memory_extract` skips, less the
 * one it skips for a short answer and the one that wrote its own notes,
 * which still gets the skill half (EO-731).
 */
export type LearningReviewSkip = Exclude<ExtractionSkip, "little_prose" | "noted_itself">;

/**
 * Which review a run gets, or why it gets none. Pure. The runs
 * extraction skips — not ended on its own terms (cancelled),
 * interrupted, a preview, or no scope — get none; a run whose answer is
 * short is not skipped, since it may still have read and run plenty,
 * which is what the fork sees. A run that called `memory_note` itself
 * gets the skill half alone (EO-731): the skip that extraction made for
 * it is about memory, so only memory is skipped.
 */
export function learningReviewFor(
  run: Run,
  item: Pick<Item, "previewAt">,
  produce: RunProduce,
  scopes: readonly MemoryScopeInfo[],
): { review: LearningReviewKind } | { skip: LearningReviewSkip } {
  const skip = extractionSkip(run, item, { ...produce, calledMemoryNote: false }, scopes);
  if (skip !== null && skip !== "little_prose" && skip !== "noted_itself") return { skip };
  return { review: produce.calledMemoryNote ? "skills_only" : "full" };
}

const MEMORY_NOTE = eoToolName(MEMORY_NOTE_TOOL_NAME);
const MEMORY_READ = eoToolName(MEMORY_READ_TOOL_NAME);
const SKILL_VIEW = eoToolName(SKILL_VIEW_TOOL_NAME);
const SKILL_CREATE = eoToolName(SKILL_CREATE_TOOL_NAME);
const SKILL_PATCH = eoToolName(SKILL_PATCH_TOOL_NAME);
const SKILL_FILE_WRITE = eoToolName(SKILL_FILE_WRITE_TOOL_NAME);
const SKILL_FILE_REMOVE = eoToolName(SKILL_FILE_REMOVE_TOOL_NAME);

/** One skill the review may read and change, as its prompt lists it (EO-718). */
export interface LearningReviewSkill {
  slug: string;
  description: string;
  /** Whether the reviewed run loaded it. */
  loaded: boolean;
  /** Whether a person locked it, so no write to it is taken. */
  locked: boolean;
}

/** What the review is told about skills: the ones it may change, and whether it may create one (only on an item with a project). */
export interface LearningReviewSkills {
  skills: readonly LearningReviewSkill[];
  canCreate: boolean;
}

/**
 * What the review turn is sent. What a note is comes from core
 * (`MEMORY_NOTE_DEFINITION`), word for word, as it does for an agent
 * writing its own notes and for `MEMORY_EXTRACT_SYSTEM`. Around it are
 * the rules that worked in Hermes: save only what the run can point to,
 * never infer what a person is like, and never save what describes this
 * run's circumstances rather than the project — an environment failure,
 * a claim that a tool does not work, an error that went away, an
 * approach that did not work. A later agent told any of those stops
 * trying what would work for it.
 *
 * Then skills (EO-718): the order Hermes keeps a library broad rather
 * than long — patch a skill the run loaded, then an existing broad one,
 * then add a `references/` file under one, and only then create a skill,
 * named for the kind of task. One lesson stated once, and wrong text
 * fixed where it stands.
 */
export function learningReviewPrompt(scopes: readonly MemoryScopeInfo[], skills: LearningReviewSkills = { skills: [], canCreate: false }): string {
  const limit = MAX_MEMORY_NOTE_CHARS.toLocaleString("en-US");
  return [
    ...REVIEW_HEAD,
    `You are asked one thing: whether this run learned something the next agent on this project should be told, and if it did, to write it down — a fact to memory with \`${MEMORY_NOTE}\`, a way of doing a kind of task to a skill (below). Use \`${MEMORY_READ}\` to see what memory already holds. Do nothing else — do not change files, run commands, post comments, or carry on the run's work.`,
    "",
    MEMORY_NOTE_DEFINITION,
    "",
    `${SAVE_ONLY_EVIDENCE} A note is believed by agents that cannot ask you where it came from.`,
    "",
    "Never infer a person's traits, habits or preferences from how they wrote or what they asked for. What a person said about how work is done here may be a note, in what they said, and nothing read into it.",
    "",
    ...NEVER_SAVE,
    "",
    `One fact per note, in at most ${limit} characters. Give each note the scope it is true of:`,
    ...scopeLines(scopes),
    "",
    `A note that corrects an entry memory holds, or says again what one already says, names that entry's id in \`${MEMORY_NOTE_REPLACES}\`, and EO retires the entry when it writes the note. Name only entries an agent wrote, never a person's. Do not write again what memory already holds.`,
    "",
    ...skillsSection(skills),
    "",
    "Many runs teach nothing worth keeping. Then write nothing. Either way, end with one line saying what you saved, or that there was nothing to save.",
  ].join("\n");
}

/**
 * What the skill-only review is sent (EO-731), for a run that called
 * `memory_note` itself: the same opening, evidence rules and skills part
 * as the full review, and nothing about writing memory — not
 * `MEMORY_NOTE_DEFINITION`, not the scopes a note may go to. It says the
 * run already wrote its own notes, and that memory may be read to see
 * them, since a skill should not repeat what a note already holds.
 */
export function learningReviewSkillsPrompt(skills: LearningReviewSkills): string {
  return [
    ...REVIEW_HEAD,
    `You are asked one thing: whether this run worked out a way of doing a kind of task that the next agent on this project should be told, and if it did, to write it to a skill (below). This run already wrote its own notes to memory, so memory is not asked for here and you cannot write to it; use \`${MEMORY_READ}\` to see what it holds. Do nothing else — do not change files, run commands, post comments, or carry on the run's work.`,
    "",
    SAVE_ONLY_EVIDENCE,
    "",
    ...NEVER_SAVE,
    "",
    ...skillsSection(skills),
    "",
    "Many runs teach nothing worth keeping. Then write nothing. Either way, end with one line saying what you saved, or that there was nothing to save.",
  ].join("\n");
}

/** How either review opens: what this turn is, and is not. */
const REVIEW_HEAD = [
  "# Learning review",
  "",
  "The run above has ended. This turn is not part of its work: nothing you say here reaches the item, its thread or anybody on it, and the run's next turn will not see it.",
  "",
];

const SAVE_ONLY_EVIDENCE =
  "Save only what this run can point to: a command it ran and what came of it, a file it read, an answer a person gave. Not what you suspect or expect, and not what the run assumed and never checked.";

/** What is never saved, in either review. */
const NEVER_SAVE = [
  "Never save any of these, however sure the run was of them:",
  "- An environment failure: a network or service outage, a missing credential, a full disk, a sandbox or permission refusing a command, a machine that was slow.",
  "- A claim that a tool, command or service does not work, or cannot do something.",
  "- An error that went away on its own or on a retry.",
  "- An approach that did not work. Where the run found what does work, save that instead.",
  "Each of these is about this run's circumstances, not the project, and a later agent told it stops trying what would work for it.",
];

/** The prompt's skills part (EO-718): what a skill is for, the order to prefer, the rules, and the skills this review may change. */
function skillsSection({ skills, canCreate }: LearningReviewSkills): string[] {
  const listed =
    skills.length === 0
      ? ["This run's agent is given no skills here yet."]
      : [
          "The skills this run's agent is given here, which you may read and change:",
          ...skills.map((skill) => `- \`${skill.slug}\`${skill.loaded ? " (loaded in this run)" : ""}${skill.locked ? " (a person locked it: read it, but it cannot be changed)" : ""} — ${skill.description}`),
        ];
  return [
    "## Skills",
    "",
    "A skill is how to do a kind of task: a description saying when it applies, a body saying how, and files beside it. Memory holds facts; a skill holds a procedure. Where this run found out how a kind of task is done here — the steps, their order, the trap and the way round it — that belongs in a skill.",
    "",
    ...listed,
    "",
    "Where a lesson belongs in a skill, put it in the first of these that fits:",
    "1. Patch a skill this run loaded.",
    "2. Else patch an existing broad skill that covers this kind of task.",
    `3. Else add a file under \`references/\` in one of those skills with \`${SKILL_FILE_WRITE}\`, and say in its body when to read it.`,
    canCreate
      ? `4. Only then create a new skill with \`${SKILL_CREATE}\`, named after the kind of task — never after a ticket, an error string or a date.`
      : "4. Do not create a skill: this run's item is on no project, and a new skill belongs to one.",
    "",
    `Read a skill with \`${SKILL_VIEW}\` before you change it, and a file before you overwrite it with \`${SKILL_FILE_WRITE}\` or remove it with \`${SKILL_FILE_REMOVE}\`: EO refuses a change to what this review has not read. \`${SKILL_PATCH}\` replaces text the body holds exactly once.`,
    "",
    "State one lesson once: where a skill already says it, leave it. Where a skill says something wrong, fix that text in place rather than adding a correction beside it. Every change is kept as a version a person can see and restore, and a skill a person locked takes no change.",
  ];
}

/** How a review ended, as its run event records it. */
export type LearningReviewOutcome =
  | { kind: "written"; entryIds: string[]; skillIds: string[]; forkThreadId: string }
  | { kind: "nothing_to_save"; forkThreadId: string }
  | { kind: "failed"; entryIds: string[]; skillIds: string[]; reason: string; forkThreadId: string | null }
  | { kind: "fell_back"; reason: string };

/** The `learning_review` event an outcome is recorded as, and which review it was (EO-731). */
export function learningReviewEvent(outcome: LearningReviewOutcome, review: LearningReviewKind): LearningReviewEvent {
  switch (outcome.kind) {
    case "written":
      return { type: LEARNING_REVIEW_EVENT, outcome: "written", review, entryIds: outcome.entryIds, skillIds: outcome.skillIds, reason: null, forkThreadId: outcome.forkThreadId };
    case "nothing_to_save":
      return { type: LEARNING_REVIEW_EVENT, outcome: "nothing_to_save", review, entryIds: [], skillIds: [], reason: null, forkThreadId: outcome.forkThreadId };
    case "failed":
      return { type: LEARNING_REVIEW_EVENT, outcome: "failed", review, entryIds: outcome.entryIds, skillIds: outcome.skillIds, reason: outcome.reason, forkThreadId: outcome.forkThreadId };
    case "fell_back":
      return { type: LEARNING_REVIEW_EVENT, outcome: "fell_back", review, entryIds: [], skillIds: [], reason: outcome.reason, forkThreadId: null };
  }
}
