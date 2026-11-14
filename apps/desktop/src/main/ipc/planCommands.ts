import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { addItemAttachments, hasJiraPullPending } from "../db/repos/index.js";
import { checkItemUploads, rollbackItemUploads, storeItemUploads } from "../attachments/itemUploads.js";
import type { AttachmentStorage } from "../attachments/storage.js";
import { requestJiraPullDrain } from "../packs/developer/jira/pullSchedule.js";
import { applyNewFeature } from "../roles/discussion.js";
import { activeProjectId } from "./repositoryCommands.js";
import { emitPush } from "./push.js";
import { withModuleEntryChecks } from "../modules/entryChecks.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * A plan agreed outside EO, handed over whole.
 *
 * The one thing this does that `discussions:approve` does not is decide
 * which project it lands in without a conversation to ask. Everything
 * after that is the same function, deliberately: the plan is validated,
 * its dependency graph is checked for cycles, its stories are placed on
 * the pipeline's entry step, and the understanding is pinned on the
 * feature exactly as the product owner's is.
 *
 * A plan that cannot be built comes back as a `problem`, not a throw.
 * The submitter is an agent that can read the reason and fix the plan —
 * a story naming a dependency that is not there, a pipeline the project
 * does not have, a Jira key some item already holds — and those are
 * all things it can put right and send again.
 *
 * `jiraKey` and `jiraSync` are the case this was missing (EO-124): a
 * plan agreed outside EO often mirrors an epic whose stories are
 * already written under it, and there was nowhere to say which is
 * which. Attaching is a local write that calls nothing, and it marks
 * every item it attached for the pull the schedule does next
 * (EO-127).
 */
export function submitPlan(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"work:submitPlan">,
  /**
   * Each item's own files, already checked and stored (EO-704): the
   * feature's first, then each story's in the order the stories were
   * sent. Written in the transaction that creates the plan, so nothing
   * is dispatched on a story before its files are there. See
   * `submitPlanCommand`.
   */
  files: readonly Parameters<typeof addItemAttachments>[2][] = [],
): IpcResponse<"work:submitPlan"> {
  const projectId = (input.projectId ?? activeProjectId(db)) as Uuid | null;

  // The stories as a plan's stories are: `paths` is this channel's, and
  // what they named arrives as `files`, never as part of the proposal.
  const proposed = input.stories.map(({ paths: _paths, ...story }) => story);

  // One transaction around the plan and its files. `applyNewFeature`'s
  // own becomes a savepoint inside it.
  const applied = db.transaction(() => {
    const made = applyNewFeature(
      db,
      projectId,
      {
        action: "new_feature",
        title: input.title,
        understanding: input.understanding,
        decisions: input.decisions,
        stories: proposed,
        ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
        // The feature's own, and only the feature's (EO-568): each story's
        // rides on the story, and one that says nothing is 0.
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        // The feature's (EO-739), which its stories inherit. Trimmed and
        // judged by `applyNewFeature`, which refuses one git would not
        // take before anything is written.
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        // The feature's reviewers (EO-743), which its stories inherit,
        // normalised and judged by `applyNewFeature` before anything is
        // written.
        ...(input.reviewers === undefined ? {} : { reviewers: input.reviewers }),
      },
      null,
      // What the submitter said about Jira, carried whole and defaulted
      // nowhere (EO-124). An absent key leaves an item unlinked; an
      // absent switch is inherited — the feature's from nothing, a
      // story's from the feature — so filling either in here would be
      // this layer inventing an answer. The per-story entries stay
      // positional, matching the array they were sent in.
      {
        ...(input.jiraKey === undefined ? {} : { key: input.jiraKey }),
        ...(input.jiraSync === undefined ? {} : { sync: input.jiraSync }),
        stories: input.stories.map((story) => ({
          ...(story.jira_key === undefined ? {} : { key: story.jira_key }),
          ...(story.jira_sync === undefined ? {} : { sync: story.jira_sync }),
        })),
      },
    );
    if (made.ok) {
      made.created.forEach((item, index) => {
        const own = files[index] ?? [];
        if (own.length > 0) addItemAttachments(db, item.id, own);
      });
    }
    return made;
  });

  if (!applied.ok) return { created: false, featureKey: null, storyKeys: [], problem: applied.reason };

  // The board, the inbox and the archive all derive from these, and the
  // scheduler has work it did not have a moment ago.
  for (const item of applied.created) emitPush("items:changed", { itemId: item.id });
  engine?.notifyStateChange();
  // The epic and every story that came with a key of its own (EO-127).
  // One kick for the plan, not one per item: the drain reads the
  // whole marked set.
  if (hasJiraPullPending(db)) requestJiraPullDrain();

  const [feature, ...stories] = applied.created;
  return {
    created: true,
    featureKey: feature?.key ?? null,
    storyKeys: stories.map((item) => item.key),
    problem: null,
    ...(applied.warnings === undefined ? {} : { warnings: applied.warnings }),
  };
}

/**
 * `work:submitPlan` as the channel answers it, with the files the plan
 * names by path on the feature and on each story (EO-704).
 *
 * Every path in the plan is checked, under the grant the door stamped,
 * before anything is written, and one that may not be read refuses the
 * whole plan, naming it and why. The files are then stored, and the plan
 * and every item's files are written in one transaction by
 * `submitPlan`; a plan refused after that takes the stored files back.
 */
export async function submitPlanCommand(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"work:submitPlan">,
  attachmentStorage?: AttachmentStorage,
): Promise<IpcResponse<"work:submitPlan">> {
  const lists = [input.paths ?? [], ...input.stories.map((story) => story.paths ?? [])];
  // Each story's module entry rules are run before the plan is written
  // (EO-736): `submitPlan` refuses whole, before its first row, until
  // every one has a verdict.
  if (lists.every((paths) => paths.length === 0)) return withModuleEntryChecks(db, "creation", () => submitPlan(db, engine, input));
  const refused = (problem: string): IpcResponse<"work:submitPlan"> => ({ created: false, featureKey: null, storyKeys: [], problem });
  const granted = await checkItemUploads(input.pathsFrom, lists, attachmentStorage);
  if (!granted.ok) return refused(granted.problem);
  const stored = await storeItemUploads(granted, lists);
  if (!stored.ok) return refused(stored.problem);
  let answer: IpcResponse<"work:submitPlan">;
  try {
    answer = await withModuleEntryChecks(db, "creation", () => submitPlan(db, engine, input, stored.records));
  } catch (error) {
    await rollbackItemUploads(granted.storage, stored.records);
    throw error;
  }
  if (!answer.created) await rollbackItemUploads(granted.storage, stored.records);
  return answer;
}
