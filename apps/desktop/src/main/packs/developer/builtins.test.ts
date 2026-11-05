import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_RESULTS, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import {
  createRepositoryIntelligenceService,
  type RepositoryIndexBuild,
  type RepositoryIndexTarget,
  type RepositoryIntelligenceProvider,
} from "./repositoryIntelligence/index.js";
import { BUILTIN_RUNNERS, createBuiltinRunners, type OpenForItem } from "./builtins.js";
import { preparedIn, preparingAt } from "../../supervisor/testWorkspaceKinds.js";

/**
 * What the shipped builtins report, against what they declare (EO-77).
 *
 * The declaration in `packages/core` is the thing the editor fills its
 * result rows from and the thing `validatePipeline` checks a route key
 * against — so a runner answering something that is not in it would put
 * an item on a result no row can catch, and the design would park it and ask a
 * person. `BUILTIN_RUNNERS` is typed by the declaration, so that cannot
 * compile; this is the other half, run rather than typed, because a type
 * says nothing about which branch a real item takes.
 *
 * The pull request half is exercised against a stub of the one function
 * that reaches a forge. What it does with a real repository, a real
 * remote and a recorded CLI is `forge/openForItem.test.ts`; what the
 * *step* does with each outcome is here, which is the thing that has to
 * agree with the declaration.
 */

let handle: DbHandle;

const runId = "019fb8c6-0000-7000-8000-00000000dead" as Uuid;

function story(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
  return createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree", ...overrides });
}

/** The merge step, over a stub of the one function that reaches a forge. */
async function pullRequestStep(open: OpenForItem, signal?: AbortSignal) {
  const repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "REPO", repoPath: "/tmp/eo/repo" });
  return createBuiltinRunners(open).open_pull_request({
    db: handle.db,
    item: story({ workspaceId: repository.id, git: { branch: "eo/REPO-1" } }),
    prepareWorkspace: preparingAt("/tmp/eo/worktree"),
    report: () => {},
    runId,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The index step, over a stand-in for whatever describes a checkout.
 *
 * Faked at the port and never below it: the implementation has its own
 * tests where the binary is real, and a step's job is what it does with
 * an outcome. `id` is deliberately not the shipped provider's — the port
 * treats it as opaque, and a test that spelled the real one would be a
 * test quietly asserting which implementation is configured.
 */
function indexStep(options: { build?: { ok: false; reason: string }; installed?: { ok: false; reason: string }; workspaceId?: Uuid | null } = {}) {
  const repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "REPO", repoPath: "/tmp/eo/repo" });
  const indexPath = "/tmp/eo/worktree/.index";
  const build = async (): Promise<RepositoryIndexBuild> =>
    options.build ?? { ok: true, indexPath, providerVersion: "1.2.3", indexedCommitSha: "cafebabe" };
  const provider: RepositoryIntelligenceProvider = {
    id: "test-index",
    initialize: build,
    sync: build,
    ensureReady: build,
    rebuild: build,
    getStatus: async (_target: RepositoryIndexTarget) => ({ present: false, indexPath, providerVersion: "1.2.3", indexedCommitSha: null, unavailableReason: null }),
    getAgentMcpConfig: async () => null,
    remove: async () => ({ ok: true as const }),
  };

  return createBuiltinRunners(undefined, undefined, ({ db }) => ({
    service: createRepositoryIntelligenceService({ db, provider }),
    ensureInstalled: async () => options.installed ?? { ok: true as const },
  })).index_repository({
    db: handle.db,
    item: story({ workspaceId: options.workspaceId === undefined ? repository.id : options.workspaceId }),
    prepareWorkspace: preparingAt("/tmp/eo/worktree"),
    report: () => {},
    runId,
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("the built-in functions EO ships", () => {
  it("reports `ready` when the worktree is prepared", async () => {
    const outcome = await BUILTIN_RUNNERS.create_worktree({
      db: handle.db,
      item: story(),
      prepareWorkspace: preparingAt("/tmp/eo/worktree"),
      report: () => {},
      runId,
    });

    expect(outcome).toMatchObject({ ok: true, result: "ready" });
    expect(BUILTIN_RESULTS.create_worktree).toContain(outcome.ok ? outcome.result : "");
  });

  it("reports `failed` when the worktree could not be prepared", async () => {
    // A refusal, not an outcome key, because it carries a reason a
    // result cannot. The supervisor maps it onto `failed` if the
    // pipeline routes that, and asks a person if it does not.
    const outcome = await BUILTIN_RUNNERS.create_worktree({
      db: handle.db,
      item: story(),
      prepareWorkspace: async () => ({ ok: false as const, reason: `The branch "eo/REPO-1" already exists.` }),
      report: () => {},
      runId,
    });

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("already exists") });
  });

  it("carries up the answers a refusal named, so they can be offered as buttons", async () => {
    const outcome = await BUILTIN_RUNNERS.create_worktree({
      db: handle.db,
      item: story(),
      prepareWorkspace: async () => ({ ok: false as const, reason: "Two dependencies are equidistant.", options: ["REPO-2", "REPO-3"] }),
      report: () => {},
      runId,
    });

    expect(outcome).toMatchObject({ ok: false, options: ["REPO-2", "REPO-3"] });
  });

  it("hands the worktree its run's cancellation, which is where the slow part is", async () => {
    // Cutting the branch is local and instant; deciding what to cut it
    // *from* fetches the base branch and may ask a forge about every
    // same-feature dependency. Until the signal reached `prepareWorkspace`
    // those carried on against a run the board had already called
    // cancelled — `cancelRun` looked like it worked and stopped nothing.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    await BUILTIN_RUNNERS.create_worktree({
      db: handle.db,
      item: story(),
      prepareWorkspace: async (item, _action, options) => {
        seen = options?.signal;
        return preparedIn(item, "/tmp/eo/worktree");
      },
      report: () => {},
      runId,
      signal: controller.signal,
    });

    expect(seen).toBe(controller.signal);
  });

  it("reports `indexed` once the checkout has been described", async () => {
    const outcome = await indexStep();

    expect(outcome).toMatchObject({ ok: true, result: "indexed" });
    expect(BUILTIN_RESULTS.index_repository).toContain(outcome.ok ? outcome.result : "");
  });

  it("reports `skipped` rather than failing when the feature is switched off", async () => {
    // Null from the factory is the gate saying no, and it has to be an
    // ordinary result: a rollout switch that parked every item would
    // be worse than the feature it was protecting against.
    const outcome = await createBuiltinRunners(undefined, undefined, () => null).index_repository({
      db: handle.db,
      item: story(),
      prepareWorkspace: preparingAt("/tmp/eo/worktree"),
      report: () => {},
      runId,
    });

    expect(outcome).toMatchObject({ ok: true, result: "skipped" });
    expect(BUILTIN_RESULTS.index_repository).toContain(outcome.ok ? outcome.result : "");
  });

  it("reports `skipped` for an item with no repository to describe", async () => {
    // `repository_indexes` is keyed on a workspace, so there is nothing
    // to write a row about. A fact about the item, not a failure.
    const outcome = await indexStep({ workspaceId: null });

    expect(outcome).toMatchObject({ ok: true, result: "skipped" });
  });

  it("refuses, rather than claiming an index it does not have, when the build fell over", async () => {
    const outcome = await indexStep({ build: { ok: false, reason: "The index tool exited without producing an index." } });

    // A refusal carries the reason a result key cannot, and the
    // supervisor is what turns it into a comment and a route. The
    // shipped pipeline sends it onward, because an agent without an
    // index still has the tools it always had.
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("without producing an index") });
  });

  it("repeats one bounded line of a provider's reason and no more", async () => {
    // The other half of the multi-line case in `indexStep.test.ts`: a
    // single line long enough to be a file rather than a sentence. Both
    // are the same rule — EO says what went wrong, it does not republish
    // whatever a third-party binary decided to print.
    const flood = `The parser stopped. ${"x".repeat(4000)}`;
    const outcome = await indexStep({ build: { ok: false, reason: flood } });

    const reason = outcome.ok ? "" : outcome.reason;
    expect(reason).toContain("The parser stopped.");
    expect(reason.length).toBeLessThan(flood.length);
    expect(reason.length).toBeLessThanOrEqual(501);
  });

  it("refuses the same way when no binary could be had for this machine", async () => {
    // The degradation path that is not hypothetical: upstream publishes
    // no build for Intel Macs, so this is what those run every time.
    const outcome = await indexStep({ installed: { ok: false, reason: "publishes no build for Intel Macs (darwin x64)" } });

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("darwin x64") });
  });

  it("reports `opened` once the pull request is actually open", async () => {
    // Not once it is queued (EO-77). The step's result is what happened.
    const outcome = await pullRequestStep(async () => ({ kind: "opened", detail: "Opened https://forge.example/pr/1" }));

    expect(outcome).toMatchObject({ ok: true, result: "opened", detail: expect.stringContaining("pr/1") });
    expect(BUILTIN_RESULTS.open_pull_request).toContain(outcome.ok ? outcome.result : "");
  });

  it("reports `skipped` for work that has no pull request to open", async () => {
    // A feature carries no code changes of its own, so a PR for one is
    // always doomed — and saying `skipped` is the improvement over a
    // item that simply never got one.
    const outcome = await pullRequestStep(async () => ({ kind: "skipped", detail: "A feature has no changes of its own." }));

    expect(outcome).toMatchObject({ ok: true, result: "skipped" });
    expect(BUILTIN_RESULTS.open_pull_request).toContain(outcome.ok ? outcome.result : "");
  });

  it("refuses when the forge would not open one, rather than reporting one it did not open", async () => {
    const outcome = await pullRequestStep(async () => ({ kind: "failed", reason: "`gh` is not on PATH." }));

    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("not on PATH") });
  });

  it("passes the cancellation signal through to the forge, which is the builtin that can sit there", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await pullRequestStep(async (_db, _item, options) => {
      seen = options?.signal;
      return { kind: "skipped", detail: "" };
    }, controller.signal);

    expect(seen).toBe(controller.signal);
  });
});
