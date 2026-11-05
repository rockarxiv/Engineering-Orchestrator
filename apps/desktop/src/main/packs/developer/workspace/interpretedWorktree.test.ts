import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitStateOf, INTERPRET_ACTION, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import {
  addDependency,
  getItem,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  updateItem,
  type GitWorkspace,
} from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { createRoleWiring } from "../wiring.js";
import { BUILTIN_RUNNERS } from "../builtins.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { setBranchPrefix } from "./branchPrefix.js";
import { createWorktreeWorkspace } from "./dispatchWorkspace.js";
import { worktreePathFor } from "./worktrees.js";
import { run } from "../../../testing/git.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";

/**
 * The two flows EO-184 exists for, against a real repository (EO-184).
 *
 * Everything below the model is the real thing: the real
 * `create_worktree` builtin, the real `prepareWorkspace`, the real
 * stacking resolver reading a real git history, the real supervisor, and
 * the shared answer reader the branch is actually cut from. Only the
 * model call is scripted — which is the one part a test cannot have, and
 * the one part that is not EO's code.
 *
 * **The tied stack target.** Two dependencies are open, nothing chooses
 * between them, so the worktree step stops and offers their keys.
 * Somebody answers in a sentence instead of pressing one. Before this
 * story the step re-ran, hand-parsed the thread, found no key and asked
 * the identical question. Here the sentence reaches the system agent, the
 * key it read is filed under the person's own reply, and the next run of
 * the step cuts the branch from that dependency's tip.
 *
 * **A worktree that could not be cut.** A stray checkout holds the
 * branch, so the step refuses with a fact rather than a question — no
 * options, so a sentence is the only reply possible. The person says to
 * clear it and retry; the agent does the clearing with its own tools and
 * comes back `acted` with `retry: true`; the step runs again and
 * succeeds.
 *
 * On disk and not in memory, because what is being asserted is a branch
 * cut from the right commit — which no stub can be wrong about in the
 * way a real `git worktree add` can.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let scratch: string;
let worktreeRoot: string;
let handle: DbHandle;
let repository: GitWorkspace;
/** Every context a provider was started with — one entry per model call. */
let started: string[];

/** A commit on `branch`, cut from wherever the repository is now. */
async function commitOn(branch: string, file: string): Promise<string> {
  await run(["checkout", "-B", branch], repository.config.repoPath);
  writeFileSync(join(repository.config.repoPath, file), `${file}\n`);
  await run(["add", "-A"], repository.config.repoPath);
  await run(["commit", "-m", `feat: ${file}`], repository.config.repoPath);
  const head = await run(["rev-parse", "HEAD"], repository.config.repoPath);
  await run(["checkout", "main"], repository.config.repoPath);
  return head;
}

/**
 * The agent, scripted — plus whatever it did with its tools.
 *
 * `act` stands in for the tool calls a real interpretation makes before
 * it answers: EO-184's `acted` branch is defined by the agent having
 * *done* something, so a test that only scripted the words would prove
 * half of it.
 */
function agent(result: unknown, act?: () => Promise<void>): AgentProvider {
  const scripted = createScriptedProvider(
    [{ when: (context) => context.includes(`"${INTERPRET_ACTION}" action`), script: { result } }],
    { throwMessage: "only an interpretation should reach a provider in this test" },
  );
  return {
    async *start(options: AgentProviderStartOptions): AsyncIterable<AgentEvent> {
      started.push(options.context);
      await act?.();
      yield* scripted.start(options);
    },
    resume: scripted.resume.bind(scripted),
  };
}

function supervisorWith(provider: AgentProvider) {
  return createRunSupervisor({
    db: handle.db,
    provider,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    // The real worktree builtin, and nothing else: the step after it in
    // the seeded pipeline fetches an index binary, which this test has
    // no business running. It is never reached — each test stops on the
    // tick that cuts the branch — and naming only this one is what makes
    // that a fact rather than a hope.
    builtins: { create_worktree: BUILTIN_RUNNERS.create_worktree! },
    kinds: installedKinds(fakeWorkspaceKind({ prepare: createWorktreeWorkspace(handle.db, worktreeRoot) })),
  });
}

/** What a person does: a reply filed under the question. */
function reply(item: Item, body: string): void {
  const asked = listCommentsForItem(handle.db, item.id).at(-1);
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, parentId: asked?.id ?? null, body });
}

function escalations(item: Item) {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "eo interpreted worktree "));
  worktreeRoot = join(scratch, "work trees");
  handle = openMigratedTestDb();
  started = [];
  // Hermetic: without this the prefix seeds itself from whatever
  // `git config --global user.email` happens to be on this machine.
  setBranchPrefix(handle.db, "eo");

  const repoPath = join(scratch, "the repo");
  mkdirSync(repoPath, { recursive: true });
  await run(["init", "-b", "main"], repoPath);
  await run(["config", "user.email", "eo@example.com"], repoPath);
  await run(["config", "user.name", "EO Test"], repoPath);
  await run(["config", "commit.gpgsign", "false"], repoPath);
  await run(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# the repo\n");
  await run(["add", "-A"], repoPath);
  await run(["commit", "-m", "initial"], repoPath);

  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath, baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a tied stack target, answered in a sentence", () => {
  it("reads the reply, files the dependency under it, and cuts the branch from that dependency", async () => {
    // The situation the tie describes, and it is an ordinary one: two
    // stories of the same feature have finished on the board — they sit
    // on the terminal step, which is what unblocks work that depends on
    // them — while their branches are still unmerged. A third story
    // depends on both and on nothing else, and neither of the two
    // depends on the other, so there is nothing for EO to prefer.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: repository.id });
    const common = { type: "story" as const, workspaceId: repository.id, parentId: feature.id };
    const first = createTestItem(handle.db, { ...common, title: "The limiter", stepId: "ready_to_merge" });
    const second = createTestItem(handle.db, { ...common, title: "The store", stepId: "ready_to_merge" });
    const dependent = createTestItem(handle.db, { ...common, title: "Wire them together", stepId: "worktree" });

    const firstTip = await commitOn(`eo/${first.key}`, "limiter.ts");
    const secondTip = await commitOn(`eo/${second.key}`, "store.ts");
    updateItem(handle.db, first.id, { git: { branch: `eo/${first.key}` } });
    updateItem(handle.db, second.id, { git: { branch: `eo/${second.key}` } });
    addDependency(handle.db, dependent.id, first.id);
    addDependency(handle.db, dependent.id, second.id);

    // The agent reads "the store" as the second story. It answers with
    // the key, which is the step's own vocabulary — not a paraphrase.
    const supervisor = supervisorWith(agent({ status: "answered", answer: second.key, note: `The store is ${second.key}.` }));

    // 1. The step stops and offers both keys.
    await supervisor.runOnce();
    const asked = escalations(dependent).at(-1);
    expect(asked?.options).toEqual([first.key, second.key]);
    expect(getItem(handle.db, dependent.id)?.stepId).toBe("worktree");

    // 2. A sentence, not a button.
    reply(dependent, "stack it on the one that holds the store, please");

    // 3. The interpretation runs — and the step does not.
    await supervisor.runOnce();
    const interpretations = listRunsForItem(handle.db, dependent.id).filter((entry) => entry.action === INTERPRET_ACTION);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0]?.status).toBe("succeeded");
    expect(escalations(dependent)).toHaveLength(1); // it did not ask again
    const decision = listCommentsForItem(handle.db, dependent.id).find((comment) => comment.kind === "decision");
    // Threaded under the person's own reply, which is what makes it an
    // answer to every reader of this thread (EO-183).
    expect(decision?.body).toBe(second.key);
    expect(decision?.parentId).toBe(listCommentsForItem(handle.db, dependent.id).find((comment) => comment.authorType === "human")?.id);

    // 4. The step runs again, reads the key out of the thread, and cuts
    //    the branch from it.
    await supervisor.runOnce();
    const worktree = worktreePathFor(dependent.key, worktreeRoot);
    expect(existsSync(worktree)).toBe(true);
    expect(gitStateOf(getItem(handle.db, dependent.id)!).branch).toBe(`eo/${dependent.key}`);

    // From the story a person meant, not from `main` and not from the
    // other one: the new branch's tip is the second story's commit.
    expect(await run(["rev-parse", "HEAD"], worktree)).toBe(secondTip);
    expect(await run(["rev-parse", "HEAD"], worktree)).not.toBe(firstTip);
    // And the item moved on, as a successful step does.
    expect(getItem(handle.db, dependent.id)?.stepId).toBe("repository_index");
  }, 30_000);
});

describe("a worktree that could not be cut, answered with an instruction", () => {
  it("does what was asked and retries the step", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree", workspaceId: repository.id });
    const branch = `eo/${item.key}`;
    // Somebody's own checkout of the branch, somewhere EO does not
    // expect it — the refusal `ensureWorktree` gives is a fact rather
    // than a question, so it carries no options and a sentence is the
    // only reply there is.
    const stray = join(scratch, "somebody elses checkout");
    await run(["worktree", "add", "-b", branch, stray], repository.config.repoPath);

    const supervisor = supervisorWith(
      agent({ status: "acted", summary: `Removed the stray checkout of ${branch} at ${stray}.`, retry: true }, async () => {
        // The tool calls a real interpretation would make: it does the
        // thing it was asked to do, and only then says what it did.
        await run(["worktree", "remove", "--force", stray], repository.config.repoPath);
      }),
    );

    // 1. Refused, with no answers on offer.
    await supervisor.runOnce();
    const asked = escalations(item).at(-1);
    expect(asked?.body).toContain("already checked out");
    expect(asked?.options).toBeNull();

    // 2. An instruction, in a sentence.
    reply(item, "that is my old checkout — get rid of it and try again");

    // 3. The agent clears it and reports what it did.
    await supervisor.runOnce();
    const interpretation = listRunsForItem(handle.db, item.id).find((entry) => entry.action === INTERPRET_ACTION);
    expect(interpretation).toMatchObject({ status: "succeeded" });
    expect(interpretation?.result).toMatchObject({ parsed: { status: "acted", retry: true } });
    expect(existsSync(stray)).toBe(false);
    const note = listCommentsForItem(handle.db, item.id).at(-1);
    expect(note?.body).toContain("Removed the stray checkout");

    // 4. `retry: true` hands the item back to the step, which now
    //    works — the obstacle it refused over is gone.
    await supervisor.runOnce();
    expect(existsSync(worktreePathFor(item.key, worktreeRoot))).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");
  }, 30_000);
});
