import type { IpcPayload, IpcResponse, Item, Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { clearSetting, deleteProject, getProject, getSetting, listItemsIncludingArchived, listProjects, listRunsForItem, setSetting } from "../db/repos/index.js";
import { finishedItemIds } from "../db/repos/pipelineVersionsRepo.js";
import { featureIsDone, featureProgress } from "../roles/featureLifecycle.js";
import { heldWorktreesFor, removeItemsAndTheirWork } from "./deleteItemCommand.js";
import type { EngineHandle } from "./domainCommands.js";
import { ACTIVE_PROJECT_KEY, activeProjectId } from "./repositoryCommands.js";

type Answer = IpcResponse<"projects:delete">;

/** What every answer carries when there is nothing to count. */
const NOTHING: Omit<Answer, "problem" | "name" | "activeProjectId"> = {
  deleted: false,
  itemCount: 0,
  unfinishedCount: 0,
  running: [],
  uncommitted: [],
  deletedCount: 0,
  leftoverWorktrees: [],
};

/**
 * The line a project on the organisation's record is refused with.
 *
 * Exported so the tool description, the refusal and the tests say the
 * same thing: it is not that EO cannot, it is that this machine is not
 * where that project is kept.
 */
export function managedProjectRefusal(name: string, act: "deleted" | "archived" = "deleted"): string {
  return `"${name}" is on your organisation's record, and the record owns it — it cannot be ${act} from this machine.`;
}

/**
 * How many of these tickets are unfinished: not archived, and not done.
 *
 * "Done" is the answer the rest of EO already gives. An item on a step
 * is done when that step is terminal **by the version it entered on**
 * (`finishedItemIds`, EO-327) — not by whatever the pipeline says
 * today. An item on no step is a container, which is done when
 * everything under it is (`featureIsDone`); asking whether *its* step
 * is terminal would count every finished feature as unfinished, and the
 * confirmation would overstate what is being thrown away.
 */
export function unfinishedCount(db: Db, all: readonly Item[]): number {
  const live = all.filter((item) => item.archivedAt === null);
  const finished = finishedItemIds(db, live);
  return live.filter((item) => {
    if (item.stepId !== null) return !finished.has(item.id);
    // Its live children only, which is what `featureProgress` reads by
    // default and so what every other screen says about this feature:
    // an archived story has been put away, and an unfinished one left
    // there must not keep a feature whose live stories are all done
    // counted as unfinished here when EO calls it done everywhere else.
    return !featureIsDone(featureProgress(db, item.id, live));
  }).length;
}

/**
 * Deletes a project and every item on it (EO-346).
 *
 * **Refuse first, confirm second**, as `items:delete` does. An
 * unconfirmed call deletes nothing and answers with what deleting
 * would take — the tickets, how many are unfinished, which have an
 * agent on them and which hold uncommitted work — so that the dialog
 * in Settings and a system agent are asked the same question with the
 * same facts. There is one confirmation rather than `items:delete`'s
 * two, because this answer already names both things the second one
 * exists for; a person who has read "EO-12 has an agent running" and
 * pressed Delete has said they meant it.
 *
 * **Each item goes the way one item goes** (KAN-30), through
 * `removeItemsAndTheirWork`: runs cancelled as `superseded`, worktrees
 * released with their branches kept, attachments removed. Jira is left
 * alone — a project going from EO says nothing about whether its
 * issues should go from Jira, and nothing here is asked about them.
 *
 * **The tickets go before the project row.** `items.project_id`
 * references `projects(id)` with no ON DELETE rule and `foreign_keys`
 * is on, so the other order fails. Everything else that hangs off a
 * project is the schema's to take: pipelines, item types, jobs and
 * connector bindings cascade, and workspaces are set to no project —
 * the repositories stay in EO for another project to use.
 *
 * **A project on the organisation's record is refused**, and so is one
 * halfway through moving there: the record owns the first, and the
 * second is a transfer that would be left pointing at rows that no
 * longer exist.
 */
export async function deleteProjectCommand(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"projects:delete">,
  attachmentStorage: AttachmentStorage,
  worktreeRoot?: string,
): Promise<Answer> {
  const project = getProject(db, input.projectId as Uuid);
  if (!project) return { ...NOTHING, problem: "That project no longer exists.", name: null, activeProjectId: activeProjectId(db) };

  const refuse = (problem: string): Answer => ({ ...NOTHING, problem, name: project.name, activeProjectId: activeProjectId(db) });
  if (project.managedAt !== null) return refuse(managedProjectRefusal(project.name));
  if (project.adoptingAt !== null) {
    return refuse(`"${project.name}" is being moved to your organisation's record. Wait for the move to finish, then decide.`);
  }

  // Archived ones too: they are on the project, `items.project_id`
  // still points at it, and a delete that left them would fail on the
  // very foreign key this ordering exists for.
  const doomed = listItemsIncludingArchived(db).filter((item) => item.projectId === project.id);
  const doomedIds = new Set(doomed.map((item) => item.id));
  // One `deleteItem` per tree: a feature takes its stories, so handing
  // it the stories as well would delete them twice.
  const rootIds = doomed.filter((item) => item.parentId === null || !doomedIds.has(item.parentId)).map((item) => item.id);

  const activeRuns = doomed.flatMap((item) => listRunsForItem(db, item.id).filter((run) => run.status === "running" || run.status === "queued"));
  const held = await heldWorktreesFor(db, doomed, worktreeRoot);

  const byId = new Map(doomed.map((item) => [item.id, item]));
  const byKey = new Map(doomed.map((item) => [item.key, item]));
  const runningIds = [...new Set(activeRuns.map((run) => run.itemId))];
  const running = runningIds
    .map((id) => byId.get(id as Uuid))
    .filter((item): item is Item => item !== undefined)
    .map((item) => ({ itemKey: item.key, title: item.title }));
  const uncommitted = held
    .filter((entry) => entry.uncommittedChanges > 0)
    .map((entry) => ({ itemKey: entry.key, title: byKey.get(entry.key)?.title ?? "", changes: entry.uncommittedChanges }));

  const facts = {
    name: project.name,
    itemCount: doomed.length,
    unfinishedCount: unfinishedCount(db, doomed),
    running,
    uncommitted,
  };

  if (!input.confirm) {
    return { ...NOTHING, ...facts, problem: null, activeProjectId: activeProjectId(db) };
  }

  const { deletedItemIds, leftoverWorktrees } = await removeItemsAndTheirWork(
    db,
    engine,
    attachmentStorage,
    { rootIds, doomed, activeRuns, held, discardUncommitted: true },
    () => {
      // The window moves off it in the same write the project goes in,
      // rather than leaving the setting pointing at nothing for
      // `activeProjectId` to paper over on every read. Whichever project
      // is left first, which is the fallback that read would make.
      if (getSetting<string | null>(db, ACTIVE_PROJECT_KEY, null) === project.id) {
        const next = listProjects(db).find((candidate) => candidate.id !== project.id && candidate.archivedAt === null);
        if (next) setSetting(db, ACTIVE_PROJECT_KEY, next.id);
        else clearSetting(db, ACTIVE_PROJECT_KEY);
      }
      deleteProject(db, project.id);
    },
  );

  engine?.notifyStateChange();

  return {
    ...facts,
    deleted: true,
    problem: null,
    deletedCount: deletedItemIds.length,
    leftoverWorktrees,
    activeProjectId: activeProjectId(db),
  };
}
