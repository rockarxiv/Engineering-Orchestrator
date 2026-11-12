import { KEEP_OR_MOVE_LINE, MOVE_IS_ONE_WAY_LINE, type IpcPayload, type IpcResponse, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  addWorkspaceToProject,
  createProject,
  getProject,
  getWorkspace,
  listItemsForProject,
  listProjects,
  projectWorkspaceList,
  removeWorkspaceFromProject,
  takenKeyPrefixes,
  updateProject,
  type Project,
} from "../db/repos/index.js";
import { keepProjectLocal, listUndecidedProjects } from "../db/repos/projectsRepo.js";
import { costCentsByProject } from "../db/repos/runsRepo.js";
import { previewProjectId } from "../gallery/commands.js";
import { settleSeededPipelines } from "../gallery/sharedPipelines.js";
import { moveProjectToRecord, type MovedFileStore, type SendAdoptPage } from "../record/adopt.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { actingCaller, visibleProjectIds } from "../identity/acting.js";
import { ACTIVE_PROJECT_KEY, activeProjectId, movingProjectRefusal } from "./repositoryCommands.js";

/**
 * Projects (KAN-17).
 *
 * A project used to be a repository, and for one repository it still looks
 * exactly like one. The difference shows when an application is several
 * repositories: one project spans them, and a feature described on it produces stories that
 * each name a single repository.
 */

/**
 * Why a workspace cannot be moved to `projectId`, or null if it can.
 *
 * Attaching is a **move**: a workspace belongs to one project, so
 * attaching one another project holds takes it off that one. Any item
 * left behind is then on a project whose workspace belongs to somebody
 * else — and the two Jira paths do not resolve a binding the same way.
 * Pull asks the *item's* project (`askableProjectId`); the outbox sender
 * asks the *workspace's* (`jiraForWorkspace`). An item where those
 * differ pulls its comments from one Jira account and pushes its status
 * to another, with nothing anywhere reporting it.
 *
 * So the move is refused, which is what `projects:removeProject` has
 * always done for the same stranding through the other door — invariant
 * 8, nothing dropped on the floor silently. The person moves or closes
 * the items first, and nothing else has to reason about an item and its
 * workspace disagreeing.
 *
 * A project on its way to the record keeps what it has as well (EO-607):
 * its repositories do not change during a move, whatever is on them.
 */
function moveRefusal(db: Db, workspaceId: Uuid, projectId: Uuid | null): string | null {
  const workspace = getWorkspace(db, workspaceId);
  // Attached to nothing, or already here: no move, so nothing to strand.
  // `projectId` is null where the project does not exist yet, and every
  // attachment to it is therefore a move.
  if (!workspace || workspace.projectId === null || workspace.projectId === projectId) return null;

  const from = getProject(db, workspace.projectId);
  if (from && from.adoptingAt !== null) return movingProjectRefusal(from.name);

  const stranded = listItemsForProject(db, workspace.projectId).filter((item) => item.workspaceId === workspaceId);
  if (stranded.length === 0) return null;

  return (
    `${stranded.length} ticket(s) on ${from ? `"${from.name}"` : "another project"} belong to that repository. ` +
    `Move or close them first — taking it away would leave them pointing at a repository their project no longer covers.`
  );
}

function toView(db: Db, project: Project, costCents = 0): IpcResponse<"projects:list">["projects"][number] {
  return {
    id: project.id,
    name: project.name,
    keyPrefix: project.keyPrefix,
    repositoryIds: projectWorkspaceList(db, project.id).map((workspace) => workspace.id),
    itemCount: listItemsForProject(db, project.id).length,
    // Whose it is (EO-325). Null on every project in solo mode, where
    // no screen says anything about it: there is no record for the word
    // "local" to be in contrast with.
    managedAt: project.managedAt,
    keptLocalAt: project.keptLocalAt,
    adoptingAt: project.adoptingAt,
    // Put away (EO-347). Listed all the same — Settings shows them
    // behind "Show archived" and `projects_list` says which they are —
    // and left out by everything that picks a project to look at.
    archivedAt: project.archivedAt,
    preview: project.id === previewProjectId(db),
    costCents,
  };
}

/**
 * The projects this caller may see, and what each has cost (EO-326,
 * ARCHITECTURE.md, "Identity", "Policy").
 *
 * Two things arrive here together because they belong to the same
 * screen: the switcher is where an admin crosses from one team's board
 * to another's, and "what has this project spent" is the fact they are
 * crossing to find. `identity/acting.ts` owns which projects those are —
 * every one of them on a desktop and for an admin, the caller's own
 * otherwise.
 *
 * `activeProjectId` is narrowed to the answer as well. It is a setting
 * on *this installation* rather than a fact about the caller, so on a
 * server it is whatever the process last wrote — and handing a person a
 * pointer at a project that is not in their own list would put them on a
 * board that is blank for a reason nothing on screen explains. Where it
 * is not theirs, the first project they can see is, which is the same
 * fallback `activeProjectId` already makes for an installation that has
 * never chosen one.
 */
export function listProjectsCommand(db: Db, input?: IpcPayload<"projects:list">): IpcResponse<"projects:list"> {
  const caller = actingCaller(db, input?.actingDeviceId);
  const allowed = visibleProjectIds(db, caller);
  const costs = costCentsByProject(db);

  const projects = listProjects(db)
    .filter((project) => allowed === null || allowed.has(project.id))
    .map((project) => toView(db, project, costs.get(project.id) ?? 0));

  const active = activeProjectId(db);
  // Archived projects are in the list (EO-347) and never the fallback:
  // the window only ever shows a live one, or none.
  const live = projects.filter((project) => project.archivedAt === null);
  const visible = live.some((project) => project.id === active);
  return { projects, activeProjectId: visible ? active : (live[0]?.id ?? null) };
}

/**
 * A project over several repositories.
 *
 * The prefix is fixed at creation: every item on the project already
 * carries it in its key, and changing it would leave SHOP-1 and WEB-2 on
 * one project with no way to tell which counter either came from.
 */
/**
 * A new project, and where it lives the moment it exists (EO-325).
 *
 * On a solo desktop this is what it always was: a row, and it is the
 * person's.
 *
 * On a signed-in one it is made here and handed over at once, through
 * the same `record:adopt` that a project moved from the keep-or-move
 * sheet takes. Somebody who creates a project while signed in to an
 * organisation is creating it *there*, and this is what makes that
 * true rather than merely intended — the column that says the record
 * holds it is written by the transfer that put it there, and by
 * nothing else.
 *
 * **A handover that cannot happen leaves the project local**, with a
 * sentence saying so. That is the honest outcome and the recoverable
 * one: the project exists, the person has it, and it is on the
 * keep-or-move sheet to be handed over when the record is reachable
 * again. The alternative — refusing to create it at all — would make a
 * network outage a reason somebody cannot start work, which is the one
 * thing managed mode undertakes never to be (ARCHITECTURE.md, "The record").
 */
export async function createProjectCommand(
  db: Db,
  input: IpcPayload<"projects:create">,
  /** How this machine reaches its record, where it has one. Absent on a solo desktop and in a test. */
  handover?: KeepOrMoveContext,
): Promise<IpcResponse<"projects:create">> {
  const name = input.name.trim();
  const keyPrefix = input.keyPrefix.trim().toUpperCase();
  if (name === "") return { ok: false, problem: "A project needs a name." };
  if (!/^[A-Z][A-Z0-9]*$/.test(keyPrefix)) {
    return { ok: false, problem: "A key prefix is letters and digits, starting with a letter — SHOP, WEB2." };
  }
  // One project, one prefix: a prefix is a counter, and two projects on
  // one counter would interleave their numbering. Refused here rather
  // than left to the unique constraint, which arrives as a thrown
  // dispatch error rather than the refusal this channel answers with.
  if (takenKeyPrefixes(db).has(keyPrefix)) {
    return {
      ok: false,
      problem: `${keyPrefix} is already in use by another project, and a prefix numbers exactly one project's tickets.`,
    };
  }

  // The same repository named twice is attached once, not twice. The
  // schema takes a list and a list can repeat itself; attaching is one
  // write of the workspace's project, so `[a, a]` would silently
  // renumber it rather than fail — and the second position is the one
  // that would stick.
  //
  // Deduplicated rather than refused, because the other door already
  // reads it this way: `projects:addProject` on a repository the project
  // already spans is a no-op that answers ok, and one call naming it
  // twice means what two calls naming it once mean. First occurrence
  // wins — the order here is the order the workspaces are positioned in,
  // and position decides which one a feature's worktree is cut from.
  const workspaceIds = [...new Set(input.repositoryIds as Uuid[])];

  // Every repository named, before any of it is written. An id EO does
  // not have would otherwise be written onto nothing and reported as a
  // project that spans one fewer than was asked for.
  const missing = workspaceIds.filter((workspaceId) => getWorkspace(db, workspaceId) === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      problem:
        `EO has no repository with id ${missing.map((repositoryId) => `"${repositoryId}"`).join(", ")}. Call ` +
        `repositories:list for the ones it has, or attach it first. Nothing was created.`,
    };
  }

  // Every move checked before any of it is written, for the same reason
  // the ids are: this door attaches a whole list, and a refusal halfway
  // through would leave a project holding some of what was asked for.
  // `createProject` writes the row and the attachments in one
  // transaction, so the only way to keep that all-or-nothing is to ask
  // first — and the project does not exist yet, so no id can be checked
  // against it.
  const strandings = workspaceIds.map((workspaceId) => moveRefusal(db, workspaceId, null)).filter((refusal) => refusal !== null);
  if (strandings.length > 0) return { ok: false, problem: `${strandings[0]} Nothing was created.` };

  const project = createProject(db, { name, keyPrefix, workspaceIds });
  // An empty project (EO-766): the first one made this way archives the
  // seeded Delivery rather than being shown it.
  settleSeededPipelines(db, project.id);
  if (handover === undefined || !handover.signedIn()) return { ok: true, project: toView(db, project), problem: null };

  // Straight over, while the person is watching. A brand-new project is
  // one row, its types and its graph, so the transfer the sheet uses
  // for a year of work costs a request or two here — and it is the same
  // transfer, which is why there is no second way for a project to
  // reach the record and no second set of things to get wrong.
  const moved = await moveProjectToRecordCommand(handover, { projectId: project.id });
  if (moved.problem !== null) {
    return {
      ok: true,
      project: toView(db, getProject(db, project.id) ?? project),
      problem:
        `"${name}" was created here, and EO could not hand it to your organisation: ${moved.problem} ` +
        `It is on this machine for now, and you can move it from Settings when the record is reachable.`,
    };
  }
  return { ok: true, project: toView(db, getProject(db, project.id) ?? project), problem: null };
}

export function updateProjectCommand(db: Db, input: IpcPayload<"projects:update">): IpcResponse<"projects:update"> {
  const project = getProject(db, input.id as Uuid);
  if (!project) return { ok: false, problem: "That project no longer exists." };

  // Nothing about Jira arrives here any more. `jiraProjectId` named
  // which of the project's repositories held the Jira its features were
  // mirrored through, which was only a question while every repository
  // carried its own Jira columns. The project has one binding since
  // KAN-130 and everything on it mirrors through that, so the argument
  // is gone rather than kept as a control that would do nothing
  // (invariant 12).
  const updated = updateProject(db, project.id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
  });
  return { ok: true, project: updated ? toView(db, updated) : undefined, problem: null };
}

export function setActiveProjectCommand(db: Db, input: IpcPayload<"projects:setActive">): IpcResponse<"projects:setActive"> {
  const project = getProject(db, input.id as Uuid);
  // Not to a project EO does not have, and not to an archived one
  // (EO-347): it has no board, and it is not in the switcher to be
  // picked from. Both are answered with whichever project the window is
  // still showing.
  if (!project || project.archivedAt !== null) return { activeProjectId: activeProjectId(db) };
  setSetting(db, ACTIVE_PROJECT_KEY, input.id);
  return { activeProjectId: input.id };
}

export function addRepositoryToProjectCommand(db: Db, input: IpcPayload<"projects:addProject">): IpcResponse<"projects:addProject"> {
  const project = getProject(db, input.projectId as Uuid);
  if (!project) return { ok: false, problem: "That project no longer exists." };
  if (project.adoptingAt !== null) return { ok: false, problem: movingProjectRefusal(project.name) };
  // `projectToJoin` makes a project in Preview's place (EO-603). Here the
  // repository already exists, and adding it would take it off its own.
  if (project.id === previewProjectId(db)) {
    return { ok: false, problem: "Preview is EO's rehearsal, and a repository belongs on a real project. Add it to another project, or make one for it." };
  }

  // Same reason the ids are checked on the way into `projects:create`:
  // attaching writes the workspace's project, and an id EO does not have
  // would write onto nothing and answer ok to a project that gained
  // nothing.
  if (getWorkspace(db, input.repositoryId as Uuid) === undefined) {
    return {
      ok: false,
      problem:
        `EO has no repository with id "${input.repositoryId}". Call repositories:list for the ones it has, or ` +
        `attach it first. The project is unchanged.`,
    };
  }

  // Checked before the write, like the id above: a move that would
  // strand another project's tickets is refused rather than made.
  const refusal = moveRefusal(db, input.repositoryId as Uuid, project.id);
  if (refusal !== null) return { ok: false, problem: refusal };

  addWorkspaceToProject(db, project.id, input.repositoryId as Uuid);
  return { ok: true, project: toView(db, project), problem: null };
}

/**
 * Takes a repository off a project.
 *
 * Refused while the project still has items belonging to that
 * repository: they would stay on the project pointing at a workspace the
 * project no longer holds, which is a worse state than saying no
 * (invariant 8 — nothing gets dropped on the floor silently).
 *
 * Nothing about Jira is cleared here any more. The binding is the
 * project's since KAN-130, so taking a repository off cannot change
 * which Jira the project mirrors into — which is the answer the comment
 * this replaces was reaching for.
 */
export function removeRepositoryFromProjectCommand(db: Db, input: IpcPayload<"projects:removeProject">): IpcResponse<"projects:removeProject"> {
  const project = getProject(db, input.projectId as Uuid);
  if (!project) return { ok: false, problem: "That project no longer exists." };
  if (project.adoptingAt !== null) return { ok: false, problem: movingProjectRefusal(project.name) };

  const stranded = listItemsForProject(db, project.id).filter((item) => item.workspaceId === input.repositoryId);
  if (stranded.length > 0) {
    return {
      ok: false,
      problem: `${stranded.length} ticket(s) on this project belong to that repository. Move or close them first — leaving them here would point them at a repository the project no longer covers.`,
    };
  }

  // Detached, not deleted: the checkout is still on disk and EO still
  // holds it (`repositories:remove` is the one that lets go), so the
  // workspace stays with no project rather than taking its own row down
  // with the membership it no longer has.
  removeWorkspaceFromProject(db, project.id, input.repositoryId as Uuid);
  return { ok: true, project: toView(db, project), problem: null };
}

// ── Keep it here, or move it to the record (EO-325) ─────────────────

/**
 * The keep-or-move sheet's list, and what the sheet says above it
 * (the original design).
 *
 * "A person who already has local projects is shown one sheet, 'You
 * have 2 local projects · keep local / move to the record', per
 * project, defaulting to keep."
 *
 * Empty unless this machine is signed in, which is what opens and
 * closes the sheet: a solo desktop has no record to move anything to,
 * and there is nothing to ask. Empty again once every project has an
 * answer, so there is no "have I shown this" flag anywhere — the list
 * *is* the state, and a flag that could disagree with it would be a
 * sheet that either nagged or never appeared.
 *
 * The Preview project is never on it. It is EO's own rehearsal rather
 * than anybody's work — "nothing was sent, nothing cost money" (ARCHITECTURE.md, "Preview")
 * — and asking somebody where they would like it kept would be asking
 * them to answer for something they did not make. A preview made after
 * this story is marked kept at birth; this is for the installations
 * that already had one.
 */
export function undecidedProjectsCommand(context: KeepOrMoveContext): IpcResponse<"projects:undecided"> {
  if (!context.signedIn()) return { projects: [], line: KEEP_OR_MOVE_LINE };
  const preview = previewProjectId(context.db);
  return {
    projects: listUndecidedProjects(context.db)
      .filter((project) => project.id !== preview)
      .map((project) => toView(context.db, project)),
    line: KEEP_OR_MOVE_LINE,
  };
}

export interface KeepOrMoveContext {
  db: Db;
  /** Whether this machine has a record to move anything to. */
  signedIn: () => boolean;
  /** Who this machine signed in as, and therefore whose a moved project becomes. */
  personId: () => Uuid | null;
  /** What the organisation calls them, for the local row a move may have to write. */
  personName?: () => string | undefined;
  /** Hands one page of a project to the record. Null when there is no record to hand it to. */
  send: SendAdoptPage | null;
  /**
   * Where this machine keeps the files the move has to carry (EO-325).
   *
   * Absent refuses a project that has any, rather than moving it
   * without them — see `sendFiles`. A move that is allowed to lose
   * something is not a move.
   */
  files?: MovedFileStore;
}

/**
 * "Keep this one here."
 *
 * The sheet's default, and the one answer that changes nothing about
 * the project except that nobody will be asked about it again.
 */
export function keepProjectLocalCommand(
  context: KeepOrMoveContext,
  payload: IpcPayload<"projects:keepLocal">,
): IpcResponse<"projects:keepLocal"> {
  const project = getProject(context.db, payload.projectId as Uuid);
  if (project === undefined) return { project: null, problem: "EO has no project with that id." };
  if (project.managedAt !== null) {
    return { project: toView(context.db, project), problem: `"${project.name}" is already on the record. ${MOVE_IS_ONE_WAY_LINE}` };
  }
  const kept = keepProjectLocal(context.db, project.id);
  return { project: kept === undefined ? null : toView(context.db, kept), problem: null };
}

/**
 * "Move this one to the record."
 *
 * Refused while this machine cannot reach its record, and deliberately
 * so — `adopt.ts` argues it at length. The short version: a move is a
 * long ordered conversation about thousands of rows, and a queued one
 * would be a promise about somebody's whole project that EO could not
 * keep if they quit the app before the network came back.
 */
export async function moveProjectToRecordCommand(
  context: KeepOrMoveContext,
  payload: IpcPayload<"projects:moveToRecord">,
): Promise<IpcResponse<"projects:moveToRecord">> {
  const project = getProject(context.db, payload.projectId as Uuid);
  if (project === undefined) return { project: null, moved: null, problem: "EO has no project with that id." };

  const personId = context.personId();
  if (context.send === null || personId === null) {
    return {
      project: toView(context.db, project),
      moved: null,
      problem: "EO is not signed in to an organisation, so there is no record to move this project to.",
    };
  }

  const personName = context.personName?.();
  const outcome = await moveProjectToRecord({
    db: context.db,
    projectId: project.id,
    personId,
    ...(personName === undefined ? {} : { personName }),
    ...(context.files === undefined ? {} : { files: context.files }),
    send: context.send,
  });
  if (!outcome.ok) {
    // The project is untouched — `moveProjectToRecord` marks it only
    // once every page has landed — so it is still local, still
    // undecided, and still on the sheet. Which is the state it is safe
    // to be left in.
    return { project: toView(context.db, project), moved: null, problem: outcome.problem };
  }
  return { project: toView(context.db, outcome.project), moved: outcome.moved, problem: null };
}
