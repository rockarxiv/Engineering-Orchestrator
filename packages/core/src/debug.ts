import { z } from "zod";
import { RunViewSchema } from "./ipc-schemas.js";

/**
 * Debug mode: what EO handed a backend, kept so a person can read it
 * (EO-392).
 *
 * The run view shows what an agent *did*. Nothing showed what EO *sent*
 * — which instructions, which prompt, on a new thread or a resumed one —
 * and the only way to find out was to read the code that assembles it.
 * Re-assembling a context afterwards would not answer the question
 * either: it shows what EO would send now, not what it sent.
 *
 * So the material is recorded where it is final, at the moment it is
 * handed to a provider, as one appended `run_events` row per send
 * (invariant #3). Only while debug mode is on: an installation that
 * never turns it on stores nothing extra.
 */

/** The `run_events.type` one send is stored under. */
export const DEBUG_SENT_EVENT = "debug_sent";

/**
 * What a learning review's fork did, as debug mode records it on the
 * reviewed run's log (EO-734): the fork's own `tool_call`, `tool_result`
 * and `output`, each under a type of its own.
 *
 * **Never the run's own types.** The review runs inside the run and
 * holds its slot, so its record belongs on that run's log — but
 * everything that counts a run's activity (its tool calls, the skills it
 * loaded, the memory it used, its turns and its cost) reads the log by
 * type, and must not count what the review did as the run's. A row's
 * payload is the fork's event as the backend reported it, with the
 * fork's thread id beside it.
 */
export const LEARNING_REVIEW_ACTIVITY_EVENTS = {
  tool_call: "learning_review_tool_call",
  tool_result: "learning_review_tool_result",
  output: "learning_review_output",
} as const;

/** One of the fork's event types debug mode records. */
export type LearningReviewActivityKind = keyof typeof LEARNING_REVIEW_ACTIVITY_EVENTS;

/** The fork's own event type a learning-review row was recorded from, or null for any other row. */
export function learningReviewActivityKind(type: string): LearningReviewActivityKind | null {
  for (const [kind, recordedAs] of Object.entries(LEARNING_REVIEW_ACTIVITY_EVENTS)) {
    if (recordedAs === type) return kind as LearningReviewActivityKind;
  }
  return null;
}

/**
 * The marker in the URL's query that makes a window the debug window.
 *
 * In the query for the canvas window's reason (`CANVAS_WINDOW_SEARCH`):
 * the platform builds the URL and the renderer reads it, in two
 * processes, and what a window *is* should not be something a route
 * table has to know about. The debug window draws no route at all.
 */
export const DEBUG_WINDOW_SEARCH = "window=debug";

/** Whether a URL's query (`location.search`) is the debug window's. */
export function isDebugWindowSearch(search: string): boolean {
  // Split by hand, as `isCanvasWindowSearch` is: this package is built
  // without the DOM's or Node's globals.
  return search.replace(/^\?/, "").split("&").includes(DEBUG_WINDOW_SEARCH);
}

/**
 * The session a turn was opened with, by name only.
 *
 * **Nothing here is a value.** MCP servers, tools and skills are listed
 * by the names the backend was given them under; a server's command, its
 * environment, its headers and every token are deliberately absent, so
 * there is no secret for this row to hold or for a window to show.
 */
export const DebugSessionSchema = z.object({
  /** `runs.provider` for this run — what actually ran, `fake` for a preview. */
  backend: z.string(),
  /**
   * Whether the adapter described its own session. False on a backend
   * with nothing to describe (the demo provider), where the fields below
   * are only what EO passed and say nothing about a default.
   */
  described: z.boolean(),
  /** The backend's own name for where instructions go (`systemPrompt`, `baseInstructions`), or null when it did not say. */
  instructionsSlot: z.string().nullable(),
  /** The model the adapter named to its backend. Null when it named none and the backend used its own default. */
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Sandbox and approval settings, in the backend's own words: Claude's `permissionMode`, Codex's `sandboxMode` and `approvalPolicy`. */
  policy: z.array(z.object({ name: z.string(), value: z.string() })),
  /** The name of the answer schema that constrained the turn — the resolved one, which a type may override — or null when none did. */
  outputSchema: z.string().nullable(),
  mcpServers: z.array(z.string()),
  /** The tool allowlist the backend was handed, or null when it was handed none. */
  allowedTools: z.array(z.string()).nullable(),
  skills: z.array(z.string()),
  /** The agent is ticked over to the person's own setup, so the backend also loads whatever that holds — which EO does not enumerate. */
  inheritsAmbientConfig: z.boolean(),
  /** Files named to the turn, by name. Their content travels by tool call, not in the prompt. */
  attachments: z.array(z.string()),
});
export type DebugSession = z.infer<typeof DebugSessionSchema>;

/** One thing EO handed a backend: the payload of a {@link DEBUG_SENT_EVENT} row. */
export const DebugSentSchema = z.object({
  /**
   * Why it was sent. `dispatch` opens a run; `reply` and `recovery`
   * continue a parked or interrupted one; `correction` is a further send
   * inside a run, asking the agent to fix what it returned;
   * `learning_review` is the review turn on a fork of the run's thread
   * after it ended (EO-717, recorded since EO-734) — not the run's own.
   */
  purpose: z.enum(["dispatch", "reply", "recovery", "correction", "learning_review"]),
  thread: z.object({
    /** Whether this turn opened a provider thread, continued one, or continued a copy of one (`forked`, the learning review's). */
    mode: z.enum(["new", "resumed", "forked"]),
    /**
     * The thread continued — on a fork, the thread it was forked from.
     * Null on a new one, whose id the backend had not issued yet when
     * this was written.
     */
    threadId: z.string().nullable(),
    /** Why a thread that existed was not carried on, in `findReusableThread`'s words. Null when nothing was refused. */
    refusal: z.string().nullable(),
  }),
  instructions: z.object({
    /** False on a resumed or forked thread: neither backend is sent instructions there, the thread keeps the ones it started with. */
    sent: z.boolean(),
    /**
     * Sent: the text, verbatim. Not sent: the instructions the thread
     * was started with, or null when EO cannot say what those were (the
     * agent's have been edited since and the thread predates the edit).
     */
    text: z.string().nullable(),
  }),
  /** The turn's prompt text, exactly as it was passed to the adapter. */
  prompt: z.string(),
  session: DebugSessionSchema,
});
export type DebugSent = z.infer<typeof DebugSentSchema>;

/** A run as the debug window lists it: the run view, and the item it worked on. */
export const DebugRunSchema = RunViewSchema.extend({
  itemId: z.string(),
  itemKey: z.string(),
  itemTitle: z.string(),
  provider: z.string().nullable(),
  cwd: z.string().nullable(),
});
export type DebugRun = z.infer<typeof DebugRunSchema>;

/**
 * One tab: an agent, and its recorded runs in the project, newest first.
 *
 * Recorded runs only (EO-394) — those with a `debug_sent` event. `live`
 * and `totalRuns` count the same runs `runs` is drawn from.
 */
export const DebugAgentSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  provider: z.string(),
  /** Has a recorded run in flight. Agents that do are listed first. */
  live: z.boolean(),
  /** How many recorded runs this agent has in the project, which may be more than `runs` holds. */
  totalRuns: z.number(),
  /** The newest of them, bounded per agent — so a long history shortens a tab and never removes one. */
  runs: z.array(DebugRunSchema),
});
export type DebugAgent = z.infer<typeof DebugAgentSchema>;
