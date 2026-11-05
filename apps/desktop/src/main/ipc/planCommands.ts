import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { hasJiraPullPending } from "../db/repos/index.js";
import { requestJiraPullDrain } from "../packs/developer/jira/pullSchedule.js";
import { applyNewFeature } from "../roles/discussion.js";
import { activeProjectId } from "./repositoryCommands.js";
import { emitPush } from "./push.js";
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
): IpcResponse<"work:submitPlan"> {
  const projectId = (input.projectId ?? activeProjectId(db)) as Uuid | null;

  const applied = applyNewFeature(
    db,
    projectId,
    {
      action: "new_feature",
      title: input.title,
      understanding: input.understanding,
      decisions: input.decisions,
      stories: input.stories,
      ...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
      // The feature's own, and only the feature's (EO-568): each story's
      // rides on the story, and one that says nothing is 0.
      ...(input.priority === undefined ? {} : { priority: input.priority }),
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
  };
}
