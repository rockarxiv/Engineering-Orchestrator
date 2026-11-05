import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { createRoute, createStep, getItem, listRunEvents, listRunsForItem } from "../../../db/repos/index.js";
import { getRepositoryIndex } from "../../../db/repos/repositoryIndexesRepo.js";
import { comments, pipelineSteps, stepRoutes } from "../../../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { createRoleWiring } from "../wiring.js";
import { createBuiltinRunners } from "../builtins.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { samePath } from "../workspace/git.js";
import { writeRepositoryIntelligenceConfig } from "./gate.js";
import { repositoryIntelligenceFor, type RepositoryIntelligenceFactory } from "./composition.js";
import type {
  RepositoryIndexBuild,
  RepositoryIndexProbe,
  RepositoryIndexQueryServer,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "./port.js";
import { createRepositoryIntelligenceService } from "./service.js";
import { fakeWorkspaceKind, installedKinds, kindsPreparing, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";

/**
 * Indexing as a step on the pipeline (EO-149).
 *
 * The story this file is really about is degradation. Everything else
 * here — the row, the transcript, the routing — is ordinary builtin
 * machinery already proven in `builtinSteps.test.ts`; what is new and
 * what nothing else can check is that a repository index which cannot
 * be built leaves the item exactly as workable as it was before this
 * feature existed. EO-141 states that as a requirement rather than a
 * preference, and an Intel Mac is a real instance of it and not a
 * hypothetical: upstream publishes no build for that machine at all.
 *
 * **Everything is driven through the real supervisor.** The routing,
 * the comment, the run status and the transcript are all things
 * `runBuiltinHeld` does with what the runner returned, and a test that
 * called the runner directly would be asserting its own arrangement of
 * them. `builtins.test.ts` covers the runner in isolation, which is the
 * other half.
 *
 * **The provider is faked, and faked at the port.** Not at the process
 * boundary and not by importing the real implementation — the
 * architectural invariant beside this file forbids a test outside
 * `codewiki/` from reaching one, and it forbids it for a reason worth
 * restating: a test that reaches past the port is where a
 * provider-specific assumption gets written down, and from there copied
 * into production code that has to satisfy it. What is under the port
 * has its own tests where the binary is real.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * Where the fake provider writes, and what it calls what it writes.
 *
 * Its own names rather than the shipped implementation's, which is not
 * fussiness: the port says a provider owns its layout, so a fake that
 * borrowed a real directory name would let something above the port
 * quietly depend on it and still pass (EO-163). Nothing in the step, the
 * service or the row composes these — they only ever come back from the
 * provider.
 */
const FAKE_INDEX_DIR = ".fake-index";
const FAKE_INDEX_DATABASE = "index.db";

let handle: DbHandle;
let workspaceRoot: string;

/** A stand-in for whatever actually describes a checkout. */
interface FakeProviderOptions {
  /** Refuses every build with this sentence, the way an absent binary does. */
  refuse?: string;
  /** Told the target of every call, in order, so isolation can be asserted. */
  seen?: RepositoryIndexTarget[];
  /** Blocks the build until resolved, so a cancel can arrive mid-flight. */
  gate?: Promise<void>;
  /** What the checkout's HEAD is said to be. */
  sha?: string;
  version?: string;
}

/**
 * A provider that writes a real file where a real one would.
 *
 * It writes rather than pretending to because two of this story's
 * criteria are about *where* the bytes land — a populated index under
 * the worktree, and two items never touching each other's — and a
 * recorded call proves neither. The path is composed the way the port
 * says it is: from the target's own workspace, by the provider.
 */
function fakeProvider(options: FakeProviderOptions = {}): RepositoryIntelligenceProvider {
  const indexPathFor = (target: RepositoryIndexTarget): string => join(target.workspacePath, FAKE_INDEX_DIR);
  const version = options.version ?? "9.9.9";

  const build = async (target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> => {
    options.seen?.push(target);
    if (options.gate) await options.gate;
    if (options.refuse !== undefined) return { ok: false, reason: options.refuse };

    const directory = indexPathFor(target);
    mkdirSync(directory, { recursive: true });
    // Named for the item so a test can tell whose index it is reading,
    // which is the whole of the concurrency assertion below.
    writeFileSync(join(directory, FAKE_INDEX_DATABASE), `index of ${target.workspacePath}`);
    return { ok: true, indexPath: directory, providerVersion: version, indexedCommitSha: options.sha ?? null, durationMs: 1 };
  };

  const probe = async (target: RepositoryIndexTarget): Promise<RepositoryIndexProbe> => ({
    present: existsSync(join(indexPathFor(target), FAKE_INDEX_DATABASE)),
    indexPath: indexPathFor(target),
    providerVersion: options.refuse === undefined ? version : null,
    indexedCommitSha: options.sha ?? null,
    unavailableReason: options.refuse ?? null,
  });

  return {
    id: "codewiki",
    initialize: build,
    sync: build,
    ensureReady: build,
    rebuild: build,
    getStatus: probe,
    getAgentMcpConfig: async (): Promise<RepositoryIndexQueryServer | null> => null,
    remove: async (): Promise<RepositoryIndexRemoval> => ({ ok: true }),
  };
}

/**
 * The factory the step is handed, standing in for the composition root.
 *
 * `signal` is threaded through exactly as production threads it, because
 * the cancellation criterion is about that thread and nothing else: what
 * happens to the process once the signal fires belongs to the runner
 * under the port, which is tested where the process is real.
 */
function intelligenceWith(provider: RepositoryIntelligenceProvider, installed: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const signals: (AbortSignal | undefined)[] = [];
  const factory: RepositoryIntelligenceFactory = ({ db, signal }) => {
    signals.push(signal);
    return { service: createRepositoryIntelligenceService({ db, provider }), ensureInstalled: async () => installed };
  };
  return { factory, signals };
}

/** A story sitting on the index step, with a worktree already cut for it. */
function storyOnIndexStep(name: string): { item: Item; workspace: string } {
  const repository = attachWorkspace(handle.db, { name, keyPrefix: name.toUpperCase(), repoPath: join(workspaceRoot, `${name}-repo`) });
  const item = createTestItem(handle.db, { type: "story", title: `Rate limit ${name}`, stepId: "repository_index", workspaceId: repository.id });
  const workspace = join(workspaceRoot, name);
  mkdirSync(workspace, { recursive: true });
  return { item, workspace };
}

/**
 * The workspace preparation the step shares with every other dispatch,
 * pinned to a directory this test owns.
 *
 * Substituted rather than run for real because `git worktree add` is
 * `create_worktree`'s subject and not this one's; what matters here is
 * that the step indexes the checkout it was handed.
 */
function withWorkspace(intelligence: RepositoryIntelligenceFactory, workspaces: Map<string, string>) {
  const supervisor = createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach an agent provider"); } } as never,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    kinds: installedKinds(
      fakeWorkspaceKind({
        prepare: async (item) => {
          const cwd = workspaces.get(item.id);
          return cwd ? preparedIn(item, cwd) : { ok: false as const, reason: "no workspace" };
        },
      }),
    ),
    builtins: createBuiltinRunners(undefined, undefined, intelligence),
  });
  return supervisor;
}

function engineComments(itemId: Uuid): { kind: string; body: string }[] {
  return handle.db
    .select()
    .from(comments)
    .all()
    .filter((row) => row.itemId === itemId && row.authorType === "engine")
    .map((row) => ({ kind: row.kind, body: row.body }));
}

function transcriptOf(itemId: Uuid): string {
  const runs = listRunsForItem(handle.db, itemId).filter((run) => run.action === "index_repository");
  return runs.flatMap((run) => listRunEvents(handle.db, run.id)).map((event) => JSON.stringify(event.payload)).join("\n");
}

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceRoot = mkdtempSync(join(tmpdir(), "eo-index-step-"));
  writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
});

afterEach(() => {
  handle.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("the index step, with the feature on", () => {
  it("leaves a populated index in the worktree before the implementer is dispatched", async () => {
    const { item, workspace } = storyOnIndexStep("alpha");
    const { factory } = intelligenceWith(fakeProvider({ sha: "abc123def456789" }));

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    // The file exists and has something in it — "populated", not merely
    // created, because an empty database is what a build that fell over
    // half way leaves behind.
    const database = join(workspace, FAKE_INDEX_DIR, FAKE_INDEX_DATABASE);
    expect(existsSync(database)).toBe(true);
    expect(readFileSync(database, "utf8").length).toBeGreaterThan(0);
    // And the item is only now on the implementer's step, which is the
    // ordering the criterion is really about.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("records the revision, the provider and its version on the row", async () => {
    const { item, workspace } = storyOnIndexStep("beta");
    const { factory } = intelligenceWith(fakeProvider({ sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736", version: "0.2.1" }));

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    const row = getRepositoryIndex(handle.db, { workspaceId: item.workspaceId!, itemId: item.id });
    expect(row?.status).toBe("ready");
    expect(row?.indexedCommitSha).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f009182736");
    expect(row?.provider).toBe("codewiki");
    expect(row?.providerVersion).toBe("0.2.1");
  });

  it("narrates what it is doing into the run's own transcript", async () => {
    const { item, workspace } = storyOnIndexStep("gamma");
    const { factory } = intelligenceWith(fakeProvider());

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    // Through `report`, so it is `output` rows on `run_events` — which is
    // what the run's event panel reads. Before this the panel for a
    // builtin said "No events recorded for this run".
    const [run] = listRunsForItem(handle.db, item.id).filter((entry) => entry.action === "index_repository");
    const events = listRunEvents(handle.db, run!.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "output")).toBe(true);
    // Compare the path as a path. Serialising the payload first doubles
    // Windows separators, and Windows may independently spell the same
    // directory with its 8.3 alias.
    const narrated = events
      .map((event) => event.payload)
      .find((payload): payload is { type: "output"; text: string } => {
        if (typeof payload !== "object" || payload === null) return false;
        const value = payload as { type?: unknown; text?: unknown };
        return value.type === "output" && typeof value.text === "string" && value.text.startsWith("Indexing ");
      });
    expect(narrated).toBeDefined();
    expect(samePath(narrated!.text.slice("Indexing ".length, -1), workspace)).toBe(true);
  });

  it("never writes a line of anybody's source into a run event", async () => {
    const { item, workspace } = storyOnIndexStep("delta");
    const secret = "const API_KEY = 'sk-live-do-not-log-me';";
    writeFileSync(join(workspace, "secrets.ts"), secret);
    // A provider that has stopped behaving, in the exact shape a real
    // one misbehaves: the diagnosis on the first line and the offending
    // source quoted underneath it. An earlier version of this test put
    // the secret in the worktree and a *benign* sentence in the
    // provider, so nothing it asserted could ever have failed — the
    // secret had no path to an event at all.
    const leaky = [
      "EO could not build the repository index: the parser stopped.",
      "  --> secrets.ts:1",
      `  ${secret}`,
    ].join("\n");
    const { factory } = intelligenceWith(fakeProvider({ refuse: leaky }));

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    // Asserted on everything this step wrote — transcript and comment
    // both, since a refusal reaches each of them.
    const written = transcriptOf(item.id) + engineComments(item.id).map((comment) => comment.body).join("\n");
    expect(written).not.toContain(secret);
    expect(written).not.toContain("sk-live");
    // And the person is still told what went wrong. A guard that
    // achieved silence would pass the assertion above and fail the
    // item, so the diagnosis has to survive the same call that drops
    // the quotation.
    expect(written).toContain("the parser stopped");
  });
});

describe("the index step, when there is no index to be had", () => {
  it("records the failure, says so in a comment, and sends the item on anyway", async () => {
    const { item, workspace } = storyOnIndexStep("epsilon");
    const { factory } = intelligenceWith(fakeProvider({ refuse: "The index tool exited without producing an index." }));

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    // FAILED on the row, carrying the captured reason...
    const row = getRepositoryIndex(handle.db, { workspaceId: item.workspaceId!, itemId: item.id });
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("without producing an index");

    // ...a comment naming what went wrong (invariant #8)...
    const [comment] = engineComments(item.id);
    expect(comment?.body).toContain("without producing an index");

    // ...and the item carries on to the implementer regardless, which
    // is the whole degradation promise. A note rather than an
    // escalation: the pipeline has already said who picks this up, so
    // raising `!` would interrupt somebody about an item that is
    // already moving.
    expect(comment?.kind).toBe("note");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("treats a binary that cannot exist on this machine the same way, and names the platform", async () => {
    const { item, workspace } = storyOnIndexStep("zeta");
    // What resolution answers on an Intel Mac: no build is published, so
    // nothing is ever going to download and there is no error to report.
    const unsupported = "CodeWiki 0.2.1 publishes no build for Intel Macs (darwin x64), so repository intelligence is unavailable on this machine.";
    const { factory } = intelligenceWith(fakeProvider(), { ok: false, reason: unsupported });

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    const [comment] = engineComments(item.id);
    expect(comment?.body).toContain("darwin x64");
    expect(comment?.kind).toBe("note");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    // And the reason is written down rather than living only in that
    // comment. This is the half an item-shaped record cannot carry: a
    // machine with no build published for it fails identically on every
    // repository forever, and the status screen has to be able to say
    // why without going hunting through somebody's item thread.
    const row = getRepositoryIndex(handle.db, { workspaceId: item.workspaceId!, itemId: item.id });
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("darwin x64");
    // Nothing was built, though — a recorded failure is not a claim
    // that anything reached the disk.
    expect(existsSync(join(workspace, FAKE_INDEX_DIR))).toBe(false);
  });

  it("hands the run's cancellation to whatever is doing the work", async () => {
    const { item, workspace } = storyOnIndexStep("eta");
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, signals } = intelligenceWith(fakeProvider({ gate }));

    const supervisor = withWorkspace(factory, new Map([[item.id, workspace]]));
    const running = supervisor.runOnce();
    // Let the dispatch reach the provider before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [run] = listRunsForItem(handle.db, item.id).filter((entry) => entry.action === "index_repository");
    supervisor.cancelRun(run!.id);
    release();
    await running;

    // The signal the supervisor registered for this run is the one the
    // provider was built with. That is the whole chain: the process it
    // spawns is killed by the runner watching this signal, which is
    // tested where a process is real.
    expect(signals[0]).toBeDefined();
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("the index step, as a row in a pipeline", () => {
  it("is a no-op with the feature off: no row, no index, nothing fetched", async () => {
    writeRepositoryIntelligenceConfig(handle.db, { enabled: false });
    const { item, workspace } = storyOnIndexStep("theta");
    // The *real* composition root, wired as production wires it. A stub
    // returning null would only prove that the step handles null; what
    // has to hold is that the shipped path reads the gate and stops
    // before it resolves a binary, spawns anything or opens a socket.
    const forbidden: RepositoryIntelligenceFactory = (options) =>
      repositoryIntelligenceFor({
        ...options,
        root: join(workspaceRoot, "never-used"),
        fetchImpl: () => {
          throw new Error("nothing may be fetched with the feature off");
        },
      });

    await withWorkspace(forbidden, new Map([[item.id, workspace]])).runOnce();

    expect(getRepositoryIndex(handle.db, { workspaceId: item.workspaceId!, itemId: item.id })).toBeUndefined();
    expect(existsSync(join(workspace, FAKE_INDEX_DIR))).toBe(false);
    // And the item moves on exactly as it would have, because a step
    // that does nothing must not be a step that stops anything.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(engineComments(item.id)).toEqual([]);
  });

  it("can be deleted from the pipeline, and everything else still works", async () => {
    // Exactly what a person does in the configuration screen: re-point
    // the route that fed it, then drop the step and its own routes.
    handle.db.update(stepRoutes).set({ target: "todo" }).where(eq(stepRoutes.id, "r_worktree_ready")).run();
    handle.db.delete(stepRoutes).where(eq(stepRoutes.fromStepId, "repository_index")).run();
    handle.db.delete(pipelineSteps).where(eq(pipelineSteps.id, "repository_index")).run();

    const repository = attachWorkspace(handle.db, { name: "iota", keyPrefix: "IOTA", repoPath: join(workspaceRoot, "iota-repo") });
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit iota", stepId: "worktree", workspaceId: repository.id });
    const { factory } = intelligenceWith(fakeProvider());

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a builtin must not reach an agent provider"); } } as never,
      ...createRoleWiring(handle.db),
      limits: LIMITS,
      kinds: kindsPreparing(workspaceRoot),
      builtins: createBuiltinRunners(undefined, undefined, factory),
    });
    await supervisor.runOnce();

    // The worktree step ran and routed straight past where the index
    // used to be. No run was minted for a step that is not there, and
    // nothing anywhere failed looking for it.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["create_worktree"]);
  });

  it("can be added back to a pipeline without a line of TypeScript", async () => {
    // Invariant #7, and the reason the step exists as a row rather than
    // as a few lines inside the worktree builtin. Strip the shipped step
    // out first, so what is asserted is a pipeline that has never had
    // one gaining it — under a step id and name of somebody's own
    // choosing, with nothing but inserts.
    const pipelineId = "default" as Uuid;
    handle.db.update(stepRoutes).set({ target: "todo" }).where(eq(stepRoutes.id, "r_worktree_ready")).run();
    handle.db.delete(stepRoutes).where(eq(stepRoutes.fromStepId, "repository_index")).run();
    handle.db.delete(pipelineSteps).where(eq(pipelineSteps.id, "repository_index")).run();

    // Two rows and three routes. Exactly what the configuration screen
    // writes, and exactly what an exported pipeline would carry.
    createStep(handle.db, { id: "second_look", pipelineId, position: 6, name: "Second look", type: "builtin", entryAction: "index_repository" });
    for (const [index, key] of ["indexed", "skipped", "failed"].entries()) {
      createRoute(handle.db, { pipelineId, fromStepId: "second_look", resultKey: key, label: key, target: "todo", position: index });
    }
    handle.db.update(stepRoutes).set({ target: "second_look" }).where(eq(stepRoutes.id, "r_worktree_ready")).run();

    const repository = attachWorkspace(handle.db, { name: "mu", keyPrefix: "MU", repoPath: join(workspaceRoot, "mu-repo") });
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit mu", stepId: "second_look", workspaceId: repository.id });
    const workspace = join(workspaceRoot, "mu");
    mkdirSync(workspace, { recursive: true });
    const { factory } = intelligenceWith(fakeProvider());

    await withWorkspace(factory, new Map([[item.id, workspace]])).runOnce();

    // It ran under a name nothing in the source has ever heard of, and
    // routed on the result it declared.
    expect(existsSync(join(workspace, FAKE_INDEX_DIR, FAKE_INDEX_DATABASE))).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });
});

describe("two items indexing at once", () => {
  it("each writes only into its own worktree", async () => {
    const first = storyOnIndexStep("kappa");
    const second = storyOnIndexStep("lambda");
    const seen: RepositoryIndexTarget[] = [];
    const { factory } = intelligenceWith(fakeProvider({ seen }));
    const workspaces = new Map([
      [first.item.id, first.workspace],
      [second.item.id, second.workspace],
    ]);

    // Genuinely at the same time. Concurrency is 1 for dispatch
    // (invariant #10), so this drives both steps directly rather than
    // waiting for two ticks — the isolation being asserted is a property
    // of the paths, and it has to hold whatever the scheduler does.
    const supervisor = withWorkspace(factory, workspaces);
    await Promise.all([supervisor.runOnce(), supervisor.runOnce()]);

    // Nothing was indexed twice and nothing was indexed under the wrong
    // root — the isolation is free because each index is composed from
    // the target's own workspace rather than shared and copied.
    expect(seen.map((target) => target.workspacePath).sort()).toEqual([first.workspace, second.workspace].sort());
    expect(readFileSync(join(first.workspace, FAKE_INDEX_DIR, FAKE_INDEX_DATABASE), "utf8")).toContain(first.workspace);
    expect(readFileSync(join(second.workspace, FAKE_INDEX_DIR, FAKE_INDEX_DATABASE), "utf8")).toContain(second.workspace);
    // The rows are per item too, so neither reads the other's status.
    const rows = [first, second].map((each) => getRepositoryIndex(handle.db, { workspaceId: each.item.workspaceId!, itemId: each.item.id }));
    expect(rows.map((row) => row?.indexPath)).toEqual([join(first.workspace, FAKE_INDEX_DIR), join(second.workspace, FAKE_INDEX_DIR)]);
  });
});
