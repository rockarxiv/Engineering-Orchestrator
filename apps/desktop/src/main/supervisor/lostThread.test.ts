import type { SectionRenderer } from "@eo/engine";
import { ThreadNotFoundError, type Agent, type AgentEvent, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import type { CreateRunInput } from "../db/repos/runsRepo.js";
import {
  archiveAgent,
  createProject,
  createRun,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { promptHash } from "../roles/prompts.js";
import { createRunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * Standing in for the developer pack's acceptance-criteria section
 * (KAN-161).
 *
 * The sections a prompt carries beyond the core's own come from the
 * installed pack, and a core-side test must not reach into one
 * (`packs/boundary.test.ts`). So it supplies the section itself: what is
 * asserted below is that what the caller supplies reaches the agent,
 * which is true of whoever wrote the renderer.
 */
const CRITERIA_SECTION: SectionRenderer = {
  id: "acceptanceCriteria",
  after: "item",
  render: ({ item }) =>
    item.acceptanceCriteria.length === 0 ? null : ["## Acceptance Criteria", ...item.acceptanceCriteria.map((item) => `- ${item}`)].join("\n"),
};


const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** Every action on an item shares one worktree — `createWorktreeWorkspace` sees to that. */
const CWD = "/tmp/eo/worktrees/EO-93";
/** The session id EO stored, pointing at a file the backend no longer has. */
const GONE = "session-cleaned-up";

const ITEM_BODY = "The importer drops rows whose id is null.";
const ACCEPTANCE_CRITERION = "A null id is rejected with a 400.";

/** What a provider was actually asked to do, in order. */
interface Turn {
  kind: "start" | "resume";
  threadId?: string;
  /** The context for a start, the message for a resume — either way, what the model reads. */
  prompt: string;
  /**
   * The agent's own instructions, which only a `start` carries.
   *
   * Recorded separately from `prompt` because that is the whole of the
   * arrangement: the context does not repeat the role prompt, so the
   * only assertion that can catch it going missing is one that looks at
   * the field it now travels in.
   */
  instructions?: string;
}

/**
 * A turn that fails before it says anything, which is what resuming a
 * session that is not there does: the CLI exits, and the first `next()`
 * throws.
 */
function failedTurn(error: unknown): AsyncIterable<AgentEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) };
}

/**
 * Recovering when the backend has lost the thread (EO-93).
 *
 * The premise is a stored `thread_id` that has stopped being true.
 * Sessions live under the backend's own directory — `~/.claude`,
 * `~/.codex/sessions` — which EO does not own: they get cleaned up, and
 * machines change. What the providers do with that is their own tests'
 * business; these are about what the supervisor does once one of them
 * says so, which is: write the thread off, explain, and do the work
 * anyway.
 *
 * The rejection here is the typed error a provider raises, not a
 * sentence from an SDK. That is the seam — if this file had to spell out
 * "No conversation found with session ID" to make the supervisor react,
 * the supervisor would be the thing matching English from two backends
 * it does not own.
 */
describe("when the backend has lost the thread", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let turns: Turn[];

  beforeEach(() => {
    handle = openMigratedTestDb();

    // Two repositories, so a full context assembly genuinely renders the
    // repository listing — otherwise "the fresh run got the whole thing"
    // would pass against a context that never had one.
    const repositories = [
      attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/eo/app" }),
      attachWorkspace(handle.db, { name: "engine", keyPrefix: "ENG", repoPath: "/tmp/eo/engine" }),
    ];
    const project = createProject(handle.db, {
      name: "EO",
      keyPrefix: "EO",
      workspaceIds: repositories.map((repository) => repository.id),
    });

    item = createTestItem(handle.db, {
      type: "story",
      title: "A story",
      body: ITEM_BODY,
      spec: { acceptance_criteria: [ACCEPTANCE_CRITERION] },
      projectId: project.id,
      stepId: "todo",
    });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    turns = [];
  });

  afterEach(() => {
    handle.close();
  });

  /** Somebody ticked "reuse the agent thread per item" on this agent. */
  function enableReuse(): void {
    implementer = updateAgent(handle.db, implementer.id, { config: { reuseThreadPerItem: true } });
  }

  /**
   * A prior run of this agent's on this item, finished the way a real
   * dispatch leaves one — the row a later dispatch weighs up and decides
   * it can carry on from.
   */
  function priorRun(overrides: Partial<CreateRunInput> = {}) {
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: GONE,
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
      ...overrides,
    });
    updateRun(handle.db, run.id, { startedAt: 1_000, endedAt: 1_000 });
    return run;
  }

  /**
   * Records every provider call, and rejects the resumes `rejects`
   * names. Everything else is the ordinary fake.
   */
  function recording(script: FakeProviderScript, rejects: (threadId: string) => unknown = () => null): AgentProvider {
    const inner = createFakeProvider(script);
    return {
      start: (opts) => {
        turns.push({ kind: "start", prompt: opts.context, instructions: opts.instructions });
        return inner.start(opts);
      },
      resume: (threadId, message, opts) => {
        turns.push({ kind: "resume", threadId, prompt: message });
        const rejection = rejects(threadId);
        return rejection ? failedTurn(rejection) : inner.resume(threadId, message, opts);
      },
    };
  }

  function supervisorFor(provider: AgentProvider, overrides: Partial<RunSupervisorOptions> = {}) {
    return createRunSupervisor({
      db: handle.db,
      provider,
      kinds: kindsPreparing(CWD),
      limits: LIMITS,
      // What the fresh thread is told includes the acceptance criteria,
      // and those arrive as a section the caller supplies (KAN-161).
      sectionRenderers: [CRITERIA_SECTION],
      ...overrides,
    });
  }

  /** What a backend with no such session raises, once its provider has translated it. */
  const lost = (threadId: string) => new ThreadNotFoundError({ threadId, provider: implementer.provider });

  const engineNotes = (): string[] =>
    listCommentsForItem(handle.db, item.id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);

  const runsOnItem = () => listRunsForItem(handle.db, item.id);

  it("writes the thread off, says so once, and finishes the work on a fresh one", async () => {
    enableReuse();
    const prior = priorRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Do the null check first." });

    await supervisorFor(
      recording({ result: validImplementResult }, (threadId) => (threadId === GONE ? lost(threadId) : null)),
    ).runOnce();

    // The dispatch tried the stored thread, was told it is not there, and
    // opened a new one — in that order, once each.
    expect(turns.map((turn) => `${turn.kind}:${turn.threadId ?? ""}`)).toEqual([`resume:${GONE}`, "start:"]);
    // And the fresh conversation is told everything, because it knows
    // nothing: this is what makes a lost thread cost tokens, not work.
    expect(turns[1]?.prompt).toContain(ITEM_BODY);
    expect(turns[1]?.prompt).toContain(ACCEPTANCE_CRITERION);
    expect(turns[1]?.prompt).toContain("## Repositories");
    expect(turns[1]?.prompt).toContain("Do the null check first.");
    // Including the role prompt, which travels in its own field rather
    // than in the context.
    expect(turns[1]?.instructions).toBe(implementer.instructions);

    const runs = runsOnItem();
    expect(runs.map((run) => run.id)).toContain(prior.id);
    const [, dead, recovered] = runs;

    // The marker, on the run that found the session missing — and its
    // thread id still there beside it. Nulling that would describe a run
    // that never had a thread, which is a different thing that happened.
    expect(dead?.threadId).toBe(GONE);
    expect(dead?.threadLost).toBe(true);
    // Not `failed`: nothing was asked and nothing was answered. The run
    // was abandoned and a successor is carrying the work, which is what
    // `reconcile` calls an interrupted run too.
    expect(dead?.status).toBe("cancelled");

    // One comment, in the engine's own voice, saying what was lost and
    // what happens next — rather than a provider error about a session id.
    const notes = engineNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("no longer available");
    expect(notes[0]).toContain(implementer.name);
    expect(notes[0]).toContain("starting a fresh conversation");

    // And the work got done.
    expect(recovered?.status).toBe("succeeded");
    expect(recovered?.threadId).not.toBe(GONE);
    expect(recovered?.threadId).toBeTruthy();
    expect(recovered?.threadLost).toBe(false);
  });

  it("does not open a fresh conversation as an agent archived while the dead thread was being written off", async () => {
    // The continuation paths are the ones the entry-point guards cannot
    // see (EO-186): this one decides to start a *new* conversation from
    // inside a run that is already under way, holding an `Agent` it read
    // before it ever called the backend. Archived in that window, it
    // would open a fresh session as an agent EO has retired.
    enableReuse();
    priorRun();

    await supervisorFor(
      recording({ result: validImplementResult }, (threadId) => {
        if (threadId !== GONE) return null;
        // Retired while EO was talking to the backend — the only moment
        // that produces this, and the reason the check is at the door
        // rather than at the decision.
        archiveAgent(handle.db, implementer.id);
        return lost(threadId);
      }),
    ).runOnce();

    // The dead thread was tried, as it always is. Nothing was started in
    // its place.
    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    // And EO said so, rather than leaving the note above promising a
    // fresh conversation that never came (invariant #8).
    const refusal = engineNotes().find((body) => body.includes("EO did not start this run"));
    expect(refusal).toContain("Implementer has been archived");
    expect(refusal).toContain('give the "implementer" role another agent');
    // No run of this agent's is left running: the abandoned one is
    // closed, and the replacement was refused rather than written.
    expect(runsOnItem().filter((run) => run.status === "running")).toEqual([]);
  });

  it("does not offer the dead thread to the next dispatch", async () => {
    // The failure this story exists for. Without the marker the next
    // dispatch looks up the newest run for this agent, finds the same
    // dead id on the run before it, and fails exactly the same way —
    // bounded only by the attempt limit, which then refuses the item
    // for a reason that has nothing to do with the work.
    enableReuse();
    priorRun();
    const supervisor = supervisorFor(
      recording({ result: validImplementResult }, (threadId) => (threadId === GONE ? lost(threadId) : null)),
      // Straight back to the step it is on, so the same agent is asked
      // again on the next tick — the shape of a review bounce, without
      // the reviewer.
      { resolveNextState: (current) => ({ stepId: "todo", pipelineId: current.pipelineId }) },
    );

    await supervisor.runOnce(); // resume the dead thread, recover, succeed
    await supervisor.runOnce(); // and round again

    const resumed = turns.filter((turn) => turn.kind === "resume").map((turn) => turn.threadId);
    expect(resumed.filter((threadId) => threadId === GONE)).toHaveLength(1); // tried once, ever
    // The conversation the recovery opened is a perfectly good one, and
    // is picked up as usual: the marker is on the thread that was lost,
    // not on the agent or the item.
    const recovered = runsOnItem()[2];
    expect(resumed.at(-1)).toBe(recovered?.threadId);
    expect(runsOnItem().at(-1)?.status).toBe("succeeded");
  });

  it("still fails the run on any other provider error, exactly as it did before", async () => {
    // The line this path must not cross. A resume that fails for any
    // other reason is a failed run: the item stays where it is, the
    // failure is reported as one, and nothing restarts the work behind
    // whoever is reading it.
    enableReuse();
    priorRun();
    const boom = new Error("the backend is overloaded");

    await supervisorFor(recording({ result: validImplementResult }, () => boom)).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]); // no second attempt of any kind
    const failed = runsOnItem().at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.threadLost).toBe(false); // the thread is fine; the turn was not
    expect(failed?.threadId).toBe(GONE);
    expect(engineNotes().join("\n")).toContain("the backend is overloaded");
  });

  it("recovers a human's reply whose parked conversation is gone", async () => {
    // The other place a stored thread is resumed: a person answering a
    // parked run. The reply is the most expensive moment to lose one —
    // somebody is waiting on it — and the thread here is the run's own,
    // with no opt-in involved.
    const parked = priorRun({ status: "awaiting_input" });
    updateRun(handle.db, parked.id, { error: "@user which limit?" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use the per-item limit." });

    await supervisorFor(
      recording({ result: validImplementResult }, (threadId) => (threadId === GONE ? lost(threadId) : null)),
    ).resumeItem(item.id);

    expect(turns.map((turn) => `${turn.kind}:${turn.threadId ?? ""}`)).toEqual([`resume:${GONE}`, "start:"]);
    // The reply is in the fresh context — it is in the comment thread,
    // which is what invariant #4 makes recoverable.
    expect(turns[1]?.prompt).toContain("Use the per-item limit.");

    const [, dead, recovered] = runsOnItem();
    expect(dead?.threadLost).toBe(true);
    expect(dead?.threadId).toBe(GONE);
    expect(engineNotes()).toHaveLength(1);
    expect(recovered?.status).toBe("succeeded");
  });
});
