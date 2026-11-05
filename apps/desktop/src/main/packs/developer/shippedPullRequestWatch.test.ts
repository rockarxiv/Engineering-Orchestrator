import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentProvider, Item } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { getItem, getStep, listCommentsForItem, listTransitionsForItem } from "../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../db/testHelpers.js";
import { validImplementResult } from "../../providers/fixtures.js";
import type { BuiltinRunner } from "../../supervisor/builtins.js";
import { createRunSupervisor } from "../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../../supervisor/testWorkspaceKinds.js";
import { createBuiltinRunners } from "./builtins.js";
import type { CliRunner } from "./forge/cli.js";
import { checkRun, fakeGh, gitHubState, type GitHubState } from "./forge/testForges.js";
import { createRoleWiring } from "./wiring.js";

/**
 * The shipped pipeline watching the pull request it opened (EO-461),
 * end to end on the rows migration 0123 writes — not on a graph the test
 * draws for itself.
 *
 * Merge Request is the one thing stood in for: opening a pull request is
 * `open_pull_request`'s own subject and has its tests, and what matters
 * here is only that its success route now leads into the watch. The
 * watch itself is the real `watch_pull_request` over a scripted `gh`, and
 * the implementer is dispatched by the real supervisor, so what the test
 * reads is the prompt the agent would actually have been sent.
 */

const MINUTE = 60_000;
const START = 1_800_000_000_000;
const URL = "https://github.com/acme/api/pull/7";

let handle: DbHandle;
let clock: number;
/** What each agent turn was opened with, in order. */
let prompts: string[];

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = START;
  prompts = [];
});

afterEach(() => {
  handle.close();
});

/** An item with its pull request recorded, on Merge Request — where an approved review leaves it. */
function approvedItem(): Item {
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: "/nonexistent/acme-api" });
  return createTestItem(handle.db, {
    type: "story",
    title: "Rate limit the API",
    stepId: "merge_request",
    workspaceId: repository.id,
    spec: REVIEWABLE_SPEC,
    git: { branch: "eo/API-1", pullRequest: URL },
  });
}

/** Merge Request finding the pull request already open, which is what a second pass says too. */
const alreadyOpen: BuiltinRunner = async () => ({ ok: true, result: "opened", detail: `Already open: ${URL}` });

/** An agent backend that records the prompt it was handed and answers as a finished implementation. */
function recordingProvider(): AgentProvider {
  const answer = (): AsyncIterable<AgentEvent> =>
    (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      yield { type: "result", data: validImplementResult };
    })();
  return {
    start: (opts) => {
      prompts.push(opts.context);
      return answer();
    },
    resume: (_threadId, message) => {
      prompts.push(message);
      return answer();
    },
  };
}

function supervisorWith(gh: CliRunner) {
  return createRunSupervisor({
    db: handle.db,
    provider: recordingProvider(),
    ...createRoleWiring(handle.db),
    limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
    now: () => clock,
    kinds: installedKinds(fakeWorkspaceKind()),
    builtins: {
      open_pull_request: alreadyOpen,
      watch_pull_request: createBuiltinRunners(undefined, undefined, undefined, gh).watch_pull_request,
    },
    guards: { interpretReplies: false },
  });
}

const stepOf = (item: Item): string | null => getItem(handle.db, item.id)?.stepId ?? null;

describe("the shipped pipeline watches the pull request it opened", () => {
  it("sends a failed check back to the implementer, whose prompt names the check that failed", async () => {
    const item = approvedItem();
    // The lint job fails while e2e is still running, so the first check
    // only reports news. The second, once e2e is green, answers
    // checks_failed and has nothing new to post: the comment naming the
    // failure is the one the earlier check wrote, and it is that one the
    // implementer has to be shown.
    let pr: GitHubState = gitHubState({ checkRuns: [checkRun(12, "lint", "completed", "failure"), checkRun(13, "e2e", "in_progress")] });
    const supervisor = supervisorWith(fakeGh(() => pr).run);

    await supervisor.runOnce();
    expect(stepOf(item)).toBe("pull_request_watch");

    await supervisor.runOnce();
    expect(stepOf(item)).toBe("pull_request_watch");
    const news = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes('The check "lint" failed'));
    expect(news).toHaveLength(1);

    pr = { ...pr, checkRuns: [checkRun(12, "lint", "completed", "failure"), checkRun(13, "e2e", "completed", "success")] };
    clock += 5 * MINUTE;
    await supervisor.runOnce();
    expect(stepOf(item)).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id).at(-1)).toMatchObject({ fromStepId: "pull_request_watch", toStepId: "todo", actor: "engine" });

    await supervisor.runOnce();
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain('perform the "implement" action');
    expect(prompt).toContain("### At Watching pull request");
    expect(prompt).toContain('> The check "lint" failed: https://github.com/acme/api/actions/runs/1/job/12');
  });

  it("moves a merged pull request to Done with no person acting", async () => {
    const item = approvedItem();
    const supervisor = supervisorWith(fakeGh(() => gitHubState({ pr: { state: "MERGED" } })).run);

    await supervisor.runOnce();
    expect(stepOf(item)).toBe("pull_request_watch");
    await supervisor.runOnce();

    expect(stepOf(item)).toBe("ready_to_merge");
    expect(getStep(handle.db, "ready_to_merge")?.isTerminal).toBe(true);
    // Every move EO's own, and nothing anybody said.
    expect(listTransitionsForItem(handle.db, item.id).map((move) => [move.toStepId, move.actor])).toEqual([
      ["pull_request_watch", "engine"],
      ["ready_to_merge", "engine"],
    ]);
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "human")).toEqual([]);
    expect(prompts).toEqual([]);
  });
});
