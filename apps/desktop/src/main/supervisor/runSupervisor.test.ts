import { LOCAL_PERSON_ID, McpServerDraftSchema, parsedResultOf, type Agent, type Item, UNSCOPED_RUN } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAttachmentsHash, EMPTY_ATTACHMENTS_HASH } from "../agentAttachments/fingerprint.js";
import { listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { listCommentsForItem, needsAttention, postComment } from "../db/repos/commentsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { deleteItem, getItem } from "../db/repos/itemsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import type { DbHandle } from "../db/client.js";
import { comments, commentMentions } from "../db/schema.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { promptHash } from "../roles/prompts.js";
import { blockingEscalationFixture, crashMidStreamFixture, happyPathFixture, validImplementResult, validImplementResultParsed } from "../providers/fixtures.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { hourlyClock } from "../testing/clock.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

describe("createRunSupervisor", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    writes = await startTestWriteBridge();
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  /**
   * A supervisor whose agents' comments reach it over the agent write
   * bridge, as a real `eo` server's do (EO-543). Without one a scripted
   * `comment` call is only said, never made — nothing is posted and no
   * blocking comment parks the run — so every test about what an agent's
   * comment does is driven through this.
   */
  function writingSupervisor(options: Omit<RunSupervisorOptions, "agentWriteBridge">): RunSupervisor {
    const supervisor = createRunSupervisor({ ...options, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(supervisor);
    return supervisor;
  }

  it("routes each agent to its own backend, so one project can mix providers (A-06)", async () => {
    // Provider choice was a single value chosen by majority vote across
    // the agents table. Reviewing Codex's work with Claude is an obvious
    // thing to want, and the majority rule silently gave the minority
    // agent someone else's backend.
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    updateAgent(handle.db, implementer.id, { provider: "codex" });
    updateAgent(handle.db, reviewer.id, { provider: "claude" });

    const asked: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: (agent) => {
        asked.push(agent.provider);
        return inner;
      },
      limits: LIMITS,
    });

    await supervisor.runOnce();

    expect(asked).toEqual(["codex"]); // the implementer's own, not a project-wide winner
  });

  it("records the instructions the dispatched thread was started with", async () => {
    // Neither backend re-sends instructions on resume, so the run row is
    // the only record of which ones this thread was born with (EO-87).
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(happyPathFixture), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.instructionsHash).toBe(promptHash(implementer.instructions));
  });

  it("records the tool surface the dispatched thread was started with", async () => {
    // The other half of what a session opens with, and recorded for the
    // same reason (EO-106): no backend re-sends configuration on resume
    // either, so this row is the only record of which servers and skills
    // the thread was born with. An agent with nothing attached still
    // records an answer — the empty surface is a surface.
    const github = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
    expect(github.ok).toBe(true);
    if (!github.ok) return;
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: github.server.id, attached: true });

    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(happyPathFixture), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.agentAttachmentsHash).toBe(agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN));
    expect(run?.agentAttachmentsHash).not.toBe(EMPTY_ATTACHMENTS_HASH);
  });

  it("silently defers dispatch while a managed provider is updating", async () => {
    let providerAsked = false;
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: () => {
        providerAsked = true;
        return createFakeProvider({ result: validImplementResult });
      },
      isAgentAvailable: () => false,
      limits: LIMITS,
    });

    await supervisor.runOnce();

    expect(providerAsked).toBe(false);
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(handle.db.select().from(comments).all()).toEqual([]);
  });

  it("rechecks runtime availability after async preflight before admitting a run", async () => {
    let available = true;
    let releaseAuth!: () => void;
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => { authStarted = resolve; });
    const auth = new Promise<{ ok: true }>((resolve) => { releaseAuth = () => resolve({ ok: true }); });
    const inner = createFakeProvider({ result: validImplementResult });
    const start = vi.fn(inner.start);
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...inner, start },
      isAgentAvailable: () => available,
      checkAuth: () => {
        authStarted();
        return auth;
      },
      limits: LIMITS,
    });

    const tick = supervisor.runOnce();
    await started;
    available = false; // the main-process disable command landed during preflight
    releaseAuth();
    await tick;

    expect(start).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("does not dispatch a request whose item is deleted during preflight", async () => {
    let releaseAuth!: () => void;
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    const auth = new Promise<{ ok: true }>((resolve) => {
      releaseAuth = () => resolve({ ok: true });
    });
    const inner = createFakeProvider({ result: validImplementResult });
    const start = vi.fn(inner.start);
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...inner, start },
      checkAuth: () => {
        authStarted();
        return auth;
      },
      limits: LIMITS,
    });

    const run = supervisor.runOnce();
    await started;
    deleteItem(handle.db, item.id);
    releaseAuth();
    await run;

    expect(start).not.toHaveBeenCalled();
    expect(getItem(handle.db, item.id)).toBeUndefined();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("a fake-provider run goes queued -> running -> succeeded, moves the item, and writes a transitions row", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 30, output: "working" }], result: validImplementResult }),
      limits: LIMITS,
    });

    const runPromise = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the run row get created and start

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("running"); // caught mid-flight, before the scripted sleep resolves

    await runPromise;

    const finished = getRun(handle.db, run!.id)!;
    expect(finished.status).toBe("succeeded");
    expect(parsedResultOf(finished.result)).toEqual(validImplementResultParsed);

    const updatedItem = getItem(handle.db, item.id);
    expect(updatedItem?.stepId).toBe("review"); // next position after "todo" in the seeded pipeline

    const transitions = listTransitionsForItem(handle.db, item.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStepId: "todo", toStepId: "review", actor: implementer.id });
  });

  it("cancelling mid-run marks the run cancelled", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 2000, output: "should never arrive" }] }),
      limits: LIMITS,
    });

    const runPromise = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toBeDefined();
    supervisor.cancelRun(run!.id);

    const started = Date.now();
    await runPromise;
    expect(Date.now() - started).toBeLessThan(500); // well under the scripted 2000ms sleep

    expect(getRun(handle.db, run!.id)?.status).toBe("cancelled");
  });

  it("a provider throwing mid-stream marks the run failed and preserves the partial event log", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(crashMidStreamFixture), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("simulated provider crash");

    const events = listRunEvents(handle.db, run!.id);
    expect(events.some((event) => event.type === "output")).toBe(true); // the step before the throw was preserved
  });

  it("a blocking escalation ends the run awaiting_input and posts the comment, without transitioning the item", async () => {
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(blockingEscalationFixture), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.threadId).toBeTruthy(); // persisted so it can be resumed later
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // unchanged — an escalation isn't a success
  });

  it("the scheduler skips an item whose last run is awaiting_input, on the very next tick", async () => {
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(blockingEscalationFixture), limits: LIMITS });

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);

    await supervisor.runOnce(); // a second tick must not dispatch a new run for the same item
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("a non-blocking comment posts and the run continues to completion — the pipeline doesn't stall", async () => {
    const script: FakeProviderScript = {
      steps: [
        { toolCall: { name: "comment", args: { body: "fyi, starting now", blocking: false } } },
        { output: "still working" },
      ],
      result: validImplementResult,
    };
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded"); // reached the result — the comment didn't end the run
    expect(getItem(handle.db, item.id)?.stepId).toBe("review"); // normal success transition still happened

    const posted = handle.db.select().from(comments).all();
    expect(posted.some((comment) => comment.body === "fyi, starting now")).toBe(true);
  });

  it("an unknown mention is refused in the tool's answer, and the agent's corrected call in the same turn parks the run", async () => {
    // Before EO-543 an invalid call was the run's problem: EO posted
    // nothing and opened a correction turn on the thread. Now the write is
    // refused as it is made and the agent hears why in the tool's answer,
    // while it can still fix the call — so nothing is posted, no second
    // turn is opened, and the corrected call is simply the next one.
    const script: FakeProviderScript = {
      steps: [
        { toolCall: { name: "comment", args: { body: "need help", mentions: ["not-a-real-agent"], blocking: true } } },
        { toolCall: { name: "comment", args: { body: "sorry, meant @user", mentions: ["user"], blocking: true } } },
      ],
    };
    const turns: string[] = [];
    const inner = createFakeProvider(script);
    const supervisor = writingSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          turns.push("start");
          return inner.start(opts);
        },
        resume: (threadId, message, opts) => {
          turns.push("resume");
          return inner.resume(threadId, message, opts);
        },
      },
      limits: LIMITS,
    });

    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("awaiting_input"); // the corrected call's blocking comment ended the run
    expect(turns).toEqual(["start"]); // no correction turn

    // The refusal is what the agent was answered, and it says why. (The
    // corrected call's answer is not recorded: its blocking comment ended
    // the turn as it was posted, before the backend could say more.)
    const refusal = listRunEvents(handle.db, runs[0]!.id)
      .filter((event) => event.type === "tool_result")
      .map((event) => event.payload as { ok: boolean; output: string })[0];
    expect(refusal?.ok).toBe(false);
    expect(refusal?.output).toContain("MENTION_REFUSED");
    expect(refusal?.output).toContain("not posted");

    const posted = handle.db.select().from(comments).all();
    // The refused call never got posted — only the corrected one did.
    expect(posted.map((comment) => comment.body)).toEqual(["sorry, meant @user"]);
  });

  it("the mention-depth cap trips and redirects to the human rather than looping agent-to-agent", async () => {
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;

    // Pre-seed the item right up to the cap with prior escalations.
    for (let i = 0; i < 5; i++) {
      postComment(handle.db, {
        itemId: item.id,
        author: { type: "agent", agentId: i % 2 === 0 ? implementer.id : reviewer.id },
        body: "over to you",
        mentions: [{ type: "agent", agentId: i % 2 === 0 ? reviewer.id : implementer.id }],
        kind: "escalation",
      });
    }

    const script: FakeProviderScript = {
      steps: [{ toolCall: { name: "comment", args: { body: "need a review", mentions: ["reviewer"], blocking: true } } }],
    };
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();

    const newestMention = handle.db.select().from(commentMentions).all().at(-1);
    expect(newestMention?.targetType).toBe("human"); // redirected, not sent to the reviewer agent
    expect(newestMention?.targetId).toBe(LOCAL_PERSON_ID); // and at the person, not at nobody (EO-302)
  });

  it("resume path: a human reply resumes the same thread and the agent picks up where it left off", async () => {
    const script: FakeProviderScript = {
      steps: [
        { output: "investigating" },
        { toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } },
        { output: "thanks, continuing with what you said" },
      ],
      result: validImplementResult,
    };
    let selectedRuntime: "managed" | "configured" = "managed";
    const supervisor = writingSupervisor({
      db: handle.db,
      provider: createFakeProvider(script),
      runtimeSource: () => selectedRuntime,
      limits: LIMITS,
    });

    await supervisor.runOnce();
    const [firstRun] = listRunsForItem(handle.db, item.id);
    expect(firstRun?.status).toBe("awaiting_input");
    const threadId = firstRun!.threadId;
    expect(threadId).toBeTruthy();
    expect(firstRun?.runtimeSource).toBe("managed");

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    selectedRuntime = "configured";

    await supervisor.resumeItem(item.id);

    const runs = listRunsForItem(handle.db, item.id).sort((a, b) => a.attempt - b.attempt);
    expect(runs).toHaveLength(2);
    const [, secondRun] = runs;
    expect(secondRun?.attempt).toBe(2);
    expect(secondRun?.threadId).toBe(threadId); // same thread — prior context intact, not a fresh start
    expect(secondRun?.runtimeSource).toBe("configured"); // this resumed subprocess uses the newly configured executable
    expect(secondRun?.status).toBe("succeeded");

    const events = listRunEvents(handle.db, secondRun!.id);
    expect(events.some((event) => event.type === "output")).toBe(true); // continued past the escalation, not replaying it
  });

  it("hands a reply to the newest parked run when two of them share a millisecond", async () => {
    // Which run a reply belongs to is decided three other places — the
    // scheduler's skip list, the deferred-reply sweep, and this — and they
    // have to agree. `startedAt` alone does not settle it: two runs can
    // park in the same millisecond and `listRunsForItem` has no ORDER BY,
    // so the tie falls to whatever order SQLite happened to return. Ids
    // are minted monotonically precisely to break it (see uuidv7).
    //
    // Ordered wrongly, the reply goes to the older run — here the guard
    // placeholder, which has no thread — and a conversation that should
    // have continued starts again from nothing.
    const parkedAt = 1_000;
    const refusal = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "awaiting_input",
      initiationId: "initiation-1",
    });
    updateRun(handle.db, refusal.id, { startedAt: parkedAt, endedAt: parkedAt, error: "stopped after 3 attempt(s)" });
    const parked = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "awaiting_input",
      threadId: "thread-x",
      provider: "fake",
      initiationId: "initiation-2",
    });
    updateRun(handle.db, parked.id, { startedAt: parkedAt, endedAt: parkedAt });
    expect(parked.id > refusal.id).toBe(true); // what the tie-break leans on

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Go ahead." });

    const turns: string[] = [];
    const inner = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          turns.push("start");
          return inner.start(opts);
        },
        resume: (threadId, message, opts) => {
          turns.push(`resume:${threadId}`);
          return inner.resume(threadId, message, opts);
        },
      },
      limits: LIMITS,
    });

    await supervisor.resumeItem(item.id);

    expect(turns).toEqual(["resume:thread-x"]);
  });

  it("keeps a reply posted while paused and resumes it on the next open-gate tick", async () => {
    const provider = createFakeProvider({
      steps: [{ toolCall: { name: "comment", args: { body: "@user proceed?", mentions: ["user"], blocking: true } } }],
      result: validImplementResult,
    });
    const supervisor = writingSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();
    const [parked] = listRunsForItem(handle.db, item.id);
    expect(parked?.status).toBe("awaiting_input");

    supervisor.pause();
    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Proceed." });
    await supervisor.resumeItem(item.id);
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);

    supervisor.resume();
    await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: "succeeded", threadId: parked?.threadId });
    expect(reply.body).toBe("Proceed.");
  });

  it("an agent's comment cannot mark a human-targeted mention addressed, even via the comment tool", async () => {
    // Once escalated, the scheduler skips this item entirely (E-02
    // condition 3) until it's resumed — so the only way to get a second
    // agent-authored comment onto it is through resumeItem(), not
    // another plain dispatch.
    const script: FakeProviderScript = {
      steps: [
        { toolCall: { name: "comment", args: { body: "@user please look", mentions: ["user"], blocking: true } } },
        { toolCall: { name: "comment", args: { body: "unrelated note", blocking: false } } },
      ],
      result: validImplementResult,
    };
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();
    expect(needsAttention(handle.db, item.id)).toBe(true);

    await supervisor.resumeItem(item.id); // agent posts again (non-blocking), then succeeds

    expect(needsAttention(handle.db, item.id)).toBe(true); // still open — the agent's second post didn't resolve it
  });

  it("stamps a mid-run comment with the run that wrote it, so it can be placed at a step", async () => {
    // Without this every comment an agent writes *while working* has no
    // run, and a seeded dispatch cannot say which step it belongs to —
    // the largest population of comments that could go unplaced.
    const script: FakeProviderScript = {
      steps: [{ toolCall: { name: "comment", args: { body: "a note from the middle of the work", blocking: false } } }],
      result: validImplementResult,
    };
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();

    const written = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("from the middle of the work"));
    expect(written?.runId).toBe(listRunsForItem(handle.db, item.id).at(-1)?.id);
  });

  it("does not let an agent open a mention by writing @someone in prose", async () => {
    // The back door into "ask a person" that KAN-29 closed at the front:
    // `postComment` parses a body for mentions by default, so a note
    // mentioning a person would raise an Inbox row and a `!` on the
    // item without ever going through `clarification_required`.
    const script: FakeProviderScript = {
      steps: [{ toolCall: { name: "comment", args: { body: "asked @user about the limit", blocking: false } } }],
      result: validImplementResult,
    };
    const supervisor = writingSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();

    // Posted — so the absence of a mention is the rule, not a comment that never arrived.
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body === "asked @user about the limit")).toBe(true);
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("throttles renderer push — a 10k-event run does not lock up the UI", async () => {
    const steps = Array.from({ length: 10_000 }, (_, i) => ({ output: `line ${i}` }));
    let clock = 0;
    const pushCalls: number[] = [];

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps, result: validImplementResult }),
      limits: LIMITS,
      now: () => (clock += 1), // deterministic: each check advances the clock by 1
      onPushEvents: (_runId, events) => pushCalls.push(events.length),
    });

    await supervisor.runOnce();

    expect(pushCalls.length).toBeLessThan(100); // far fewer push calls than events — coalesced, not one-per-event
    // Every event still reaches the renderer eventually: the 10k output
    // events plus thread_started and the final result.
    expect(pushCalls.reduce((sum, n) => sum + n, 0)).toBe(steps.length + 2);
  });

  it("graceful shutdown mid-run cancels the run, leaving a clean, reconcilable DB state", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 200, output: "slow" }], result: validImplementResult }),
      limits: LIMITS,
    });

    const runPromise = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await supervisor.shutdown();
    await runPromise;

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("cancelled");
    // The DB is still fully queryable afterwards — nothing was left corrupted.
    expect(() => listRunEvents(handle.db, run!.id)).not.toThrow();
  });

  it("uses a custom resolveNextState when the default next-position behavior isn't right for the action", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(happyPathFixture),
      limits: LIMITS,
      // e.g. a hypothetical "send back" outcome. The pipeline comes off the
      // step the item is on, which is the one `review` belongs to.
      resolveNextState: (current) => ({ stepId: "review", pipelineId: current.pipelineId }),
    });

    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("notifyStateChange() triggers a debounced tick without waiting for the interval", async () => {
    // A script that never completes within the test, so the item
    // start() dispatches stays "running" throughout — isolating what
    // notifyStateChange() itself causes, rather than counting pipeline
    // hops through an instantly-completing fixture.
    const supervisor: RunSupervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 60_000 }] }),
      limits: LIMITS,
      tickIntervalMs: 60_000, // effectively disabled for this test
      debounceMs: 10,
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the startup tick dispatch the existing item
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);

    const secondItem = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    supervisor.notifyStateChange();
    await new Promise((resolve) => setTimeout(resolve, 100)); // past debounceMs, well under the disabled interval

    const secondItemRuns = listRunsForItem(handle.db, secondItem.id);
    expect(secondItemRuns).toHaveLength(1); // picked up promptly, not waiting for the interval

    supervisor.stop();
    for (const run of [...listRunsForItem(handle.db, item.id), ...secondItemRuns]) {
      supervisor.cancelRun(run.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 10)); // let cancellations settle before the DB closes
  });

  it("notifyStateChange({ promptly }) does not wait out the debounce, for a person's own send", async () => {
    const supervisor: RunSupervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 60_000 }] }),
      limits: LIMITS,
      tickIntervalMs: 60_000,
      debounceMs: 30_000, // a debounce no test would wait out
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondItem = createTestItem(handle.db, { type: "story", title: "Second", stepId: "todo" });
    // An ordinary signal first, then a prompt one: the prompt one wins.
    supervisor.notifyStateChange();
    supervisor.notifyStateChange({ promptly: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const secondItemRuns = listRunsForItem(handle.db, secondItem.id);
    expect(secondItemRuns).toHaveLength(1);

    supervisor.stop();
    for (const run of [...listRunsForItem(handle.db, item.id), ...secondItemRuns]) {
      supervisor.cancelRun(run.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("a tool_call claiming to set item state directly has no effect — only transitionItem() can move it", async () => {
    // Nothing in executeDispatch interprets a tool_call's args as a state
    // mutation, no matter what it claims — only the "comment" tool name
    // with blocking:true is special-cased (escalation), and even that
    // never writes items.stepId, only postComment(). This run ends
    // without a result, so it should fail, and the item must stay put.
    const script: FakeProviderScript = {
      steps: [{ toolCall: { name: "set_ticket_state", args: { stepId: "ready_to_merge" } } }],
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(script), limits: LIMITS });

    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  /**
   * What EO will not do for this agent, said once (EO-108).
   *
   * Unlike `checkAuth`, this does not refuse the dispatch: the servers
   * are still delivered and still worth having, and the only thing
   * missing is a value. Invariant 8 with nothing dropped rather than
   * nothing said.
   */
  describe("dispatch notices", () => {
    it("posts the notice as an engine note and still dispatches", async () => {
      const supervisor = createRunSupervisor({
        db: handle.db,
        provider: createFakeProvider(happyPathFixture),
        dispatchNotices: () => ['"github" declares a value EO will not carry.'],
        limits: LIMITS,
      });

      await supervisor.runOnce();

      const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
      expect(notes.map((note) => note.body)).toContain('"github" declares a value EO will not carry.');
      expect(notes.every((note) => note.kind !== "escalation")).toBe(true);
      // The dispatch went ahead: a notice is not a refusal.
      expect(listRunsForItem(handle.db, item.id)).not.toEqual([]);
    });

    it("says it once however many times the item is dispatched", async () => {
      // The failure this guards. The notice describes configuration, not
      // this run, and EO cannot see the person fixing it — the fix lands
      // in a file EO deliberately does not read. One note per dispatch
      // would repeat on every step of every item, forever, which is how
      // a guard comment gets tuned out.
      const notice = '"github" declares a value EO will not carry.';
      // A run that fails leaves the item where it was, so the next tick
      // dispatches it again — which is the real shape of the repetition
      // this guards, and it means the second dispatch is genuine rather
      // than forced. The run count is asserted below so this cannot pass
      // for having only ever dispatched once.
      const supervisor = createRunSupervisor({
        db: handle.db,
        provider: createFakeProvider(crashMidStreamFixture),
        dispatchNotices: () => [notice],
        limits: LIMITS,
        // Past the retry backoff by the next tick.
        now: hourlyClock(),
      });

      await supervisor.runOnce();
      await supervisor.runOnce();

      expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(1);
      const said = listCommentsForItem(handle.db, item.id).filter((comment) => comment.body === notice);
      expect(said).toHaveLength(1);
    });

    it("says it again when the sentence changes, because the set it names did", async () => {
      // Attaching a second declaring server changes the body, and that is
      // deliberately what makes it speak again: the person is being told
      // about a set, and the set is different.
      const first = createRunSupervisor({
        db: handle.db,
        provider: createFakeProvider(happyPathFixture),
        dispatchNotices: () => ['"github" declares a value EO will not carry.'],
        limits: LIMITS,
      });
      await first.runOnce();

      const second = createRunSupervisor({
        db: handle.db,
        provider: createFakeProvider(happyPathFixture),
        dispatchNotices: () => ['"github", "linear" declare a value EO will not carry.'],
        limits: LIMITS,
      });
      await second.runOnce();

      const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
      expect(bodies).toContain('"github" declares a value EO will not carry.');
      expect(bodies).toContain('"github", "linear" declare a value EO will not carry.');
    });
  });

});
