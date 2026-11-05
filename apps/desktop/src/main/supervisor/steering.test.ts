import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUMAN_MESSAGE_EVENT, type AgentEvent, type AgentInputAttachment, type AgentProvider, type HumanMessageEvent, type InterruptibleStream, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { postHumanComment, type EngineHandle } from "../ipc/domainCommands.js";
import { createItemLock } from "./itemLock.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import { createRunEventBuffer } from "../db/repos/runEventBuffer.js";
import { createRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { buildFollowUpContext } from "./buildDispatchContext.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "./workspaceKind.js";

/**
 * A person saying something to an agent that is working (EO-176).
 *
 * The property under test is mostly a property of what *doesn't* happen.
 * EO already had a control that reaches into a live run — Cancel — and
 * the thing that makes this a different control rather than a second
 * spelling of that one is that it writes no run row, takes no item
 * lock, classifies no cancellation and moves nothing. A steer that
 * started writing run rows would be stop-and-restart wearing a new word.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * A backend that holds its turn open until the test lets go.
 *
 * Deliberately not `createFakeProvider`: that one is an async generator,
 * which is exactly the shape that *cannot* carry a control — an
 * `InterruptibleStream` is an object with methods beside the iterator,
 * and half of what these tests check is that the supervisor finds them
 * there. `steerable: false` builds the other backend EO really has, the
 * one whose stream implements no `steer` at all.
 */
function heldProvider(options: { steerable?: boolean } = {}): {
  provider: AgentProvider;
  /** Everything the backend was told mid-turn, in order. */
  heard: string[];
  /** The files each of those messages was said to carry, in the same order (EO-395). */
  files: AgentInputAttachment[][];
  /** Resolves once the turn is genuinely under way, which is when a steer means anything. */
  working: Promise<void>;
  /** Lets the turn finish. */
  finish: () => void;
} {
  const heard: string[] = [];
  const files: AgentInputAttachment[][] = [];
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let announce!: () => void;
  const working = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const open = (): InterruptibleStream<AgentEvent> => {
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      announce();
      await held;
      yield { type: "result", data: validImplementResult };
    }
    const iterator = events()[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => iterator,
      ...(options.steerable === false
        ? {}
        : {
            steer: (message: string, attachments: AgentInputAttachment[] = []) => {
              heard.push(message);
              files.push(attachments);
              return Promise.resolve(true);
            },
          }),
    };
  };

  return { provider: { start: open, resume: open }, heard, files, working, finish: () => letGo() };
}

/** Polls rather than guesses: a dispatch takes several awaits to reach a run row. */
async function until<T>(read: () => T | null | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let handle: DbHandle;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("steerRun", () => {
  it("reaches the running turn, and writes no run row, no transition and no cancellation", async () => {
    const backend = heldProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");
    expect(run.status).toBe("running");

    const outcome = await supervisor.steerRun(run.id, {
      commentId: "comment-1" as Uuid,
      body: "Stop rewriting the schema — the limit belongs in the middleware.",
      delivery: "now",
    });

    expect(outcome).toBe("steered");
    expect(backend.heard).toEqual(["Stop rewriting the schema — the limit belongs in the middleware."]);

    // The same run, still going, in the same place. Everything a cancel
    // would have written is absent.
    const runsNow = listRunsForItem(handle.db, item.id);
    expect(runsNow).toHaveLength(1);
    expect(runsNow[0]?.id).toBe(run.id);
    expect(runsNow[0]?.status).toBe("running");
    expect(runsNow[0]?.threadId).toBe(run.threadId);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);

    backend.finish();
    await dispatch;

    // And the run went on to finish as itself: succeeded, not cancelled.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  /**
   * A steered message's files (EO-395).
   *
   * The path is shared, so this is the ticket and transcript composers'
   * case as much as the assistant's: `comments:post` with a delivery,
   * through the supervisor, to the backend. The files are read off the
   * comment — nothing in `postHumanComment` passes them — which is what
   * makes it true of every composer that steers.
   */
  it("carries the files posted with a comment from the ticket composer into the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo steering attachment "));
    try {
      const storage = new AttachmentStorage(join(directory, "managed"));
      const source = join(directory, "screen.png");
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const [withWords, alone] = await storage.stagePaths([source, source]);

      const backend = heldProvider();
      const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });
      const engine: EngineHandle = {
        resumeItem: async () => {},
        cancelRun: supervisor.cancelRun,
        steerRun: supervisor.steerRun,
        pause: () => undefined,
        resume: () => undefined,
        isPaused: () => false,
        dispatchBlockerFor: () => null,
        activeRunCount: () => 1,
        finishingRunCount: () => 0,
        notifyStateChange: () => undefined,
        itemLock: createItemLock(),
        offerWork: async () => [],
      };

      const dispatch = supervisor.runOnce();
      await backend.working;
      await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");

      const post = (body: string, attachmentId: string) =>
        postHumanComment(handle.db, engine, { itemId: item.id, body, mentions: [], pinned: false, parentId: null, delivery: "now", attachmentIds: [attachmentId] }, storage);

      expect((await post("This is the response I mean.", withWords!.id)).delivery?.outcome).toBe("now");
      // A screenshot with nothing typed under it used to steer an empty
      // string and nothing else.
      expect((await post("", alone!.id)).delivery?.outcome).toBe("now");

      expect(backend.heard).toEqual(["This is the response I mean.", ""]);
      expect(backend.files).toEqual([
        [expect.objectContaining({ id: withWords!.id, name: "screen.png", mimeType: "image/png" })],
        [expect.objectContaining({ id: alone!.id, name: "screen.png", mimeType: "image/png" })],
      ]);

      backend.finish();
      await dispatch;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("says nothing of files for a message that came with none", async () => {
    const backend = heldProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });
    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");

    const said = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Use the middleware." });
    await supervisor.steerRun(run.id, { commentId: said.id, body: said.body, delivery: "now" });

    expect(backend.files).toEqual([[]]);
    backend.finish();
    await dispatch;
  });

  it("puts the delivery in the run's own transcript, appended and never as an edit", async () => {
    const backend = heldProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");

    await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "Use the middleware.", delivery: "now" });

    const events = listRunEvents(handle.db, run.id);
    const said = events.filter((event) => event.type === HUMAN_MESSAGE_EVENT);
    expect(said).toHaveLength(1);
    expect(said[0]?.payload).toMatchObject({ commentId: "comment-1", body: "Use the middleware.", delivery: "now", delivered: true });
    // Appended, at the end, on the run's own numbering (invariant #3).
    // The distinct, ascending sequence is the point rather than tidiness:
    // it is what says this row went through the same allocator the
    // stream is using, and a second writer with a counter of its own
    // would hand out a number the stream had already spent.
    expect(events.at(-1)?.type).toBe(HUMAN_MESSAGE_EVENT);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);

    backend.finish();
    await dispatch;
  });

  it("says so rather than pretending, when the backend cannot be spoken to mid-turn", async () => {
    const backend = heldProvider({ steerable: false });
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");

    const outcome = await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "Use the middleware.", delivery: "now" });

    expect(outcome).toBe("unsupported");
    // Still recorded on the run, and recorded as what it is: a message
    // this turn never got. A transcript that showed it as delivered
    // would be the worst lie this feature could tell.
    const said = listRunEvents(handle.db, run.id).find((event) => event.type === HUMAN_MESSAGE_EVENT);
    expect(said?.payload).toMatchObject({ delivered: false });

    backend.finish();
    await dispatch;
  });

  it("answers a run nothing is driving without touching anything", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, provider: heldProvider().provider, limits: LIMITS });

    expect(await supervisor.steerRun("no-such-run", { commentId: "c" as Uuid, body: "hello", delivery: "now" })).toBe("no-live-run");
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("tells the person where a queued message has gone once the run hands the item on", async () => {
    const backend = heldProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");

    expect(await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "Check the retry maths.", delivery: "next" })).toBe("queued");
    expect(backend.heard, "a queued message is not pushed at the backend at all").toEqual([]);

    backend.finish();
    await dispatch;

    // The run routed the item onward, so the message is now somebody
    // else's to read — which is the one thing a person cannot work out
    // for themselves, and so the one thing EO has to say (invariant #8).
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.body.includes("queued for the next turn"));
    expect(note?.authorType).toBe("engine");
    expect(note?.body).toContain("Review"); // named, or the sentence is not worth posting
  });

  /**
   * The window between a run row saying `running` and a stream existing
   * to say anything into.
   *
   * It is not a narrow one and it is not exotic. `resumeItemHeld`
   * writes `running`, announces it, and then spends however long the
   * preflight takes — a tool directory, a query server resolved against
   * a worktree — before a provider stream exists. A person watching the
   * item sees a live run for the whole of it.
   *
   * What made a message landing there worse than useless is the
   * watermark. The resumed turn's prompt was assembled *before* the run
   * row was written, so the comment misses that turn outright; and being
   * older than the `endedAt` that run eventually gets, it is on the
   * wrong side of `followUpComments` for the turn after it too. Recorded
   * nowhere, it reached nobody, while the composer said it was queued.
   */
  it("keeps a message posted while a resumed run is still being prepared, and hands it to the next turn", async () => {
    const backend = heldProvider();
    let letPreflightFinish!: () => void;
    const preflight = new Promise<void>((resolve) => {
      letPreflightFinish = resolve;
    });
    let reachedPreflight!: () => void;
    const inPreflight = new Promise<void>((resolve) => {
      reachedPreflight = resolve;
    });

    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: backend.provider,
      limits: LIMITS,
      // The real await this window is made of, held open so the test can
      // stand inside it rather than race it: attaching what the
      // workspace lends is the last thing a resume waits for.
      kinds: installedKinds(
        fakeWorkspaceKind({
          attach: async () => {
            reachedPreflight();
            await preflight;
            return NOTHING_ATTACHED;
          },
        }),
      ),
    });

    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const parked = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      threadId: "thr_1",
      cwd: "/tmp/eo-steering-worktree",
    });
    updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: 1_000, endedAt: 2_000 });

    const resuming = supervisor.resumeItem(item.id);
    await inPreflight;

    const resumed = await until(() => listRunsForItem(handle.db, item.id).find((run) => run.id !== parked.id), "the resumed run row");
    expect(resumed.status, "the window only exists because the row is already live").toBe("running");

    // What `postHumanComment` does, in the order it does it: the comment
    // first, the delivery second.
    const said = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Actually, cap it at 100 a minute." });
    const outcome = await supervisor.steerRun(resumed.id, { commentId: said.id, body: said.body, delivery: "now" });

    expect(outcome, "there is no turn yet — but that is not the same as nowhere to put it").toBe("no-live-run");
    const queued = listRunEvents(handle.db, resumed.id).filter((event) => event.type === HUMAN_MESSAGE_EVENT);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({ commentId: said.id, delivered: false });

    letPreflightFinish();
    await backend.working;
    backend.finish();
    await resuming;

    // The run this landed on has ended, so its `endedAt` is now *later*
    // than the comment and the ordinary delta drops it. The row above is
    // the only reason the next turn on this thread is still told.
    const ended = listRunsForItem(handle.db, item.id).find((run) => run.id === resumed.id)!;
    expect(ended.endedAt).toBeGreaterThan(said.createdAt);
    expect(buildFollowUpContext(handle.db, getItem(handle.db, item.id)!, implementer, "implement", ended).fullText).toContain(
      "Actually, cap it at 100 a minute.",
    );
  });

  it("numbers a message that arrives after the stream has gone without reusing what the stream spent", async () => {
    // The other end of the same window. A turn's stream is finished and
    // released several awaits before the row it belongs to is terminal,
    // so a message can land on a live run with no buffer behind it —
    // and the row it writes has to continue the transcript rather than
    // land on top of it. Two allocators over one run is the failure
    // being ruled out: the buffer counts in memory, this reads what is
    // persisted, and the rule is that only one of them is ever in play.
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });
    const buffer = createRunEventBuffer(handle.db);
    buffer.append(run.id, "output", { type: "output", text: "before" });
    buffer.append(run.id, "output", { type: "output", text: "and before" });
    buffer.dispose(); // what `driveToCompletion` does when its turn ends

    const supervisor = createRunSupervisor({ db: handle.db, provider: heldProvider().provider, limits: LIMITS });
    expect(await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "One more thing.", delivery: "now" })).toBe("no-live-run");

    const events = listRunEvents(handle.db, run.id);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(events.at(-1)).toMatchObject({ type: HUMAN_MESSAGE_EVENT, seq: 2 });
  });

  it("writes nothing against a run that has already ended, where the ordinary delta already carries it", async () => {
    // Not tidiness: a row here would tell the *next* turn to re-read a
    // message that turn is already being given. A comment posted after a
    // run's `endedAt` is on the later side of the follow-up watermark
    // and needs no help.
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement" });
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 5_000 });

    const supervisor = createRunSupervisor({ db: handle.db, provider: heldProvider().provider, limits: LIMITS });
    expect(await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "Too late.", delivery: "now" })).toBe("no-live-run");

    expect(listRunEvents(handle.db, run.id)).toEqual([]);
  });

  it("says nothing about a message the turn actually got", async () => {
    const backend = heldProvider();
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    const dispatch = supervisor.runOnce();
    await backend.working;
    const run = await until(() => listRunsForItem(handle.db, item.id)[0], "the run row");
    await supervisor.steerRun(run.id, { commentId: "comment-1" as Uuid, body: "Check the retry maths.", delivery: "now" });

    backend.finish();
    await dispatch;

    const delivered = listRunEvents(handle.db, run.id)
      .filter((event) => event.type === HUMAN_MESSAGE_EVENT)
      .map((event) => (event.payload as HumanMessageEvent).delivered);
    expect(delivered).toEqual([true]);
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n")).not.toContain("queued for the next turn");
  });
});
