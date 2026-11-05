import {
  DEFAULT_WORKSPACE_MODE,
  GIT_WORKTREE_KIND,
  NONE_KIND,
  stepWorkspaceChoice,
  type Item,
  type PipelineStep,
  type SkillRunScope,
  type Uuid,
  type WorkspaceKindSlug,
  type WorkspaceMode,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getWorkspace, projectWorkspaceList, type Workspace, stepForItem } from "../db/repos/index.js";

/**
 * Which workspace an item's next run happens on, and how it is used
 * (EO-296, ARCHITECTURE.md, "The four kinds").
 *
 * One answer, asked by four callers that had four different ways of
 * working it out: the supervisor deciding which kind to call, the git
 * kind deciding whether to cut a branch, the scheduler's capacity key,
 * and the card's badge. They must agree — a card that says "reads the
 * repository, changes nothing" over a run that cut a branch is worse
 * than no badge at all — and the only way to make them agree is for
 * there to be one function.
 *
 * **Nothing here falls to the process working directory.** That was the
 * old answer to every question this one answers, and it is deleted: an
 * item with nowhere to work resolves to `none`, which is a kind with an
 * empty directory and a badge that says so.
 */
export interface ResolvedWorkspace {
  /** The slug of the kind that prepares it. `none` when there is no workspace to be had. */
  kind: WorkspaceKindSlug;
  /**
   * How a git workspace is used here.
   *
   * `isolated` on a kind that has no modes, because something has to be
   * answered and no other kind reads it. The badge is what turns that
   * back into "not applicable" — it carries `mode: null` for anything
   * that is not a git workspace.
   */
  mode: WorkspaceMode;
  /**
   * The workspace row the run answers to — the item's own if it names
   * one, else the first its project spans.
   *
   * The project's first is what a read-mode run reads, and what an
   * item with no workspace of its own has always been given: a
   * discussion, a container, a feature spanning several repositories
   * belong to a project rather than to one disk. Null when there is
   * none, which is what makes the kind `none`.
   */
  workspaceId: Uuid | null;
  /** That row, where a caller needs what is in it — the base branch for the badge, the repo path for a read-mode run. */
  workspace: Workspace | undefined;
}

/**
 * What the resolution reads off an item — and all it reads.
 *
 * Narrower than `Item` so the same answer can be asked about an item
 * that is about to exist (EO-364): a plan naming a base branch for a
 * story is refused before the story is created when that story's first
 * step would not work on a branch, and the only honest way to say so is
 * to ask the function the dispatch itself will ask.
 */
export type WorkspaceSubject = Pick<Item, "container" | "workspaceId" | "projectId" | "pipelineId" | "stepId" | "pipelineVersionId">;

/**
 * The item's own workspace, else the first its project spans.
 *
 * One resolution for both, because they are one question. A feature's
 * `workspaceId` is null for the same reason a discussion's is — it
 * belongs to a project that may span several repositories (issue #148) —
 * and a *code-bearing* item with a null one is a different matter
 * entirely, which the git kind refuses rather than substituting for.
 *
 * Exported on its own as well as through the resolution below, because
 * the scheduler asks this question and only this one: **which bucket is
 * this run in** does not depend on how the workspace is used, and it is
 * asked for every item on every tick. What the fuller resolution adds
 * is the mode and the kind, neither of which a capacity key reads.
 *
 * Since EO-301 this does read the item's step, which it did not before:
 * the step's pick is part of the answer, so the read is the answer
 * rather than an extra. `resolveItemWorkspace` needs the same row for
 * the mode and passes it down rather than fetching it twice.
 */
export function workspaceFor(db: Db, item: WorkspaceSubject): Workspace | undefined {
  return workspaceForStep(db, item, stepForItem(db, item));
}

/**
 * The same question, for a caller that already holds the step.
 *
 * The step this item is *on* gets the first word (EO-301, ARCHITECTURE.md,
 * "A workspace is a kind, attached to the project"). A pipeline whose first step drafts in
 * `scratch` and whose
 * second commits to a repository is the whole point of a step being
 * able to pick, and it only works if the pick beats the ticket's own
 * workspace rather than the other way round — the ticket carries one
 * disk for its whole life, and every step of the pipeline would
 * otherwise share it.
 *
 * Here rather than in `resolveItemWorkspace` alone, because
 * `workspaceFor` is what the scheduler's capacity key, the folder
 * kind's `prepare`, the git kind's and the card's badge all go through:
 * a pick that only the resolver honoured would route the run into the
 * folder and then cap its concurrency on the repository.
 */
function workspaceForStep(db: Db, item: WorkspaceSubject, step: PipelineStep | undefined): Workspace | undefined {
  const choice = stepWorkspaceChoice(step?.workspaceId ?? null);
  // "No disk", said out loud. Nothing further is consulted — that is
  // the difference between this and an unset pick, and the reason the
  // sentinel exists at all.
  if (choice.pick === "none") return undefined;
  const picked = pickedBy(db, item, step);
  if (picked) return picked;
  const own = item.workspaceId === null ? undefined : getWorkspace(db, item.workspaceId);
  if (own) return own;
  return item.projectId === null ? undefined : projectWorkspaceList(db, item.projectId)[0];
}

/**
 * What this item's step picked, if it picked a workspace this item may
 * use (EO-301).
 *
 * Exported because the git kind needs the pick *apart from* the
 * fallbacks `workspaceFor` applies after it, and the distinction is
 * load-bearing rather than fussy. An isolated run cuts a branch, and a
 * code-bearing item's branch belongs to the one checkout it names: if
 * its own workspace row is gone, the honest answer is a refusal, not
 * the next repository its project happens to span. `workspaceFor` is
 * right to substitute — a conversation asked "how does this work
 * today?" needs somewhere real to read — and the git kind is right not
 * to, so the two ask different questions and this is the half they
 * share.
 *
 * Undefined for all three of the ways there is no usable pick: the step
 * said nothing, the step said "no disk" (which `workspaceForStep` turns
 * into no workspace rather than into a fallback), and the pick is a row
 * that is gone or that this item's project does not hold.
 */
export function stepPickedWorkspace(db: Db, item: WorkspaceSubject): Workspace | undefined {
  return pickedBy(db, item, stepForItem(db, item));
}

/**
 * Where a run on this item works, as far as a skill's scope cares
 * (EO-470, ARCHITECTURE.md §13.3).
 *
 * The project the item answers to, and the workspace its step works in —
 * `workspaceFor`'s answer, so the skills a run is given are decided by
 * the same disk the run is sent to, and the scheduler, the badge and the
 * delivery cannot disagree about it. Asked by every path that delivers
 * skills or fingerprints them for thread reuse: the Claude tool
 * directory, the Codex turn's options, and `findReusableThread`.
 */
export function skillRunScope(db: Db, item: WorkspaceSubject): SkillRunScope {
  return { projectId: projectAnsweringFor(db, item), workspaceId: workspaceFor(db, item)?.id ?? null };
}

/**
 * Which project a ticket answers to, for deciding whether a step's pick
 * is one it may use (EO-301).
 *
 * `item.projectId` where there is one, and otherwise the project of the
 * ticket's own workspace. The fallback is not defensive padding: an item
 * may legitimately carry a null `projectId` while sitting on a workspace
 * that belongs to a project — `createItem` takes the two separately —
 * and comparing against the null alone would make every pick look like
 * another project's and be quietly ignored. The question being asked is
 * "whose disks may this ticket use", and a ticket on a project's
 * repository is that project's whatever its own column says.
 */
function projectAnsweringFor(db: Db, item: WorkspaceSubject): Uuid | null {
  if (item.projectId !== null) return item.projectId;
  return (item.workspaceId === null ? undefined : getWorkspace(db, item.workspaceId))?.projectId ?? null;
}

/** The membership-checked pick, for a caller that already holds the step. */
function pickedBy(db: Db, item: WorkspaceSubject, step: PipelineStep | undefined): Workspace | undefined {
  const choice = stepWorkspaceChoice(step?.workspaceId ?? null);
  if (choice.pick === "workspace") {
    const picked = getWorkspace(db, choice.workspaceId as Uuid);
    // A pick whose row has gone falls through to the ticket's
    // workspace rather than to nothing. `deleteWorkspace` clears the
    // picks it orphans, so reaching here means a row vanished some
    // other way — a restored database, a hand-edit — and the fallback
    // is the one that leaves work running.
    //
    // **And a pick is only this ticket's if this ticket's project holds
    // it** (EO-301, caught in review). `pipeline:save` refuses a step
    // pointed at another project's disk, and for a pipeline that
    // belongs to a project that is the whole of the guarantee. It
    // cannot be for a **project-less** one: the shipped `default`
    // belongs to *every* project rather than to none, so the save can
    // only judge the pick against whichever project it was configured
    // in — and the moment an item from a second project reaches that
    // same step, a pick that was legitimately stored would route it
    // onto the first project's disk. That is not a stale row to be
    // cleaned up; it is a correct row being read by the wrong item.
    //
    // So membership is asked here, per item, where the item's project
    // is known. Falling through rather than refusing, for the reason
    // the missing row above falls through: the ticket's own workspace
    // is the right disk for this ticket — it is the answer a step with
    // no pick gives, and the only one that keeps the run in its own
    // project.
    if (picked && picked.projectId === projectAnsweringFor(db, item)) return picked;
  }
  return undefined;
}

/**
 * Read mode, decided from the item rather than from the step.
 *
 * Three of EO's own behaviours, and they predate modes: a **container**
 * never carries its own code changes, so a branch for one is a stray
 * branch with nothing on it; an **off-board step** holds a conversation
 * — Discussions, the architect's room, the assistant's room — which carries
 * no changes either but is asked "how does this work today?" and has to
 * be able to look. Both read the repository and write nothing.
 *
 * They override the step's own setting rather than deferring to it.
 * Neither has any use for a branch whatever a person ticks, and a
 * conversation that cut one would leave it behind empty — so the
 * setting is not a choice on those steps, which is why the segmented
 * control is not offered for them.
 */
function readsOnly(item: WorkspaceSubject, step: PipelineStep | undefined): boolean {
  return item.container || (step?.offBoard ?? false);
}

/**
 * Where this item's next run happens, and how.
 *
 * The *kind* comes from the workspace this item answers to, which since
 * EO-301 is the step's pick before the ticket's own — `workspaceFor`
 * holds that order, so this function reads the same as it did while the
 * picker did not exist.
 */
export function resolveItemWorkspace(db: Db, item: WorkspaceSubject): ResolvedWorkspace {
  // Once, and used for both halves: which workspace the step picked and
  // how it says to use one. Read twice, the two could not disagree —
  // they are the same row — but it is a second query on the dispatch
  // path for an answer already in hand.
  const step = stepForItem(db, item);
  const workspace = workspaceForStep(db, item, step);
  const mode: WorkspaceMode = readsOnly(item, step) ? "read" : (step?.workspaceMode ?? DEFAULT_WORKSPACE_MODE);

  return {
    kind: workspace?.kind ?? NONE_KIND,
    mode,
    workspaceId: workspace?.id ?? null,
    workspace,
  };
}

/**
 * Whether this item's next run cuts a branch of a git repository — a
 * git workspace in "Works on a branch" mode (EO-364).
 *
 * The question a base branch is only ever asked under. An item on a
 * folder, in scratch, on no disk or reading a repository has no branch
 * to cut, so a base for one would be a `git` row saying something about
 * a branch that will never exist; every door that writes one asks this
 * first, and the item screen draws the control only where it answers
 * yes — the same resolution the dispatch uses, so the two cannot
 * disagree about whether a branch is coming.
 */
export function worksOnABranch(db: Db, item: WorkspaceSubject): boolean {
  const resolved = resolveItemWorkspace(db, item);
  return resolved.kind === GIT_WORKTREE_KIND && resolved.mode === "isolated";
}

/**
 * Which kind of workspace a project's steps run on (EO-296).
 *
 * The project's first workspace, because that is as fine-grained as the
 * answer gets today: a step cannot name a workspace of its own until
 * EO-301's picker, so every step of a pipeline resolves to the same
 * kind, and the step editor asks this to decide whether the "Works on a
 * branch / Reads only" control is a choice anybody has here.
 *
 * **The project asked about is not always the pipeline's own.** A
 * project-less pipeline — which the shipped `default` is — belongs to
 * *every* project rather than to none, so the project it is open in is
 * the one that answers for it. Its caller resolves that; this function
 * takes the project it has been given. `none` is then a real answer for
 * a project with nothing attached, and for an installation with no
 * project at all, which is EO before anything is configured.
 */
export function projectWorkspaceKind(db: Db, projectId: Uuid | null): WorkspaceKindSlug {
  if (projectId === null) return NONE_KIND;
  return projectWorkspaceList(db, projectId)[0]?.kind ?? NONE_KIND;
}

/**
 * The kind one *step* runs on, which is the finer answer the picker
 * made possible (EO-301) and the column head needs (EO-312).
 *
 * `projectWorkspaceKind` above answers for a pipeline, which was the
 * whole answer while a step could not name a disk of its own. A head
 * saying what is checked cannot use it: the pipeline whose draft step
 * works in `scratch` and whose publish step commits to a repository is
 * the case the design exists for, and one answer for both columns would be
 * wrong on one of them.
 *
 * The three picks `stepWorkspaceChoice` reads, and no fallback of its
 * own beyond them: "no disk" is `none` said out loud, a named workspace
 * answers with its own kind — `none` if the row has gone, which is what
 * `deleteWorkspace` leaves behind for a moment — and saying nothing
 * inherits whatever the caller resolved for the pipeline. The item's
 * own workspace is deliberately not consulted: a head is drawn for a
 * column rather than for an item, and the items standing in it may be on
 * different disks.
 */
export function stepWorkspaceKind(db: Db, step: { workspaceId: string | null }, inherited: WorkspaceKindSlug): WorkspaceKindSlug {
  const choice = stepWorkspaceChoice(step.workspaceId);
  if (choice.pick === "none") return NONE_KIND;
  if (choice.pick === "inherit") return inherited;
  return getWorkspace(db, choice.workspaceId as Uuid)?.kind ?? NONE_KIND;
}
