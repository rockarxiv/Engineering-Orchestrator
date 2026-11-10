import type { SectionRenderer } from "@eo/engine";
import { sql } from "drizzle-orm";
import { uuidv7, type Agent, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import type { CreateRunInput } from "../db/repos/runsRepo.js";
import {
  addItemAttachments,
  archiveAgent,
  createAgent,
  createProject,
  createRun,
  deleteItem,
  insertAttachments,
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
import { itemFilesHash } from "./threadReuse.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { fakeWorkspaceKind, installedKinds, kindsPreparing } from "./testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "./workspaceKind.js";

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
const CWD = "/tmp/eo/worktrees/EO-91";
/** The session id the agent's previous run on this item left behind. */
const PRIOR_THREAD = "session-1";

const ITEM_BODY = "The importer drops rows whose id is null.";
const ACCEPTANCE_CRITERION = "A null id is rejected with a 400.";

/**
 * Where the agents' comments reach the supervisor, as a real `eo`
 * server's do (EO-543). Without it a scripted `comment` call is only
 * said, never made: nothing is posted and no blocking comment parks a
 * run. Every supervisor below whose agent comments is served by it.
 */
let writes: TestWriteBridge;

beforeEach(async () => {
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
});

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
 * Dispatch resuming the agent's own thread instead of opening a new one
 * (EO-86, EO-91).
 *
 * What these assert on is which provider method a dispatch called and
 * what it sent — the only two things that change. Everything else about
 * a dispatch is deliberately untouched, and the preflight cases below
 * are here to hold that line: reuse decides what is sent, never what is
 * allowed.
 */
describe("dispatch on a reused thread", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let turns: Turn[];

  beforeEach(() => {
    handle = openMigratedTestDb();

    // Two repositories, so the full assembly genuinely renders the
    // repository listing — otherwise "the follow-up does not carry it"
    // would pass against a context that never had one either.
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
   * An agent with reuse off, dispatched on the `todo` step in the
   * implementer's place.
   *
   * A role somebody invented, because since EO-178 that is the only kind
   * of agent the switch is still a switch on: `reusesThreadPerItem`
   * answers from the role for the four EO ships, and the editor draws no
   * checkbox for them. The implementer used to be able to have it
   * cleared — that is what this helper did, and its own case below is
   * now the one asserting that a cleared key changes nothing there.
   *
   * The step is repointed rather than the agent's role changed, because
   * `role` is immutable after creation and a step finds its agent by it.
   */
  function dispatchAnInventedRoleInstead(config: Record<string, unknown> = {}): void {
    implementer = createAgent(handle.db, {
      name: "Tester",
      role: "tester",
      provider: implementer.provider,
      instructions: implementer.instructions,
      promptHash: promptHash(implementer.instructions),
      config,
    });
    handle.db.run(sql`UPDATE pipeline_steps SET owner_role = 'tester' WHERE id = 'todo'`);
  }

  /**
   * A prior run of this agent's on this item, finished the way a real
   * dispatch leaves one: a thread, a backend, the instructions it was
   * given and the directory it worked in.
   */
  function priorRun(overrides: Partial<CreateRunInput> = {}) {
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: PRIOR_THREAD,
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
      ...overrides,
    });
    updateRun(handle.db, run.id, { startedAt: 1_000, endedAt: 1_000 });
    return run;
  }

  /** Records every provider call before handing it on to the fake. */
  function recording(script: FakeProviderScript): AgentProvider {
    const inner = createFakeProvider(script);
    return {
      start: (opts) => {
        turns.push({ kind: "start", prompt: opts.context, instructions: opts.instructions });
        return inner.start(opts);
      },
      resume: (threadId, message, opts) => {
        turns.push({ kind: "resume", threadId, prompt: message });
        return inner.resume(threadId, message, opts);
      },
    };
  }

  function supervisorFor(script: FakeProviderScript, overrides: Partial<RunSupervisorOptions> = {}) {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: recording(script),
      kinds: kindsPreparing(CWD),
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      // The acceptance criteria in the prompt below arrive as a section
      // the caller supplies, the way `createEngine` supplies the
      // developer pack's (KAN-161).
      sectionRenderers: [CRITERIA_SECTION],
      ...overrides,
    });
    writes.serve(supervisor);
    return supervisor;
  }

  /** What the human said since the agent's last run — the only thing a follow-up should carry. */
  function newComment(body = "Do the null check first, the rest can wait."): void {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body });
  }

  const engineNotes = (): string[] =>
    listCommentsForItem(handle.db, item.id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);

  it("resumes the agent's own thread rather than opening a second one", async () => {
    enableReuse();
    priorRun();
    newComment();

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("resume");
    expect(turns[0]?.threadId).toBe(PRIOR_THREAD);
  });

  it("sends the task line and the new comments, and nothing the thread already holds", async () => {
    enableReuse();
    priorRun();
    newComment();

    await supervisorFor({ result: validImplementResult }).runOnce();

    const prompt = turns[0]?.prompt ?? "";
    // The action, because a thread is keyed on (item, agent) and the
    // action really can differ from the one it began with.
    expect(prompt).toContain('perform the "implement" action');
    expect(prompt).toContain("Do the null check first, the rest can wait.");
    // ~24k of things the conversation already contains. This list is the
    // saving; every entry that leaks back in is spend the feature exists
    // to remove.
    expect(prompt).not.toContain(ITEM_BODY);
    expect(prompt).not.toContain(ACCEPTANCE_CRITERION);
    expect(prompt).not.toContain("## Repositories");
    // And the role prompt is not re-sent either, which on a resume is
    // the backend's rule rather than a choice: the session keeps the
    // instructions it was started with.
    expect(turns[0]?.instructions).toBeUndefined();
  });

  it("hands the run being continued to the context seam, and sends back what it built", async () => {
    // The seam is how a caller substitutes a prompt, and it is the same
    // one either way — a resumed dispatch does not build its prompt
    // somewhere a `buildContext` override cannot see.
    enableReuse();
    const prior = priorRun();

    const asked: (string | null)[] = [];
    await supervisorFor(
      { result: validImplementResult },
      {
        buildContext: (_db, _item, _agent, _action, resumingRun) => {
          asked.push(resumingRun?.id ?? null);
          return "only what you have not seen";
        },
      },
    ).runOnce();

    expect(asked).toEqual([prior.id]);
    expect(turns[0]?.prompt).toBe("only what you have not seen");
  });

  it("with the setting off, dispatch is what it always was: a fresh thread and the whole context", async () => {
    dispatchAnInventedRoleInstead();
    priorRun(); // a perfectly good thread, and its agent was told not to use it

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("start");
    const prompt = turns[0]?.prompt ?? "";
    expect(prompt).toContain(ITEM_BODY);
    expect(prompt).toContain(ACCEPTANCE_CRITERION);
    expect(prompt).toContain("## Repositories");
    expect(turns[0]?.instructions).toBe(implementer.instructions);
    expect(engineNotes()).toEqual([]); // an agent whose owner opted out is not owed an explanation
  });

  it("with the box ticked on a role EO ships no opinion about, it still resumes", async () => {
    // The other half of the same helper: the switch is still a switch
    // where EO has not decided, and it decides the same thing it always
    // did there.
    dispatchAnInventedRoleInstead({ reuseThreadPerItem: true });
    priorRun();
    newComment();

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.threadId).toBe(PRIOR_THREAD);
  });

  /**
   * On the four roles EO ships, the role decides and `config` is not
   * consulted (EO-178).
   *
   * The editor draws no checkbox for these, so a key in the bag is one
   * nobody can see — left by an older EO, by MCP `agent_save`, or by
   * whoever opened the database. Acting on it would make dispatch
   * disagree with a screen showing no control at all. The implementer
   * resumes because that is 0048's argument; the reviewer must not,
   * because a reviewer resuming its own thread is re-reading a diff it
   * has already formed an opinion about.
   */
  it("resumes the implementer even with the stored key cleared", async () => {
    implementer = updateAgent(handle.db, implementer.id, { config: { reuseThreadPerItem: false } });
    priorRun();
    newComment();

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.threadId).toBe(PRIOR_THREAD);
  });

  it.each(["system", "reviewer"])(
    "starts a fresh thread for %s even with the stored key set",
    async (role) => {
      const shipped = listAgents(handle.db).find((agent) => agent.role === role)!;
      updateAgent(handle.db, shipped.id, { config: { reuseThreadPerItem: true } });
      handle.db.run(sql`UPDATE pipeline_steps SET owner_role = ${role} WHERE id = 'todo'`);
      priorRun({ agentId: shipped.id, instructionsHash: promptHash(shipped.instructions) });

      await supervisorFor({ result: validImplementResult }).runOnce();

      expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
      expect(turns[0]?.prompt).toContain(ITEM_BODY); // the whole context, because nothing is being carried over
      expect(engineNotes()).toEqual([]); // not a refusal, so nothing to explain
    },
  );

  it("starts fresh and says nothing about it on the first dispatch of an item", async () => {
    enableReuse();
    // No prior run: there was simply nothing to carry over, which is not
    // a refusal and must not put an engine comment on every new item.

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(ITEM_BODY);
    expect(engineNotes()).toEqual([]);
  });

  it("starts fresh and posts one comment when the thread was born on another backend", async () => {
    enableReuse();
    priorRun({ provider: "codex" });
    updateAgent(handle.db, implementer.id, { provider: "claude" });

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(ITEM_BODY); // the full context, so nothing is lost with the thread
    const notes = engineNotes();
    expect(notes).toHaveLength(1); // one explanation, not one per rule the thread failed
    expect(notes[0]).toContain("codex");
    expect(notes[0]).toContain("claude");
  });

  it("starts fresh and posts one comment when the agent's instructions have been edited", async () => {
    enableReuse();
    priorRun();
    // A session keeps the instructions it was started with, so a reused
    // thread would silently ignore the edit for the rest of the item.
    implementer = updateAgent(handle.db, implementer.id, {
      instructions: "Write the test first, then the code.",
      promptHash: null,
    });

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.instructions).toBe("Write the test first, then the code."); // and the new run picks them up
    const notes = engineNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("instructions have changed");
  });

  it("starts fresh and posts one comment when a file was added to the item, and lists it (EO-703)", async () => {
    enableReuse();
    priorRun();
    // A resumed thread is told nothing about the item again, so a file
    // put on it mid-work would never reach the agent.
    const fileId = uuidv7();
    addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(`- ID: ${fileId}; name: mock.png; MIME type: image/png`);
    const notes = engineNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("The files on this item have changed");
    // And the new thread records the list it was told, so the dispatch
    // after it resumes rather than starting fresh again.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.itemFilesHash).toBe(itemFilesHash(handle.db, item.id));
  });

  it("does not carry on a thread when a file lands on the item while the dispatch is being prepared (EO-703)", async () => {
    enableReuse();
    priorRun();
    newComment();
    // Put on the item while the context is being assembled — after the
    // thread was weighed up and chosen, before the provider is reached.
    const fileId = uuidv7();
    let landed = false;
    const landsMidPreflight: SectionRenderer = {
      id: "landsMidPreflight",
      after: "item",
      render: () => {
        if (!landed) {
          landed = true;
          addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
        }
        return null;
      },
    };
    const supervisor = supervisorFor({ result: validImplementResult }, { sectionRenderers: [CRITERIA_SECTION, landsMidPreflight] });

    // The dispatch turns back having written nothing…
    await supervisor.runOnce();
    expect(landed).toBe(true);
    expect(turns).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);

    // …and the next one refuses the thread, says why, and lists the file.
    await supervisor.runOnce();
    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(`- ID: ${fileId}; name: mock.png; MIME type: image/png`);
    const notes = engineNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("The files on this item have changed");
  });

  it("resumes a thread born with the item's files, and does not list them again (EO-703)", async () => {
    enableReuse();
    const fileId = uuidv7();
    addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
    priorRun({ itemFilesHash: itemFilesHash(handle.db, item.id) });
    newComment();

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.prompt).not.toContain(fileId);
    expect(engineNotes()).toEqual([]);
  });

  it("records the thread, the backend and the worktree the resumed run is continuing", async () => {
    enableReuse();
    const prior = priorRun();

    await supervisorFor({ result: validImplementResult }).runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    const resumed = runs[1]!;
    expect(resumed.id).not.toBe(prior.id);
    // Everything a later resume — a crash recovery, the next dispatch
    // weighing this thread up — has to read off the row.
    expect(resumed.threadId).toBe(PRIOR_THREAD);
    expect(resumed.provider).toBe(implementer.provider);
    expect(resumed.cwd).toBe(CWD);
    expect(resumed.status).toBe("succeeded");
  });

  it("parks a resumed dispatch on the conversation it continued, after a refused comment it corrected itself", async () => {
    // This used to hold the A-02 correction turn to `initialThreadId`: a
    // resumed dispatch never sees `thread_started`, and a correction
    // opened on null would have forked the conversation. Since EO-543
    // there is no correction turn — the refused call is answered as it is
    // made, and the agent fixes it inside the turn it is in. What is left
    // to hold is the same conversation: one turn on the prior thread, and
    // the run parked on that thread so the reply goes back into it.
    enableReuse();
    priorRun();

    await supervisorFor({
      steps: [
        { toolCall: { name: "comment", args: { body: "need help", mentions: ["not-a-real-agent"], blocking: true } } },
        { toolCall: { name: "comment", args: { body: "sorry, meant @user", mentions: ["user"], blocking: true } } },
      ],
    }).runOnce();

    expect(turns.map((turn) => `${turn.kind}:${turn.threadId ?? ""}`)).toEqual([`resume:${PRIOR_THREAD}`]); // the dispatch, and no second turn
    const resumed = listRunsForItem(handle.db, item.id)[1]!;
    expect(resumed.status).toBe("awaiting_input"); // the corrected escalation landed
    expect(resumed.threadId).toBe(PRIOR_THREAD);
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toEqual(["sorry, meant @user"]);
  });

  it("still refuses at the attempt limit, before any thread is touched", async () => {
    enableReuse();
    priorRun({ initiationId: `initial:${item.id}:todo` });

    await supervisorFor({ result: validImplementResult }, { guards: { perItemAttemptLimit: 1 } }).runOnce();

    expect(turns).toEqual([]);
    const guard = listRunsForItem(handle.db, item.id).at(-1)!;
    expect(guard.status).toBe("awaiting_input");
    expect(guard.threadId).toBeNull(); // the guard placeholder, not a resumed run
  });

  it("still refuses a signed-out backend, before any thread is touched", async () => {
    enableReuse();
    priorRun();

    await supervisorFor(
      { result: validImplementResult },
      { checkAuth: async () => ({ ok: false, reason: "Not signed in." }) },
    ).runOnce();

    expect(turns).toEqual([]);
    expect(engineNotes().join("\n")).toContain("Not signed in.");
  });

  it("still refuses when the workspace cannot be prepared, before any thread is touched", async () => {
    // Asked before the reuse question for a reason: which directory the
    // dispatch got is half of whether a session can be resumed at all.
    enableReuse();
    priorRun();

    await supervisorFor(
      { result: validImplementResult },
      { kinds: installedKinds(fakeWorkspaceKind({ prepare: async () => ({ ok: false as const, reason: "The base repository is dirty." }) })) },
    ).runOnce();

    expect(turns).toEqual([]);
    expect(engineNotes().join("\n")).toContain("The base repository is dirty.");
  });

  it("aborts before the thread is touched when the item is deleted during preflight", async () => {
    enableReuse();
    priorRun();

    let releaseAuth!: () => void;
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    const auth = new Promise<{ ok: true }>((resolve) => {
      releaseAuth = () => resolve({ ok: true });
    });
    const supervisor = supervisorFor(
      { result: validImplementResult },
      {
        checkAuth: () => {
          authStarted();
          return auth;
        },
      },
    );

    const tick = supervisor.runOnce();
    await started;
    deleteItem(handle.db, item.id);
    releaseAuth();
    await tick;

    expect(turns).toEqual([]);
  });

  it("aborts before the thread is touched when a pause arrives during preflight", async () => {
    enableReuse();
    priorRun();

    let releaseAuth!: () => void;
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    const auth = new Promise<{ ok: true }>((resolve) => {
      releaseAuth = () => resolve({ ok: true });
    });
    const supervisor = supervisorFor(
      { result: validImplementResult },
      {
        checkAuth: () => {
          authStarted();
          return auth;
        },
      },
    );

    const tick = supervisor.runOnce();
    await started;
    supervisor.pause();
    releaseAuth();
    await tick;

    expect(turns).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // only the prior run
  });
});

/**
 * The whole point, driven end to end: an item goes round the pipeline
 * and comes back to the agent that already worked on it.
 *
 * Separate from the cases above because nothing here is pre-seeded — the
 * thread being resumed is one this test's own first dispatch opened, and
 * the comments it does and does not carry were written by the agents
 * themselves.
 */
describe("a full cycle back to the same agent", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, {
      type: "story",
      title: "A story",
      body: ITEM_BODY,
      spec: { acceptance_criteria: [ACCEPTANCE_CRITERION] },
      stepId: "todo",
    });
  });

  afterEach(() => {
    handle.close();
  });

  it("resumes on the second visit, and does not read the agent its own comment back", async () => {
    const agents = listAgents(handle.db);
    const implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, {
      config: { reuseThreadPerItem: true },
    });
    const reviewer = agents.find((agent) => agent.role === "reviewer")!;

    const turns: Turn[] = [];
    const record = (role: string, script: FakeProviderScript): AgentProvider => {
      const inner = createFakeProvider(script);
      return {
        start: (opts) => {
          turns.push({ kind: "start", prompt: `${role}` });
          return inner.start(opts);
        },
        resume: (threadId, message, opts) => {
          turns.push({ kind: "resume", threadId, prompt: message });
          return inner.resume(threadId, message, opts);
        },
      };
    };

    // The implementer says something on its way through. Its own words
    // are already in its thread, so they must not come back to it.
    const implementerProvider = record("implementer", {
      steps: [{ toolCall: { name: "comment", args: { body: "Left the retry logic alone for now.", blocking: false } } }],
      result: validImplementResult,
    });
    // The reviewer sends it back, and says why in the thread.
    const reviewerProvider = record("reviewer", {
      steps: [{ toolCall: { name: "comment", args: { body: "The null check is in the wrong layer.", blocking: false } } }],
      result: {
        verdict: "reject",
        feedback: "Move the check.",
        criteria_coverage: [{ criterion: "The null check is in the right layer", result: "not_met" }],
        blocking_issues: ["The null check is in the wrong layer."],
      },
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      agentWriteBridge: writes.agentWriteBridge,
      provider: (agent) => (agent.role === "reviewer" ? reviewerProvider : implementerProvider),
      kinds: kindsPreparing(CWD),
      limits: LIMITS,
      // The shipped `review` → `todo` route, without pulling the whole
      // role wiring into a supervisor test.
      resolveNextState: (current, _states, _result, action) =>
        action === "review"
          ? { stepId: "todo", pipelineId: current.pipelineId }
          : { stepId: "review", pipelineId: current.pipelineId },
    });

    writes.serve(supervisor);

    await supervisor.runOnce(); // implement, fresh thread
    await supervisor.runOnce(); // review, sends it back
    await supervisor.runOnce(); // implement again — the thread is still the agent's

    const runs = listRunsForItem(handle.db, item.id);
    const implementerRuns = runs.filter((run) => run.agentId === implementer.id);
    expect(implementerRuns).toHaveLength(2);
    expect(implementerRuns[1]?.threadId).toBe(implementerRuns[0]?.threadId); // one conversation, two visits

    expect(turns.map((turn) => turn.kind)).toEqual(["start", "start", "resume"]);
    const followUp = turns[2]!;
    expect(followUp.threadId).toBe(implementerRuns[0]?.threadId);
    // The reviewer's comment is news. The implementer's own is not — it
    // wrote it, in this very conversation.
    expect(followUp.prompt).toContain("The null check is in the wrong layer.");
    expect(followUp.prompt).not.toContain("Left the retry logic alone for now.");
    expect(followUp.prompt).not.toContain(ITEM_BODY);

    // The reviewer is not opted in, so its own dispatch is untouched.
    expect(runs.filter((run) => run.agentId === reviewer.id)).toHaveLength(1);
  });

  it("survives a park and a human reply on the way round", async () => {
    // The same cycle with a person in the middle of it. `resumeItem`
    // writes a run row of its own for the reply it is answering, and that
    // row becomes the newest one behind the thread — so it is the row the
    // *next* dispatch weighs up. Left without the instructions its thread
    // was born with it reads as "EO has no record", which is never a
    // match, and answering a question would cost the item the very
    // conversation the reply was continuing.
    const agents = listAgents(handle.db);
    const implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, {
      config: { reuseThreadPerItem: true },
    });

    const turns: Turn[] = [];
    const record = (script: FakeProviderScript): AgentProvider => {
      const inner = createFakeProvider(script);
      return {
        start: (opts) => {
          turns.push({ kind: "start", prompt: opts.context, instructions: opts.instructions });
          return inner.start(opts);
        },
        resume: (threadId, message, opts) => {
          turns.push({ kind: "resume", threadId, prompt: message });
          return inner.resume(threadId, message, opts);
        },
      };
    };

    // The implementer asks the person a question and parks on it. The
    // fake resumes a thread's script where it left off, so the reply
    // below picks up at the result.
    const implementerProvider = record({
      steps: [
        {
          toolCall: {
            name: "comment",
            args: { body: "@user which layer should the check live in?", mentions: ["user"], blocking: true },
          },
        },
      ],
      result: validImplementResult,
    });
    const reviewerProvider = record({
      result: {
        verdict: "reject",
        feedback: "Move the check.",
        criteria_coverage: [{ criterion: "The null check is in the right layer", result: "not_met" }],
        blocking_issues: ["The null check is in the wrong layer."],
      },
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      agentWriteBridge: writes.agentWriteBridge,
      provider: (agent) => (agent.role === "reviewer" ? reviewerProvider : implementerProvider),
      kinds: kindsPreparing(CWD),
      limits: LIMITS,
      resolveNextState: (current, _states, _result, action) =>
        action === "review"
          ? { stepId: "todo", pipelineId: current.pipelineId }
          : { stepId: "review", pipelineId: current.pipelineId },
    });

    writes.serve(supervisor);

    await supervisor.runOnce(); // implement — a fresh thread, parked on the question
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The importer, not the parser." });
    await supervisor.resumeItem(item.id); // the answer, on that same thread
    await supervisor.runOnce(); // review, sends it back
    await supervisor.runOnce(); // implement again — still the agent's own conversation

    const runs = listRunsForItem(handle.db, item.id);
    const implementerRuns = runs.filter((run) => run.agentId === implementer.id);
    expect(implementerRuns).toHaveLength(3); // the parked dispatch, the reply, and the dispatch after it
    const thread = implementerRuns[0]?.threadId;
    expect(thread).toBeTruthy();
    expect(implementerRuns.map((run) => run.threadId)).toEqual([thread, thread, thread]);

    // The reply's row carries the instructions its thread was born with,
    // rather than the null of a row that never sent any.
    expect(implementerRuns[1]?.instructionsHash).toBe(promptHash(implementer.instructions));

    // A start for each agent's first visit, and a resume for everything
    // that came back to a conversation already open. The dispatch after
    // the reply is the one this test is about.
    expect(turns.map((turn) => turn.kind)).toEqual(["start", "resume", "start", "resume"]);
    expect(turns[3]?.threadId).toBe(thread);
    expect(turns[3]?.prompt).not.toContain(ITEM_BODY);
    // And nothing was posted apologising for a full context it did not
    // have to assemble.
    const notes = listCommentsForItem(handle.db, item.id)
      .filter((comment) => comment.authorType === "engine")
      .map((comment) => comment.body);
    expect(notes.filter((note) => note.includes("instructions"))).toEqual([]);
  });
});

/**
 * The same delta, on the path a person's reply takes.
 *
 * `resumeItem` has always continued the conversation it is answering,
 * ticked box or not — a reply belongs to the run it replies to. What it
 * did not do was build its message the way a resumed dispatch does, and
 * the two disagreed about precisely the things this feature is for: it
 * read the agent its own comments back out of the thread it was
 * resuming, and it filtered on `createdAt` alone, so a reply landing in
 * the same millisecond its run ended was dropped — the one comment the
 * agent was most likely being woken for.
 *
 * These live here rather than beside the other `resumeItem` tests
 * because what they hold is the shared builder, not the reply.
 */
describe("a human reply resuming a parked run", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let turns: Turn[];

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, {
      type: "story",
      title: "A story",
      body: ITEM_BODY,
      spec: { acceptance_criteria: [ACCEPTANCE_CRITERION] },
      stepId: "todo",
    });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    turns = [];
  });

  afterEach(() => {
    handle.close();
  });

  /** A run parked on a mention, as `runToCompletion` leaves one: a thread, a backend and a directory. */
  function parkedRun(overrides: Partial<CreateRunInput> = {}) {
    return createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "awaiting_input",
      threadId: PRIOR_THREAD,
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
      ...overrides,
    });
  }

  function supervisorFor(script: FakeProviderScript, overrides: Partial<RunSupervisorOptions> = {}) {
    const inner = createFakeProvider(script);
    return createRunSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          turns.push({ kind: "start", prompt: opts.context, instructions: opts.instructions });
          return inner.start(opts);
        },
        resume: (threadId, message, opts) => {
          turns.push({ kind: "resume", threadId, prompt: message });
          return inner.resume(threadId, message, opts);
        },
      },
      limits: LIMITS,
      ...overrides,
    });
  }

  it("sends the reply and the task line, and not the agent's own comments", async () => {
    const parked = updateRun(handle.db, parkedRun().id, { startedAt: 1_000, endedAt: 1_000 });
    // What the agent said on its way to parking. It is already in the
    // conversation being resumed — it wrote it there — so sending it back
    // is the same waste on this path as on the automatic one.
    postComment(handle.db, {
      itemId: item.id,
      runId: parked.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which layer should the check live in?",
    });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The importer, not the parser." });

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.threadId).toBe(PRIOR_THREAD);
    const prompt = turns[0]?.prompt ?? "";
    expect(prompt).toContain("The importer, not the parser.");
    expect(prompt).not.toContain("@user which layer should the check live in?");
    // The task line the shared builder renders — which the hand-rolled
    // one this replaced never had — and none of what the thread holds.
    expect(prompt).toContain('perform the "implement" action');
    expect(prompt).not.toContain(ITEM_BODY);
  });

  it("starts a fresh run that lists the file, with a comment, when a file was put on the item while the run was parked (EO-703)", async () => {
    updateRun(handle.db, parkedRun().id, { startedAt: 1_000, endedAt: 1_000 });
    const fileId = uuidv7();
    addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The mock is on the item now." });

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(`- ID: ${fileId}; name: mock.png; MIME type: image/png`);
    expect(turns[0]?.prompt).toContain("The mock is on the item now.");
    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine").map((comment) => comment.body);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("The files on this item have changed");
  });

  it("starts fresh with the reply and the file, saying why once, when a file lands while the reply is being prepared (EO-703)", async () => {
    const parked = updateRun(handle.db, parkedRun().id, { startedAt: 1_000, endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use the importer, not the parser." });
    // Put on the item while the workspace is being attached — after the
    // thread passed `resumeBlockedReason`, before the backend is reached.
    const fileId = uuidv7();
    let landed = false;
    const kinds = installedKinds(
      fakeWorkspaceKind({
        cwd: CWD,
        attach: async () => {
          if (!landed) {
            landed = true;
            addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
          }
          return NOTHING_ATTACHED;
        },
      }),
    );

    await supervisorFor({ result: validImplementResult }, { kinds }).resumeItem(item.id);

    expect(landed).toBe(true);
    expect(turns.map((turn) => turn.kind)).toEqual(["start"]);
    expect(turns[0]?.prompt).toContain(`- ID: ${fileId}; name: mock.png; MIME type: image/png`);
    // The reply is not lost behind the row that never reached a backend.
    expect(turns[0]?.prompt).toContain("Use the importer, not the parser.");
    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine").map((comment) => comment.body);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("The files on this item changed while");
    const closed = listRunsForItem(handle.db, item.id).find((run) => run.id !== parked.id && run.status === "cancelled");
    expect(closed).toMatchObject({ threadId: null });
  });

  it("still resumes the parked thread when the item's files are the ones it was told about (EO-703)", async () => {
    const fileId = uuidv7();
    addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);
    updateRun(handle.db, parkedRun({ itemFilesHash: itemFilesHash(handle.db, item.id) }).id, { startedAt: 1_000, endedAt: 1_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.threadId).toBe(PRIOR_THREAD);
    // The resumed run records the list its thread holds, so the next dispatch can carry it on too.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.itemFilesHash).toBe(itemFilesHash(handle.db, item.id));
  });

  it("carries a reply that landed in the same millisecond the run ended", async () => {
    // Ids rather than the clock: the run row is minted first, the reply
    // second, so `(createdAt, id)` can tell them apart where `createdAt`
    // alone cannot. On a bare `>` this reply is dropped and the agent is
    // resumed with nothing new to read.
    const run = parkedRun();
    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });
    const parked = updateRun(handle.db, run.id, { startedAt: reply.createdAt - 1, endedAt: reply.createdAt });

    expect(parked.endedAt).toBe(reply.createdAt); // the premise: one millisecond, two rows
    expect(reply.id > parked.id).toBe(true); // and the order that settles it

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    expect(turns[0]?.prompt).toContain("Go ahead.");
  });

  it("carries a new comment's attachment metadata, exactly as the renderer it replaced did", async () => {
    // The one thing the hand-rolled renderer did that had to survive
    // being deleted. An agent that cannot see an attachment's id cannot
    // ask `attachment_read` for its content — this line is the only
    // handle it gets, and the storage path is deliberately not on it.
    // Asserted through `resumeItem` and not only on the builder
    // because what this story changed is which renderer this path
    // reaches, and a metadata line is exactly the kind of detail a swap
    // like that drops in silence.
    updateRun(handle.db, parkedRun().id, { startedAt: 1_000, endedAt: 1_000 });
    const reply = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "The rows it drops are in here.",
    });
    const attachmentId = uuidv7();
    insertAttachments(handle.db, [{
      id: attachmentId,
      itemId: item.id,
      commentId: reply.id,
      storagePath: "/private/eo/managed/rows.csv",
      name: "rows.csv",
      mimeType: "text/csv",
      size: 128,
    }]);

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    const prompt = turns[0]?.prompt ?? "";
    expect(prompt).toContain(
      `ID: ${attachmentId}; name: rows.csv; MIME type: text/csv; size: 128 bytes; origin: eo; synchronization state: local`,
    );
    expect(prompt).not.toContain("/private/eo/managed/rows.csv"); // metadata only, never the path
  });

  it("does not resume an agent archived while its run was parked, and closes the park instead", async () => {
    // The one route a retired agent could still be started down
    // (EO-186): a reply is what unparks a parked run, and it comes
    // through here rather than through the scheduler or a mention. Left
    // alone this resumed the retired agent's own conversation.
    const parked = parkedRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });
    archiveAgent(handle.db, implementer.id);

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    // Neither half: no thread resumed, and no fresh run started in its
    // place either.
    expect(turns).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([parked.id]);

    // The park is released rather than left standing. `awaiting_input`
    // on the newest run is what keeps the scheduler away, so a park
    // nobody can ever answer is an item stuck for good.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("has since been archived");
    expect(note?.body).toContain('give the "implementer" role another agent');

    // And a second reply does not start it either — the refusal is not
    // a one-tick condition, it is the row.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Still there?" });
    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);
    expect(turns).toEqual([]);
  });

  it("does not resume a thread when the agent is archived while its context is being built", async () => {
    // The window the check before the await cannot see (EO-186).
    // `buildContext` is asynchronous — a review turn reads the pull
    // request template off disk — so a person can retire the agent
    // between "this reply may resume" and the resume itself, which is
    // the last moment before the retired agent's own conversation is
    // handed back to it.
    const parked = parkedRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });

    await supervisorFor(
      { result: validImplementResult },
      {
        buildContext: (_db, _item, agent) => {
          archiveAgent(handle.db, agent.id);
          return "the context this reply will never send";
        },
      },
    ).resumeItem(item.id);

    // The provider was never reached, in either direction.
    expect(turns).toEqual([]);
    // No queued run was written for the resume it was about to make.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([parked.id]);
    // And the same answer as the earlier check gives, because it is the
    // same fact: the park is closed rather than left where nothing can
    // ever answer it, and the thread says why.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("has since been archived");
    expect(note?.body).toContain('give the "implementer" role another agent');
  });

  it("does not resume a thread when the agent is archived while the query server is resolved", async () => {
    // The last await before the backend is spoken to (EO-186), and the
    // one where the run row already exists: a parked conversation can
    // wait days for a reply, so the index behind it is resolved again on
    // the way out, and a person can retire the agent while that happens.
    const parked = parkedRun();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });

    await supervisorFor(
      { result: validImplementResult },
      {
        // The last await before the backend is spoken to: whatever the
        // workspace lends is resolved there, and this archives the agent
        // inside it.
        kinds: installedKinds(
          fakeWorkspaceKind({
            cwd: CWD,
            attach: async (_item, agent) => {
              archiveAgent(handle.db, agent.id);
              return NOTHING_ATTACHED;
            },
          }),
        ),
      },
    ).resumeItem(item.id);

    // Never resumed.
    expect(turns).toEqual([]);
    // The run row that had been written is closed rather than left
    // running for a reconciliation to find, and it says why.
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    const resumeRun = runs.find((run) => run.id !== parked.id)!;
    expect(resumeRun.status).toBe("cancelled");
    expect(resumeRun.error).toContain("was archived before this resume reached");
    // …and the park it was continuing goes with it, so the item is not
    // left waiting on a conversation nothing will ever pick up.
    expect(runs.find((run) => run.id === parked.id)?.status).toBe("cancelled");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note?.body).toContain("has since been archived");
  });

  it("does not start a fresh run for an archived agent when the parked thread cannot be carried over", async () => {
    // The other branch of the same function: a thread that cannot be
    // resumed — here because the backend changed under it — falls back
    // to a *fresh* dispatch, which is a provider start like any other
    // and must not happen either.
    // A thread born on another backend cannot be carried over, which is
    // what sends this down the fresh-dispatch branch.
    const parked = parkedRun({ provider: "codex" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });
    archiveAgent(handle.db, implementer.id);

    await supervisorFor({ result: validImplementResult }).resumeItem(item.id);

    expect(turns).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([parked.id]);
  });

  it("agrees with the deferred-reply sweep about which comment is new", async () => {
    // The latent bug this story closes, from both ends at once. Two
    // things decide what counts as new: `deferredReplyItemIds` decides
    // *that* a reply is waiting, and the delta builder decides *what*
    // gets sent. They now share one rule, so a reply sharing a
    // millisecond with the run's end has to survive both of them.
    //
    // Reached through the tick rather than `resumeItem` directly,
    // because the sweep is the half only the tick exercises. Split, this
    // fails at whichever end kept the bare `>`: the item never wakes,
    // or it wakes with nothing to read.
    const run = parkedRun();
    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });
    const parked = updateRun(handle.db, run.id, { startedAt: reply.createdAt - 1, endedAt: reply.createdAt });

    expect(parked.endedAt).toBe(reply.createdAt); // the premise: one millisecond, two rows
    expect(reply.id > parked.id).toBe(true); // and the order that settles it

    await supervisorFor({ result: validImplementResult }).runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(turns[0]?.prompt).toContain("Go ahead.");
  });
});
