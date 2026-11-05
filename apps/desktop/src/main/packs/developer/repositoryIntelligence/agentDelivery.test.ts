import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentProvider, type RepositoryIndexAnswers, type RepositoryMcpServer, type Item, type Uuid, UNSCOPED_RUN } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAttachmentsHash } from "../../../agentAttachments/fingerprint.js";
import type { DbHandle } from "../../../db/client.js";
import {
  createRun,
  deleteRepositoryIndexesForItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  updateRun,
} from "../../../db/repos/index.js";
import { recordRepositoryIndex } from "../../../db/repos/repositoryIndexesRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { promptHash } from "../../../roles/prompts.js";
import { createRoleWiring } from "../wiring.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { findReusableThread } from "../../../supervisor/threadReuse.js";
import { repositoryQueryServerFor } from "./agentServer.js";
import { writeRepositoryIntelligenceConfig } from "./gate.js";
import type { RepositoryIntelligenceFactory } from "./composition.js";
import type {
  RepositoryIndexBuild,
  RepositoryIndexProbe,
  RepositoryIndexQueryServer,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "./port.js";
import { createRepositoryIntelligenceService } from "./service.js";
import { fakeWorkspaceKind, installedKinds, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";
import { gitWorkspaceKind } from "../workspace/gitKind.js";

/**
 * Giving an agent the repository intelligence server, from the dispatch
 * that decides to the backend that is handed it (EO-151).
 *
 * The adapters are asserted where they are — `providers/claude.test.ts`
 * and `providers/codex.test.ts` each check what reaches their own
 * server map, which is how EO's `eo` service has always been checked.
 * This file is the half neither of those can see: *which* dispatches get
 * one, pointed at *whose* checkout, and what a person is told on a run
 * that goes without.
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

/** What the reviewer returns when it approves — `ReviewOutputSchema`'s approve branch. */
const REVIEW_APPROVAL = { verdict: "approve", feedback: "Reads well." };

let handle: DbHandle;
let workspaceRoot: string;
/** What each turn was handed, in order — the whole subject of this file. */
let turns: { kind: "start" | "resume"; cwd: string | undefined; repositoryMcp: RepositoryMcpServer | undefined }[];

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceRoot = mkdtempSync(join(tmpdir(), "eo-repo-mcp-"));
  writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
  turns = [];
});

afterEach(() => {
  handle.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/**
 * A stand-in for whatever describes a checkout.
 *
 * `getAgentMcpConfig` composes the server from the target's own
 * workspace, which is what the real one does and the only part of it
 * this file depends on: the path is the provider's to build, and a
 * caller never composes one.
 */
function fakeProvider(
  options: {
    indexed?: Set<string>;
    refuse?: string;
    command?: string;
    answers?: RepositoryIndexAnswers;
    /**
     * The indexer as resolved on this machine, mutable so a test can
     * move it out from under an index that is already built — which is
     * the whole of a version skew, and one of the three ways an index
     * stops being queryable mid-item (EO-177).
     */
    version?: { value: string };
    /** A build that falls over on a machine that can index perfectly well. */
    buildFails?: string;
    /** Every build this provider was asked for, by name and in order. */
    asked?: string[];
  } = {},
): RepositoryIntelligenceProvider {
  const indexed = options.indexed ?? new Set<string>();
  const version = options.version ?? { value: "9.9.9" };
  const indexPathFor = (target: RepositoryIndexTarget): string => join(target.workspacePath, ".index");

  const build =
    (name: string) =>
    async (target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> => {
      options.asked?.push(name);
      if (options.refuse !== undefined) return { ok: false, reason: options.refuse };
      if (options.buildFails !== undefined) return { ok: false, reason: options.buildFails };
      indexed.add(target.workspacePath);
      return { ok: true, indexPath: indexPathFor(target), providerVersion: version.value, indexedCommitSha: null };
    };

  return {
    id: "codewiki",
    initialize: build("initialize"),
    sync: build("sync"),
    ensureReady: build("ensureReady"),
    rebuild: build("rebuild"),
    getStatus: async (target): Promise<RepositoryIndexProbe> => ({
      present: indexed.has(target.workspacePath),
      indexPath: indexPathFor(target),
      providerVersion: options.refuse === undefined ? version.value : null,
      indexedCommitSha: null,
      unavailableReason: options.refuse ?? null,
    }),
    getAgentMcpConfig: async (target): Promise<RepositoryIndexQueryServer | null> =>
      indexed.has(target.workspacePath)
        ? {
            name: "repo",
            command: options.command ?? "/opt/eo/index-tool",
            // Composed from this target's own workspace and nothing
            // else, exactly as the real provider composes it. This is
            // what the isolation assertion below actually reads.
            args: ["serve", "--mcp", "--path", target.workspacePath, "--no-watch"],
            env: {},
            ...(options.answers ? { answers: options.answers } : {}),
          }
        : null,
    remove: async (): Promise<RepositoryIndexRemoval> => ({ ok: true }),
  };
}

function factoryFor(provider: RepositoryIntelligenceProvider): RepositoryIntelligenceFactory {
  return ({ db }) => ({ service: createRepositoryIntelligenceService({ db, provider }), ensureInstalled: async () => ({ ok: true as const }) });
}

/**
 * The service behind a factory, for the arranging half of these tests.
 *
 * A factory answers `null` when the feature is off, and every use here
 * is on the arrange side where it is deliberately on — so this narrows
 * once rather than at nine call sites.
 */
function serviceOf(factory: RepositoryIntelligenceFactory) {
  const runtime = factory({ db: handle.db });
  if (runtime === null) throw new Error("the factory answered null with the feature on");
  return runtime.service;
}

/** The index the `index_repository` step would have left behind. */
async function indexed(factory: RepositoryIntelligenceFactory, item: Item, workspace: string): Promise<void> {
  const outcome = await serviceOf(factory).ensureIndexed({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace });
  if (!outcome.ok) throw new Error(outcome.reason);
}

/** The gate, answered honestly: null is the feature being off. */
const gatedFactory = (provider: RepositoryIntelligenceProvider): RepositoryIntelligenceFactory => {
  const inner = factoryFor(provider);
  return (options) => (writeRepositoryIntelligenceConfig(handle.db, {}).enabled ? inner(options) : null);
};

/**
 * A provider that records what each turn was handed and answers with
 * the next scripted result.
 *
 * One result per `start`, in order, because a tick can carry an item
 * through more than one step and the reviewer's shape is not the
 * implementer's — a single canned result would be re-prompted and
 * escalated at the second step, which is a failure about fixtures rather
 * than about delivery. A `resume` re-answers with the last one, which is
 * what a corrective turn is being asked for.
 */
function recording(...results: unknown[]): AgentProvider {
  const scripted = results.length > 0 ? [...results] : [validImplementResult];
  let last: unknown = scripted[0];
  function replay(result: unknown): AsyncIterable<AgentEvent> {
    return (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      yield { type: "result", data: result };
    })();
  }
  return {
    start: (opts) => {
      turns.push({ kind: "start", cwd: opts.cwd, repositoryMcp: opts.repositoryMcp });
      last = scripted.length > 1 ? scripted.shift() : scripted[0];
      return replay(last);
    },
    resume: (_threadId, _message, opts) => {
      turns.push({ kind: "resume", cwd: opts?.cwd, repositoryMcp: opts?.repositoryMcp });
      return replay(last);
    },
  };
}

function storyWithWorktree(name: string): { item: Item; workspace: string } {
  const repository = attachWorkspace(handle.db, { name, keyPrefix: name.toUpperCase(), repoPath: join(workspaceRoot, `${name}-repo`) });
  const item = createTestItem(handle.db, { type: "story", title: `Rate limit ${name}`, stepId: "todo", workspaceId: repository.id, spec: REVIEWABLE_SPEC });
  return { item, workspace: join(workspaceRoot, name) };
}

/**
 * The same, with the checkout on disk — which is what a dispatch in
 * production always has and what the repair requires (EO-177).
 *
 * Most of this file works from a path that was never created, because
 * most of it is about which server a dispatch is handed and none of that
 * reads the filesystem. The rebuild does: it will not start an indexer
 * against a directory that is not there, so the tests about it have to
 * put one there.
 */
function storyOnDisk(name: string): { item: Item; workspace: string } {
  const story = storyWithWorktree(name);
  mkdirSync(story.workspace, { recursive: true });
  return story;
}

function supervisorFor(
  intelligence: RepositoryIntelligenceFactory,
  workspaces: Map<string, string>,
  provider: AgentProvider = recording(),
) {
  return createRunSupervisor({
    db: handle.db,
    provider,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    // The same wiring `createEngine` uses in production: the git kind's
    // own `attach`, over a workspace this test decides.
    kinds: installedKinds(
      fakeWorkspaceKind({
        prepare: async (item) => {
          const cwd = workspaces.get(item.id);
          return cwd ? preparedIn(item, cwd) : { ok: false as const, reason: "no workspace" };
        },
        attach: gitWorkspaceKind({ db: handle.db, intelligenceFor: intelligence }).attach,
      }),
    ),
  });
}

const engineNotes = (itemId: Uuid): string[] =>
  listCommentsForItem(handle.db, itemId)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

describe("which dispatches receive the query server", () => {
  /**
   * The criterion, and it is about roles rather than about one agent.
   *
   * Nothing in the delivery path asks who is being dispatched — a
   * dispatch whose item has a ready index gets the server — which is
   * why both of the two code-bearing roles get it without either being
   * named anywhere. The alternative, a list of roles that may query,
   * would be a list to keep in step with a pipeline that is data.
   */
  it("gives it to the implementer and to the reviewer alike", async () => {
    const { item, workspace } = storyWithWorktree("alpha");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), recording(validImplementResult, REVIEW_APPROVAL));
    // The implementer, then the reviewer the route sends the item to.
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review"]);
    // Every turn, not merely the first: a corrective turn respawns the
    // backend, and one built without the server would take the index
    // away between asking for a result and asking for it to be fixed.
    expect(turns.length).toBeGreaterThanOrEqual(2);
    for (const turn of turns) {
      expect(turn.repositoryMcp?.name).toBe("repo");
      expect(turn.repositoryMcp?.args).toEqual(["serve", "--mcp", "--path", workspace, "--no-watch"]);
    }
  });

  /**
   * The isolation criterion, and the reason it is free rather than
   * engineered.
   *
   * Each item is indexed in its own worktree and the server is pointed
   * at that worktree with `--path`. There is no shared index, and no
   * second path an agent could be pointed at — so an agent on one item
   * cannot reach another's because there is nothing to reach it through,
   * not because something refused.
   */
  it("points each item's agent at its own checkout and no other", async () => {
    const alpha = storyWithWorktree("alpha");
    const beta = storyWithWorktree("beta");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, alpha.item, alpha.workspace);
    await indexed(factory, beta.item, beta.workspace);

    await supervisorFor(
      factory,
      new Map([
        [alpha.item.id, alpha.workspace],
        [beta.item.id, beta.workspace],
      ]),
      recording(validImplementResult),
    ).runOnce();

    const paths = turns.map((turn) => turn.repositoryMcp?.args.join(" ") ?? "");
    // Both items were dispatched and each names its own worktree.
    expect(paths.filter((argv) => argv.includes(alpha.workspace)).length).toBeGreaterThan(0);
    expect(paths.filter((argv) => argv.includes(beta.workspace)).length).toBeGreaterThan(0);
    // And no agent was ever handed a path into the other's checkout,
    // which is the assertion that actually matters: `--path` is the
    // whole of what an agent's index can see.
    for (const argv of paths) {
      expect(argv.includes(alpha.workspace) && argv.includes(beta.workspace)).toBe(false);
    }
  });

  it("passes `--no-watch`, so EO's own syncs are the only writes to the index", async () => {
    const { item, workspace } = storyWithWorktree("gamma");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    // Load-bearing rather than incidental: without it the server runs a
    // debounced file watcher that writes to the index on every save,
    // which would race EO's deterministic syncs and make it impossible
    // to say what the reviewer actually saw.
    expect(turns[0]?.repositoryMcp?.args).toContain("--no-watch");
  });

  it("gives nothing and says nothing with the feature off", async () => {
    const { item, workspace } = storyWithWorktree("delta");
    writeRepositoryIntelligenceConfig(handle.db, { enabled: false });

    await supervisorFor(gatedFactory(fakeProvider()), new Map([[item.id, workspace]])).runOnce();

    expect(turns[0]?.repositoryMcp).toBeUndefined();
    // Silence is the whole rollout promise: with the switch off,
    // dispatch is what it was before any of this shipped. A comment on
    // every run in EO would not be that.
    expect(engineNotes(item.id)).toEqual([]);
  });

  it("gives nothing and says nothing on an item with no repository", async () => {
    // A feature carries none, and an index is keyed on one. Nothing is
    // missing: there is no checkout to describe.
    const item = createTestItem(handle.db, { type: "story", title: "No repository", stepId: "todo" });

    await supervisorFor(factoryFor(fakeProvider()), new Map([[item.id, join(workspaceRoot, "orphan")]])).runOnce();

    expect(turns[0]?.repositoryMcp).toBeUndefined();
    expect(engineNotes(item.id)).toEqual([]);
  });
});

/**
 * What a dispatch actually carries, once EO owns when the server ends
 * (EO-151).
 *
 * The wrapper's own behaviour is proven in
 * `mcp/superviseStdioServer.test.ts`, against real processes and each of
 * the three ways a run can end. This is the other half of that claim:
 * that the thing handed to a backend is the wrapped command rather than
 * the provider's own, so the guarantee reaches a real dispatch instead of
 * living in a test of a file nobody wired up.
 *
 * Applied once, where the server is resolved, so both adapters get it by
 * having asked for nothing — which is also why this is asserted here
 * rather than twice over in `claude.test.ts` and `codex.test.ts`.
 */
describe("the server a dispatch is handed", () => {
  const SUPERVISOR = "/opt/eo/superviseStdioServer.mjs";

  it("is the provider's command line behind EO's supervisor", async () => {
    const { item, workspace } = storyWithWorktree("supervised");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    const delivery = await repositoryQueryServerFor(factory, {
      db: handle.db,
      item,
      worktreePath: workspace,
      agentName: "Iris",
      superviseWith: SUPERVISOR,
    });

    expect(delivery.server).toEqual({
      name: "repo",
      // Electron is Node when told to be, so there is no second runtime
      // to install — the same trick `eoMcpStdioConfig` uses.
      command: process.execPath,
      args: [SUPERVISOR, "/opt/eo/index-tool", "serve", "--mcp", "--path", workspace, "--no-watch"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("still points at that item's checkout and nothing else", async () => {
    // The wrap must not disturb what the provider composed: `--path` is
    // the whole of what one item's agent can see, and a wrapper that
    // reordered or dropped an argument would be an agent querying the
    // wrong tree while every other test went on passing.
    const { item, workspace } = storyWithWorktree("supervised-path");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    const delivery = await repositoryQueryServerFor(factory, {
      db: handle.db,
      item,
      worktreePath: workspace,
      agentName: "Iris",
      superviseWith: SUPERVISOR,
    });

    // The provider's own argv, intact and in order, after the wrapper.
    expect(delivery.server?.args.slice(1)).toEqual(["/opt/eo/index-tool", "serve", "--mcp", "--path", workspace, "--no-watch"]);
    expect(delivery.server?.args).toContain("--no-watch");
  });

  it("carries the provider's vocabulary through the wrap (EO-165)", async () => {
    // The wrapper changes how the server is *started* and nothing about
    // what it answers. Dropping the vocabulary here would switch the
    // interception off in production — where the supervisor is always
    // configured — while leaving it on in every test that skips the
    // wrap, which is the worst possible place for a difference.
    const answers: RepositoryIndexAnswers = { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" };
    const { item, workspace } = storyWithWorktree("supervised-answers");
    const factory = factoryFor(fakeProvider({ answers }));
    await indexed(factory, item, workspace);

    const delivery = await repositoryQueryServerFor(factory, {
      db: handle.db,
      item,
      worktreePath: workspace,
      agentName: "Iris",
      superviseWith: SUPERVISOR,
    });

    expect(delivery.server?.answers).toEqual(answers);
  });

  it("is handed over untouched when no supervisor was configured", async () => {
    // A caller with no packaged resources still gets a working server —
    // the wrap is a guarantee added on top, not a condition of delivery.
    const { item, workspace } = storyWithWorktree("unsupervised");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    expect(delivery.server?.command).toBe("/opt/eo/index-tool");
    expect(delivery.server?.args[0]).toBe("serve");
  });
});

describe("a run whose index is not there", () => {
  it("runs anyway, and an engine comment says what is missing and why", async () => {
    const { item, workspace } = storyWithWorktree("epsilon");
    const provider = fakeProvider({ refuse: "EO has no build of the repository indexer for darwin-x64." });
    const factory = factoryFor(provider);
    // The step ran and failed, the way an unsupported platform makes it.
    await serviceOf(factory).recordUnavailable(
      { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace },
      "EO has no build of the repository indexer for darwin-x64.",
    );

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(turns[0]?.repositoryMcp).toBeUndefined();
    const notes = engineNotes(item.id);
    expect(notes.some((body) => body.includes("Repository intelligence is unavailable"))).toBe(true);
    // The reason, not just the fact: a person who reads "unavailable"
    // learns nothing they can act on.
    expect(notes.some((body) => body.includes("darwin-x64"))).toBe(true);
    // And it reads as one sentence. Half of these clauses are EO's own
    // and half are a provider's, written to stand alone — joined
    // carelessly they meet at two full stops.
    expect(notes.join("\n")).not.toContain("..");
    // And the run proceeded normally — degradation, not a block.
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
  });

  /**
   * A machine that cannot index anything, with nothing recorded about it
   * (EO-151).
   *
   * The realistic shape of this is an Intel Mac, where upstream
   * publishes no build at all — so it is a case that happens rather than
   * one imagined for a test — reaching a dispatch before the indexing
   * step has run on that item, or on a pipeline somebody removed the
   * step from, which invariant #7 exists to permit.
   *
   * With only the row to go on, EO said the index "has not been built
   * yet". That is true and useless: it reads as "run the step", and the
   * step would fail every time it ran. The person is owed the sentence
   * that is actually actionable, which is about their machine and not
   * about this item.
   */
  it("names the binary rather than the missing step when the machine cannot index at all", async () => {
    const { item, workspace } = storyWithWorktree("mu-platform");
    const factory = factoryFor(fakeProvider({ refuse: "EO has no build of the repository indexer for darwin-x64." }));
    // Deliberately no row of any kind: nothing has recorded a failure,
    // because nothing has been attempted.
    expect(serviceOf(factory).describe({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace })).toBeUndefined();

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    const notes = engineNotes(item.id).join("\n");
    expect(notes).toContain("darwin-x64");
    // And specifically *not* the sentence that sends somebody to add a
    // step, which is what this used to say.
    expect(notes).not.toContain("the indexing step has not run");
    // Degradation, not a block: the run went ahead regardless.
    expect(turns[0]?.repositoryMcp).toBeUndefined();
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("supersedes a row that promises a rebuild the machine cannot perform", async () => {
    // A `stale` row says "rebuild it", which is the right advice on a
    // machine that can. On one that cannot, it is a promise EO has no
    // way to keep — the same reasoning `resolveStatus` already applies
    // when it declines to call an unresolvable version skew.
    const { item, workspace } = storyWithWorktree("mu-stale");
    const factory = factoryFor(fakeProvider({ refuse: "EO has no build of the repository indexer for darwin-x64." }));
    const target = { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace };
    recordRepositoryIndex(handle.db, {
      workspaceId: target.workspaceId,
      itemId: target.itemId,
      provider: "codewiki",
      indexPath: join(workspace, ".index"),
      status: "stale",
    });

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    const notes = engineNotes(item.id).join("\n");
    expect(notes).toContain("darwin-x64");
    expect(notes).not.toContain("has to be rebuilt");
  });

  /**
   * The sentence EO-176 was told four times, and it was not true.
   *
   * The indexing step *had* run on that item, at +0s, and succeeded.
   * Its record was thrown away fifty-six minutes later when something
   * released the checkout between two steps. "The indexing step has not
   * run on it" reads as "add the step to your pipeline", so a person
   * following it goes looking for a missing step and finds one that ran.
   *
   * The checkout is deliberately not on disk here, because that is the
   * one case that still reaches this sentence at all: where there is one,
   * EO builds an index rather than explaining why it has none.
   */
  it("does not claim the indexing step never ran when the record is simply gone", async () => {
    const { item, workspace } = storyWithWorktree("zeta");
    const asked: string[] = [];

    await supervisorFor(factoryFor(fakeProvider({ asked })), new Map([[item.id, workspace]])).runOnce();

    expect(turns[0]?.repositoryMcp).toBeUndefined();
    const notes = engineNotes(item.id).join("\n");
    expect(notes).not.toContain("the indexing step has not run");
    // Both of the things it could be, and neither of them a pipeline
    // somebody has to go and edit.
    expect(notes).toContain("never built");
    expect(notes).toContain("forgotten when its checkout was released");
    // And nothing was indexed: there is no checkout here to index.
    expect(asked).toEqual([]);
  });

  it("repeats one line of the provider's reason and never the source under it", async () => {
    // The realistic shape of a leak: the diagnosis on the first line and
    // the offending source quoted, indented, underneath. Keeping the
    // first line keeps the diagnosis and drops the quotation.
    const { item, workspace } = storyWithWorktree("eta");
    const secret = "const API_KEY = 'sk-live-do-not-log-me';";
    const factory = factoryFor(fakeProvider());
    await serviceOf(factory).recordUnavailable(
      { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace },
      ["The indexer's parser stopped.", "  --> secrets.ts:1", `  ${secret}`].join("\n"),
    );

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    const notes = engineNotes(item.id).join("\n");
    expect(notes).toContain("The indexer's parser stopped.");
    expect(notes).not.toContain(secret);
  });
});

/**
 * An index that stops being queryable while the item is in flight
 * (EO-177).
 *
 * Three faults, one place they all arrive at. On EO-176 the step ran and
 * succeeded at +0s; at +63m the reviewer was told the index had to be
 * rebuilt, and four seconds later that the step had never run at all.
 * Nothing rebuilt it, because the step was behind the item by then and
 * nothing on the dispatch path built one — so the feature switched itself
 * off partway through an item and stayed off.
 *
 * Each of the three is arranged the way it actually happens rather than
 * by writing a status onto a row: the indexer moves under a built index,
 * the record is forgotten with a released checkout, a build falls over.
 */
describe("an index that went away mid-item", () => {
  /** Every build the provider was asked for, in order, for the tests that care which. */
  let asked: string[];

  beforeEach(() => {
    asked = [];
  });

  it("builds one at dispatch when the record was forgotten between two steps", async () => {
    // Route 2, and the one EO-176 actually took: `releaseWorktree`
    // forgets the record on every successful removal — right for a
    // finished item, and two of its three callers release on idle. A
    // paused engine's Resume looks exactly like a crashed run.
    const { item, workspace } = storyOnDisk("nu-forgotten");
    const factory = factoryFor(fakeProvider({ asked }));
    await indexed(factory, item, workspace);
    deleteRepositoryIndexesForItem(handle.db, item.id);

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    expect(delivery.server?.args).toContain(workspace);
    // Nothing to say: the run got what it was promised, and a comment
    // per repair is the narration that stops threads being read.
    expect(delivery.notice).toBeNull();
    expect(asked).toEqual(["ensureReady", "rebuild"]);
    // And the record is back, so the handover sync after this run has
    // something to bring up to date.
    expect(serviceOf(factory).describe({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace })?.status).toBe("ready");
  });

  it("rebuilds an index the installed indexer can no longer read", async () => {
    // Route 1, which involves no worktree removal at all — which is why
    // narrowing what counts as a stale worktree would not have saved
    // EO-176 on its own.
    const { item, workspace } = storyOnDisk("nu-skew");
    const version = { value: "9.9.9" };
    const factory = factoryFor(fakeProvider({ asked, version }));
    await indexed(factory, item, workspace);

    // The binary changed under the item between the implement run and
    // the review.
    version.value = "10.0.0";
    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    expect(delivery.server).not.toBeNull();
    expect(delivery.notice).toBeNull();
    // A rebuild, and specifically never a sync: handing a new indexer an
    // old graph is the migration `resolveStatus` exists to refuse.
    expect(asked).toEqual(["ensureReady", "rebuild"]);
  });

  it("retries a build that failed, and repeats what the indexer said when it fails again", async () => {
    // Route 3. The row sat at `failed` and nothing ever tried again.
    const { item, workspace } = storyOnDisk("nu-failed");
    const factory = factoryFor(fakeProvider({ asked, buildFails: "CodeWiki could not parse three files and stopped." }));
    const target = { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace };
    expect((await serviceOf(factory).ensureIndexed(target)).ok).toBe(false);

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    // Tried again...
    expect(asked).toEqual(["ensureReady", "rebuild"]);
    // ...and the sentence left behind is the one worth having: what the
    // indexer said about the build EO has just watched fall over.
    expect(delivery.server).toBeNull();
    expect(delivery.notice).toContain("could not parse three files");
    expect(delivery.notice).not.toContain("the indexing step has not run");
  });

  it("does not start a second build over one already running", async () => {
    // `indexing` is a build in flight, and invariant #10 keeps
    // concurrency at 1: two builds writing one directory is the thing
    // the transition table refuses. Waiting is the right advice and it
    // is already what this says.
    const { item, workspace } = storyOnDisk("nu-inflight");
    const factory = factoryFor(fakeProvider({ asked }));
    const target = { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace };
    await indexed(factory, item, workspace);
    serviceOf(factory).setStatus(target, "stale");
    serviceOf(factory).setStatus(target, "indexing");
    asked.length = 0;

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    expect(asked).toEqual([]);
    expect(delivery.notice).toContain("still being indexed");
  });

  it("does not promise a rebuild on a machine that cannot index at all", async () => {
    // The checkout is on disk and the row says rebuild me, and neither
    // matters: there is no binary to run. Starting one here would be the
    // promise `unavailableReason` exists to stop EO making.
    const { item, workspace } = storyOnDisk("nu-platform");
    const factory = factoryFor(fakeProvider({ asked, refuse: "EO has no build of the repository indexer for darwin-x64." }));
    recordRepositoryIndex(handle.db, {
      workspaceId: item.workspaceId!,
      itemId: item.id,
      provider: "codewiki",
      indexPath: join(workspace, ".index"),
      status: "stale",
    });

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });

    expect(asked).toEqual([]);
    expect(delivery.server).toBeNull();
    expect(delivery.notice).toContain("darwin-x64");
  });

  it("hands the repaired index to the agent the dispatch was for", async () => {
    // The same repair through the whole dispatch rather than at the
    // resolver, because what the story is about is an agent going
    // without: the implementer that ran at +66m and the reviewer at
    // +74m both did, on an item whose index EO could have rebuilt.
    const { item, workspace } = storyOnDisk("nu-dispatch");
    const factory = factoryFor(fakeProvider({ asked }));

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(turns[0]?.repositoryMcp).toBeDefined();
    expect(engineNotes(item.id).some((body) => body.includes("Repository intelligence is unavailable"))).toBe(false);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });
});

/**
 * The server's life is the turn's life (EO-151).
 *
 * EO never starts this process. It names it in the configuration the
 * backend is launched with, and the backend starts it — so the server
 * lives exactly as long as the backend process does, and EO holds no
 * second handle it could leak. What EO owns is ending that backend, and
 * that is what this asserts: the signal a cancelled or timed-out run
 * aborts is the signal handed to the very turn the server was declared
 * for.
 *
 * **Where the line falls, and why there is no fake process tree here.**
 * The chain is EO's abort → the kill of the CLI child → the CLI ending
 * the MCP servers it started. For Codex the first two links are EO's
 * since EO-372: its own client spawns `codex app-server` (not detached)
 * and ends it on the abort, which `providers/codexClient.test.ts`
 * asserts against a real child process. Claude reaches the same place by
 * bridging EO's signal onto an `AbortController` the SDK owns.
 *
 * So the last link lives inside binaries EO downloads, and no fixture
 * can establish it: a stand-in backend demonstrates only what
 * the stand-in was written to do. An earlier version of this coverage
 * built its own three-process tree and swept it with a process-group
 * kill, which proved that a group kill reaches a grandchild — true, and
 * nothing to do with EO, because neither backend is spawned into a group
 * or signalled as one. `providers/repositoryServerLifecycle.live.test.ts` observes the
 * real topology against the real binaries instead, opt-in.
 *
 * What is left here is exactly EO's half — and that is two of the three
 * ways a run can end, not three. A cancel and the wall-clock guard are
 * both EO firing an abort, and both are asserted below against a
 * provider that *blocks* on the signal, so an abort that never came
 * hangs the test rather than passing quietly.
 *
 * **Normal completion is absent on purpose.** A turn that ends on its
 * own has EO abort nothing: the stream ends and the backend exits
 * because its work is done. There is no EO action to assert there, and
 * "the signal was not aborted" is a claim about a non-event. That third
 * way is covered in `repositoryServerLifecycle.live.test.ts`, where the
 * backend is real and its exit is something that can be watched rather
 * than modelled.
 */
describe("when the run ends", () => {
  it("aborts the signal the turn carrying the server was given", async () => {
    const { item, workspace } = storyWithWorktree("mu");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    let handed: { signal: AbortSignal; repositoryMcp: RepositoryMcpServer | undefined } | null = null;
    const hanging: AgentProvider = {
      start: (opts) => {
        handed = { signal: opts.signal, repositoryMcp: opts.repositoryMcp };
        return (async function* (): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: "session-1" };
          // Held open until the run is cancelled, the way a real turn is
          // held open by a model that is still thinking.
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) resolve();
            else opts.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { type: "error", message: "cancelled", retryable: false };
        })();
      },
      resume: () => (async function* (): AsyncIterable<AgentEvent> {})(),
    };

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), hanging);
    const running = supervisor.runOnce();
    // Let the dispatch reach the provider before cancelling it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [run] = listRunsForItem(handle.db, item.id);
    supervisor.cancelRun(run!.id);
    await running;

    const turn = handed as { signal: AbortSignal; repositoryMcp: RepositoryMcpServer | undefined } | null;
    // The turn had the server...
    expect(turn?.repositoryMcp?.name).toBe("repo");
    // ...and the signal it was given is the one the cancel fired. The
    // process the backend started from that configuration dies with the
    // backend this ends.
    expect(turn?.signal.aborted).toBe(true);
  });

  it("aborts it for a turn that overran its wall-clock guard", async () => {
    // A separate path to the same end, and one nothing else covers: the
    // guard fires `controller.abort()` from a timer rather than from
    // anything a person did.
    const { item, workspace } = storyWithWorktree("nu");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    let handed: { signal: AbortSignal; repositoryMcp: RepositoryMcpServer | undefined } | null = null;
    const hanging: AgentProvider = {
      start: (opts) => {
        handed = { signal: opts.signal, repositoryMcp: opts.repositoryMcp };
        return (async function* (): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: "session-1" };
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) resolve();
            else opts.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          // Retryable, so that this ends as a failed run: one the backend
          // called final is parked for a person instead (EO-437), and what
          // the flag says is not what this test is about.
          yield { type: "error", message: "the guard ended it", retryable: true };
        })();
      },
      resume: () => (async function* (): AsyncIterable<AgentEvent> {})(),
    };

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: hanging,
      ...createRoleWiring(handle.db),
      limits: LIMITS,
      guards: () => ({ wallClockTimeoutMs: 200 }),
      kinds: installedKinds(fakeWorkspaceKind({ cwd: workspace, attach: gitWorkspaceKind({ db: handle.db, intelligenceFor: factory }).attach })),
    });
    await supervisor.runOnce();

    const turn = handed as { signal: AbortSignal; repositoryMcp: RepositoryMcpServer | undefined } | null;
    expect(turn?.repositoryMcp?.name).toBe("repo");
    expect(turn?.signal.aborted).toBe(true);
    // The run really did end on the guard rather than on anything else.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("failed");
  });
});

/**
 * The sentence itself, one status at a time.
 *
 * Driven straight at the resolver rather than through a dispatch,
 * because what is being checked is that each state gets its *own*
 * account: a person reading "unavailable" learns nothing they can act
 * on, and the difference between these five sentences is the difference
 * between rebuilding, waiting, and adding the step back to the pipeline.
 */
describe("what a run that goes without is told", () => {
  async function noticeWith(status: "not_indexed" | "indexing" | "updating" | "stale"): Promise<string> {
    const { item, workspace } = storyWithWorktree(`why-${status}`);
    const factory = factoryFor(fakeProvider());
    const target = { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace };
    const service = serviceOf(factory);
    // A row in each state, reached through the transition table rather
    // than written by hand — except `not_indexed`, which is the state a
    // row is *born* in and which nothing legally moves back to.
    if (status === "not_indexed") {
      recordRepositoryIndex(handle.db, {
        workspaceId: target.workspaceId,
        itemId: target.itemId,
        provider: "codewiki",
        indexPath: join(workspace, ".index"),
        status: "not_indexed",
      });
    } else {
      await service.ensureIndexed(target);
      if (status === "updating") service.setStatus(target, "updating");
      if (status === "stale") service.setStatus(target, "stale");
      if (status === "indexing") {
        service.setStatus(target, "stale");
        service.setStatus(target, "indexing");
      }
    }

    const delivery = await repositoryQueryServerFor(factory, { db: handle.db, item, worktreePath: workspace, agentName: "Iris" });
    expect(delivery.server).toBeNull();
    return delivery.notice ?? "";
  }

  it("names the agent going without, and says the work carries on regardless", async () => {
    const { item, workspace } = storyWithWorktree("named");
    const delivery = await repositoryQueryServerFor(factoryFor(fakeProvider()), {
      db: handle.db,
      item,
      worktreePath: workspace,
      agentName: "Iris",
    });

    expect(delivery.notice).toContain("Iris");
    // The degradation promise, stated where the person reads it rather
    // than only in a design document.
    expect(delivery.notice).toContain("filesystem and git tools");
  });

  it("tells a mid-build index apart from one that has to be rebuilt", async () => {
    // Two states, two different things to do: one is worth waiting for,
    // the other never resolves on its own.
    expect(await noticeWith("indexing")).toContain("still being indexed");
    expect(await noticeWith("updating")).toContain("brought up to date");
    expect(await noticeWith("stale")).toContain("rebuilt");
    expect(await noticeWith("not_indexed")).toContain("has not been indexed yet");
  });
});

describe("what this must not disturb", () => {
  /**
   * Thread reuse, which repository intelligence deliberately does not
   * participate in (EO-151).
   *
   * `findReusableThread` refuses a thread whose *attachments* moved,
   * because a session keeps the tool surface it was opened with. The
   * query server is not part of that surface as far as this rule is
   * concerned, and it must not be: an index is rebuilt and resynced at
   * every handover, so folding it in would refuse a thread on almost
   * every dispatch — spending a full context assembly to save a query
   * server. The server is re-declared on the resume instead, which the
   * adapter tests assert.
   */
  it("leaves a thread reusable across two dispatches with an index on both", async () => {
    const { item, workspace } = storyWithWorktree("theta");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    // The run the first dispatch left behind, as `findReusableThread`
    // weighs it up on the next one.
    const [first] = listRunsForItem(handle.db, item.id);
    expect(first?.threadId).toBe("session-1");
    expect(first?.agentAttachmentsHash).toBe(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN));

    const reuse = findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: workspace });
    expect(reuse.kind).toBe("resume");
  });

  it("keeps that true when the index went away between the two", async () => {
    // The point of the rule: repository intelligence comes and goes with
    // an index EO rebuilds, and a thread must not be thrown away every
    // time it moves. The agent simply stops being handed a server.
    const { item, workspace } = storyWithWorktree("iota");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();
    serviceOf(factory).setStatus({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace }, "stale");

    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const reuse = findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: workspace });

    expect(reuse.kind).toBe("resume");
  });
});

describe("a run recovered after a crash", () => {
  /**
   * The path that went without, until it did not (EO-151).
   *
   * `reconcile()` was synchronous, and resolving a query server is not,
   * so a recovered implementer or reviewer was dispatched with an index
   * it was entitled to and never told about — and got no note saying so
   * either, because there was nothing to say it from. Reconciliation is
   * async now, which is what lets this path ask the same question the
   * other two ask.
   *
   * The process holding those servers open died with the app, so the
   * server has to be named again on the resumed turn for the same reason
   * the tool directory has to be written again.
   */
  function interruptedRun(item: Item, workspace: string): void {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: workspace,
    });
    updateRun(handle.db, run.id, { status: "running", startedAt: Date.now() });
  }

  it("names the server on the resumed turn, pointed at that item's checkout", async () => {
    const { item, workspace } = storyWithWorktree("nu");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);
    interruptedRun(item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]));
    expect(await supervisor.reconcile()).toEqual({ reattached: 0, resumed: 1, orphaned: 0 });
    await supervisor.waitForIdle();

    const resumed = turns.find((turn) => turn.kind === "resume");
    expect(resumed?.repositoryMcp?.args).toEqual(["serve", "--mcp", "--path", workspace, "--no-watch"]);
    // Delivered through `resume`, which is the entry point both adapters
    // are asserted to honour: `claude.test.ts` "gives the server to a
    // resumed turn too" and `codex.test.ts` "names it again on a
    // resume". Recovery is those two facts composed — this half is that
    // the supervisor asks at all, which is the half that was missing.
    expect(resumed?.kind).toBe("resume");
  });

  it("says what is missing when the recovered item has no index to give", async () => {
    const { item, workspace } = storyWithWorktree("xi");
    const factory = factoryFor(fakeProvider());
    await serviceOf(factory).recordUnavailable(
      { workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace },
      "EO has no build of the repository indexer for darwin-x64.",
    );
    interruptedRun(item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]));
    await supervisor.reconcile();
    await supervisor.waitForIdle();

    expect(turns.find((turn) => turn.kind === "resume")?.repositoryMcp).toBeUndefined();
    // Silently worse off is the failure; a recovered run is owed the
    // same sentence a fresh one gets (invariant #8).
    expect(engineNotes(item.id).join("\n")).toContain("darwin-x64");
  });
});

describe("a person's reply unparking a run", () => {
  it("names the server again, because resuming spawns the backend afresh", async () => {
    const { item, workspace } = storyWithWorktree("kappa");
    const factory = factoryFor(fakeProvider());
    await indexed(factory, item, workspace);

    // A run that asked a blocking question and parked.
    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), {
      start: (opts) => {
        turns.push({ kind: "start", cwd: opts.cwd, repositoryMcp: opts.repositoryMcp });
        return (async function* (): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: "session-1" };
          yield { type: "tool_call", name: "comment", args: { body: "@user which limit?", mentions: ["user"], blocking: true } };
          yield { type: "result", data: validImplementResult };
        })();
      },
      resume: (_threadId, _message, opts) => {
        turns.push({ kind: "resume", cwd: opts?.cwd, repositoryMcp: opts?.repositoryMcp });
        return (async function* (): AsyncIterable<AgentEvent> {
          yield { type: "result", data: validImplementResult };
        })();
      },
    });
    await supervisor.runOnce();
    const [parked] = listRunsForItem(handle.db, item.id);
    updateRun(handle.db, parked!.id, { status: "awaiting_input", endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The per-minute one." });

    await supervisor.resumeItem(item.id);

    const resumed = turns.find((turn) => turn.kind === "resume");
    expect(resumed?.repositoryMcp?.args).toEqual(["serve", "--mcp", "--path", workspace, "--no-watch"]);
  });
});

/**
 * Nothing of the person's own goes near this (EO-151).
 *
 * EO owns the configuration for agents EO starts, and nothing else.
 * Delivering a server means putting it in the options one dispatch is
 * launched with — never in a file under `~/.claude`, `~/.codex` or
 * anywhere else the person's own tools read, which would change what
 * every agent on the machine can do and outlive EO entirely.
 *
 * Asserted against a `HOME` this test owns, so it is a fact about what
 * ran rather than about what was intended: nothing appears there, and
 * nothing in what an agent was handed points there either.
 */
describe("the person's own configuration", () => {
  it("is neither read nor written when a dispatch is given the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "eo-home-"));
    const previous = { HOME: process.env["HOME"], USERPROFILE: process.env["USERPROFILE"] };
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    try {
      const { item, workspace } = storyWithWorktree("lambda");
      const factory = factoryFor(fakeProvider());
      await indexed(factory, item, workspace);

      await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

      expect(turns[0]?.repositoryMcp?.name).toBe("repo");
      // Nothing was created there...
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(existsSync(join(home, ".codex"))).toBe(false);
      // ...and nothing an agent was handed points there either, which is
      // the half a directory listing cannot rule out.
      const handed = JSON.stringify(turns[0]?.repositoryMcp ?? {});
      expect(handed).not.toContain(".claude");
      expect(handed).not.toContain(".codex");
      expect(handed).not.toContain(home);
    } finally {
      if (previous.HOME === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous.HOME;
      if (previous.USERPROFILE === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = previous.USERPROFILE;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
