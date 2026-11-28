import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "../providers/codexClient.js";
import type { AgentEvent, AgentProvider, QuotaEvent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { listAgents, listCommentsForItem, updateAgent } from "../db/repos/index.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import type { DbHandle } from "../db/client.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { mapSdkMessage } from "../providers/claude.js";
import { mapThreadEvent } from "../providers/codex.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { onPush } from "../ipc/push.js";
import { planUsage } from "../planUsage/store.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** Fixed, so "in about 3 hours" is arithmetic rather than a race. */
const NOW = Date.UTC(2026, 7, 28, 20, 40);
const HOUR = 3_600_000;

/** The backend saying it will not answer: five-hour window full, back in three hours. */
function refusal(over: Partial<QuotaEvent> = {}): QuotaEvent {
  return {
    type: "quota",
    provider: "claude",
    window: "five_hour",
    utilization: 100,
    status: "rejected",
    resetsAt: (NOW + 3 * HOUR) / 1000,
    ...over,
  };
}

/**
 * A provider that plays one scripted turn and then whatever it is asked
 * for again, counting the times it was asked.
 *
 * The count is the assertion that matters here: EO-172 is about a run
 * being re-prompted against an allowance that is already spent, so
 * "how many times did EO go back to the backend" is the behaviour under
 * test rather than an implementation detail.
 */
function providerEmitting(events: AgentEvent[]): { provider: AgentProvider; resumes: string[] } {
  const resumes: string[] = [];
  return {
    resumes,
    provider: {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: "thread-1" };
        yield* events;
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        resumes.push(message);
        yield* events;
      },
    },
  };
}

describe("a run stopped by the provider's token limit (EO-172)", () => {
  let handle: DbHandle;
  let item: Item;
  let clock: number;

  /** The implementer on a real runtime, as the backend that refused would be (EO-798 holds that runtime). */
  function implementerOn(provider: "claude" | "codex"): void {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, implementer.id, { provider });
  }

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    clock = NOW;
    implementerOn("claude");
  });

  afterEach(() => {
    handle.close();
  });

  function supervisorFor(provider: AgentProvider) {
    return createRunSupervisor({ db: handle.db, provider, limits: LIMITS, now: () => clock, checkAuth: async () => ({ ok: true }) });
  }

  /**
   * What the item is told about the limit: an engine note since EO-798,
   * which holds the runtime rather than parking the item.
   */
  function limitNoteBody(): string {
    const posted = handle.db.select().from(comments).all();
    return posted.find((comment) => comment.authorType === "engine" && comment.kind === "note" && comment.body.includes("refused this run"))?.body ?? "";
  }

  /** Whether anything on the item asks a person for a reply. */
  function anyEscalation(): boolean {
    return handle.db.select().from(comments).all().some((comment) => comment.kind === "escalation");
  }

  it("does not re-prompt a half-written result when the window is what cut it short", async () => {
    // Exactly what was observed: the turn ran out of allowance partway
    // through writing its result, so what arrived fails the schema. The
    // old behaviour was two corrections and then "the agent cannot
    // produce valid output".
    const { provider, resumes } = providerEmitting([refusal(), { type: "result", data: "I was writing an object and ran out" }]);

    await supervisorFor(provider).runOnce();

    expect(resumes).toEqual([]); // not once, let alone twice
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("cancelled");
    expect(run?.interruption).toBe("limit");
    expect(run?.error).toContain("refused this run");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // nothing moved on a run that never happened
  });

  it("tells the item about the limit, the window and when it comes back", async () => {
    const { provider } = providerEmitting([refusal(), { type: "result", data: "half an answer" }]);

    await supervisorFor(provider).runOnce();

    const body = limitNoteBody();
    expect(body).toContain('"claude" backend refused this run');
    expect(body).toContain("five-hour usage window");
    expect(body).toContain("five-hour usage window is full.");
    expect(body).not.toContain("% used"); // the run's own share is not on a scale to print (EO-938)
    expect(body).toContain("in about 3 hours");
    expect(body).toContain("2026-08-28 23:40 UTC");
    // The sentence that stops somebody debugging a schema that was never
    // the problem.
    expect(body).toContain("not a schema anybody needs to change");
    // Told, but not asked (EO-798): the runtime is held and the item
    // carries on by itself, so nothing raises `!` and nobody replies.
    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(anyEscalation()).toBe(false);
    expect(body).toContain("Nobody needs to reply here.");
  });

  it("says it does not know the reset time rather than inventing one", async () => {
    // No `resetsAt` at all, rather than an undefined one: absent is the
    // fact under test and the two are different types here.
    const silent: QuotaEvent = { type: "quota", provider: "claude", window: "five_hour", utilization: 100, status: "rejected" };
    const { provider } = providerEmitting([silent, { type: "result", data: "half an answer" }]);

    await supervisorFor(provider).runOnce();

    const body = limitNoteBody();
    expect(body).toContain("did not say when the window refreshes");
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamp anywhere to be believed
  });

  it("reports the limit rather than 'ended without a result' when the turn dies silently", async () => {
    const { provider } = providerEmitting([refusal(), { type: "output", text: "I'll start by reading the ticket" }]);

    await supervisorFor(provider).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("cancelled");
    expect(run?.error).toContain("refused this run");
    expect(run?.error).not.toContain("without a result");
  });

  it("reports the limit rather than the provider's own parting error", async () => {
    const { provider } = providerEmitting([refusal(), { type: "error", message: "Claude run ended: error_during_execution", retryable: true }]);

    await supervisorFor(provider).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("cancelled"); // not `failed`, which the scheduler would retry into the same wall
    expect(run?.error).toContain("refused this run");
  });

  it("holds the item, so waiting for a window does not spend the attempt budget", async () => {
    const { provider, resumes } = providerEmitting([refusal(), { type: "result", data: "half an answer" }]);
    const supervisor = supervisorFor(provider);

    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    // One run, one attempt. A failed row would have been re-dispatched
    // on every tick until the per-item limit refused the item for a
    // reason that had nothing to do with what stopped it; the runtime's
    // hold (EO-798) is what keeps it from being offered again.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(resumes).toEqual([]);
  });

  it("still accepts an answer that arrived before the window closed", async () => {
    // The refusal came after the work was done. A run that finished is
    // not a run stopped by a limit, and throwing its result away would
    // be a second bug wearing the first one's clothes.
    const { provider } = providerEmitting([{ type: "result", data: validImplementResult }, refusal()]);

    await supervisorFor(provider).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("names the window that holds the work longest when two refuse in one run", async () => {
    // The case a single remembered refusal got wrong. The five-hour
    // window rejects last, so reporting "the most recent one" would send
    // somebody back in three hours to a seven-day window that is still
    // spent — a wrong time that looks nothing like a guess.
    const sevenDay = refusal({ window: "seven_day", resetsAt: (NOW + 4 * 24 * HOUR) / 1000 });
    const { provider } = providerEmitting([sevenDay, refusal(), { type: "result", data: "half an answer" }]);

    await supervisorFor(provider).runOnce();

    const body = limitNoteBody();
    expect(body).toContain("seven-day usage window");
    expect(body).toContain("in about 4 days");
    expect(body).not.toContain("five-hour");
    expect(body).not.toContain("in about 3 hours");
  });

  it("names it whichever order the two refusals arrive in", async () => {
    const sevenDay = refusal({ window: "seven_day", resetsAt: (NOW + 4 * 24 * HOUR) / 1000 });
    const { provider } = providerEmitting([refusal(), sevenDay, { type: "result", data: "half an answer" }]);

    await supervisorFor(provider).runOnce();

    expect(limitNoteBody()).toContain("seven-day usage window");
  });

  it("ignores a window that came back before the run ended", async () => {
    // Rejected early, allowed again later in the same stream. Only the
    // window still refusing should be reported.
    const sevenDay = refusal({ window: "seven_day", resetsAt: (NOW + 4 * 24 * HOUR) / 1000 });
    const recovered: QuotaEvent = { type: "quota", provider: "claude", window: "seven_day", utilization: 41, status: "allowed" };
    const { provider } = providerEmitting([sevenDay, refusal(), recovered, { type: "result", data: "half an answer" }]);

    await supervisorFor(provider).runOnce();

    const body = limitNoteBody();
    expect(body).toContain("five-hour usage window");
    expect(body).toContain("in about 3 hours");
    expect(body).not.toContain("seven-day");
  });

  it("clears a refusal on a recovery that carries no share, so ordinary corrections resume", async () => {
    // End to end through the real mapper, deliberately. The events are
    // not hand-written here: they are whatever `mapSdkMessage` makes of
    // the SDK messages the backend actually sends, so the mapper dropping
    // a share-less recovery fails this test rather than only its own.
    //
    // A stale refusal suppresses the correction attempts a genuinely
    // malformed result should still get, and parks the item as
    // rate-limited when nothing is limiting it any more.
    const readings = [
      { status: "rejected", rateLimitType: "five_hour", utilization: 100 },
      { status: "allowed", rateLimitType: "five_hour" }, // the recovery, with no share on it
    ].flatMap((rate_limit_info) =>
      mapSdkMessage({ type: "rate_limit_event", rate_limit_info, uuid: "u1", session_id: "s1" } as unknown as SDKMessage).mapped,
    );
    expect(readings).toHaveLength(2); // both survived the mapper, which is half the regression

    const { provider, resumes } = providerEmitting([...readings, { type: "result", data: { thisFieldDoesNotExist: true } }]);

    await supervisorFor(provider).runOnce();

    expect(resumes).toHaveLength(2); // A-02's corrections, exactly as if no window had ever refused
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.error).toContain("validation");
    expect(run?.error).not.toContain("refused this run");
    expect(limitNoteBody()).not.toContain("refused this run");
  });

  it("carries on when every window that refused has come back", async () => {
    const recovered: QuotaEvent = { type: "quota", provider: "claude", window: "five_hour", utilization: 12, status: "allowed" };
    const { provider } = providerEmitting([refusal(), recovered, { type: "result", data: validImplementResult }]);

    await supervisorFor(provider).runOnce();

    // Nothing is holding the work up any more, so this is an ordinary run.
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("a window merely filling up is not a refusal and stops nothing", async () => {
    const warning: QuotaEvent = { type: "quota", provider: "claude", window: "seven_day", utilization: 96, status: "allowed_warning" };
    const { provider } = providerEmitting([warning, { type: "result", data: validImplementResult }]);

    await supervisorFor(provider).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("a genuinely malformed result still gets its corrections — only a limit is exempt", async () => {
    // The half of the item that must not change. Same malformed
    // result, no refusal behind it, and A-02's two corrections happen
    // exactly as before.
    const { provider, resumes } = providerEmitting([{ type: "result", data: { thisFieldDoesNotExist: true } }]);

    await supervisorFor(provider).runOnce();

    expect(resumes).toHaveLength(2);
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("validation");
    expect(limitNoteBody()).not.toContain("refused this run");
  });

  /**
   * The same limit, on the other backend (EO-340).
   *
   * Everything below this line is EO-172's machinery — the refusal
   * ledger, the parked run, the comment, the option to carry on — and
   * none of it was written twice. What was missing was the event that
   * starts it, so these go end to end through `mapThreadEvent`
   * deliberately: the events are not hand-written, they are whatever the
   * Codex adapter makes of what the CLI actually sends. An adapter that
   * stops recognising the refusal fails these, not only its own file.
   */
  describe("and the same limit on a Codex run (EO-340)", () => {
    beforeEach(() => implementerOn("codex"));

    const CODEX_THREAD = "0199e2ab-7f5c-7a31-9b64-6c2f1d0a55e1";

    /** The CLI's reset format, local-zone, as `providers/codex.ts` explains. */
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function codexResetStamp(at: number): string {
      const when = new Date(at);
      const hour24 = when.getHours();
      const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
      const minute = `${when.getMinutes()}`.padStart(2, "0");
      return `${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()} ${hour}:${minute} ${hour24 < 12 ? "AM" : "PM"}`;
    }

    /** What the CLI says when the window is spent — window named, reset three hours out. */
    const REFUSED = `You've hit your usage limit for gpt-5-codex. Switch to another model now, or try again at ${codexResetStamp(NOW + 3 * HOUR)}.`;

    /** A turn that failed for a reason that is nobody's allowance. */
    const BROKE = "sandbox denied exec error, exit code: 1";

    /** A whole Codex turn — the thread it opened and the failure that ended it — through the real mapper. */
    function codexTurn(message: string): AgentEvent[] {
      const events: ThreadEvent[] = [
        { type: "thread.started", thread_id: CODEX_THREAD },
        { type: "turn.failed", error: { message } },
      ];
      return events.flatMap((event) => mapThreadEvent(event).mapped);
    }

    function codexProvider(message: string): { provider: AgentProvider; resumed: { threadId: string; message: string }[] } {
      const events = codexTurn(message);
      const resumed: { threadId: string; message: string }[] = [];
      return {
        resumed,
        provider: {
          async *start(): AsyncIterable<AgentEvent> {
            yield* events;
          },
          async *resume(threadId: string, message: string): AsyncIterable<AgentEvent> {
            resumed.push({ threadId, message });
            yield* events;
          },
        },
      };
    }

    it("stops the run rather than failing it, and asks the backend nothing further", async () => {
      const { provider, resumed } = codexProvider(REFUSED);

      await supervisorFor(provider).runOnce();

      expect(resumed).toEqual([]);
      const [run] = listRunsForItem(handle.db, item.id);
      expect(run?.status).toBe("cancelled"); // not `failed`, which is what this used to be
      expect(run?.interruption).toBe("limit");
      expect(run?.error).toContain("refused this run");
      expect(run?.error).not.toContain("sandbox"); // nor the CLI's raw sentence
      expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    });

    it("names Codex, the window it filled and when it comes back", async () => {
      const { provider } = codexProvider(REFUSED);

      await supervisorFor(provider).runOnce();

      const body = limitNoteBody();
      expect(body).toContain('"codex" backend refused this run');
      expect(body).toContain("gpt-5-codex usage window");
      expect(body).toContain("in about 3 hours");
      expect(body).toContain("2026-08-28 23:40 UTC");
      // Codex reports no share of the window, so nothing claims one.
      expect(body).not.toContain("% used");
      expect(needsAttention(handle.db, item.id)).toBe(false);
    });

    it("says it does not know the reset rather than inventing one, in the same words Claude gets", async () => {
      const { provider } = codexProvider("You've hit your usage limit.");

      await supervisorFor(provider).runOnce();

      const body = limitNoteBody();
      expect(body).toContain("did not say when the window refreshes");
      expect(body).toContain("a usage window it did not name");
      expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("carries on in the same Codex thread once the window refreshes, with nobody replying", async () => {
      const { provider, resumed } = codexProvider(REFUSED);
      const supervisor = supervisorFor(provider);

      await supervisor.runOnce();

      // The thread id is what lets it carry on rather than start the
      // work again from nothing.
      const [stopped] = listRunsForItem(handle.db, item.id);
      expect(stopped?.threadId).toBe(CODEX_THREAD);
      expect(anyEscalation()).toBe(false);

      clock = NOW + 3 * HOUR + 1;
      await supervisor.runOnce(); // the hold lifts at the reset, and the run is carried on

      // This scripted backend refuses the resumed turn too, so one is all
      // that should be asked of it in this pass.
      expect(resumed.map((turn) => turn.threadId)).toEqual([CODEX_THREAD]);
    });

    it("still fails a Codex run that broke rather than ran out", async () => {
      // The line the classification must not cross. A turn that failed
      // for any other reason ends exactly as it does today: a failed
      // run, the CLI's own message, and nothing about a window.
      const { provider } = codexProvider(BROKE);

      await supervisorFor(provider).runOnce();

      const [run] = listRunsForItem(handle.db, item.id);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe(BROKE);
      const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
      expect(bodies.some((body) => body.includes("refused this run"))).toBe(false);
    });
  });

  it("keeps a run's reading as the rail's latest status for that backend and window, not its share, and rings planUsage:changed (EO-896, EO-938)", async () => {
    const rang: unknown[] = [];
    const stop = onPush("planUsage:changed", (payload) => rang.push(payload));
    try {
      // The store reads the process's clock, not the supervisor's.
      const resetsAt = Math.floor((Date.now() + 50 * HOUR) / 1000);
      const reading: QuotaEvent = { type: "quota", provider: "claude", window: "seven_day", utilization: 64, status: "allowed", resetsAt };
      const { provider } = providerEmitting([reading, { type: "result", data: validImplementResult }]);

      await supervisorFor(provider).runOnce();

      const claude = planUsage.view().backends.find((backend) => backend.provider === "claude");
      // The share is the five-minute read's to set; this one stands where none came before.
      expect(claude?.windows.find((window) => window.window === "seven_day")).toMatchObject({ utilization: null, status: "allowed", resetsAt: resetsAt * 1000 });
      expect(rang.length).toBeGreaterThan(0);
      // Kept in memory only: nothing on the item says so.
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("64%"))).toBe(false);
    } finally {
      stop();
    }
  });
});
