import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_IDLE_BEFORE_REVIEW_MS,
  FOLDER_KIND,
  LEARNING_REVIEW_EVENT,
  MEMORY_NOTE_TOOL_NAME,
  SKILL_PATCH_TOOL_NAME,
  SKILL_VIEW_TOOL_NAME,
  SYSTEM_ROLE,
  type Agent,
  type AgentEvent,
  type AgentForkResult,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type AgentWriteAnswer,
  type AgentWriteRequest,
  type Item,
  type LearningReviewEvent,
  type MemoryScope,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addMemory,
  appendSyncedRunEvents,
  createProject,
  createWorkspace,
  getMemory,
  getSkill,
  listAgents,
  listCommentsForItem,
  listMemories,
  listRunEvents,
  listRunsForItem,
  listSkillVersions,
  postComment,
  saveSkill,
  setAgentAttachment,
  updateAgent,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendAgentWrite } from "../mcp/writeBridge.js";
import { createLocalRecord } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import { openAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
/** The notice a chat's turn posts when it cannot resume its thread because what its agent is given changed. */
const ATTACHMENTS_CHANGED = /The MCP servers[^.]* attached to .* have changed/;

/** What the scripted review on a fork does: the writes it asks EO for, then whether it waits to be stopped. */
interface ReviewScript {
  /** Each write, or one made from the answers to those before it — a note replacing one the review wrote. */
  writes: (AgentWriteRequest | ((answers: readonly AgentWriteAnswer[]) => AgentWriteRequest))[];
  /** The first review waits for its turn's signal before ending, as one the person interrupts would. */
  hang?: boolean;
}

/**
 * An assistant chat is reviewed once it has gone quiet, not after every
 * reply (EO-788): an `assist` run ends without a learning review, and once
 * `CHAT_IDLE_BEFORE_REVIEW_MS` has passed with nothing said, one review
 * runs in the background on a fork of the newest run's thread, holding its
 * writes until it ends.
 */
describe("the learning review of a quiet assistant chat", () => {
  let handle: DbHandle;
  let folder: string;
  let writes: TestWriteBridge;
  let project: MemoryScope;
  let chat: Item;
  let system: Agent;
  let clock: number;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-quiet-chat-"));
    const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
    project = { kind: "project", id: p.id };
    chat = openAssistConversation(handle.db, p.id as Uuid);
    system = listAgents(handle.db).find((agent) => agent.role === SYSTEM_ROLE)!;
    clock = Date.now();
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * A backend for the chat's turns — a thread started once and resumed
   * after — whose fork plays `review`, recording what it was asked.
   */
  function backend(review: ReviewScript) {
    const starts: string[] = [];
    const resumes: string[] = [];
    const forks: { threadId: string; opts: AgentProviderResumeOptions }[] = [];
    const answers: AgentWriteAnswer[] = [];
    let sessions = 0;
    let reviewStarted: () => void = () => {};
    const reviewing = new Promise<void>((resolve) => {
      reviewStarted = resolve;
    });
    async function* turn(threadId: string): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId };
      yield { type: "result", data: { message: `Answered on ${threadId}.`, questions: [], proposals: [] } };
    }
    const provider: AgentProvider = {
      start() {
        const threadId = `session-${String((sessions += 1))}`;
        starts.push(threadId);
        return turn(threadId);
      },
      resume(threadId) {
        resumes.push(threadId);
        return turn(threadId);
      },
      async fork(threadId, _message, opts): Promise<AgentForkResult> {
        forks.push({ threadId, opts: opts ?? {} });
        const forkId = `fork-of-${threadId}`;
        async function* events(): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: forkId, model: "the-agents-model" };
          for (const write of review.writes) answers.push(await sendAgentWrite(opts!.writeBridge!, typeof write === "function" ? write(answers) : write));
          reviewStarted();
          if (review.hang && forks.length === 1) await new Promise<void>((resolve) => opts!.signal!.addEventListener("abort", () => resolve(), { once: true }));
          yield { type: "output", text: "Saved what was worth saving." };
        }
        return { ok: true, threadId: forkId, events: events() };
      },
    };
    return { provider, starts, resumes, forks, answers, reviewing };
  }

  function supervisorOver(provider: AgentProvider, record?: ItemRecord): RunSupervisor {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      ...(record === undefined ? {} : { record }),
      limits: LIMITS,
      now: () => clock,
      agentWriteBridge: writes.agentWriteBridge,
      onRunSucceeded: (item, agent, action, parsedResult, runId) => {
        if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
      },
    });
    writes.serve(supervisor);
    return supervisor;
  }

  /** The person's message, and the turn it starts run to its end. */
  async function say(supervisor: RunSupervisor, body: string): Promise<void> {
    postComment(handle.db, { itemId: chat.id, author: { type: "human" }, body, mentions: [{ type: "agent", agentId: system.id }] });
    await supervisor.runOnce();
  }

  /** Time passing with nothing said, and the tick that looks. */
  async function quiet(supervisor: RunSupervisor, ms: number): Promise<void> {
    clock += ms;
    await supervisor.runOnce();
  }

  const runs = () => listRunsForItem(handle.db, chat.id).filter((run) => run.action === ASSIST_ACTION);
  const reviewEvents = () => runs().flatMap((run) => listRunEvents(handle.db, run.id).filter((event) => event.type === LEARNING_REVIEW_EVENT).map((event) => ({ runId: run.id, payload: event.payload })));
  const notices = () => listCommentsForItem(handle.db, chat.id).filter((comment) => ATTACHMENTS_CHANGED.test(comment.body));
  const note = (text: string, replaces?: string[]): AgentWriteRequest => ({ tool: MEMORY_NOTE_TOOL_NAME, args: { scope: "project", text, ...(replaces === undefined ? {} : { replaces }) } });
  /** Whatever the supervisor started in the background has finished. */
  const settled = async (supervisor: RunSupervisor): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await supervisor.runOnce();
  };
  const entryIdOf = (answer: AgentWriteAnswer | undefined): string => {
    const id = answer?.ok ? answer.data?.["entryId"] : undefined;
    if (typeof id !== "string") throw new Error(`no entry id in ${JSON.stringify(answer)}`);
    return id;
  };

  /** An agent-written skill given to the system agent, which the review is scripted to patch. */
  function systemSkill() {
    const saved = saveSkill(handle.db, {
      slug: "convert-watcher-pipeline",
      name: "convert-watcher-pipeline",
      description: "Use when converting a watcher pipeline to a watch job.",
      body: "Move the steps into a job.",
      files: [],
    });
    if (!saved.ok) throw new Error(saved.problems.join(" "));
    setAgentAttachment(handle.db, { agentId: system.id, kind: "skill", id: saved.skill.id, attached: true });
    return saved.skill;
  }
  const patchSkill: AgentWriteRequest[] = [
    { tool: SKILL_VIEW_TOOL_NAME, args: { slug: "convert-watcher-pipeline" } },
    { tool: SKILL_PATCH_TOOL_NAME, args: { slug: "convert-watcher-pipeline", old_text: "Move the steps into a job.", new_text: "Move the steps into a job, and keep its schedule." } },
  ];

  it("runs no review after a chat's turns, then exactly one once it has been quiet for the idle time, and every turn resumes the one thread", async () => {
    const skill = systemSkill();
    const { provider, starts, resumes, forks, answers } = backend({ writes: [...patchSkill, note("Watch jobs keep their pipeline's schedule.")] });
    const supervisor = supervisorOver(provider);

    await say(supervisor, "Convert the watcher pipeline.");
    await quiet(supervisor, 20_000);
    await say(supervisor, "Keep the schedule.");
    await quiet(supervisor, 20_000);
    await say(supervisor, "And name it nightly.");

    // Three turns, each answered, none reviewed: the slot was given back
    // as each answer was posted.
    expect(runs().map((run) => run.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(forks).toEqual([]);
    expect(reviewEvents()).toEqual([]);

    // Not before the chat has been quiet for the whole idle time…
    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS - 1_000);
    expect(forks).toEqual([]);

    // …and then once, on a fork of the newest run's thread.
    await quiet(supervisor, 2_000);
    const newest = runs().at(-1)!;
    expect(forks.map((fork) => fork.threadId)).toEqual([newest.threadId]);
    expect(answers.every((answer) => answer.ok)).toBe(true);
    // What it held is written once it ended, as the reviewed run.
    expect(getSkill(handle.db, skill.id)?.body).toBe("Move the steps into a job, and keep its schedule.");
    expect(listSkillVersions(handle.db, skill.id).filter((version) => version.author.kind === "run")).toEqual([expect.objectContaining({ author: { kind: "run", runId: newest.id } })]);
    const written = listMemories(handle.db, project);
    expect(written.map((entry) => entry.body)).toEqual(["Watch jobs keep their pipeline's schedule."]);
    expect(reviewEvents()).toEqual([
      { runId: newest.id, payload: expect.objectContaining({ outcome: "written", review: "full", entryIds: [written[0]!.id], skillIds: [skill.id] }) },
    ]);

    // Nothing is owed after that: more quiet runs no second review.
    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS * 2);
    expect(forks).toHaveLength(1);

    // All three turns shared one thread, and none said what it was given changed.
    expect(starts).toEqual(["session-1"]);
    expect(resumes).toEqual(["session-1", "session-1"]);
    expect(new Set(runs().map((run) => run.threadId))).toEqual(new Set(["session-1"]));
    expect(notices()).toEqual([]);
  });

  it("is cancelled by a message sent while it runs, keeping none of its notes or skill writes, and the chat is owed a review again after its next quiet stretch", async () => {
    const skill = systemSkill();
    const first = backend({ writes: [...patchSkill, note("Watch jobs keep their pipeline's schedule.")], hang: true });
    const supervisor = supervisorOver(first.provider);

    await say(supervisor, "Convert the watcher pipeline.");
    clock += CHAT_IDLE_BEFORE_REVIEW_MS + 1_000;
    const looking = supervisor.runOnce();
    await first.reviewing;
    expect(first.forks).toHaveLength(1);
    expect(first.answers.every((answer) => answer.ok)).toBe(true);
    // Held while it runs: nothing is written yet.
    expect(getSkill(handle.db, skill.id)?.body).toBe("Move the steps into a job.");
    expect(listMemories(handle.db, project)).toEqual([]);

    // The person carries on the chat.
    await say(supervisor, "And name it nightly.");
    await looking;

    // Nothing it would have written was kept, and no event says it was reviewed.
    expect(getSkill(handle.db, skill.id)?.body).toBe("Move the steps into a job.");
    expect(listSkillVersions(handle.db, skill.id).filter((version) => version.author.kind === "run")).toEqual([]);
    expect(listMemories(handle.db, project)).toEqual([]);
    expect(reviewEvents()).toEqual([]);
    // The reply resumed the chat's thread.
    expect(runs().map((run) => run.threadId)).toEqual(["session-1", "session-1"]);
    expect(notices()).toEqual([]);

    // Owed again, once the chat goes quiet again: of the newest run.
    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS - 1_000);
    expect(first.forks).toHaveLength(1);
    await quiet(supervisor, 2_000);
    expect(first.forks).toHaveLength(2);
  });

  it("reviews after a restart a chat that went quiet before EO quit", async () => {
    const before = backend({ writes: [] });
    const quitting = supervisorOver(before.provider);
    await say(quitting, "Convert the watcher pipeline.");
    await quitting.shutdown();
    expect(before.forks).toEqual([]);

    // EO starts again later, after the chat has been quiet for the idle time.
    clock += CHAT_IDLE_BEFORE_REVIEW_MS + 1_000;
    const after = backend({ writes: [note("Watch jobs keep their pipeline's schedule.")] });
    const restarted = supervisorOver(after.provider);
    await restarted.runOnce();

    const [run] = runs();
    expect(after.forks.map((fork) => fork.threadId)).toEqual([run!.threadId]);
    expect(reviewEvents()).toEqual([{ runId: run!.id, payload: expect.objectContaining({ outcome: "written" }) }]);
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Watch jobs keep their pipeline's schedule."]);
  });

  it("gives each thread the chat's runs since its last review span a review of its own, of that thread's newest run", async () => {
    const { provider, forks } = backend({ writes: [] });
    const supervisor = supervisorOver(provider);

    await say(supervisor, "Convert the watcher pipeline.");
    // The system agent's instructions change, so the next turn cannot
    // resume the thread and starts another.
    updateAgent(handle.db, system.id, { instructions: `${system.instructions} And be brief.` });
    await quiet(supervisor, 20_000);
    await say(supervisor, "Keep the schedule.");
    await say(supervisor, "And name it nightly.");
    const [first, second, third] = runs();
    expect([first!.threadId, second!.threadId, third!.threadId]).toEqual(["session-1", "session-2", "session-2"]);

    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS + 1_000);

    expect(forks.map((fork) => fork.threadId)).toEqual(["session-1", "session-2"]);
    expect(reviewEvents().map((event) => event.runId)).toEqual([first!.id, third!.id]);
  });

  /**
   * A record standing in for the organisation's: it counts what it is
   * asked, holds the first note write open until `release` where
   * `holdFirst`, and fails the first `failNotes` note writes, as one out of
   * reach does — having taken the first `lostAnswers` of those first, as
   * one whose answer is lost does.
   */
  function slowRecord(options: { holdFirst?: boolean; failNotes?: number; lostAnswers?: number } = {}) {
    const local = createLocalRecord(handle.db);
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing: () => void = () => {};
    const noteOut = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const asked: string[] = [];
    let failed = 0;
    const record: ItemRecord = {
      ...local,
      async writeMemory(request) {
        asked.push(request.op);
        if (request.op === "note" && options.holdFirst && asked.filter((op) => op === "note").length === 1) {
          writing();
          await released;
        }
        if (request.op === "note" && failed < (options.failNotes ?? 0)) {
          failed += 1;
          if (failed <= (options.lostAnswers ?? 0)) await local.writeMemory(request);
          throw new Error("Your organisation's record could not be reached.");
        }
        return local.writeMemory(request);
      },
    };
    return { record, asked, release, noteOut };
  }

  it("writes nothing to the record while it runs, so a message that cancels it leaves nothing of it anywhere", async () => {
    const first = backend({ writes: [note("Watch jobs keep their pipeline's schedule.")], hang: true });
    const slow = slowRecord();
    const supervisor = supervisorOver(first.provider, slow.record);

    await say(supervisor, "Convert the watcher pipeline.");
    clock += CHAT_IDLE_BEFORE_REVIEW_MS + 1_000;
    const looking = supervisor.runOnce();
    await first.reviewing;
    expect(first.answers.map((answer) => answer.ok)).toEqual([true]);
    await say(supervisor, "And name it nightly.");
    await looking;
    await settled(supervisor);

    // Not one write reached the record, so no device could be given it.
    expect(slow.asked).toEqual([]);
    expect(listMemories(handle.db, project, { includeRetired: true })).toEqual([]);
    expect(reviewEvents()).toEqual([]);
  });

  it("commits what it held in its event before writing any of it, and a message sent while its notes are written comes after the review and does not wait for them", async () => {
    const skill = systemSkill();
    const { provider, forks } = backend({ writes: [...patchSkill, note("Watch jobs keep their pipeline's schedule."), note("A watch job is named for its schedule.")] });
    const slow = slowRecord({ holdFirst: true });
    const supervisor = supervisorOver(provider, slow.record);

    await say(supervisor, "Convert the watcher pipeline.");
    const [reviewed] = runs();
    clock += CHAT_IDLE_BEFORE_REVIEW_MS + 1_000;
    const looking = supervisor.runOnce();
    await slow.noteOut;
    expect(forks).toHaveLength(1);
    // Committed before the first note went out: the event names both
    // notes and carries them, and the skill is saved.
    const [event] = reviewEvents();
    expect(event?.runId).toBe(reviewed!.id);
    const payload = event?.payload as { outcome: string; entryIds: string[]; skillIds: string[]; notes: { id: string; text: string }[] };
    expect(payload.outcome).toBe("written");
    expect(payload.skillIds).toEqual([skill.id]);
    expect(payload.notes.map((held) => held.text)).toEqual(["Watch jobs keep their pipeline's schedule.", "A watch job is named for its schedule."]);
    expect(payload.entryIds).toEqual(payload.notes.map((held) => held.id));
    expect(getSkill(handle.db, skill.id)?.body).toBe("Move the steps into a job, and keep its schedule.");
    expect(listMemories(handle.db, project)).toEqual([]);

    // The person carries on the chat while the first note is out, and is
    // answered at once, without waiting for the notes. (A new thread: the
    // skill the review saved changed what the agent is given.)
    postComment(handle.db, { itemId: chat.id, author: { type: "human" }, body: "And name it nightly.", mentions: [{ type: "agent", agentId: system.id }] });
    const replying = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs()).toHaveLength(2);
    slow.release();
    await Promise.all([looking, replying]);
    await settled(supervisor);

    // Both notes are written, under the ids the event named, as the reviewed run.
    expect(slow.asked).toEqual(["note", "note"]);
    const written = listMemories(handle.db, project);
    expect(written.map((entry) => entry.id).sort()).toEqual([...payload.entryIds].sort());
    expect(written.every((entry) => entry.source.type === "run" && entry.source.runId === reviewed!.id)).toBe(true);
    expect(reviewEvents()).toHaveLength(1);
  });

  it("writes a committed note on a later look where the record could not be reached at first, and a note the record took whose answer was lost is not written twice", async () => {
    const { provider } = backend({ writes: [note("Watch jobs keep their pipeline's schedule."), note("A watch job is named for its schedule.")] });
    // The first note is taken and its answer lost; the second is not taken.
    const slow = slowRecord({ failNotes: 2, lostAnswers: 1 });
    const supervisor = supervisorOver(provider, slow.record);

    await say(supervisor, "Convert the watcher pipeline.");
    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS + 1_000);
    await settled(supervisor);
    expect(reviewEvents()).toHaveLength(1);
    expect(slow.asked).toEqual(["note", "note"]);
    expect(listMemories(handle.db, project)).toHaveLength(1);

    // The next look writes what is still missing, and only that.
    await quiet(supervisor, 60_000);
    await settled(supervisor);
    expect(slow.asked).toEqual(["note", "note", "note"]);
    const ids = (reviewEvents()[0]!.payload as { entryIds: string[] }).entryIds;
    expect(listMemories(handle.db, project).map((entry) => entry.id).sort()).toEqual([...ids].sort());

    // Nothing is left to write.
    await quiet(supervisor, 60_000);
    await settled(supervisor);
    expect(slow.asked).toHaveLength(3);
  });

  it("writes after a restart the notes a review committed and EO quit before writing", async () => {
    const { provider } = backend({ writes: [note("Watch jobs keep their pipeline's schedule.")] });
    const slow = slowRecord({ failNotes: 1 });
    const quitting = supervisorOver(provider, slow.record);

    await say(quitting, "Convert the watcher pipeline.");
    await quiet(quitting, CHAT_IDLE_BEFORE_REVIEW_MS + 1_000);
    await settled(quitting);
    await quitting.shutdown();
    expect(reviewEvents()).toHaveLength(1);
    expect(listMemories(handle.db, project)).toEqual([]);

    // EO starts again: the note is written, and the chat is not reviewed again.
    const again = backend({ writes: [] });
    const restarted = supervisorOver(again.provider);
    await restarted.runOnce();
    await settled(restarted);
    expect(again.forks).toEqual([]);
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Watch jobs keep their pipeline's schedule."]);
  });

  it("leaves to the device that committed it a note another device's review committed", async () => {
    const supervisor = supervisorOver(backend({ writes: [] }).provider);
    await say(supervisor, "Convert the watcher pipeline.");
    const [run] = runs();
    const committed: LearningReviewEvent = {
      type: LEARNING_REVIEW_EVENT,
      outcome: "written",
      review: "full",
      entryIds: ["01a1dc80-0000-7000-8000-000000000001"],
      skillIds: [],
      reason: null,
      forkThreadId: "fork-of-session-1",
      notes: [{ id: "01a1dc80-0000-7000-8000-000000000001", scope: project.id, text: "Watch jobs keep their pipeline's schedule.", replaces: [] }],
    };
    appendSyncedRunEvents(handle.db, run!.id, "another-desktop", [{ seq: 1_000, ts: clock, type: LEARNING_REVIEW_EVENT, payload: committed }]);
    // A new process looks at once.
    const restarted = supervisorOver(backend({ writes: [] }).provider);
    await restarted.runOnce();
    await settled(restarted);
    expect(listMemories(handle.db, project)).toEqual([]);
  });

  it("retires what a held note replaced when a later note replaces that one", async () => {
    // Filled in below, once the chat's run exists to be its source.
    let stale = "";
    const { provider, answers } = backend({
      writes: [
        (): AgentWriteRequest => note("Watch jobs run hourly.", [stale]),
        (earlier) => note("Watch jobs keep their pipeline's schedule.", [entryIdOf(earlier[0])]),
      ],
    });
    const supervisor = supervisorOver(provider);
    await say(supervisor, "Convert the watcher pipeline.");
    const [run] = runs();
    const written = addMemory(handle.db, { scope: project, body: "Watch jobs run every minute.", source: { type: "run", runId: run!.id, itemId: chat.id } });
    if (!written.ok) throw new Error(written.problem);
    stale = written.entry.id;

    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS + 1_000);

    expect(answers.map((answer) => answer.ok)).toEqual([true, true]);
    // The first held note was never written, and the entry it replaced is
    // retired by the note that replaced it.
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Watch jobs keep their pipeline's schedule."]);
    expect(getMemory(handle.db, stale)?.retiredReason).toBe("superseded");
  });

  it("refuses a held note naming one a later note already replaced, or an entry another held note retires", async () => {
    let stale = "";
    const { provider, answers } = backend({
      writes: [
        (): AgentWriteRequest => note("Watch jobs run hourly.", [stale]),
        (earlier) => note("Watch jobs run daily.", [entryIdOf(earlier[0])]),
        (earlier) => note("Watch jobs run weekly.", [entryIdOf(earlier[0])]),
        (): AgentWriteRequest => note("Watch jobs run monthly.", [stale]),
      ],
    });
    const supervisor = supervisorOver(provider);
    await say(supervisor, "Convert the watcher pipeline.");
    const [run] = runs();
    const written = addMemory(handle.db, { scope: project, body: "Watch jobs run every minute.", source: { type: "run", runId: run!.id, itemId: chat.id } });
    if (!written.ok) throw new Error(written.problem);
    stale = written.entry.id;

    await quiet(supervisor, CHAT_IDLE_BEFORE_REVIEW_MS + 1_000);

    expect(answers.map((answer) => answer.ok)).toEqual([true, true, false, false]);
    expect(answers[2]).toMatchObject({ ok: false, problem: expect.stringMatching(/already replaced by a later note/) });
    expect(answers[3]).toMatchObject({ ok: false, problem: expect.stringMatching(/already replaced by an earlier note/) });
    expect(listMemories(handle.db, project).map((entry) => entry.body)).toEqual(["Watch jobs run daily."]);
    expect(getMemory(handle.db, stale)?.retiredReason).toBe("superseded");
  });
});
