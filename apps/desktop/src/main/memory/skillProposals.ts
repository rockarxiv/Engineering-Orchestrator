import { renderSkillMarkdown, skillProposalFingerprint, type MemoryScope, type Skill, type SkillAuthor, type SkillProposal, type SkillScope, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  decideSkillProposal,
  getAgent,
  getConsolidation,
  getItem,
  getMemory,
  getProject,
  getRun,
  getSkill,
  getSkillBySlug,
  getWorkspace,
  listDiscardedSkillProposals,
  listSkills,
  listSkillVersions,
  postComment,
  recordSkillProposal,
  retireMemory,
  saveSkill,
  setAgentAttachment,
  skillProposalDiscarded,
  type CreateAttachmentRecord,
  type DiscardedSkillProposal,
  type SkillProposalRecord,
} from "../db/repos/index.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";
import type { ProjectThreadAnswer } from "../projects/projectThread.js";
import { unifiedDiff } from "../skills/unifiedDiff.js";

/**
 * Memory consolidation's skill proposals, applied (EO-483, EO-719,
 * ARCHITECTURE.md, "Proposing skills").
 *
 * When a consolidation finds a procedure that keeps appearing in a
 * scope's memory, its proposal call may answer with up to three skills.
 * Each is applied here as it arrives, with no person's approval: a new
 * one is created — `created_by` 'agent', in the proposal's scope, attached
 * to the agents whose runs wrote the evidence — and an improvement writes
 * a new version of its target. Every write is a `skill_versions` row
 * authored by the consolidation, and the evidence entries are retired as
 * `moved_to_skill` with its id, so restoring it brings them back.
 *
 * Skills are instructions, which agents may write (invariant 11). What
 * answers for one is its history, a person's lock and archiving it, so:
 * a locked target refuses the write; and a person archiving a skill a
 * consolidation created is the person discarding it — a later proposal
 * with its scope and slug is not applied unless a person restores it.
 *
 * Each proposal, applied or not, is a notice on the project's thread:
 * what was created or changed, or why nothing was, the evidence, and the
 * draft (and, for an improvement, its diff). It asks nothing and offers
 * no answer; nothing acts on a reply to it.
 */

/** Where the files a notice attaches are kept — `AttachmentStorage`, structurally, as the supervisor's `ArtifactStore` takes it. */
export interface ProposalFileStore {
  storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">>;
  rollback?(records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): Promise<void>;
}

export interface ApplySkillProposalsInput {
  db: Db;
  consolidationId: string;
  scope: MemoryScope;
  /** What the scope is called — `the workspace "api"`. */
  scopeLabel: string;
  /** The project whose thread the notices are posted on: the scope's own, or its workspace's. */
  projectId: Uuid | null;
  proposals: readonly SkillProposal[];
  /**
   * The entries the consolidations before the proposal call wrote by
   * folding two or more entries into one (EO-575), or by rewriting one
   * that was. Evidence names entries as those consolidations left them, so
   * an entry among these may hold the procedure together with whatever
   * else was folded in; applying a proposal leaves it in memory
   * (`coveringEntries`).
   */
  folded: readonly string[];
  /**
   * The skills the proposal call was shown, slug to id, as they were when
   * it was asked. An improvement names its target by slug; this is the
   * skill that slug meant then, so one renamed while the call ran is
   * refused as renamed rather than followed to whatever holds the slug now.
   */
  shown?: ReadonlyMap<string, string>;
  projectThread: (projectId: Uuid) => Promise<ProjectThreadAnswer>;
  store?: ProposalFileStore;
  now: number;
}

/** What became of each proposal. */
export interface AppliedProposals {
  /** The proposals applied, as recorded. */
  applied: SkillProposalRecord[];
  /** The proposals not applied, and why — each said in its notice too. */
  refused: { slug: string; problem: string }[];
  /** For the consolidation's own note: a proposal held back or not acted on, and why. */
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
 * Whether a person discarded this skill: a consolidation created it, in
 * this scope, and it is archived, by a person — or by the system agent,
 * which acts with the person's authority. Restoring it makes it live, and
 * so not discarded; archiving it again discards it again.
 */
function discardedByArchive(db: Db, skill: Skill, scope: MemoryScope): boolean {
  if (skill.archivedAt === null || skill.createdBy !== "agent" || !sameScope(skill.scope, scope)) return false;
  const versions = listSkillVersions(db, skill.id);
  // Newest first: the create is the last of them.
  const created = [...versions].reverse().find((version) => version.action === "create");
  if (created?.author.kind !== "consolidation") return false;
  const archived = versions.find((version) => version.action === "archive");
  return archived?.author.kind === "person" || archived?.author.kind === "agent";
}

/**
 * What a scope's proposal call is told not to propose again (EO-512):
 * every proposal a person discarded with the Discard answer proposals
 * used to offer, and every skill a consolidation created in the scope
 * that a person archived. One per slug, newest first.
 */
export function discardedSkillProposals(db: Db, scope: MemoryScope): DiscardedSkillProposal[] {
  const bySlug = new Map<string, DiscardedSkillProposal>();
  const archived = listSkills(db, true)
    .filter((skill) => discardedByArchive(db, skill, scope))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  for (const skill of archived) bySlug.set(skill.slug, { slug: skill.slug, description: skill.description });
  for (const proposal of listDiscardedSkillProposals(db, scope)) if (!bySlug.has(proposal.slug)) bySlug.set(proposal.slug, proposal);
  return [...bySlug.values()];
}

/**
 * Why a proposal is held back without a notice, as the consolidation's
 * note says it, or null: a person discarded its scope and slug — a new
 * skill whose slug is a consolidation's skill a person archived, or any
 * proposal whose slug a person discarded with the Discard answer
 * proposals used to offer. Nothing is posted for it: the person has
 * already said no, and a notice every consolidation would only say it
 * again. An improvement to an archived skill is not held back here; it
 * is refused with a notice saying why (`improvementTarget`).
 */
function heldBack(db: Db, scope: MemoryScope, proposal: SkillProposal): string | null {
  if (proposal.kind === "new") {
    const skill = getSkillBySlug(db, proposal.slug);
    if (skill && discardedByArchive(db, skill, scope)) {
      return `The skill proposal \`${proposal.slug}\` was not applied: a person archived the skill \`${proposal.slug}\` a consolidation created in this scope, and it stays discarded unless a person restores it.`;
    }
  }
  const slugs = proposal.kind === "improvement" ? [...new Set([proposal.slug, proposal.target])] : [proposal.slug];
  for (const slug of slugs) {
    if (skillProposalDiscarded(db, scope, slug)) return `The skill proposal \`${proposal.slug}\` was discarded before, so it was not applied.`;
  }
  return null;
}

/** Why an archived target is not written to: a person's discard, if it is one, or an archive. */
function archivedProblem(db: Db, skill: Skill, scope: MemoryScope): string {
  return discardedByArchive(db, skill, scope)
    ? `A person archived the skill \`${skill.slug}\`, which a consolidation created, and that discards it: it is not changed again unless a person restores it on the Skills screen.`
    : `The skill it improves, \`${skill.slug}\`, is archived, so it was left as it is; a person can restore it on the Skills screen.`;
}

/**
 * The skill an improvement's target slug means: the one the proposal call
 * was shown under it, by id. With no snapshot of what it was shown (a
 * caller that passes none), the skill holding the slug now.
 */
function targetIdOf(db: Db, named: string, shown: ReadonlyMap<string, string> | undefined): string | undefined {
  return shown ? shown.get(named) : getSkillBySlug(db, named)?.id;
}

/**
 * The skill an improvement applies to, or why there is none to apply it
 * to: `targetId` is the skill its target slug meant when the proposal call
 * was asked. So the row has to be there, live, unlocked, still carry the
 * slug the proposal named, and be global or in the proposal's scope. A
 * renamed target is refused rather than followed: the draft was written
 * for the skill as it was named, and its diff says that name.
 */
function improvementTarget(db: Db, named: string, targetId: string | undefined, scope: MemoryScope): { ok: true; skill: Skill } | { ok: false; problem: string } {
  const target = targetId === undefined ? undefined : getSkill(db, targetId);
  if (!target) {
    // Not one the call was shown. Whatever holds the slug now is only
    // looked at to say why: an archived skill (which the call is never
    // shown), or one made while the call ran, which its draft was not
    // written for and which is never written to.
    const now = getSkillBySlug(db, named);
    if (now && now.archivedAt !== null) return { ok: false, problem: archivedProblem(db, now, scope) };
    if (now) return { ok: false, problem: `The skill \`${named}\` was made while the proposal was being written, so this draft was not written for it and it was left as it is.` };
    return { ok: false, problem: `There is no skill \`${named}\` for it to improve, so there is nothing to apply it to.` };
  }
  if (target.archivedAt !== null) return { ok: false, problem: archivedProblem(db, target, scope) };
  if (target.slug !== named) {
    return { ok: false, problem: `The skill it improves was \`${named}\` and has since been renamed \`${target.slug}\`, so this draft is no longer for it.` };
  }
  if (target.locked) return { ok: false, problem: `A person locked the skill \`${target.slug}\`, so only a person can change it.` };
  if (target.scope.kind !== "global" && !sameScope(target.scope, scope)) {
    return { ok: false, problem: `The skill it improves, \`${target.slug}\`, is scoped to another ${target.scope.kind}, so this scope cannot change it.` };
  }
  return { ok: true, skill: target };
}

/**
 * The entries applying a proposal moves into the skill, and those it
 * leaves in memory.
 *
 * Evidence is named after the consolidation (EO-575), from the entries as
 * it left them. An evidence entry it did not fold is the note the
 * procedure was seen in, and moves. One it wrote by folding two or more
 * entries into one may have merged the procedure with something else
 * (the ledger is in UTC) — a fact the skill does not hold, which retiring
 * the entry would lose — and nothing EO keeps says which of the folded
 * entries held the procedure. So it is left in memory, conservatively,
 * and counted in `mixed`, so the notice can say the procedure stays
 * there too.
 */
export function coveringEntries(evidence: readonly string[], folded: readonly string[]): { covering: string[]; mixed: string[] } {
  const merged = new Set(folded);
  const unique = [...new Set(evidence)];
  return { covering: unique.filter((id) => !merged.has(id)), mixed: unique.filter((id) => merged.has(id)) };
}

/** The agents whose runs wrote these entries — who a new skill is attached to. */
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

/** The SKILL.md a proposal makes: for an improvement, the target as it is with the proposed body. */
function draftFile(proposal: SkillProposal, target: Skill | undefined): { file: string; current: string | null } {
  if (target) {
    const frontmatter = { slug: target.slug, name: target.name, description: target.description, disableModelInvocation: target.disableModelInvocation };
    return { file: renderSkillMarkdown({ ...frontmatter, body: proposal.body }), current: renderSkillMarkdown({ ...frontmatter, body: target.body }) };
  }
  return { file: renderSkillMarkdown({ slug: proposal.slug, name: proposal.name, description: proposal.description, disableModelInvocation: false, body: proposal.body }), current: null };
}

/** What became of one proposal, as its notice says it. */
export type ProposalOutcome = { applied: true; attachedTo: readonly string[]; moved: number } | { applied: false; problem: string };

/** What a proposal's notice says. */
export function proposalNoticeBody(
  db: Db,
  proposal: Pick<SkillProposal, "kind" | "slug" | "description"> & { evidenceEntryIds: readonly string[]; evidenceItemIds: readonly string[] },
  outcome: ProposalOutcome,
  context: {
    scopeLabel: string;
    attached: boolean;
    draft: string;
    diff: string | null;
    /** Evidence entries a consolidation folded together with others, which applying it leaves in memory. */
    mixed: number;
  },
): string {
  const heading = outcome.applied
    ? proposal.kind === "new"
      ? `**Memory consolidation created the skill \`${proposal.slug}\` for ${context.scopeLabel}**`
      : `**Memory consolidation changed the skill \`${proposal.slug}\`, from ${context.scopeLabel}**`
    : proposal.kind === "new"
      ? `**Memory consolidation proposed the skill \`${proposal.slug}\` for ${context.scopeLabel}, and it was not created**`
      : `**Memory consolidation proposed a change to the skill \`${proposal.slug}\`, from ${context.scopeLabel}, and it was not applied**`;
  const lines: string[] = [heading, "", `> ${proposal.description}`, ""];
  if (!outcome.applied) lines.push(`${outcome.problem} Nothing was changed, and no memory entry was moved.`, "");
  lines.push(
    `Memory consolidation found this procedure again and again in ${context.scopeLabel}'s memory. As a skill, an agent chooses it by the line above and reads its steps when it needs them, and those lines leave every dispatch's memory.`,
    "",
    "**Evidence**",
    "",
  );
  for (const id of proposal.evidenceEntryIds) {
    const entry = getMemory(db, id);
    const item = entry?.source.type === "run" && entry.source.itemId !== null ? getItem(db, entry.source.itemId as Uuid) : undefined;
    // An item key in a comment is drawn as a link to the item.
    const where = item ? ` — from ${item.key}` : "";
    lines.push(`- Memory entry \`${id}\`${where}: "${oneLine(entry?.body ?? "(no longer there)", 140)}"`);
  }
  const keys = proposal.evidenceItemIds.flatMap((id) => getItem(db, id as Uuid)?.key ?? []);
  if (keys.length > 0) lines.push("", `Seen on ${listOf(keys)}.`);
  lines.push("");

  if (outcome.applied) {
    const done =
      proposal.kind === "new"
        ? outcome.attachedTo.length > 0
          ? `It is in ${context.scopeLabel}, attached to ${listOf(outcome.attachedTo)}, whose runs wrote the evidence.`
          : `It is in ${context.scopeLabel}, attached to no agent — none of the runs that wrote its evidence has an agent any more.`
        : `Only its body was replaced; its name, description, files, scope and the agents it is attached to are as they were.`;
    const moved =
      outcome.moved > 0
        ? ` Moved the ${entries(outcome.moved)} holding this procedure out of memory into it; restoring the consolidation brings ${outcome.moved === 1 ? "it" : "them"} back.`
        : "";
    lines.push(`${done}${moved}`);
    if (context.mixed > 0) {
      lines.push(
        "",
        `${context.mixed === 1 ? "One memory entry holds" : `${context.mixed} memory entries hold`} this procedure folded together with other entries, so ${context.mixed === 1 ? "it was" : "they were"} left in memory rather than lose any other fact ${context.mixed === 1 ? "it holds" : "they hold"}.`,
      );
    }
    lines.push("");
  }

  if (context.attached) {
    lines.push(
      context.diff === null
        ? `The ${outcome.applied ? "skill" : "draft"} is attached as \`SKILL.md\`.`
        : `The ${outcome.applied ? "skill as it now is" : "draft"} is attached as \`SKILL.md\`, and what ${outcome.applied ? "it changed" : "it would change"} as \`SKILL.md.diff\`.`,
    );
  } else {
    // No file store on this installation: the draft travels in the body
    // instead, so the notice still carries all of it.
    lines.push(`The ${outcome.applied ? "skill" : "draft"}, as \`SKILL.md\`:`, "", "````markdown", context.draft.trimEnd(), "````");
    if (context.diff !== null) lines.push("", `What ${outcome.applied ? "it changed" : "it would change"}:`, "", "````diff", context.diff.trimEnd(), "````");
  }

  if (outcome.applied) {
    lines.push(
      "",
      proposal.kind === "new"
        ? "Its history is on the Skills screen. Lock it there to keep agents from changing it, or archive it: a skill consolidation created that a person archives is not created again unless a person restores it."
        : "Its history is on the Skills screen, where a person can restore the version before this one, or lock the skill to keep agents from changing it.",
    );
  }
  return lines.join("\n");
}

/**
 * Applies a consolidation's proposals, each with a notice on the project's
 * thread. Never throws: what could not be done is a sentence in `notes`,
 * which the consolidation keeps on its row.
 *
 * A proposal a person discarded — its scope and slug discarded before
 * EO-719, or, for a new one, a skill a consolidation created there
 * archived by a person — is held back with no notice (`heldBack`); an
 * improvement to an archived skill is refused with one. Asked first, and again in the
 * transaction that applies it: finding the thread and storing the draft
 * are awaited, and a person may archive meanwhile.
 *
 * A scope with no project thread to say it on has nothing applied: a
 * skill write nobody is told of on the thread is not one EO makes.
 */
export async function applySkillProposals(input: ApplySkillProposalsInput): Promise<AppliedProposals> {
  const { db } = input;
  const result: AppliedProposals = { applied: [], refused: [], notes: [] };
  const fresh = input.proposals.filter((proposal) => {
    const held = heldBack(db, input.scope, proposal);
    if (held !== null) result.notes.push(held);
    return held === null;
  });
  if (fresh.length === 0) return result;

  const some = fresh.length === 1 ? "A skill was" : `${fresh.length} skills were`;
  if (input.projectId === null) {
    result.notes.push(`${some} proposed and none applied: ${input.scopeLabel} is on no project, so there is no project thread to say so on.`);
    return result;
  }
  let thread: ProjectThreadAnswer;
  try {
    thread = await input.projectThread(input.projectId);
  } catch (error) {
    thread = { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  if (!thread.ok) {
    result.notes.push(`${some} proposed and none applied: the project thread to say so on could not be opened: ${thread.problem}`);
    return result;
  }
  const threadItemId = thread.item.id as Uuid;

  for (const proposal of fresh) {
    try {
      const done = await applyOne(input, proposal, threadItemId);
      if ("held" in done) result.notes.push(done.held);
      else if ("record" in done) result.applied.push(done.record);
      else {
        result.refused.push({ slug: proposal.slug, problem: done.problem });
        result.notes.push(`The skill proposal \`${proposal.slug}\` was not applied: ${done.problem}`);
      }
    } catch (error) {
      result.notes.push(`The skill proposal \`${proposal.slug}\` could not be applied: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (result.applied.length > 0) emitPush("config:changed", {});
  return result;
}

/**
 * Why a proposal cannot be applied as it stands, or null. Asked before
 * its files are stored, and again in the transaction that applies it.
 */
function whyNotApplied(db: Db, input: ApplySkillProposalsInput, proposal: SkillProposal, targetId: string | undefined): string | null {
  // Restored while the proposal call ran: the memory it was drawn from is
  // back as it was, and an entry retired now under that consolidation's
  // id could never be restored again — its restore has been spent.
  if (getConsolidation(db, input.consolidationId)?.status === "restored") {
    return "The consolidation that proposed it was restored while it was being proposed, so the memory it was drawn from is back as it was.";
  }
  // A published configuration binds here as it does on the Skills screen:
  // applying a proposal is a skill save and an attachment, by another door.
  for (const channel of ["skills:save", "agentAttachments:set"] as const) {
    const lock = sectionLockFor(db, channel);
    if (lock) return `Your organisation has published the ${lock.section} section${lock.publishedBy ? ` (${lock.publishedBy})` : ""}, so skills are changed there.`;
  }
  const scope = input.scope;
  if (scope.kind === "project" ? !getProject(db, scope.id as Uuid) : !getWorkspace(db, scope.id as Uuid)) return `The ${scope.kind} it is for no longer exists.`;
  if (proposal.kind === "new") {
    // The slug is unique whatever a row's state, archived ones too.
    const taken = getSkillBySlug(db, proposal.slug);
    return taken ? `The slug \`${proposal.slug}\` is already taken by ${taken.archivedAt === null ? "another skill" : "an archived skill"}.` : null;
  }
  const target = improvementTarget(db, proposal.target, targetId, scope);
  return target.ok ? null : target.problem;
}

type OneOutcome = { record: SkillProposalRecord } | { problem: string } | { held: string };

/** Applies one proposal, or says why not, with its notice; or answers why it was held back after all, with nothing posted and its staged files removed. */
async function applyOne(input: ApplySkillProposalsInput, proposal: SkillProposal, threadItemId: Uuid): Promise<OneOutcome> {
  const { db } = input;
  const author: SkillAuthor = { kind: "consolidation", consolidationId: input.consolidationId };
  const targetSlug = proposal.kind === "improvement" ? proposal.target : null;
  // The skill the target slug meant when the proposal call was asked, held
  // by id from here on: a slug is the one thing a person can rename.
  const targetId = targetSlug === null ? undefined : targetIdOf(db, targetSlug, input.shown);
  const target = targetId === undefined ? undefined : getSkill(db, targetId);
  const followed = coveringEntries(proposal.evidence.entryIds, input.folded);
  const evidenceEntryIds = [...new Set(proposal.evidence.entryIds)];
  const evidenceItemIds = [...new Set(proposal.evidence.itemIds)];

  const { file, current } = draftFile(proposal, proposal.kind === "improvement" ? target : undefined);
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

  let done: OneOutcome;
  try {
    done = db.transaction((): OneOutcome => {
      // Asked again here, in the same synchronous stretch as the write:
      // the thread and the files above were awaited.
      const held = heldBack(db, input.scope, proposal);
      if (held !== null) return { held };
      let problem = whyNotApplied(db, input, proposal, targetId);
      const live = targetId === undefined ? undefined : getSkill(db, targetId);
      // The diff was made against the target as it was before the files
      // were stored; changed since, it would say something untrue.
      if (problem === null && proposal.kind === "improvement" && live?.body !== target?.body) {
        problem = `The skill \`${proposal.target}\` was changed while this was being applied, so it was left as it is.`;
      }
      let skillId: string | null = null;
      const attachedTo: string[] = [];
      if (problem === null) {
        const saved =
          proposal.kind === "new"
            ? saveSkill(db, { slug: proposal.slug, name: proposal.name, description: proposal.description, body: proposal.body, files: [], scope: skillScopeOf(input.scope) }, input.now, author)
            : // The body, and only the body: its slug, name, description,
              // files, switches, scope and attachments stay as they are.
              saveSkill(db, { id: live!.id, slug: null, name: live!.name, description: live!.description, body: proposal.body, files: live!.files }, input.now, author);
        if (saved.ok) skillId = saved.skill.id;
        else problem = saved.problems.join(" ");
      }
      if (skillId === null) {
        const why = problem ?? "It could not be written.";
        postNotice(proposalNoticeBody(db, { ...proposal, evidenceEntryIds, evidenceItemIds }, { applied: false, problem: why }, { scopeLabel: input.scopeLabel, attached: stored.length > 0, draft: file, diff, mixed: 0 }));
        return { problem: why };
      }
      if (proposal.kind === "new") {
        for (const agent of evidenceAgents(db, evidenceEntryIds)) {
          if (setAgentAttachment(db, { agentId: agent.id, kind: "skill", id: skillId, attached: true }, input.now).ok) attachedTo.push(agent.name);
        }
      }
      const moved: string[] = [];
      for (const id of followed.covering) {
        if (retireMemory(db, id, { reason: "moved_to_skill", consolidationId: input.consolidationId, now: input.now }).ok) moved.push(id);
      }
      const comment = postNotice(
        proposalNoticeBody(
          db,
          { ...proposal, evidenceEntryIds, evidenceItemIds },
          { applied: true, attachedTo, moved: moved.length },
          { scopeLabel: input.scopeLabel, attached: stored.length > 0, draft: file, diff, mixed: followed.mixed.length },
        ),
      );
      const record = recordSkillProposal(db, {
        consolidationId: input.consolidationId,
        scope: input.scope,
        kind: proposal.kind,
        targetSlug,
        targetSkillId: proposal.kind === "improvement" ? skillId : null,
        slug: proposal.slug,
        name: proposal.name,
        description: proposal.description,
        body: proposal.body,
        evidenceEntryIds,
        evidenceItemIds,
        coveringEntryIds: followed.covering,
        fingerprint: skillProposalFingerprint(proposal),
        unsaveable: null,
        commentId: comment,
        createdAt: input.now,
      });
      decideSkillProposal(db, record.id, { status: "saved", skillId, movedEntryIds: moved, now: input.now });
      return { record: { ...record, status: "saved", skillId, movedEntryIds: moved, decidedAt: input.now } };
    });
  } catch (error) {
    await input.store?.rollback?.(stored).catch(() => undefined);
    throw error;
  }
  // Held back: the files staged for it belong to no comment.
  if ("held" in done) await input.store?.rollback?.(stored).catch(() => undefined);
  return done;

  /** A note, not a question: it asks nothing, offers no answer and mentions nobody. */
  function postNotice(body: string): string {
    return postComment(db, {
      itemId: threadItemId,
      author: { type: "engine" },
      kind: "note",
      body,
      attachmentRecords: stored,
      // EO's own sentence, quoting what agents wrote: nothing in it summons anyone.
      parseBodyMentions: false,
    }).id;
  }
}
