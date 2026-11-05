import {
  renderSkillMarkdown,
  SKILL_PROPOSAL_DISCARD,
  SKILL_PROPOSAL_PROPOSE_AGAIN,
  SKILL_PROPOSAL_SAVE,
  skillProposalFingerprint,
  type Comment,
  type MemoryScope,
  type SkillProposal,
  type Skill,
  type SkillScope,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import {
  decideSkillProposal,
  forgetDiscardedSkillProposals,
  getAgent,
  getComment,
  getConsolidation,
  getItem,
  getMemory,
  getProject,
  getRun,
  getSkill,
  getSkillBySlug,
  getWorkspace,
  knownSkillProposal,
  postComment,
  recordSkillProposal,
  retireMemory,
  saveSkill,
  setAgentAttachment,
  skillProposalForComment,
  type CreateAttachmentRecord,
  type SkillProposalRecord,
} from "../db/repos/index.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";
import type { ProjectThreadAnswer } from "../projects/projectThread.js";
import { unifiedDiff } from "../skills/unifiedDiff.js";

/**
 * Memory consolidation proposes skills (EO-483, ARCHITECTURE.md, "What an
 * agent is given").
 *
 * When a consolidation finds a procedure that keeps appearing in a
 * scope's memory, it may propose up to three skills. Each is posted here
 * on the project's thread as its own comment: what the skill is for, the
 * entries and items it was seen in, the SKILL.md draft as an attachment
 * (and, for an improvement, the diff against the skill as it is), and
 * two answers — Save and Discard. It mentions the person, so it is in
 * their inbox.
 *
 * **Nothing is saved until a person presses Save.** A skill changes what
 * agents are dispatched with, and no step-owning agent may decide that
 * (invariant 11); the consolidation is a side call EO makes, and its
 * answer is a proposal and nothing more. The answer arrives the way
 * every answer to an offered option does — a reply on the thread, with
 * the option's text — and `answerSkillProposal` is what acts on it,
 * called on every human comment as `answerSkipOffer` is.
 */

/** Where the files a proposal attaches are kept — `AttachmentStorage`, structurally, as the supervisor's `ArtifactStore` takes it. */
export interface ProposalFileStore {
  storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">>;
  rollback?(records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): Promise<void>;
}

export interface PostSkillProposalsInput {
  db: Db;
  consolidationId: string;
  scope: MemoryScope;
  /** What the scope is called — `the workspace "api"`. */
  scopeLabel: string;
  /** The project whose thread they are posted on: the scope's own, or its workspace's. */
  projectId: Uuid | null;
  proposals: readonly SkillProposal[];
  /**
   * The entries the consolidations before the proposal call wrote by
   * folding two or more entries into one (EO-575), or by rewriting one
   * that was. Evidence names entries as those consolidations left them, so
   * an entry among these may hold the procedure together with whatever
   * else was folded in; Save leaves it in memory (`coveringEntries`).
   */
  folded: readonly string[];
  projectThread: (projectId: Uuid) => Promise<ProjectThreadAnswer>;
  store?: ProposalFileStore;
  now: number;
}

/** What became of each proposal: posted, or the sentence saying why not. */
export interface PostedProposals {
  posted: SkillProposalRecord[];
  /** For the consolidation's own note: a proposal that was not posted, and why. */
  notes: string[];
}

/** The skill scope a memory scope is. */
export function skillScopeOf(scope: MemoryScope): SkillScope {
  return scope.kind === "project" ? { kind: "project", projectId: scope.id } : { kind: "workspace", workspaceId: scope.id };
}

function sameScope(skill: SkillScope, scope: MemoryScope): boolean {
  if (skill.kind === "project") return scope.kind === "project" && skill.projectId === scope.id;
  if (skill.kind === "workspace") return scope.kind === "workspace" && skill.workspaceId === scope.id;
  return false;
}

/**
 * Why a proposal cannot be saved as it stands, or null: a new skill's
 * slug already belongs to another skill — archived ones too, since the
 * slug is unique whatever a row's state — or an improvement's target is
 * not the skill it was posted against (`improvementTarget`). Asked when
 * it is posted, and again when Save is pressed.
 */
function whyUnsaveable(
  db: Db,
  proposal: { kind: "new" | "improvement"; slug: string; targetSlug: string | null; targetSkillId: string | null },
  scope: MemoryScope,
): string | null {
  if (proposal.kind === "new") {
    const taken = getSkillBySlug(db, proposal.slug);
    if (!taken) return null;
    return `The slug \`${proposal.slug}\` is already taken by ${taken.archivedAt === null ? "another skill" : "an archived skill"}, so this cannot be saved as a new skill.`;
  }
  const target = improvementTarget(db, proposal, scope);
  return target.ok ? null : target.problem;
}

/**
 * The skill an improvement applies to: the one it was posted against,
 * by the id recorded then — never by its slug again. A slug is the one
 * thing about a skill a person can rename, and another skill may take
 * it up; the draft and diff a person read were for this row.
 *
 * So the row has to be there, live, still carry the slug the proposal
 * named, and be global or in the proposal's scope. A renamed target is
 * refused rather than followed: the draft was written for the skill as
 * it was named, and its frontmatter and diff say that name.
 */
function improvementTarget(
  db: Db,
  proposal: { slug: string; targetSlug: string | null; targetSkillId: string | null },
  scope: MemoryScope,
): { ok: true; skill: Skill } | { ok: false; problem: string } {
  const named = proposal.targetSlug ?? proposal.slug;
  const target = proposal.targetSkillId === null ? undefined : getSkill(db, proposal.targetSkillId);
  if (!target || target.archivedAt !== null) return { ok: false, problem: `The skill it improves, \`${named}\`, no longer exists, so there is nothing to apply it to.` };
  if (target.slug !== named) {
    return { ok: false, problem: `The skill it improves was \`${named}\` and has since been renamed \`${target.slug}\`, so this draft is no longer for it.` };
  }
  if (target.scope.kind !== "global" && !sameScope(target.scope, scope)) {
    return { ok: false, problem: `The skill it improves, \`${target.slug}\`, is scoped to another ${target.scope.kind}, so this scope cannot change it.` };
  }
  return { ok: true, skill: target };
}

/**
 * The entries Save moves into the skill, and those it leaves in memory.
 *
 * Evidence is named after the consolidation (EO-575), from the entries as
 * it left them. An evidence entry it did not fold is the note the
 * procedure was seen in, and moves. One it wrote by folding two or more
 * entries into one may have merged the procedure with something else
 * (the ledger is in UTC) — a fact the skill does not hold, which retiring
 * the entry would lose — and nothing EO keeps says which of the folded
 * entries held the procedure. So it is left in memory, conservatively,
 * and counted in `mixed`, so the proposal can say the procedure stays
 * there too.
 */
export function coveringEntries(evidence: readonly string[], folded: readonly string[]): { covering: string[]; mixed: string[] } {
  const merged = new Set(folded);
  const unique = [...new Set(evidence)];
  return { covering: unique.filter((id) => !merged.has(id)), mixed: unique.filter((id) => merged.has(id)) };
}

/** The agents whose runs wrote these entries — who Save attaches a new skill to. */
export function evidenceAgents(db: Db, entryIds: readonly string[]): { id: string; name: string }[] {
  const agents = new Map<string, string>();
  for (const id of entryIds) {
    const entry = getMemory(db, id);
    if (entry?.source.type !== "run" || entry.source.runId === null) continue;
    const run = getRun(db, entry.source.runId as Uuid);
    if (!run) continue;
    const agent = getAgent(db, run.agentId as Uuid);
    if (agent) agents.set(agent.id, agent.name);
  }
  return [...agents].map(([id, name]) => ({ id, name }));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function entries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/** The SKILL.md a proposal would make: for an improvement, the target as it is with the proposed body. */
function draftFile(db: Db, record: Pick<SkillProposalRecord, "kind" | "slug" | "name" | "description" | "body" | "targetSkillId">): { file: string; current: string | null } {
  const target = record.kind === "improvement" && record.targetSkillId !== null ? getSkill(db, record.targetSkillId) : undefined;
  if (target) {
    const frontmatter = { slug: target.slug, name: target.name, description: target.description, disableModelInvocation: target.disableModelInvocation };
    return { file: renderSkillMarkdown({ ...frontmatter, body: record.body }), current: renderSkillMarkdown({ ...frontmatter, body: target.body }) };
  }
  return { file: renderSkillMarkdown({ slug: record.slug, name: record.name, description: record.description, disableModelInvocation: false, body: record.body }), current: null };
}

/** What the comment says. */
export function proposalCommentBody(
  db: Db,
  record: Pick<SkillProposalRecord, "kind" | "slug" | "description" | "evidenceEntryIds" | "evidenceItemIds" | "coveringEntryIds" | "unsaveable">,
  context: {
    scopeLabel: string;
    attached: boolean;
    draft: string;
    diff: string | null;
    /** Evidence entries a consolidation folded together with others, which Save leaves in memory. */
    mixed?: number;
    /** The thread is the organisation's, so a press may come from another device. */
    shared?: boolean;
  },
): string {
  const lines: string[] = [
    record.kind === "new"
      ? `**A skill for ${context.scopeLabel}: \`${record.slug}\`**`
      : `**An improvement to the skill \`${record.slug}\`, from ${context.scopeLabel}**`,
    "",
    `> ${record.description}`,
    "",
    `Memory consolidation found this procedure again and again in ${context.scopeLabel}'s memory. As a skill, an agent chooses it by the line above and reads its steps when it needs them, and those lines leave every dispatch's memory.`,
    "",
    "**Evidence**",
    "",
  ];
  for (const id of record.evidenceEntryIds) {
    const entry = getMemory(db, id);
    const item = entry?.source.type === "run" && entry.source.itemId !== null ? getItem(db, entry.source.itemId as Uuid) : undefined;
    const where = item ? ` — from ${item.key}` : "";
    lines.push(`- Memory entry \`${id}\`${where}: "${oneLine(entry?.body ?? "(no longer there)", 140)}"`);
  }
  const keys = record.evidenceItemIds.flatMap((id) => getItem(db, id as Uuid)?.key ?? []);
  if (keys.length > 0) lines.push("", `Seen on ${listOf(keys)}.`);
  lines.push("");
  if (context.attached) {
    lines.push(context.diff === null ? "The draft is attached as `SKILL.md`." : "The draft is attached as `SKILL.md`, and what it changes in the skill as it is now as `SKILL.md.diff`.");
  } else {
    // No file store on this installation: the draft travels in the body
    // instead, so the comment still carries all of it.
    lines.push("The draft, as `SKILL.md`:", "", "````markdown", context.draft.trimEnd(), "````");
    if (context.diff !== null) lines.push("", "What it changes in the skill as it is now:", "", "````diff", context.diff.trimEnd(), "````");
  }
  lines.push("");
  if (record.unsaveable !== null) {
    lines.push(`**This cannot be saved.** ${record.unsaveable} Discard it, and it is not proposed again.`);
  } else {
    const agents = evidenceAgents(db, record.evidenceEntryIds).map((agent) => agent.name);
    const save =
      record.kind === "new"
        ? `**Save** creates it in ${context.scopeLabel}${agents.length > 0 ? ` and attaches it to ${listOf(agents)}` : ""}`
        : `**Save** replaces \`${record.slug}\`'s body with this one, leaving its scope and the agents it is attached to as they are`;
    const moved = record.coveringEntryIds.length;
    lines.push(
      `${save}${moved > 0 ? `, and moves the ${entries(moved)} holding this procedure out of memory into it — restoring the consolidation brings them back` : ""}. **Discard** drops it, and it is not proposed again.`,
    );
    const mixed = context.mixed ?? 0;
    if (mixed > 0) {
      lines.push(
        "",
        `${mixed === 1 ? "One memory entry holds" : `${mixed} memory entries hold`} this procedure folded together with other entries, so Save leaves ${mixed === 1 ? "it" : "them"} in memory as ${mixed === 1 ? "it is" : "they are"} rather than lose any other fact ${mixed === 1 ? "it holds" : "they hold"}.`,
      );
    }
  }
  if (context.shared) {
    lines.push(
      "",
      "These are the memory, skills and agents of the device that consolidated it, so Save and Discard are carried out there — pressed on another device, they take effect when that one next syncs, and EO answers here.",
    );
  }
  return lines.join("\n");
}

/**
 * Posts a consolidation's proposals on the project's thread, one comment
 * each. Never throws: what could not be posted is a sentence in `notes`,
 * which the consolidation keeps on its row.
 *
 * A proposal a person discarded before — the same scope and slug,
 * whatever its description says (EO-512) — posts nothing, and neither
 * does one still waiting on the thread for an answer, as
 * `skillProposalFingerprint` folds it. Asked first, so nothing is staged
 * for one already known, and asked again in the transaction that posts
 * it (`postOne`): finding the thread and storing the draft are awaited,
 * and a person may discard a proposal with the same slug meanwhile.
 */
export async function postSkillProposals(input: PostSkillProposalsInput): Promise<PostedProposals> {
  const { db } = input;
  const result: PostedProposals = { posted: [], notes: [] };
  const fresh = input.proposals.filter((proposal) => {
    const held = heldBack(db, input.scope, proposal);
    if (held !== null) result.notes.push(held);
    return held === null;
  });
  if (fresh.length === 0) return result;

  if (input.projectId === null) {
    result.notes.push(`${fresh.length === 1 ? "A skill was" : `${fresh.length} skills were`} proposed, but ${input.scopeLabel} is on no project, so there is no project thread to post ${fresh.length === 1 ? "it" : "them"} on.`);
    return result;
  }
  let thread: ProjectThreadAnswer;
  try {
    thread = await input.projectThread(input.projectId);
  } catch (error) {
    thread = { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!thread.ok) {
    result.notes.push(`${fresh.length === 1 ? "A skill was" : `${fresh.length} skills were`} proposed and could not be posted: ${thread.problem}`);
    return result;
  }
  const threadItem = thread.item;
  const shared = projectMovedToTheRecord(db, input.projectId);

  for (const proposal of fresh) {
    try {
      const posted = await postOne(input, proposal, threadItem.id as Uuid, shared);
      if ("held" in posted) result.notes.push(posted.held);
      else result.posted.push(posted);
    } catch (error) {
      result.notes.push(`The skill proposal \`${proposal.slug}\` could not be posted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/**
 * Why a proposal is not posted, as the consolidation's note says it, or
 * null: one with its scope and slug was discarded, or one with its
 * fingerprint is still waiting for an answer.
 */
function heldBack(db: Db, scope: MemoryScope, proposal: SkillProposal): string | null {
  const known = knownSkillProposal(db, scope, { slug: proposal.slug, fingerprint: skillProposalFingerprint(proposal) });
  if (known === "discarded") return `The skill proposal \`${proposal.slug}\` was discarded before, so it was not posted again.`;
  if (known === "open") return `The skill proposal \`${proposal.slug}\` is already on the project's notes, waiting for an answer, so it was not posted again.`;
  return null;
}

/** Posts one proposal, or answers why it was held back after all — with nothing posted, and its staged files removed. */
async function postOne(
  input: PostSkillProposalsInput,
  proposal: SkillProposal,
  threadItemId: Uuid,
  shared: boolean,
): Promise<SkillProposalRecord | { held: string }> {
  const { db } = input;
  const targetSlug = proposal.kind === "improvement" ? proposal.target : null;
  // Resolved by slug once, here, and recorded by id: from now on the
  // proposal is about this row, whatever is later called `targetSlug`.
  const target = targetSlug === null ? undefined : getSkillBySlug(db, targetSlug);
  const targetSkillId = target && target.archivedAt === null ? target.id : null;
  const unsaveable = whyUnsaveable(db, { kind: proposal.kind, slug: proposal.slug, targetSlug, targetSkillId }, input.scope);
  const followed = coveringEntries(proposal.evidence.entryIds, input.folded);
  const fields = {
    consolidationId: input.consolidationId,
    scope: input.scope,
    kind: proposal.kind,
    targetSlug,
    targetSkillId,
    slug: proposal.slug,
    name: proposal.name,
    description: proposal.description,
    body: proposal.body,
    evidenceEntryIds: [...new Set(proposal.evidence.entryIds)],
    evidenceItemIds: [...new Set(proposal.evidence.itemIds)],
    coveringEntryIds: followed.covering,
    fingerprint: skillProposalFingerprint(proposal),
    unsaveable,
    createdAt: input.now,
  };

  const { file, current } = draftFile(db, fields);
  const diff = current === null ? null : unifiedDiff(current, file, { from: `a/${proposal.slug}/SKILL.md`, to: `b/${proposal.slug}/SKILL.md` });
  const stored: Omit<CreateAttachmentRecord, "itemId" | "commentId">[] = [];
  if (input.store) {
    try {
      stored.push(await input.store.storeImported({ name: "SKILL.md", mimeType: "text/markdown", data: Buffer.from(file, "utf8") }));
      if (diff !== null) stored.push(await input.store.storeImported({ name: "SKILL.md.diff", mimeType: "text/x-diff", data: Buffer.from(diff, "utf8") }));
    } catch (error) {
      await input.store.rollback?.(stored).catch(() => undefined);
      throw error;
    }
  }

  const body = proposalCommentBody(db, fields, { scopeLabel: input.scopeLabel, attached: stored.length > 0, draft: file, diff, mixed: followed.mixed.length, shared });
  let posted: SkillProposalRecord | { held: string };
  try {
    posted = db.transaction((): SkillProposalRecord | { held: string } => {
      // Asked again here, in the same synchronous stretch as the write
      // (EO-512): the thread and the files above were awaited, and a
      // Discard on one with this slug, answered meanwhile, holds this
      // one back as surely as one answered before it was proposed.
      const held = heldBack(db, input.scope, proposal);
      if (held !== null) return { held };
      const comment = postComment(db, {
        itemId: threadItemId,
        author: { type: "engine" },
        kind: "question",
        body,
        mentions: [{ type: "human" }],
        // Discard is offered even where Save is not: answering is what
        // closes the mention, and "drop it" is an answer.
        options: unsaveable === null ? [SKILL_PROPOSAL_SAVE, SKILL_PROPOSAL_DISCARD] : [SKILL_PROPOSAL_DISCARD],
        attachmentRecords: stored,
        // EO's own sentence, quoting what agents wrote: nothing in it summons anyone.
        parseBodyMentions: false,
      });
      return recordSkillProposal(db, { ...fields, commentId: comment.id });
    });
  } catch (error) {
    await input.store?.rollback?.(stored).catch(() => undefined);
    throw error;
  }
  // Held back: the files staged for it belong to no comment.
  if ("held" in posted) await input.store?.rollback?.(stored).catch(() => undefined);
  return posted;
}

// ── Answering ────────────────────────────────────────────────────

export type SkillProposalAnswer =
  | { outcome: "saved"; proposal: SkillProposalRecord; skillId: string; attachedTo: string[]; moved: string[] }
  | { outcome: "discarded"; proposal: SkillProposalRecord }
  /** A person asked for a discarded one to be allowed again, and its discard records were removed (EO-512). */
  | { outcome: "allowed"; proposal: SkillProposalRecord; removed: number }
  | { outcome: "refused"; proposal: SkillProposalRecord; problem: string };

/** Which answer this reply is, by its first line, as `answerSkipOffer` reads one. */
function chosen(body: string): typeof SKILL_PROPOSAL_SAVE | typeof SKILL_PROPOSAL_DISCARD | typeof SKILL_PROPOSAL_PROPOSE_AGAIN | null {
  const first = (body.split("\n", 1)[0] ?? "").trim().replace(/[.!]+$/, "").replace(/\s+/g, " ").toLowerCase();
  if (first === SKILL_PROPOSAL_SAVE.toLowerCase()) return SKILL_PROPOSAL_SAVE;
  if (first === SKILL_PROPOSAL_DISCARD.toLowerCase()) return SKILL_PROPOSAL_DISCARD;
  if (first === SKILL_PROPOSAL_PROPOSE_AGAIN.toLowerCase()) return SKILL_PROPOSAL_PROPOSE_AGAIN;
  return null;
}

/** What EO says when it records a Discard: that it holds, and how a person lifts it (EO-512). */
function discardedSentence(slug: string): string {
  return `Discarded. A later consolidation of this scope will not propose \`${slug}\` again, however it words the description. To let it be proposed again, reply **${SKILL_PROPOSAL_PROPOSE_AGAIN}** here.`;
}

/**
 * Acts on a person's answer to a skill proposal, if that is what this
 * comment is. Called on every human comment; answers null for all but a
 * reply, on the proposal's own thread, filed under the proposal, whose
 * first line is an option the proposal offered, while it is still open —
 * or whose first line is "Propose again", while it is discarded, which
 * removes the scope's discard records for its slug (EO-512).
 *
 * Every answer it acts on ends in a reply from EO under the proposal
 * saying what was done, or why nothing was (invariant 8).
 *
 * "Human" is the whole test of who may press, and it admits the system
 * agent on purpose (EO-514, ARCHITECTURE.md, "Proposing skills"). Its
 * `comment_post` over `eo_admin` writes through `postHumanComment`, as
 * the person, and nothing here can tell it from the person's own reply.
 * That is allowed rather than refused: invariant 11 makes deciding what
 * agents are dispatched with the system agent's job, it already holds
 * `skill_save` and `agent_attachments_set` and could make the same skill
 * without the proposal, and the entries a Save retires come back with
 * the consolidation, as the ones a consolidation retires by itself do. A
 * step-owning agent's words reach the thread as the agent's, so the
 * press stays out of its reach.
 */
export function answerSkillProposal(db: Db, comment: Comment, now: number = Date.now()): SkillProposalAnswer | null {
  if (comment.parentId === null || comment.authorType !== "human") return null;
  const choice = chosen(comment.body);
  if (choice === null) return null;
  const proposal = skillProposalForComment(db, comment.parentId);
  if (!proposal) return null;
  const offer = getComment(db, comment.parentId as Uuid);
  // Answered where it was asked — the check `answerSkipOffer` makes, for its reasons.
  if (!offer || offer.itemId !== comment.itemId) return null;

  if (choice === SKILL_PROPOSAL_PROPOSE_AGAIN) {
    if (proposal.status !== "discarded") return null;
    // Every discard record for the slug, this one among them: any one
    // left would still hold it back. A copy of this reply arriving twice
    // finds no row the second time, and answers null.
    const removed = db.transaction(() => {
      const count = forgetDiscardedSkillProposals(db, proposal.scope, proposal.slug);
      if (count > 0) reply(db, offer, `Allowed again. A later consolidation of this scope may propose \`${proposal.slug}\` again, and it is posted here as a new proposal if it does.`);
      return count;
    });
    return removed > 0 ? { outcome: "allowed", proposal, removed } : null;
  }

  // Only with what it offered, and only while it is open.
  if (proposal.status !== "open" || !offer.options?.includes(choice)) return null;

  if (choice === SKILL_PROPOSAL_DISCARD) {
    if (!decideSkillProposal(db, proposal.id, { status: "discarded", now })) return null;
    reply(db, offer, discardedSentence(proposal.slug));
    return { outcome: "discarded", proposal: { ...proposal, status: "discarded", decidedAt: now } };
  }

  const refused = (problem: string): SkillProposalAnswer => {
    reply(db, offer, `Nothing was saved. ${problem}`);
    return { outcome: "refused", proposal, problem };
  };
  // A published configuration binds here as it does on the Skills screen:
  // Save is a skill save and an attachment, by another door.
  for (const channel of ["skills:save", "agentAttachments:set"] as const) {
    const lock = sectionLockFor(db, channel);
    if (lock) return refused(`Your organisation has published the ${lock.section} section${lock.publishedBy ? ` (${lock.publishedBy})` : ""}, so skills are changed there.`);
  }
  // Restored since it was posted: the memory it was drawn from is back as
  // it was before, and an entry retired now under that consolidation's id
  // could never be restored again — its restore has been spent. So
  // nothing is written; a later consolidation may propose it afresh.
  const proposing = getConsolidation(db, proposal.consolidationId);
  if (proposing?.status === "restored") {
    return refused("The consolidation that proposed it has since been restored, so the memory it was drawn from is back as it was; a later consolidation can propose it again.");
  }
  const unsaveable = whyUnsaveable(db, proposal, proposal.scope);
  if (unsaveable !== null) return refused(unsaveable);
  if (proposal.scope.kind === "project" ? !getProject(db, proposal.scope.id as Uuid) : !getWorkspace(db, proposal.scope.id as Uuid)) {
    return refused(`The ${proposal.scope.kind} it is for no longer exists.`);
  }

  try {
    return db.transaction((): SkillProposalAnswer => {
      let skillId: string;
      const attachedTo: string[] = [];
      if (proposal.kind === "new") {
        const saved = saveSkill(db, { slug: proposal.slug, name: proposal.name, description: proposal.description, body: proposal.body, files: [], scope: skillScopeOf(proposal.scope) }, now);
        if (!saved.ok) throw new Refusal(saved.problems.join(" "));
        skillId = saved.skill.id;
        for (const agent of evidenceAgents(db, proposal.evidenceEntryIds)) {
          if (setAgentAttachment(db, { agentId: agent.id, kind: "skill", id: skillId, attached: true }, now).ok) attachedTo.push(agent.name);
        }
      } else {
        // By the recorded id, asked again inside the transaction.
        const found = improvementTarget(db, proposal, proposal.scope);
        if (!found.ok) throw new Refusal(found.problem);
        const target = found.skill;
        // The body, and only the body: its slug, name, description,
        // files, switches, scope and attachments stay as they are.
        const saved = saveSkill(db, { id: target.id, slug: null, name: target.name, description: target.description, body: proposal.body, files: target.files }, now);
        if (!saved.ok) throw new Refusal(saved.problems.join(" "));
        skillId = saved.skill.id;
      }
      const moved: string[] = [];
      for (const id of proposal.coveringEntryIds) {
        if (retireMemory(db, id, { reason: "moved_to_skill", consolidationId: proposal.consolidationId, now }).ok) moved.push(id);
      }
      decideSkillProposal(db, proposal.id, { status: "saved", skillId, movedEntryIds: moved, now });
      reply(db, offer, savedSentence(proposal, attachedTo, moved));
      return { outcome: "saved", proposal: { ...proposal, status: "saved", skillId, movedEntryIds: moved, decidedAt: now }, skillId, attachedTo, moved };
    });
  } catch (error) {
    if (error instanceof Refusal) return refused(error.message);
    // The transaction took everything back, and the proposal is still
    // open: said, so the person knows to answer again (invariant 8). A
    // throw here would be lost on a mirrored answer, which is never
    // placed twice.
    return refused(`Saving it failed: ${error instanceof Error ? error.message : String(error)} Answer Save again to retry.`);
  }
}

/**
 * The same, for an answer written on another machine and copied here
 * (EO-483) — a reply pulled from the organisation's record, or one the
 * record received from a device.
 *
 * A proposal is posted on the project's thread, which every device and
 * the record share, but its row — and the memory, skills and agents Save
 * changes — are the database that consolidated it. So the press is
 * carried out where that row is, whichever machine it was made on: the
 * reply reaches it through the record like any other comment, and this
 * is called as it is written down. Every other database holds no row for
 * the proposal and answers null, and the row's own `open` status is what
 * keeps a reply that arrives twice from acting twice. EO's answer is an
 * ordinary comment here, so it travels back to the thread everyone sees.
 *
 * Never throws: it runs in the middle of a sync, which a proposal must
 * not stop.
 */
export function answerCopiedSkillProposal(db: Db, comment: Comment): SkillProposalAnswer | null {
  try {
    const answer = answerSkillProposal(db, comment);
    if (answer?.outcome === "saved") emitPush("config:changed", {});
    if (answer !== null) emitPush("items:changed", { itemId: comment.itemId });
    return answer;
  } catch (error) {
    console.warn(`[eo] an answer to a skill proposal could not be acted on: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

class Refusal extends Error {}

function savedSentence(proposal: SkillProposalRecord, attachedTo: readonly string[], moved: readonly string[]): string {
  const what =
    proposal.kind === "new"
      ? `Saved the skill \`${proposal.slug}\`${attachedTo.length > 0 ? ` and attached it to ${listOf(attachedTo)}` : ", attached to no agent — none of the runs that wrote its evidence has an agent any more"}.`
      : `Updated the skill \`${proposal.slug}\`'s body; its scope and the agents it is attached to are unchanged.`;
  const left = proposal.coveringEntryIds.length - moved.length;
  const memory =
    moved.length > 0
      ? ` Moved ${entries(moved.length)} out of memory into it; restoring the consolidation that proposed it brings them back.${left > 0 ? ` ${entries(left)} had already been retired or edited, and were left as they are.` : ""}`
      : proposal.coveringEntryIds.length > 0
        ? " The memory entries it came from had already been retired or edited, so none were moved."
        : "";
  return `${what}${memory}`;
}

function reply(db: Db, offer: Comment, body: string): void {
  postComment(db, { itemId: offer.itemId, author: { type: "engine" }, kind: "note", body, parentId: offer.id, parseBodyMentions: false });
}
