import { TurnNotEndedError, type AgentEvent, type AgentProvider, type InterruptibleStream, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, listCommentsForItem, listRunEvents, listRunsForItem, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { findReusableThread } from "./threadReuse.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A run never has two live agent processes on its thread (EO-493).
 *
 * On EO-487 the supervisor opened a correction turn — a second process
 * resuming the same session — while the turn before it was still
 * running. EO had only closed that turn's stdin, and the CLI went on to
 * do the work it had queued: two agents, one worktree, two test suites.
 * On EO-488 a CLI waiting on background tasks outlived its run's `result`
 * and started a turn of its own when they finished.
 *
 * The backend here is shaped like the processes that did that. Each turn
 * is a process: "spawned" when the turn is first read, it goes on
 * pushing events after whatever EO reads last — after its `result`, or
 * after the call that sends EO into a correction — and only stops when it
 * is told to end, and then takes a moment to exit, as a real process
 * does between SIGTERM and its exit. What is asserted is that no turn on
 * the thread ever starts while an earlier one is still alive, and that
 * nothing the earlier one said after EO stopped reading is on the run.
 */
/**
 * How a turn's process meets being ended: it exits; it is still there
 * after everything the adapter sent it, which the adapter reports as
 * `TurnNotEndedError`; the adapter fails to end it some other way; or the
 * adapter never says either way.
 */
type Ending = "exits" | "survives" | "fails" | "hangs";

function lingeringBackend(script: (turn: number) => AgentEvent[], ending: (turn: number) => Ending = () => "exits") {
  /** The turns whose process is alive right now. */
  const live = new Set<number>();
  /** Each time a turn started with an earlier one still alive: which were alive, and which started. */
  const overlaps: { alive: number[]; started: number }[] = [];
  /** Every event a turn pushed after its scripted ones — what it said once EO had stopped listening. */
  const late: string[] = [];
  /** The threads each resume asked for. */
  const resumedThreads: string[] = [];
  /** Every turn's chatter, so a test can stop a survivor's once it is done with it. */
  const timers: ReturnType<typeof setInterval>[] = [];
  let turns = 0;

  function turn(scripted: AgentEvent[]): InterruptibleStream<AgentEvent> {
    const n = ++turns;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    let spawned = false;
    let ended = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const push = (event: AgentEvent) => {
      queue.push(event);
      const resume = wake;
      wake = null;
      resume?.();
    };
    const spawn = () => {
      if (spawned) return;
      spawned = true;
      if (live.size > 0) overlaps.push({ alive: [...live], started: n });
      live.add(n);
      for (const event of scripted) push(event);
      // Working on, untracked, for as long as the process lives.
      let i = 0;
      timer = setInterval(() => {
        const text = `late word ${n}.${i++}`;
        late.push(text);
        push({ type: "output", text });
      }, 1);
      timers.push(timer);
    };
    const iterator: AsyncIterator<AgentEvent> = {
      async next() {
        spawn();
        while (queue.length === 0) {
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        return { done: false, value: queue.shift() as AgentEvent };
      },
      async return() {
        ended = true;
        const how = ending(n);
        if (how === "survives") throw new TurnNotEndedError({ provider: "fake", pids: [4242] });
        if (how === "fails") throw new Error("could not signal the process");
        if (how === "hangs") return new Promise<IteratorResult<AgentEvent>>(() => undefined);
        // Between the signal and the exit: long enough that a turn opened
        // without waiting for this would find this one still alive — and
        // still talking, as a process is until it has gone.
        await sleep(30);
        if (timer) clearInterval(timer);
        live.delete(n);
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  const provider = {
    start() {
      return turn([{ type: "thread_started", threadId: "thread-1" }, ...script(turns + 1)]);
    },
    resume(threadId: string) {
      resumedThreads.push(threadId);
      return turn(script(turns + 1));
    },
  } as unknown as AgentProvider;

  const stopAll = () => {
    for (const timer of timers) clearInterval(timer);
  };
  return { provider, live, overlaps, late, resumedThreads, turns: () => turns, stopAll };
}

describe("one live agent process per thread (EO-493)", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  /** Every word stored on the item's runs. */
  const recorded = (): string => listRunsForItem(handle.db, item.id).flatMap((run) => listRunEvents(handle.db, run.id).map((event) => JSON.stringify(event.payload))).join("\n");

  it("ends the turn whose result failed validation before its correction is opened", async () => {
    const backend = lingeringBackend((turn) => (turn === 1 ? [{ type: "result", data: { nope: true } }] : [{ type: "result", data: validImplementResult }]));

    await createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS }).runOnce();

    expect(backend.turns()).toBe(2); // the correction was opened
    expect(backend.resumedThreads).toEqual(["thread-1"]); // on the same thread
    expect(backend.overlaps).toEqual([]); // and only once the first turn's process had gone
    expect(backend.live.size).toBe(0); // and the correction's own process is gone once its result is read
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("records nothing a turn says after EO has stopped reading it", async () => {
    const backend = lingeringBackend((turn) => (turn === 1 ? [{ type: "result", data: { nope: true } }] : [{ type: "result", data: validImplementResult }]));

    await createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS }).runOnce();

    // Both turns did go on talking — the case is real — and none of it is on the run.
    expect(backend.late.some((text) => text.startsWith("late word 1."))).toBe(true);
    expect(backend.late.some((text) => text.startsWith("late word 2."))).toBe(true);
    expect(recorded()).not.toContain("late word");
  });

  it("ends run N's process before run N+1 resumes the same thread", async () => {
    // Run 1 never gets its answer right and is parked for a person, after
    // two corrections; the person's reply is run 2, resuming the thread.
    const backend = lingeringBackend((turn) => (turn <= 3 ? [{ type: "result", data: { nope: true } }] : [{ type: "result", data: validImplementResult }]));
    const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });

    await supervisor.runOnce();
    const [parked] = listRunsForItem(handle.db, item.id);
    expect(parked?.status).toBe("awaiting_input");
    // Run 1 is over, and so is every process it had.
    expect(backend.live.size).toBe(0);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Put the branch in." });
    await supervisor.resumeItem(item.id);

    expect(backend.turns()).toBe(4);
    expect(backend.resumedThreads).toEqual(["thread-1", "thread-1", "thread-1"]);
    expect(backend.overlaps).toEqual([]);
    expect(backend.live.size).toBe(0);
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toContain("succeeded");
    expect(recorded()).not.toContain("late word");
  });

  // Fails closed (EO-493 review). An ending the adapter reports as failed,
  // or never settles, is not an ended turn: no correction is opened beside
  // what may still be running, and the thread is never resumed again.
  // Fake timers, so the supervisor's bounded wait on an ending that never
  // comes is passed without waiting it out.
  describe("when the previous turn cannot be confirmed ended", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // The one correction a run opens is for a result that did not
    // validate. A mis-called comment tool used to open one too; it is now
    // refused to the agent in the tool's own answer, inside the turn, and
    // opens nothing (EO-543).
    const firstTurn: AgentEvent[] = [{ type: "result", data: { nope: true } }];

    for (const how of ["survives", "fails", "hangs"] as const) {
      it(`opens no result-validation retry and writes the thread off when the ending ${how === "hangs" ? "never settles" : how === "survives" ? "reports a survivor" : "rejects"}`, async () => {
        const backend = lingeringBackend((turn) => (turn === 1 ? firstTurn : [{ type: "result", data: validImplementResult }]), (turn) => (turn === 1 ? how : "exits"));
        try {
          const running = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS }).runOnce();
          // Past the supervisor's bound on waiting for an ending (30s).
          await vi.advanceTimersByTimeAsync(31_000);
          await running;

          expect(backend.turns()).toBe(1); // no correction was opened
          expect(backend.resumedThreads).toEqual([]);
          const [run] = listRunsForItem(handle.db, item.id);
          expect(run?.status).toBe("failed");
          expect(run?.threadId).toBe("thread-1");
          expect(run?.threadLost).toBe(true); // never resumed again
          const said = listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");
          expect(said).toContain("could not confirm");
          if (how === "survives") expect(said).toContain("4242");
          expect(recorded()).not.toContain("late word");
        } finally {
          backend.stopAll();
        }
      });
    }
  });

  it("fails closed on a turn the backend itself reports did not end, as Codex does when a finished turn's process will not go", async () => {
    // Codex shuts a finished turn's app-server down before it hands over
    // the result, so a survivor there arrives from the turn, not from
    // its `return()`.
    let resumed = 0;
    const provider = {
      async *start() {
        yield { type: "thread_started" as const, threadId: "thread-1" };
        throw new TurnNotEndedError({ provider: "codex", pids: [4243] });
      },
      async *resume() {
        resumed += 1;
        yield { type: "result" as const, data: validImplementResult };
      },
    } as unknown as AgentProvider;

    await createRunSupervisor({ db: handle.db, provider, limits: LIMITS }).runOnce();

    expect(resumed).toBe(0);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("failed");
    expect(run?.threadLost).toBe(true);
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n")).toContain("4243");
  });

  // The stopped run (EO-493 review). A run EO stops — a cancel, a guard —
  // whose backend then does not end its turn is given up on after the
  // stop's grace; its turn's ending is still asked for and waited on,
  // bounded, and a run whose ending is not confirmed keeps the ending the
  // stop gave it but loses its thread, so nothing resumes it beside an
  // agent that may still be running.
  describe("a stopped run whose backend does not end its turn", () => {
    const WEDGED_THREAD = "the-wedged-thread";
    const MINUTE = 60_000;
    const LIMIT = 10 * MINUTE;

    /**
     * The first turn names its thread and then never says another word,
     * whatever it is told — its `next()` stuck — and meets `return()` as
     * `ending` says. Every later turn is an ordinary one that answers.
     */
    function wedgedBackend(ending: Ending) {
      const resumed: string[] = [];
      let starts = 0;
      const provider = {
        start() {
          starts += 1;
          if (starts > 1) {
            return (async function* () {
              yield { type: "thread_started" as const, threadId: "a-fresh-thread" };
              yield { type: "result" as const, data: validImplementResult };
            })();
          }
          let named = false;
          const iterator: AsyncIterator<AgentEvent> = {
            async next() {
              if (!named) {
                named = true;
                return { done: false, value: { type: "thread_started", threadId: WEDGED_THREAD } };
              }
              return new Promise<IteratorResult<AgentEvent>>(() => undefined);
            },
            async return() {
              if (ending === "survives") throw new TurnNotEndedError({ provider: "fake", pids: [4244] });
              if (ending === "fails") throw new Error("could not signal the process");
              if (ending === "hangs") return new Promise<IteratorResult<AgentEvent>>(() => undefined);
              return { done: true, value: undefined };
            },
          };
          return { [Symbol.asyncIterator]: () => iterator };
        },
        resume(threadId: string) {
          resumed.push(threadId);
          return (async function* () {
            yield { type: "result" as const, data: validImplementResult };
          })();
        },
      } as unknown as AgentProvider;
      return { provider, resumed, starts: () => starts };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    const written = (how: Ending) => how !== "exits";
    const said = () => listCommentsForItem(handle.db, item.id).map((comment) => comment.body).join("\n");

    for (const how of ["survives", "fails", "hangs", "exits"] as const) {
      it(`cancelled: ${written(how) ? "writes the thread off" : "keeps the thread"} when the ending ${how === "exits" ? "is confirmed" : how === "hangs" ? "never settles" : how === "fails" ? "rejects" : "reports a survivor"}`, async () => {
        const backend = wedgedBackend(how);
        const supervisor = createRunSupervisor({ db: handle.db, provider: backend.provider, limits: LIMITS });
        const ticking = supervisor.runOnce();
        await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.threadId).toBe(WEDGED_THREAD));

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        supervisor.cancelRun(listRunsForItem(handle.db, item.id)[0]!.id);
        // The stop's grace (15s), then the bound on its ending (30s).
        await vi.advanceTimersByTimeAsync(16_000 + 31_000);
        vi.useRealTimers();
        await ticking;

        const [run] = listRunsForItem(handle.db, item.id);
        expect(run?.status).toBe("cancelled");
        expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
        expect(run?.threadLost).toBe(written(how));
        if (written(how)) {
          expect(said()).toContain("could not confirm");
          const implementer = listAgents(handle.db).find((agent) => agent.id === run!.agentId)!;
          expect(findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: run!.cwd ?? "" }).kind).not.toBe("resume");
        } else {
          expect(said()).not.toContain("could not confirm");
        }
      });
    }

    for (const how of ["survives", "hangs"] as const) {
      it(`stopped by a guard: parks the run, writes the thread off, and a reply starts afresh rather than resuming it, when the ending ${how === "hangs" ? "never settles" : "reports a survivor"}`, async () => {
        let clock = Date.now() + 3_600_000;
        const backend = wedgedBackend(how);
        const supervisor = createRunSupervisor({
          db: handle.db,
          provider: backend.provider,
          limits: LIMITS,
          guards: { inactivityTimeoutMs: LIMIT },
          now: () => clock,
        });
        const ticking = supervisor.runOnce();
        await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)[0]?.threadId).toBe(WEDGED_THREAD));

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        // The inactivity guard's watchdog, a pass every thirty seconds,
        // past the limit: the guard stops the run.
        supervisor.watchLiveRuns();
        for (let gone = 0; gone < LIMIT + 2 * MINUTE; gone += 30_000) {
          clock += 30_000;
          supervisor.watchLiveRuns();
        }
        await vi.advanceTimersByTimeAsync(16_000 + 31_000);
        vi.useRealTimers();
        await ticking;

        const [parked] = listRunsForItem(handle.db, item.id);
        expect(parked?.status).toBe("awaiting_input");
        expect(parked?.threadLost).toBe(true);
        expect(said()).toContain("could not confirm");

        postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Carry on." });
        await supervisor.resumeItem(item.id);

        expect(backend.resumed).toEqual([]); // the wedged thread was not resumed
        expect(backend.starts()).toBe(2); // the reply started a fresh one
      });
    }
  });
});
