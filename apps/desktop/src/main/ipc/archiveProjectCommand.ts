import type { IpcPayload, IpcResponse, Item, Run, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  clearSetting,
  getProject,
  getSetting,
  listItemsIncludingArchived,
  listProjects,
  listRunsForItem,
  postComment,
  setProjectArchived,
  setSetting,
  stepForItem,
  type Project,
} from "../db/repos/index.js";
import { clearStop } from "../supervisor/stoppedByHand.js";
import { managedProjectRefusal, unfinishedCount } from "./deleteProjectCommand.js";
import type { EngineHandle } from "./domainCommands.js";
import { ACTIVE_PROJECT_KEY, activeProjectId } from "./repositoryCommands.js";

type ArchiveAnswer = IpcResponse<"projects:archive">;
type RestoreAnswer = IpcResponse<"projects:restore">;

/** Every item on the project, archived ones included — the same set `projects:delete` counts from. */
function itemsOn(db: Db, project: Project): Item[] {
  return listItemsIncludingArchived(db).filter((item) => item.projectId === project.id);
}

/**
 * The sentence on an item whose run the archive stopped (EO-347,
 * invariant #8).
 *
 * Says what stopped it, and what brings it back — restoring the
 * project — because the run row alone reads "cancelled", and a person
 * finding that later is owed the difference between an agent they
 * stopped and a project they put away.
 */
export function stoppedByArchiveNote(projectName: string, stepName: string): string {
  return (
    `Run stopped because this ticket's project, "${projectName}", was archived. Nothing will be dispatched on it ` +
    `while the project is archived; restoring the project carries it on from "${stepName}".`
  );
}

/**
 * Puts a project away, reversibly (EO-347).
 *
 * **Refuse first, confirm second**, as `projects:delete` does, and with
 * the same one question: the unconfirmed answer already names every
 * item an agent is on, so pressing Archive after reading it is the
 * answer.
 *
 * **What archiving writes is one column.** Everything it means is read
 * from that column where it matters — `buildEligibilityInput` leaves
 * the project's items out of the scheduler, the Inbox and the dock
 * badge leave them out of what they count, and the switcher leaves the
 * project out of its list. Nothing is written onto an item, which is
 * the whole of how an item somebody held themselves is still held
 * after the project is restored: `heldAt` was never touched.
 *
 * **Runs in flight are stopped as `superseded`**, the classification
 * for a cancellation that belongs to something larger and says its own
 * sentence about it. The sentence is `stoppedByArchiveNote`, on each
 * such item. Any stand-off a person's earlier stop left on that
 * item (EO-175) is cleared here too, for `resumeHeldItem`'s reason:
 * restoring is the one re-authorisation that leaves the item exactly
 * where it stood, same step, same initiation — and a restored project
 * whose stopped tickets then sat still would be a restore that needed
 * a second, invisible step per item. Cleared now rather than on
 * restore because nothing between the two can record another stop —
 * no run of the project's is going — and so nothing has to remember
 * which tickets these were.
 *
 * **The window moves off it** in the same write, as it does for a
 * delete: another live project if there is one, "No projects yet" if
 * not.
 */
export function archiveProjectCommand(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"projects:archive">): ArchiveAnswer {
  const project = getProject(db, input.projectId as Uuid);
  const nothing = { archived: false, unfinishedCount: 0, running: [], activeProjectId: activeProjectId(db) };
  if (!project) return { ...nothing, problem: "That project no longer exists.", name: null };

  const refuse = (problem: string): ArchiveAnswer => ({ ...nothing, problem, name: project.name });
  if (project.managedAt !== null) return refuse(managedProjectRefusal(project.name, "archived"));
  if (project.adoptingAt !== null) {
    return refuse(`"${project.name}" is being moved to your organisation's record. Wait for the move to finish, then decide.`);
  }
  if (project.archivedAt !== null) return refuse(`"${project.name}" is already archived. Restore it from Settings → Projects to bring it back.`);

  const onIt = itemsOn(db, project);
  // One run per item: two live rows on one item is a state the item
  // lock exists to prevent, and one sentence per item is what the
  // person reads either way.
  const activeRuns = new Map<Uuid, Run>();
  for (const item of onIt) {
    const live = listRunsForItem(db, item.id).find((run) => run.status === "running" || run.status === "queued");
    if (live) activeRuns.set(item.id, live);
  }
  const running = onIt.filter((item) => activeRuns.has(item.id)).map((item) => ({ itemKey: item.key, title: item.title }));
  const facts = { name: project.name, unfinishedCount: unfinishedCount(db, onIt), running };

  if (!input.confirm) return { ...nothing, ...facts, problem: null };

  db.transaction(() => {
    // The column first, so a tick landing between this and the
    // cancellations below already leaves the project's items out, and
    // the run it would otherwise dispatch next never starts.
    setProjectArchived(db, project.id, Date.now());
    if (getSetting<string | null>(db, ACTIVE_PROJECT_KEY, null) === project.id) {
      const next = listProjects(db).find((candidate) => candidate.id !== project.id && candidate.archivedAt === null);
      if (next) setSetting(db, ACTIVE_PROJECT_KEY, next.id);
      else clearSetting(db, ACTIVE_PROJECT_KEY);
    }
  });

  for (const item of onIt) {
    const run = activeRuns.get(item.id);
    if (!run) continue;
    engine?.cancelRun(run.id, "superseded");
    clearStop(db, item.id);
    const stepName = item.stepId === null ? "no pipeline" : (stepForItem(db, item)?.name ?? item.stepId);
    postComment(db, { itemId: item.id, runId: run.id, author: { type: "engine" }, body: stoppedByArchiveNote(project.name, stepName) });
  }

  engine?.notifyStateChange();
  return { ...facts, archived: true, problem: null, activeProjectId: activeProjectId(db) };
}

/**
 * Brings an archived project back (EO-347).
 *
 * Clears the column and asks for a tick. That is all it has to do,
 * because archiving wrote nothing else: every paused item is still on
 * the step it was on, the ones whose runs were stopped had any
 * stand-off cleared when they were stopped, and the ones a person held
 * are still held because nothing ever released them.
 *
 * The window is left where it is. Restoring is putting the project
 * back in the switcher, not taking somebody off the board they are
 * reading — except where there was no board at all, where
 * `activeProjectId` now answers with this one on its own.
 */
export function restoreProjectCommand(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"projects:restore">): RestoreAnswer {
  const project = getProject(db, input.projectId as Uuid);
  if (!project) return { restored: false, problem: "That project no longer exists.", name: null, unfinishedCount: 0 };
  if (project.archivedAt === null) {
    return { restored: false, problem: `"${project.name}" is not archived.`, name: project.name, unfinishedCount: 0 };
  }

  setProjectArchived(db, project.id, null);
  engine?.notifyStateChange();
  return { restored: true, problem: null, name: project.name, unfinishedCount: unfinishedCount(db, itemsOn(db, project)) };
}
