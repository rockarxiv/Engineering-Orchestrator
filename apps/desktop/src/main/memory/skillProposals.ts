import {
  renderSkillMarkdown,
  skillProposalFingerprint,
  type MemoryScope,
  type Skill,
  type SkillAuthor,
  type SkillProposal,
  type SkillScope,
  type SkillVersionReport,
  type Uuid,
} from "@eo/core";
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
  recordSkillProposal,
  retireMemory,
  saveSkill,
  setAgentAttachment,
  skillProposalDiscarded,
  type DiscardedSkillProposal,
  type SkillProposalRecord,
} from "../db/repos/index.js";
import { emitPush } from "../ipc/push.js";
import { sectionLockFor } from "../managed/locks.js";
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
 * Nothing is posted for any of it (EO-728): a skill written asks nothing
 * of anyone. The version it files keeps the evidence — the entries and
 * the items they came from — and, for an improvement, the diff, and the
 * Skills screen's history shows them as the consolidation's. A proposal
 * not applied is a sentence in the consolidation's own note.
 */

export interface ApplySkillProposalsInput {
  db: Db;
  consolidationId: string;
  scope: MemoryScope;
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
  now: number;
}

/** What became of each proposal. */
export interface AppliedProposals {
  /** The proposals applied, as recorded. */
  applied: SkillProposalRecord[];
  /** The proposals not applied, and why — each said in `notes` too. */
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
 * Why a proposal is held back, as the consolidation's
 * note says it, or null: a person discarded its scope and slug — a new
 * skill whose slug is a consolidation's skill a person archived, or any
 * proposal whose slug a person discarded with the Discard answer
 * proposals used to offer: the person has already said no. An
 * improvement to an archived skill is not held back here; it is refused,
 * saying why (`improvementTarget`).
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
 * and counted in `mixed`.
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

/** The SKILL.md a proposal makes: for an improvement, the target as it is with the proposed body. */
function draftFile(proposal: SkillProposal, target: Skill | undefined): { file: string; current: string | null } {
  if (target) {
    const frontmatter = { slug: target.slug, name: target.name, description: target.description, disableModelInvocation: target.disableModelInvocation };
    return { file: renderSkillMarkdown({ ...frontmatter, body: proposal.body }), current: renderSkillMarkdown({ ...frontmatter, body: target.body }) };
  }
  return { file: renderSkillMarkdown({ slug: proposal.slug, name: proposal.name, description: proposal.description, disableModelInvocation: false, body: proposal.body }), current: null };
}

/**
 * What the version a proposal writes keeps of it (EO-728): each evidence
 * entry as it stands before it is moved, with the key of the item whose
 * run wrote it; the keys of the items it was seen on; and the diff.
 */
function proposalReport(db: Db, evidenceEntryIds: readonly string[], evidenceItemIds: readonly string[], diff: string | null): SkillVersionReport {
  const keyOf = (id: string | null): string | null => (id === null ? null : (getItem(db, id as Uuid)?.key ?? null));
  const evidence = evidenceEntryIds.map((entryId) => {
    const entry = getMemory(db, entryId);
    return { entryId, body: entry?.body ?? null, itemKey: entry?.source.type === "run" ? keyOf(entry.source.itemId) : null };
  });
  return { kind: "consolidation", evidence, itemKeys: evidenceItemIds.flatMap((id) => keyOf(id) ?? []), diff };
}

/**
 * Applies a consolidation's proposals, posting nothing (EO-728). Never
 * throws: what could not be done is a sentence in `notes`, which the
 * consolidation keeps on its row.
 *
 * A proposal a person discarded — its scope and slug discarded before
 * EO-719, or, for a new one, a skill a consolidation created there
 * archived by a person — is held back (`heldBack`); an improvement to an
 * archived skill is refused, saying why.
 */
export function applySkillProposals(input: ApplySkillProposalsInput): AppliedProposals {
  const { db } = input;
  const result: AppliedProposals = { applied: [], refused: [], notes: [] };
  const fresh = input.proposals.filter((proposal) => {
    const held = heldBack(db, input.scope, proposal);
    if (held !== null) result.notes.push(held);
    return held === null;
  });

  for (const proposal of fresh) {
    try {
      const done = applyOne(input, proposal);
      if ("record" in done) result.applied.push(done.record);
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

/** Why a proposal cannot be applied as it stands, or null. */
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

type OneOutcome = { record: SkillProposalRecord } | { problem: string };

/** Applies one proposal, or says why not. */
function applyOne(input: ApplySkillProposalsInput, proposal: SkillProposal): OneOutcome {
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

  return db.transaction((): OneOutcome => {
    const problem = whyNotApplied(db, input, proposal, targetId);
    if (problem !== null) return { problem };
    // Read before the entries move, so the version keeps them as they were.
    const report = proposalReport(db, evidenceEntryIds, evidenceItemIds, diff);
    const saved =
      proposal.kind === "new"
        ? saveSkill(db, { slug: proposal.slug, name: proposal.name, description: proposal.description, body: proposal.body, files: [], scope: skillScopeOf(input.scope) }, input.now, author, report)
        : // The body, and only the body: its slug, name, description,
          // files, switches, scope and attachments stay as they are.
          saveSkill(db, { id: target!.id, slug: null, name: target!.name, description: target!.description, body: proposal.body, files: target!.files }, input.now, author, report);
    if (!saved.ok) return { problem: saved.problems.join(" ") };
    const skillId = saved.skill.id;
    if (proposal.kind === "new") {
      for (const agent of evidenceAgents(db, evidenceEntryIds)) setAgentAttachment(db, { agentId: agent.id, kind: "skill", id: skillId, attached: true }, input.now);
    }
    const moved: string[] = [];
    for (const id of followed.covering) {
      if (retireMemory(db, id, { reason: "moved_to_skill", consolidationId: input.consolidationId, now: input.now }).ok) moved.push(id);
    }
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
      commentId: null,
      createdAt: input.now,
    });
    decideSkillProposal(db, record.id, { status: "saved", skillId, movedEntryIds: moved, now: input.now });
    return { record: { ...record, status: "saved", skillId, movedEntryIds: moved, decidedAt: input.now } };
  });
}
