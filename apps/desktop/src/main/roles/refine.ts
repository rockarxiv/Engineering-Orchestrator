import {
  branchNameProblem,
  developerType,
  childSpec,
  formatIssues,
  specFields,
  specIssues,
  withShapeDefaults,
  type ItemTypeRef,
  type RefineChild,
  type Item,
  type Uuid,
} from "@eo/core";
import { deriveDepsFromTouches, detectCycle, formatCyclePath } from "@eo/engine";
import { addDependency, projectWorkspaceList, createItem, creationRefusal, resolveItemType, workspaceLabel, type Workspace } from "../db/repos/index.js";
import type { Db } from "../db/client.js";
import { worksOnABranch, type WorkspaceSubject } from "../supervisor/workspaceResolution.js";

/**
 * Where a new story lands: the entry step of the pipeline it was given.
 *
 * This used to be the literal `"todo"`, which assumed the one shipped
 * pipeline's slugs — a second pipeline would have had stories created onto
 * a step that does not exist in it. The feature above them has no
 * placement at all any more (ARCHITECTURE.md, "One work entity"): it is a container, not work.
 */
export interface StoryPlacement {
  pipelineId: Uuid;
  entryStepId: string;
}

export type ApplyRefineResult = { ok: true; stories: Item[]; derivedEdgeCount: number } | { ok: false; reason: string };

/**
 * Which type one child of a decomposition is (KAN-147).
 *
 * The word the plan states, **as a bare slug** — the same reading
 * `postIntakeSummary` takes of a classification, and for the same
 * reason: the shape offered every work type the project has, so the
 * answer may name another pack's, and a word two packs both ship is a
 * question `resolveItemType` refuses by naming both rather than picking
 * one (ARCHITECTURE.md, "An item type is data").
 *
 * A child stating no type at all came from a plan written before the
 * composed document asked for one — a proposal sitting in a thread
 * across the upgrade, or a submitted plan, which speaks in stories.
 * Refining a container has always produced this pack's stories, so that
 * is what an unstated type means, said here once rather than assumed by
 * every caller.
 */
export function typeOf(child: RefineChild): ItemTypeRef | string {
  return child.type === null ? developerType("story") : child.type;
}

/**
 * What a *submitted* plan says about Jira for one story (EO-124), by
 * position in the plan.
 *
 * Carried alongside the stories rather than on them, for the reason
 * `JiraSubmission` gives on the single-item path: a proposal is what
 * an agent wrote, and no agent proposing work that does not exist yet
 * has an issue key to give. The keys come from a caller handing over a
 * plan that mirrors an epic, and only that caller fills this in — the
 * approval path passes nothing and behaves exactly as it did.
 */
export interface StoryJiraLink {
  /** Already validated by the caller — shape, and that no other item holds it. Null leaves the story unlinked. */
  key: string | null;
  /** Absent means inherit the feature's switch, which `createItem` reads off the parent at creation. */
  sync?: boolean;
}

interface IndexEdge {
  from: number; // story index that depends
  to: number; // story index depended upon
}

function edgeKey(edge: IndexEdge): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * Merges the agent's own `depends_on` with edges derived from
 * overlapping `touches` (E-01, ARCHITECTURE.md, "One work entity").
 *
 * Two stories editing the same module are serialised even when the agent
 * did not think to say so — that overlap is the main lever against the
 * semantic-conflict failure mode the design calls out, and it is exactly the
 * thing an agent decomposing in one pass tends to miss.
 */
export function mergeRefineEdges(children: readonly RefineChild[]): { edges: IndexEdge[]; derivedEdgeCount: number } {
  const seen = new Set<string>();
  const edges: IndexEdge[] = [];

  const add = (edge: IndexEdge): boolean => {
    const key = edgeKey(edge);
    if (seen.has(key)) return false;
    seen.add(key);
    edges.push(edge);
    return true;
  };

  children.forEach((child, index) => {
    for (const dependsOn of child.depends_on) add({ from: index, to: dependsOn });
  });

  let derivedEdgeCount = 0;
  for (const derived of deriveDepsFromTouches(children.map((child) => ({ touches: child.touches })))) {
    if (add({ from: derived.storyIndex, to: derived.dependsOnIndex })) derivedEdgeCount++;
  }

  return { edges, derivedEdgeCount };
}

/**
 * Renders a plan as something a human can argue with (R-04).
 *
 * The proposal is the artefact — no items exist until it is approved —
 * so this has to carry everything the decision needs: what each story
 * is, what it requires, and what it depends on.
 */
export function renderProposal(db: Db, projectId: Uuid | null, children: readonly RefineChild[], edges: IndexEdge[], derivedEdgeCount: number): string {
  const lines = [`Here is how I would break this down, into ${children.length} ${children.length === 1 ? "ticket" : "tickets"}:`, ""];

  children.forEach((child, index) => {
    lines.push(`**${index + 1}. ${child.title}**`, "", child.body);
    lines.push(...specLines(db, projectId, child));
    const dependsOn = edges.filter((edge) => edge.from === index).map((edge) => `#${edge.to + 1}`);
    if (dependsOn.length > 0) lines.push("", `_Depends on ${dependsOn.join(", ")}._`);
    if (child.baseBranch !== undefined) lines.push("", baseBranchLine(child.baseBranch));
    if (child.existingBranch !== undefined) lines.push("", existingBranchLine(child.existingBranch));
    lines.push("");
  });

  if (derivedEdgeCount > 0) {
    lines.push(
      `${derivedEdgeCount} dependenc${derivedEdgeCount === 1 ? "y was" : "ies were"} inferred from tickets touching the same files.`,
      "",
    );
  }
  lines.push("Approve to create these as tickets, or reply saying what to change.");

  return lines.join("\n");
}

/**
 * One child's own fields, as the plan shows them (KAN-147).
 *
 * Drawn from the type's shape rather than from `acceptance_criteria` by
 * name, because the plan may be a decomposition into a type this file
 * has never heard of and a person approving it has to see what they are
 * approving. A list keeps the bullets the criteria always had — on a
 * story that is exactly the plan as it read before — and anything else
 * is a labelled line, the way the classification card does it.
 *
 * A type the project does not have renders nothing rather than refusing:
 * this is the *rendering* half, and `applyApprovedProposal` is where an
 * unknown type stops the plan being built.
 */
function specLines(db: Db, projectId: Uuid | null, child: RefineChild): string[] {
  const type = resolveItemType(db, projectId, typeOf(child));
  if (!type.ok) return [];

  const lines: string[] = [];
  for (const field of specFields(type.type.specShape)) {
    const value = child.spec[field.name];
    if (field.kind === "string list") {
      const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
      if (entries.length > 0) lines.push("", ...entries.map((entry) => `- ${entry}`));
      continue;
    }
    if (typeof value === "string" && value.trim() !== "") lines.push("", `**${field.label}:** ${value.trim()}`);
    if (typeof value === "number" || typeof value === "boolean") lines.push("", `**${field.label}:** ${String(value)}`);
  }
  return lines;
}

export type ProposalResult = { ok: true; body: string } | { ok: false; reason: string };

/**
 * What an approval card says about a base branch a story names (EO-364).
 *
 * One sentence for every card that can carry one — a plan's story and a
 * single story alike — because what a person is agreeing to is the same:
 * this work is cut from somewhere other than where the repository says,
 * and its pull request goes there too.
 */
export function baseBranchLine(baseBranch: string): string {
  return `_Branches from \`${baseBranch}\`, and its pull request opens against it._`;
}

/**
 * Why a story about to be created cannot carry this base branch, or null
 * when it can (EO-364).
 *
 * Two refusals, both made before anything exists. A name git would not
 * take is refused naming the story, so the plan can be fixed and sent
 * again. And a story whose first step does not cut a branch of a git
 * repository — a folder, scratch, no disk, or a step that only reads —
 * has no branch for a base to be the start of; writing one anyway would
 * be a `git` row about a branch that is never coming, and dropping it
 * quietly would be the person's instruction lost (invariant 8). So the
 * proposal is refused, saying which story and why, and nothing is made.
 *
 * Asked of the same resolution the dispatch will use, through a subject
 * describing the item as it is about to be created.
 */
export function baseBranchRefusal(db: Db, title: string, baseBranch: string, subject: WorkspaceSubject): string | null {
  const problem = branchNameProblem(baseBranch);
  if (problem !== null) return `"${title}" names a base branch EO cannot use. ${problem}`;
  if (!worksOnABranch(db, subject)) {
    return (
      `"${title}" names \`${baseBranch}\` as its base branch, but it would land on a step that does not work on a branch of a git ` +
      `repository, so there is no branch to cut from it. Leave the base branch out, or put it on a pipeline that works on a branch.`
    );
  }
  return null;
}

/**
 * What an approval card says about an existing branch a story names
 * (EO-365): the story is worked on that branch, with what is already on
 * it, rather than on a branch EO cuts.
 */
export function existingBranchLine(branch: string): string {
  return `_Works on the existing branch \`${branch}\`, keeping every commit already on it, and its pull request opens from it._`;
}

/**
 * Why a story about to be created cannot be worked on this existing
 * branch, or null when it can (EO-365) — `baseBranchRefusal`'s two
 * refusals, for the same reasons.
 *
 * Whether the branch exists is not asked here: a plan may name a branch
 * somebody is about to push, and Worktree asks the repository and the
 * remote when it checks it out, refusing there with the name.
 */
export function existingBranchRefusal(db: Db, title: string, branch: string, subject: WorkspaceSubject): string | null {
  const problem = branchNameProblem(branch);
  if (problem !== null) return `"${title}" names an existing branch EO cannot use. ${problem}`;
  if (!worksOnABranch(db, subject)) {
    return (
      `"${title}" names \`${branch}\` as the branch to work on, but it would land on a step that does not work on a branch of a git ` +
      `repository, so there is nothing to check it out in. Leave the branch out, or put it on a pipeline that works on a branch.`
    );
  }
  return null;
}

/**
 * Both branch refusals for one story about to be created, the base's
 * first (EO-364, EO-365).
 */
export function storyBranchRefusal(db: Db, title: string, branches: { baseBranch?: string; existingBranch?: string }, subject: WorkspaceSubject): string | null {
  if (branches.baseBranch !== undefined) {
    const refusal = baseBranchRefusal(db, title, branches.baseBranch, subject);
    if (refusal !== null) return refusal;
  }
  return branches.existingBranch === undefined ? null : existingBranchRefusal(db, title, branches.existingBranch, subject);
}

/**
 * The `git` extension a new story is created with, when it names a base
 * branch, an existing branch (EO-364, EO-365) or a Reference (EO-739,
 * already trimmed and judged, null for none) — undefined when it names
 * none of them, so it gets no row.
 */
export function storyGitState(branches: {
  baseBranch?: string;
  existingBranch?: string;
  reference?: string | null;
}): { baseBranch?: string; branch?: string; namedBranch?: boolean; reference?: string } | undefined {
  const reference = branches.reference ?? null;
  if (branches.baseBranch === undefined && branches.existingBranch === undefined && reference === null) return undefined;
  return {
    ...(branches.baseBranch === undefined ? {} : { baseBranch: branches.baseBranch }),
    ...(branches.existingBranch === undefined ? {} : { branch: branches.existingBranch, namedBranch: true }),
    ...(reference === null ? {} : { reference }),
  };
}

/**
 * Validates a decomposition and renders it for the human (R-04).
 *
 * A-02 proved the agent's own graph is well-formed, but the merged
 * graph is a different graph: adding touches-derived edges to an acyclic
 * one can close a loop. A plan that cannot be built must never reach the
 * human as approvable, so the cycle check happens here rather than at
 * approval time.
 */
export function buildProposal(db: Db, projectId: Uuid | null, children: readonly RefineChild[]): ProposalResult {
  // A base branch no branch could be cut from is refused here as well as
  // at approval, for the reason the cycle check below is: a plan that
  // cannot be built must not reach a person as approvable (EO-364).
  // Only the name can be judged before approval — which pipeline the
  // stories land on may still be the person's to pick.
  for (const child of children) {
    const problem = child.baseBranch === undefined ? null : branchNameProblem(child.baseBranch);
    if (problem !== null) return { ok: false, reason: `"${child.title}" names a base branch EO cannot use. ${problem}` };
    // And an existing branch to work on, for the same reason (EO-365).
    const unusable = child.existingBranch === undefined ? null : branchNameProblem(child.existingBranch);
    if (unusable !== null) return { ok: false, reason: `"${child.title}" names an existing branch EO cannot use. ${unusable}` };
  }

  const { edges, derivedEdgeCount } = mergeRefineEdges(children);
  const cycle = detectCycle(edges.map((edge) => ({ itemId: String(edge.from) as Uuid, dependsOnId: String(edge.to) as Uuid })));

  if (cycle) {
    const readable = cycle.map((id) => `children[${id}] ("${children[Number(id)]?.title ?? "?"}")`);
    return {
      ok: false,
      reason:
        `Merging the proposed dependencies with those derived from overlapping \`touches\` produces a cycle: ` +
        `${formatCyclePath(readable as Uuid[])}. There is nothing to approve — reply with how to break the loop and I will redo the plan.`,
    };
  }

  return { ok: true, body: renderProposal(db, projectId, children, edges, derivedEdgeCount) };
}

/**
 * Which workspace one story lands in (KAN-17).
 *
 * On a project over a single repository there is nothing to decide: that
 * sole member is the answer. This matters for project-level features
 * created in a discussion, which deliberately have no workspace of their
 * own.
 *
 * Over several, the product owner names one and this resolves it.
 * Matching is on the workspace's name, case-insensitively, because the
 * name is what the prompt showed it. A name that is not on the project is
 * refused rather than guessed at: a story in the wrong repository
 * produces a branch and a pull request in the wrong place, which is
 * worse than making someone ask for the plan again.
 */
function routeChild(child: RefineChild, feature: Item, members: Workspace[]): { workspaceId: Uuid | null; problem: string | null } {
  if (members.length === 1) return { workspaceId: members[0]!.id, problem: null };
  if (members.length === 0) return { workspaceId: feature.workspaceId, problem: null };

  const names = members.map(workspaceLabel).join(", ");
  const named = child.repository?.trim();
  if (!named) {
    return {
      workspaceId: null,
      problem: `The story "${child.title}" does not say which repository it belongs to, and this project spans ${members.length}: ${names}.`,
    };
  }

  const match = members.find((workspace) => workspaceLabel(workspace).toLowerCase() === named.toLowerCase());
  if (!match) {
    return {
      workspaceId: null,
      problem: `The story "${child.title}" names the repository "${named}", which is not on this project. It spans: ${names}.`,
    };
  }

  return { workspaceId: match.id, problem: null };
}

/**
 * Creates the stories in an approved proposal (R-04).
 *
 * Runs at approval, not at refinement: until a human agrees, the plan is
 * a comment. Stories land in `todo` because approving *is* the gate —
 * there is no second one.
 *
 * `jira` is indexed by the story's position in `output.stories` and is
 * empty on every path but a submitted plan (EO-124). Its keys are
 * already checked: this creates rows, and the refusal that a key is
 * malformed or taken has to happen before any of them exist.
 */
export function applyApprovedProposal(
  db: Db,
  feature: Item,
  children: readonly RefineChild[],
  placement: StoryPlacement,
  jira: readonly StoryJiraLink[] = [],
): ApplyRefineResult {
  const { edges, derivedEdgeCount } = mergeRefineEdges(children);

  const members = feature.projectId === null ? [] : projectWorkspaceList(db, feature.projectId);
  const routed = children.map((child) => routeChild(child, feature, members));
  const unroutable = routed.find((result) => result.problem !== null);
  // Nothing is created if any one child cannot be placed: a partial
  // decomposition is harder to recover from than none, and the caller
  // turns this into a comment on the item (invariant 8).
  if (unroutable) return { ok: false as const, reason: unroutable.problem! };

  // And nothing is created if the project has no such type to create
  // them as (KAN-129). Asked once, out here, for the same reason the
  // routing is: inside the transaction below a refusal would have to
  // roll back children that had already been written.
  //
  // Per child rather than once for `story` (KAN-147): a plan states the
  // type of each of its children, so a decomposition into a pack's own
  // type resolves that type — and a plan naming one this project does
  // not have is refused whole, by name, rather than half-built.
  const types = children.map((child) => resolveItemType(db, feature.projectId, typeOf(child)));
  const unknown = types.find((result) => !result.ok);
  if (unknown !== undefined && !unknown.ok) return { ok: false as const, reason: unknown.problem };

  // What each child will be stored with, built once and checked against
  // the type it is being created as (KAN-147).
  //
  // A-02 held the whole plan to the composed document before any of this
  // ran, so this is a backstop rather than the gate — but it is one
  // worth having, because a document cannot always say everything a
  // shape does: a type may narrow a field the envelope owns, or use a
  // keyword the composer has no place for, and the answer would then
  // satisfy the document and not the type. An item whose stored spec its
  // own type rejects is the one thing this story exists to make
  // impossible, so the decomposition refuses whole rather than writing
  // one — the caller turns that into a comment (invariant 8), and
  // nothing is created either way.
  const specs = children.map((child, index) => {
    const type = types[index]!;
    const shape = type.ok ? type.type.specShape : undefined;
    return {
      ...(child.touches.length > 0 ? { touches: child.touches } : {}),
      ...(shape === undefined ? child.spec : withShapeDefaults(shape, childSpec(shape, child))),
    };
  });

  for (const [index, child] of children.entries()) {
    const type = types[index]!;
    if (!type.ok) continue;
    const issues = specIssues(type.type.specShape, specs[index]!);
    if (issues.length > 0) {
      return { ok: false as const, reason: `"${child.title}" is not a ${type.type.slug} this project would accept:\n${formatIssues(issues)}` };
    }
  }

  // A base branch, or an existing branch (EO-365), is only somewhere a
  // branch is cut (EO-364), and that is
  // a question about where each child lands — which is only known now.
  // Asked before the transaction, like everything above, so a refusal
  // leaves nothing behind.
  for (const [index, child] of children.entries()) {
    const type = types[index]!;
    if ((child.baseBranch === undefined && child.existingBranch === undefined) || !type.ok) continue;
    const refusal = storyBranchRefusal(db, child.title, child, {
      container: type.type.container,
      workspaceId: routed[index]!.workspaceId,
      projectId: feature.projectId,
      pipelineId: placement.pipelineId,
      stepId: placement.entryStepId,
      pipelineVersionId: null,
    });
    if (refusal !== null) return { ok: false as const, reason: refusal };
  }

  // The pipeline's entry rules (EO-610), asked of every child here for
  // the reason the rest of this is: the plan is refused whole, by the name
  // of the child that failed, before a row exists. `createItem` asks again
  // below, which is the door; this is what makes the refusal name a story.
  for (const [index, child] of children.entries()) {
    const type = types[index]!;
    if (!type.ok) continue;
    const refusal = creationRefusal(
      db,
      {
        type: typeOf(child),
        workspaceId: routed[index]!.workspaceId,
        projectId: feature.projectId,
        title: child.title,
        body: child.body,
        spec: specs[index]!,
        pipelineId: placement.pipelineId,
        stepId: placement.entryStepId,
        ...(jira[index]?.key == null ? {} : { jiraKey: jira[index]!.key }),
      },
      type.type,
    );
    if (refusal !== null) return { ok: false as const, reason: `"${child.title}" cannot enter. ${refusal}` };
  }

  return db.transaction(() => {
    const stories = children.map((child, index) => {
      const link = jira[index];
      const git = storyGitState(child);
      const created = createItem(db, {
        // The row resolved above rather than the name again, so that what
        // was checked and what is written cannot be two different types.
        type: typeOf(child),
        parentId: feature.id,
        // The workspace this child's work happens in — which is what
        // gives it a worktree and a set of checks (D-04). On a project
        // over one repo that is the feature's own; over several the
        // product owner chose, and `routeChild` resolved the name.
        workspaceId: routed[index]!.workspaceId,
        projectId: feature.projectId,
        title: child.title,
        body: child.body,
        // The type's own fields, by the names its shape declares, and
        // `touches` beside them — which is EO's rather than any type's:
        // the overlap check reads it to serialise work that would
        // collide (E-01), so every child carries it whether or not a
        // shape names it. `childSpec` is what keeps a field the agent
        // invented out of the item and what carries an envelope field a
        // shape *did* name into it; `withShapeDefaults` gives a type's
        // declared default to a child that said nothing. The same pair
        // the hand-over door uses, so both ways of creating an item fill
        // a spec the same way.
        // Built and checked above, before the transaction opened: EO's
        // own `touches` where there is something in it — the overlap
        // check reads it to serialise work that would collide (E-01) —
        // and the type's own fields over the top, so a type that
        // declares `touches` itself owns the value.
        spec: specs[index]!,
        // Only ever set by a plan (EO-568): a decomposition's children
        // have no priority to give, and land at 0 as they always have.
        ...(child.priority === undefined ? {} : { priority: child.priority }),
        pipelineId: placement.pipelineId,
        stepId: placement.entryStepId,
        ...(link?.key == null ? {} : { jiraKey: link.key }),
        // Omitted rather than defaulted, so a child that said nothing
        // inherits the container's switch — which the plan set (EO-124).
        ...(link?.sync === undefined ? {} : { jiraSync: link.sync }),
        // In the same insert as the row itself (EO-364): the entry step
        // of a git pipeline cuts the branch as soon as the story lands,
        // and a base written a moment later would be a base written too
        // late.
        // An existing branch the same way (EO-365): it is the branch
        // Worktree checks out instead of cutting one, so it has to be
        // there before the first dispatch reads the row.
        ...(git === undefined ? {} : { git }),
      });
      // Resolved a moment ago and unreachable in practice; thrown rather
      // than returned because this is inside the transaction, where the
      // throw is what rolls half a decomposition back.
      if (!created.ok) throw new Error(created.problem);
      return created.item;
    });

    for (const edge of edges) {
      addDependency(db, stories[edge.from]!.id, stories[edge.to]!.id);
    }

    return { ok: true as const, stories, derivedEdgeCount };
  });
}
