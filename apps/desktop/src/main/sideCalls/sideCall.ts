import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentEvent,
  type AgentProvider,
  type JsonSchema,
  SIDE_CALL_MODELS,
  type SideCallFailureReason,
  type SideCallModelChoice,
  type SideCallPurpose,
  type SideCallResult,
  type Uuid,
} from "@eo/core";
import { startOfDay } from "../dateUtils.js";
import type { Db } from "../db/client.js";
import { getRun, sumCostCentsForItem, sumCostCentsSince } from "../db/repos/index.js";
import { recordSideCall } from "../db/repos/sideCallsRepo.js";
import { createUsageTally } from "../supervisor/usageTally.js";
import type { SideCallSlots } from "./slots.js";

/**
 * One short question to a model — the backend's small one, or the system
 * agent's for the purposes `SIDE_CALL_MODELS` says need judgement
 * (EO-578) — and its schema-shaped answer
 * (EO-477, ARCHITECTURE.md, "One interface, two backends").
 *
 * What memory selection, extraction and consolidation ask, and nothing
 * like a run: no item is required, nothing appears on the board, no
 * thread is kept, and the backend is given no tools, servers, skills or
 * repository — only an empty directory and the backend's lockdown. Each
 * call writes one `side_calls` row, and the spend readers count those
 * rows wherever they count runs.
 */
export interface SideCallRequest<T> {
  purpose: SideCallPurpose;
  /** Which backend answers: the dispatched agent's, or the system agent's for consolidation. */
  backend: string;
  /** The answer's shape. Sent to the backend as JSON Schema and checked again here, because a backend's claim is not proof (invariant 5). */
  schema: z.ZodType<T>;
  system: string;
  input: string;
  /**
   * The model and reasoning effort the call runs on, for a purpose that
   * runs on the system agent's (`SIDE_CALL_MODELS`, EO-578): that agent's,
   * with its consolidation override laid over them. Required there — a
   * call without it fails rather than quietly taking the small model —
   * and not looked at for a purpose on the small model, which is always
   * asked with no effort set. A null model is the backend's default for
   * agents (`defaultModel`).
   */
  model?: SideCallModelChoice;
  itemId?: Uuid;
  projectId: Uuid | null;
  /**
   * How long the whole call may take, from the moment it is made —
   * waiting for a slot included. A consolidation that waits behind a
   * two-hour run times out and is asked again later, rather than waiting
   * with no bound.
   */
  timeoutMs: number;
  /**
   * The run whose dispatch or settle this happens inside. The call uses
   * that run's concurrency slot rather than taking another, and spends
   * against what the run's item and day have left.
   */
  insideRunId?: Uuid;
  /** The caller's own way to stop it. */
  signal?: AbortSignal;
  /**
   * The most output tokens the answer may run to (EO-577). Counted here,
   * as the answer is written, from the words the backend streams — both
   * backends stream a side call's — at one token a byte of UTF-8, which
   * no byte-level tokenizer writes fewer bytes than, and from the output
   * tokens the backend reports, whichever is larger. Past it the backend
   * is wound down (`AgentSideCallOptions.windDown`), so what it spent is
   * still reported and recorded, and the call fails as `timeout`. Absent
   * is no cap but the time limit.
   */
  maxOutputTokens?: number;
  /**
   * Whether a call made on its own gives way to pipeline work (EO-577):
   * asked at the moment it would take a global slot, and true means an
   * item is waiting to be dispatched or a run is going. Then the call is
   * not made and takes no slot — it fails as `error`, saying so — rather
   * than queueing for the slot ahead of the work. Not asked of a call
   * inside a run, which takes no slot. Absent never gives way.
   */
  giveWay?: () => boolean;
  /**
   * Told, once, how long a call made on its own held its global slot,
   * from taking it to giving it back (EO-577). Not told for a call that
   * took none — one inside a run, or one that ended before a slot.
   */
  onSlotHeld?: (ms: number) => void;
}

export interface SideCallerOptions {
  db: Db;
  /** The adapter a backend's side calls run on, built for side calls and nothing else; null where there is none. */
  provider: (backend: string) => AgentProvider | null;
  /**
   * The backend's small model; null leaves the backend's own default.
   * Handed the call's signal: finding Codex's default spawns its CLI, and
   * a call that times out or is shut down must not leave that running.
   */
  smallModel: (backend: string, signal: AbortSignal) => Promise<string | null>;
  /**
   * The model the backend's agents run on when they name none, for a
   * call on the system agent's model that names none (EO-578). Null
   * leaves the backend's own default; absent is null. Handed the call's
   * signal for `smallModel`'s reason.
   */
  defaultModel?: (backend: string, signal: AbortSignal) => Promise<string | null>;
  /** Whether the backend has a sign-in to run with. Asked before any model call, with the call's signal; absent is "yes". */
  signedIn?: (backend: string, signal: AbortSignal) => Promise<boolean>;
  /**
   * Why the backend's sign-in, though there, cannot reach where its side
   * calls run — Codex's in the keyring (EO-509) — or null. Asked before
   * the sign-in probe and any model call; a sentence fails the call as
   * `sign_in_unreachable`. Absent is "it can".
   */
  signInUnreachable?: (backend: string) => string | null;
  /** The budgets, read on every call so a settings change applies to the next one. */
  guards: () => { perItemBudgetCents: number | null; dailyBudgetCents: number | null };
  slots: SideCallSlots;
  now?: () => number;
  /** Where the call runs: an empty directory, made for it and removed after. A seam for tests. */
  workDirectory?: () => { path: string; remove: () => void };
  /** How long a call cut off at its cap may wind down (`SIDE_CALL_WIND_DOWN_MS`). A seam for tests. */
  windDownMs?: number;
}

export interface SideCaller {
  sideCall: <T>(request: SideCallRequest<T>) => Promise<SideCallResult<T>>;
  /** Stops every call in flight, waiting ones included — EO is shutting down. */
  abortAll: () => void;
  inFlight: () => number;
}

/** The sentences a backend says when it has no sign-in to run with. Both CLIs' words, and the HTTP status under them. */
const SIGNED_OUT = /not (?:logged|signed) in|please run \/?login|invalid (?:x-)?api[ -]?key|authentication[_ ]?(?:failed|error)|unauthori[sz]ed|\b401\b/i;
/** Claude's way of saying the answer never fitted the schema. */
const STRUCTURED_OUTPUT_GAVE_UP = /structured_output/i;
/**
 * How long a stopped call's stream is read on for what it spent, from the
 * moment it was stopped (`untilAborted`). Long enough for a backend that
 * heard the signal to report its last usage; short enough that one that
 * did not still leaves the call settled at once, as far as anybody waits.
 */
export const SIDE_CALL_ABORT_GRACE_MS = 2_000;
/**
 * The sentences a backend says when it cannot run the model it was
 * named: Claude's CLI and its API, Codex's catalogue and its service.
 */
const MODEL_UNAVAILABLE =
  /issue with the selected model|model[^.\n]{0,80}\b(?:not found|not_found|does not exist|doesn't exist|may not exist|is not supported|not supported|unsupported|not available|unavailable)\b|\b(?:unknown|invalid|unsupported) model\b|model_not_found|not_found_error[^\n]{0,80}\bmodel\b|catalogue does not name/i;
/**
 * How long a call cut off at its output-token cap is given to wind down
 * and report what it spent before it is stopped outright (EO-577).
 */
export const SIDE_CALL_WIND_DOWN_MS = 5_000;

/** What a call that gave way to pipeline work says (`SideCallRequest.giveWay`). */
export const SIDE_CALL_GAVE_WAY = "Pipeline work was waiting for the global slot, so the call gave way to it and was not made.";

function emptyDirectory(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), "eo-side-call-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The schema as JSON Schema, the way a backend's structured-output option takes it. */
function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "output" }) as JsonSchema;
}

/**
 * Waits for `work`, or for `signal` — whichever is first. The signal is
 * also handed to the work, so what it started is stopped; this is what
 * makes the call settle at its deadline even if the work is slow to
 * notice.
 */
async function abortable<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
  if (signal.aborted) return { done: false };
  let onAbort: () => void = () => {};
  const stopped = new Promise<{ done: false }>((resolve) => {
    onAbort = () => resolve({ done: false });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal).then((value) => ({ done: true as const, value })), stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The stream's events until it ends or `signal` aborts, whichever is
 * first. An adapter is handed the signal and stops its backend, but the
 * call settles at its deadline or at shutdown even if the backend never
 * notices — the guarantee `abortable` gives the lookups before it.
 *
 * Aborted, the stream is not dropped at once: a backend that heard the
 * signal still reports what the call spent as it ends — Claude's last
 * result, Codex's interrupted turn — and that is cost the budgets must
 * count. So for up to `graceMs` from the abort the stream is read on, and
 * the events `keepAfterAbort` accepts are passed on; it is then asked to
 * finish and not waited for, however much it still has to say.
 */
async function* untilAborted<T>(stream: AsyncIterable<T>, signal: AbortSignal, keepAfterAbort: (value: T) => boolean, graceMs = SIDE_CALL_ABORT_GRACE_MS): AsyncGenerator<T> {
  if (signal.aborted) return;
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const stopped = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let pending: Promise<IteratorResult<T>> | null;
  try {
    for (;;) {
      pending = iterator.next();
      const next = await Promise.race([pending, stopped]);
      if ("aborted" in next) break;
      pending = null;
      if (next.done) return;
      yield next.value;
    }
    // Aborted: read on until the stream ends or the grace is up, from the
    // abort and not from each event, so a backend that keeps talking
    // cannot hold the call open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), graceMs);
      timer.unref?.();
    });
    try {
      for (;;) {
        const step: Promise<IteratorResult<T> | "ended"> = (pending ?? iterator.next()).catch(() => "ended" as const);
        pending = null;
        const settled = await Promise.race([step, late]);
        if (settled === "late") {
          void Promise.resolve(iterator.return?.()).catch(() => {});
          return;
        }
        if (settled === "ended" || settled.done) return;
        if (keepAfterAbort(settled.value)) yield settled.value;
      }
    } finally {
      clearTimeout(timer);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function createSideCaller(options: SideCallerOptions): SideCaller {
  const { db, slots } = options;
  const now = options.now ?? Date.now;
  const workDirectory = options.workDirectory ?? emptyDirectory;
  const windDownMs = options.windDownMs ?? SIDE_CALL_WIND_DOWN_MS;
  /** Every call's way to stop, so a shutdown reaches the ones still waiting as well as the ones running. */
  const live = new Set<(why: "shutdown") => void>();
  let shuttingDown = false;

  /**
   * What the call may spend now, or why it may spend nothing (EO-477).
   *
   * Asked twice: once when the call is made, so a spent budget is refused
   * before anything is spawned or waited for, and again immediately before
   * the model is asked — a call that queued for a slot behind a run may
   * find the run spent what the day had left while it waited.
   */
  function budgetNow(itemId: Uuid | undefined): { refused: string } | { cents: number | undefined } {
    const guards = options.guards();
    let cents: number | undefined;
    if (guards.dailyBudgetCents != null) {
      const spent = sumCostCentsSince(db, startOfDay(now()));
      if (spent >= guards.dailyBudgetCents) return { refused: `The daily budget of ${guards.dailyBudgetCents}¢ is spent (${spent}¢ today), so the call was not made.` };
      cents = guards.dailyBudgetCents - spent;
    }
    if (guards.perItemBudgetCents != null && itemId !== undefined) {
      const spent = sumCostCentsForItem(db, itemId);
      if (spent >= guards.perItemBudgetCents) return { refused: `The item's budget of ${guards.perItemBudgetCents}¢ is spent (${spent}¢ so far), so the call was not made.` };
      const left = guards.perItemBudgetCents - spent;
      cents = cents === undefined ? left : Math.min(cents, left);
    }
    return { cents };
  }

  /**
   * One call, from its first line to the row it leaves. Never throws:
   * anything that goes wrong — the settings unreadable, a spend read
   * failing, the adapter failing to build — comes back through `fail`,
   * which writes the one row as every other ending does.
   */
  async function sideCall<T>(request: SideCallRequest<T>): Promise<SideCallResult<T>> {
    const startedAt = now();
    const usage = createUsageTally();
    /** The model asked for, until the backend says which one answered. */
    let model: string | null = null;
    let reportedModel: string | null = null;
    let itemId: Uuid | undefined = request.itemId;
    /** When the call took its global slot, or null while it holds none (EO-577). */
    let slotAt: number | null = null;

    /** The one row, however the call ended. Never allowed to turn an answer into a throw. */
    const finish = (result: SideCallResult<T>): SideCallResult<T> => {
      try {
        const totals = usage.totals();
        recordSideCall(db, {
          purpose: request.purpose,
          projectId: request.projectId,
          itemId: itemId ?? null,
          runId: request.insideRunId ?? null,
          backend: request.backend,
          // The model that actually answered, where the backend says (EO-578):
          // a call that named none ran on whatever the backend chose.
          model: reportedModel ?? model,
          tokensIn: totals.tokensIn,
          tokensOut: totals.tokensOut,
          // Unrounded (EO-510): a side call costs a fraction of a cent.
          costMicrocents: usage.costMicrocents(),
          startedAt,
          durationMs: Math.max(0, now() - startedAt),
          outcome: result.ok ? "succeeded" : "failed",
          reason: result.ok ? null : result.reason,
        });
      } catch (error) {
        console.warn(`[eo] a ${request.purpose} side call could not be recorded: ${messageOf(error)}`);
      }
      return result;
    };
    const fail = (reason: SideCallFailureReason, message: string): SideCallResult<T> => finish({ ok: false, reason, message });

    if (shuttingDown) return fail("error", "EO is shutting down, so the call was not made.");
    // A purpose that is a turn on a run's own agent, not a question to a
    // small model (EO-717): its spend is written here, and it is never asked.
    if (SIDE_CALL_MODELS[request.purpose] === "agent") return fail("error", `A ${request.purpose} is a turn on the run's own agent, not a side call, so the call was not made.`);

    const controller = new AbortController();
    let stoppedBy: "timeout" | "output_cap" | "shutdown" | "caller" | null = null;
    const stop = (why: "timeout" | "output_cap" | "shutdown" | "caller") => {
      if (stoppedBy === null) stoppedBy = why;
      controller.abort();
    };
    let windDownTimer: ReturnType<typeof setTimeout> | undefined;
    live.add(stop);
    const timer = setTimeout(() => stop("timeout"), Math.max(0, request.timeoutMs));
    timer.unref?.();
    const onCallerAbort = () => stop("caller");
    if (request.signal?.aborted) stop("caller");
    else request.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const stopped = (): SideCallResult<T> =>
      stoppedBy === "timeout"
        ? fail("timeout", `The call took longer than its ${request.timeoutMs} ms and was stopped.`)
        : stoppedBy === "shutdown"
          ? fail("error", "EO shut down while the call was in flight, so it was stopped.")
          : fail("error", "The call was cancelled by its caller.");
    /** A call cut off at its output-token cap (EO-577), with what it spent recorded. */
    const cutOffAtCap = (): SideCallResult<T> => fail("timeout", `The answer ran past its cap of ${request.maxOutputTokens} output tokens and was cut off.`);

    let release: (() => void) | null = null;
    let directory: { path: string; remove: () => void } | null = null;
    try {
      if (itemId === undefined && request.insideRunId) itemId = getRun(db, request.insideRunId)?.itemId ?? undefined;

      // The budgets first, before anything is spawned or waited for: a
      // spent budget is refused with no model call at all.
      const early = budgetNow(itemId);
      if ("refused" in early) return fail("budget", early.refused);

      const provider = options.provider(request.backend);
      if (!provider?.sideCall) return fail("error", `The "${request.backend}" backend makes no side calls.`);

      const unreachable = options.signInUnreachable?.(request.backend) ?? null;
      if (unreachable !== null) return fail("sign_in_unreachable", unreachable);

      if (options.signedIn) {
        const signedIn = await abortable(controller.signal, (signal) => options.signedIn!(request.backend, signal));
        if (!signedIn.done) return stopped();
        if (!signedIn.value) return fail("signed_out", `The ${request.backend} backend is not signed in, so the call was not made. Sign it in from Agents → Runtimes.`);
      }
      // Which model: the small one, with no effort, or the system agent's
      // with its effort (EO-578).
      let reasoningEffort: string | null = null;
      if (SIDE_CALL_MODELS[request.purpose] === "system_agent") {
        if (request.model === undefined) return fail("error", `A ${request.purpose} call runs on the system agent's model, and none was given, so the call was not made.`);
        reasoningEffort = request.model.reasoningEffort;
        const named = request.model.model;
        if (named !== null) model = named;
        else if (options.defaultModel) {
          const fallback = await abortable(controller.signal, (signal) => options.defaultModel!(request.backend, signal));
          if (!fallback.done) return stopped();
          model = fallback.value;
        }
      } else {
        const chosen = await abortable(controller.signal, (signal) => options.smallModel(request.backend, signal));
        if (!chosen.done) return stopped();
        model = chosen.value;
      }

      // A call on its own waits for a global slot and holds it; one inside
      // a run is already in that run's (invariant 10).
      if (request.insideRunId === undefined) {
        // Unless pipeline work is waiting for it, asked at the last
        // moment (EO-577): whoever made the call looked before making it,
        // and an item may have become dispatchable since.
        if (request.giveWay?.() === true) return fail("error", SIDE_CALL_GAVE_WAY);
        release = await slots.acquire(controller.signal);
        if (release === null) return stopped();
        slotAt = now();
      }

      // And the budgets again, now the call is about to be made: what
      // was left when it was asked for is not what is left after a wait.
      const budget = budgetNow(itemId);
      if ("refused" in budget) return fail("budget", budget.refused);

      directory = workDirectory();
      // Cut off at its output-token cap: asked to wind down, given a few
      // seconds to say what it spent, then stopped outright.
      const windDown = new AbortController();
      let capped = false;
      const cap = request.maxOutputTokens;
      /** The UTF-8 bytes of words streamed so far: never fewer than the tokens they took. */
      let written = 0;
      const pastCap = () => cap !== undefined && Math.max(written, usage.totals().tokensOut) > cap;
      const cutOff = () => {
        capped = true;
        windDown.abort();
        windDownTimer = setTimeout(() => stop("output_cap"), windDownMs);
        windDownTimer.unref?.();
      };
      let answer: { data: unknown } | null = null;
      let failure: { message: string; budget: boolean } | null = null;
      let refused = false;
      const stream = provider.sideCall({
        model,
        ...(reasoningEffort === null ? {} : { reasoningEffort }),
        system: request.system,
        input: request.input,
        outputSchema: jsonSchemaOf(request.schema),
        cwd: directory.path,
        signal: controller.signal,
        ...(cap === undefined ? {} : { windDown: windDown.signal }),
        ...(budget.cents === undefined ? {} : { budgetCents: budget.cents }),
      });
      try {
        // Stopped, only what it spent is still read (`untilAborted`), and it changes nothing but the row's cost.
        for await (const event of untilAborted(stream as AsyncIterable<AgentEvent>, controller.signal, (event) => event.type === "usage")) {
          if (event.type === "usage") {
            usage.record(event);
            if (event.model) reportedModel = event.model;
          } else if (event.type === "thread_started" && event.model && reportedModel === null) reportedModel = event.model;
          if (controller.signal.aborted) continue;
          // Winding down: what it spent is read until it ends, and nothing
          // else it says — its answer is past the cap whatever it is.
          if (capped) continue;
          if (event.type === "output_delta") written += Buffer.byteLength(event.text, "utf8");
          if (pastCap()) {
            cutOff();
            continue;
          }
          if (event.type === "quota" && event.status === "rejected") refused = true;
          else if (event.type === "result" && answer === null) answer = { data: event.data };
          else if (event.type === "error" && event.fatal !== false && failure === null) failure = { message: event.message, budget: event.budget === true };
        }
      } catch (error) {
        if (capped) return cutOffAtCap();
        if (controller.signal.aborted) return stopped();
        failure ??= { message: messageOf(error), budget: false };
      }
      if (capped) return cutOffAtCap();
      if (controller.signal.aborted) return stopped();

      if (answer !== null && failure === null) {
        const parsed = request.schema.safeParse(answer.data);
        if (parsed.success) return finish({ ok: true, value: parsed.data });
        // A sign-in failure some CLIs report as the answer's text.
        if (typeof answer.data === "string" && SIGNED_OUT.test(answer.data)) return fail("signed_out", `The ${request.backend} backend said: ${answer.data}`);
        return fail("schema", `The answer did not match the shape asked for: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(answer)"}: ${issue.message}`).join("; ")}`);
      }
      if (failure !== null) {
        if (failure.budget) return fail("budget", "The call was stopped at what the budget had left.");
        if (refused) return fail("quota", `The ${request.backend} backend's plan refused the call: ${failure.message}`);
        if (SIGNED_OUT.test(failure.message)) return fail("signed_out", `The ${request.backend} backend is not signed in: ${failure.message}`);
        if (STRUCTURED_OUTPUT_GAVE_UP.test(failure.message)) return fail("schema", `The backend could not answer in the shape asked for: ${failure.message}`);
        // A model the backend cannot run, said with the model's name
        // whether or not the backend's own words carry it (EO-578).
        if (MODEL_UNAVAILABLE.test(failure.message)) {
          const named = reportedModel ?? model;
          return fail("error", `The ${request.backend} backend cannot run the model ${named === null ? "it chose by default" : `"${named}"`}: ${failure.message}`);
        }
        return fail("error", failure.message);
      }
      if (refused) return fail("quota", `The ${request.backend} backend's plan refused the call.`);
      return fail("error", "The backend ended the call without an answer.");
    } catch (error) {
      // Nothing above is meant to throw; this is the promise that nothing
      // can make it — and that what did still leaves its row.
      if (controller.signal.aborted) return stopped();
      return fail("error", messageOf(error));
    } finally {
      clearTimeout(timer);
      clearTimeout(windDownTimer);
      request.signal?.removeEventListener("abort", onCallerAbort);
      live.delete(stop);
      release?.();
      if (slotAt !== null) {
        try {
          request.onSlotHeld?.(Math.max(0, now() - slotAt));
        } catch (error) {
          console.warn(`[eo] how long a ${request.purpose} side call held its slot could not be passed on: ${messageOf(error)}`);
        }
      }
      try {
        directory?.remove();
      } catch (error) {
        console.warn(`[eo] could not remove a side call's directory: ${messageOf(error)}`);
      }
    }
  }

  return {
    sideCall,
    abortAll() {
      shuttingDown = true;
      for (const stop of live) stop("shutdown");
    },
    inFlight: () => live.size,
  };
}
