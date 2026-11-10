// Provider-agnostic on purpose: this file must never import or reference
// a specific SDK's types (Codex, Claude Agent SDK, ...) — that's the
// whole point of building the interface before the first real provider
// (ARCHITECTURE.md, "An agent is a row").

import type { AttachmentSource } from "./attachment-tool.js";
import type { AgentWriteBridgeAddress } from "./agent-writes.js";
import type { MemoryReadScope } from "./memory.js";
import type { SkillRunScope } from "./schemas/skills.js";

// Same rationale as uuid.ts's Crypto declaration: this package's tsconfig
// has neither "dom" nor "node" in its lib, so AbortSignal isn't ambiently
// declared here even though every real consumer (main process, renderer)
// has it natively. Minimal, structurally compatible slice only.
declare global {
  interface AbortSignal {
    readonly aborted: boolean;
    addEventListener: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
    removeEventListener: (type: "abort", listener: () => void) => void;
  }
}

export type JsonSchema = Record<string, unknown>;

export interface AgentInputAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  size: number;
  origin: "eo" | "legacy";
  synchronizationState: "local";
}

export interface AgentTurnOverrides {
  /** Per-conversation override. Omitted means the configured agent default. */
  model?: string;
  /** Provider-specific value selected from that provider's advertised capabilities. */
  reasoningEffort?: string;
  /**
   * Whether the backend should summarise its reasoning, as `reasoning`
   * events and `output_delta`s on the reasoning stream.
   *
   * Omitted is the backend's own default. Claude omits thinking text
   * unless asked; Codex summarises unless told not to. A conversation sets
   * it from its per-chat setting, so the two backends behave alike.
   */
  showReasoning?: boolean;
  /**
   * Whether to pass on the words of a block as they are generated
   * (`OutputDeltaEvent`). On for every run: a conversation is watched,
   * and a pipeline step's transcript draws its words as they are written.
   */
  streamDeltas?: boolean;
  /**
   * Whether the answer itself is streamed as it is written, not only the
   * words around it — a conversation's, whose answer is the reply a
   * person is reading.
   *
   * Separate from `streamDeltas` because on Claude it is a different
   * switch with a cost: the answer is a structured-output tool call, and
   * streaming a tool's input as it is written is the CLI's eager input
   * streaming, which covers every tool and may hand a tool partial input
   * when a turn runs out of output mid-argument. A pipeline step's answer
   * is a result's fields, not shown as it is written, so it does not ask.
   * Codex streams its answer as a message either way.
   */
  streamAnswer?: boolean;
  /**
   * What this turn may spend, in cents, where a budget applies to it —
   * the least of what the item's budget and the day's have left.
   *
   * Enforced by the backend's side of the adapter, during the turn: the
   * budgets were only checked when a turn reported its usage, which on
   * both backends is at its end, so a turn could spend any amount before
   * the check that should have stopped it. Claude's CLI takes a cap of
   * its own (`maxBudgetUsd`); Codex's adapter prices the running total
   * the app-server reports and interrupts the turn at the cap. Either way
   * the turn ends with an `error` marked `budget`.
   */
  budgetCents?: number;
  /**
   * What, beyond the turn's own options, a warm backend must have been
   * started for to be adopted by this turn (`AgentProvider.prewarm`) — the
   * caller's fingerprint of things the options only name, such as the
   * contents of a tool directory. Absent on a turn nobody warmed for.
   */
  warmKey?: string;
  /**
   * Where this turn's run works, as far as a skill's scope cares (EO-470).
   *
   * An adapter that writes skills itself — Codex's `.agent/skills` and
   * the list in its prompt — delivers only the attached skills whose
   * scope takes this in (`skillsForRun`). Claude's are already filtered
   * into the tool directory EO generated for the run, so it reads none of
   * this. Absent delivers global skills only.
   */
  skillScope?: SkillRunScope;
  /**
   * The environment variables this turn's run is given (EO-487,
   * ARCHITECTURE.md §14.2): every shared variable, with the step's own
   * over them name by name.
   *
   * Per turn, read when the turn opens, and never held: a provider is
   * cached for the life of the process, so a value it kept would outlive
   * an edit — and this is what keeps every value out of the provider
   * cache key. Both adapters put these into the environment of the CLI
   * process they start, *under* every name EO sets for the run itself
   * (PATH, HOME, `CODEX_HOME`, the backend's keys, the admin bearer, the
   * search hook's variables): a variable never displaces one of those.
   *
   * Not secret — shown in full in Settings and not hidden in a
   * transcript. Absent or empty gives the run none.
   */
  environmentVariables?: Record<string, string>;
  /**
   * Names this turn's CLI must start without, whatever it would inherit
   * (EO-584): the variables a redirected step on a trial sets for itself
   * and its trial-only scope does not. Leaving such a name out of
   * `environmentVariables` is not enough — the CLI inherits EO's own
   * environment beneath them, and a `CHANNEL=production` EO was launched
   * with would reach a run redirected away from it. Both adapters take
   * these out of every layer beneath what EO sets for the run.
   */
  withheldEnvironmentVariables?: string[];
  attachments?: AgentInputAttachment[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * The repository intelligence server this turn may query (EO-151).
 *
 * A command, its arguments and its environment — the generic shape of
 * every stdio MCP server, which is what keeps this file free of any
 * assumption about what is being spawned. `name` is the key the backend
 * registers it under and therefore the middle of every tool id the model
 * sees; EO reserves it so nothing a person added can take it.
 *
 * Per *turn* rather than per provider, and that is the whole reason it
 * is here and not in a provider's construction options. The server is
 * pointed at one item's checkout, and a provider is cached per agent
 * and dispatched against every item that agent works — so a server
 * baked in at construction would be one item's index answering another
 * item's questions. It also means an index that fails between two
 * dispatches simply stops being passed, with no cached object to
 * invalidate.
 *
 * EO never spawns this itself. It hands the configuration to the backend
 * and the backend starts the process, which is what makes the server's
 * life exactly the backend process's life: when a run is cancelled or
 * times out, the process EO ends takes its MCP children with it and
 * there is no handle left over for EO to have leaked.
 */
export interface RepositoryMcpServer {
  /** The key under the backend's server map. EO's own name, not the implementation's. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * What to call instead of searching the tree, in this index's own tool
   * names (EO-165).
   *
   * Here rather than in the adapter that says it, and that is the whole
   * point of the field. An adapter intercepting a broad `grep -rn` has
   * to name the call that answers it — "use the index" is the advice
   * EO-164 measured as inert — and the tool names belong to whichever
   * implementation is behind the port. A constant spelled in an adapter
   * would be an agent trained on one provider's vocabulary, which is
   * exactly what `repositoryIntelligence/port.ts` exists to prevent.
   * So the provider supplies the words and the adapter supplies the
   * sentence.
   *
   * Bare tool names, without the backend's prefix: `mcp__<server>__` is
   * Claude's spelling of a tool id and another backend's may differ, so
   * qualifying them is the adapter's job and not this object's.
   *
   * Optional, and absent is an ordinary answer that means *say
   * nothing*. A provider with no vocabulary to offer gets no
   * interception at all rather than a nudge naming tools that may not
   * exist — the same rule as an absent server, one level down.
   */
  answers?: RepositoryIndexAnswers;
  /**
   * Asks the index what it actually holds, so that a suggestion is only
   * made where there is something to suggest (EO-173).
   *
   * The other half of `answers`, and it is here for the same reason:
   * naming the call that would answer a search is only good advice when
   * the index can answer it, and only the implementation can say whether
   * it can. EO-165 shipped the naming without the asking, and one run
   * measured what that costs — seven of eight interceptions named a call
   * that had nothing to say, and the agent, correctly, stopped listening
   * to all of them.
   *
   * Answers rather than throws, like every other call into this
   * subsystem, and answers *quickly* or not at all: this runs inside a
   * hook that a tool call is waiting on, so an index that cannot be
   * reached has to come back empty rather than hold the call up. An
   * empty answer and an unreachable index are deliberately the same
   * thing here — both mean "say nothing" — and neither is a second
   * opinion about whether repository intelligence is available. That was
   * decided once, when this server was handed over at all.
   *
   * Optional, and absent means the same as no vocabulary: no
   * interception. A suggestion nobody checked is the thing this exists
   * to stop.
   */
  knows?: (question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]>;
}

/**
 * What the interception asks an index before it names it (EO-173).
 *
 * Two questions, because a broad search only ever asks two things an
 * index could answer: where a name is, and where files of some shape
 * are. A tree walk with no needle in it asks the second one about every
 * file there is.
 *
 * Deliberately not "run this query": the whole point of the port is
 * that nothing above it knows the implementation's query language, and
 * a question EO poses in its own words is a question any implementation
 * can answer its own way.
 */
export type RepositoryIndexQuestion =
  /** Does the index hold a declaration under this name? */
  | { of: "symbol"; name: string }
  /** Does the index hold files matching this — a glob, a filename, or `*` for "any at all"? */
  | { of: "file"; pattern: string };

/**
 * One thing an index holds, in the least it takes to judge whether
 * naming it would help (EO-173).
 *
 * A name and a path and nothing else. Not a signature, not a line, not a
 * body: this decides whether to say a sentence the agent could act on,
 * and the agent gets the detail from the index itself, in its own call.
 * Anything more here would be EO answering the question instead of the
 * tool it is recommending.
 */
export interface RepositoryIndexHit {
  /**
   * What the index holds it under — the declared name, or the file's
   * path for a file.
   *
   * Reported rather than assumed to equal what was asked, because an
   * index that matches loosely is the case this exists for: `quota`
   * matching `QuotaEvent` is not an answer to "where is `quota`
   * declared", and only the name can say so.
   */
  name: string;
  /** Where it is, relative to the checkout. Never an absolute path off this machine. */
  path: string;
}

/**
 * The four questions a symbol index answers that a tree search cannot
 * answer well, each named by the tool that answers it (EO-165).
 *
 * Four rather than nine, because this is a vocabulary for one sentence
 * and not a catalogue: an interception has room to name the call and
 * what it returns, and a list of every tool is the tool list the agent
 * already has. They are the four shapes a broad search actually takes —
 * a name, an area, a reach, a file — which is what
 * `repositoryIntelligence/broadSearch.ts` classifies a command into.
 */
export interface RepositoryIndexAnswers {
  /** Where a name is declared: the tool a `grep -rn <symbol>` was reaching for. */
  symbol: string;
  /** A whole area from a question in prose: what an agent that does not know the name needs. */
  area: string;
  /**
   * What reaches a symbol — its callers, and the blast radius of
   * changing it. A list because the two are usually different tools, and
   * because this is the half no tree search can answer at all.
   */
  reach: string[];
  /** What files exist and where: the tool a `find -name` was reaching for. */
  files: string;
}

export interface AgentProviderStartOptions extends AgentTurnOverrides {
  instructions: string;
  context: string;
  cwd: string;
  /**
   * Told the Skills section the adapter adds after `context` (EO-602),
   * or an empty string when it adds none — synchronously, before `start`
   * returns, and from the skills it actually delivered rather than the
   * ones it was meant to. Debug mode's capture is the caller: the
   * section is added below the provider boundary, so this is the only
   * way the record of what was sent can hold it.
   */
  onSkillsSection?: (section: string) => void;
  outputSchema?: JsonSchema;
  tools?: ToolDef[];
  /**
   * The directory EO generated for this turn, holding the MCP servers
   * and skills its agent has attached (EO-107).
   *
   * A path and nothing else, deliberately. What is *in* the directory,
   * and which of it the backend reads versus the adapter, is a contract
   * between one provider and the binary it drives — Claude's holds a
   * manifest, an `.mcp.json` and a `skills/` tree, and the split between
   * them is decided in that adapter. None of that shape belongs in a
   * provider-agnostic interface. A provider with no use for a directory
   * ignores it.
   *
   * Absent means "this agent has nothing attached". Not the same as an
   * empty directory: EO writes none at all rather than pointing a
   * backend at an empty one, so a provider can tell "nothing to deliver"
   * from "delivered nothing".
   *
   * Never a secret. The generated files carry environment-variable
   * *names* — `${VAR}` — and the values arrive through the provider's
   * own environment at spawn, which is what keeps them off the command
   * line every other local process can read.
   */
  toolDirectory?: string;
  /**
   * The repository intelligence server for this item's checkout, or
   * absent when there is none to give (EO-151).
   *
   * Absent is an ordinary answer and every adapter has to treat it as
   * one: the feature is off, the item carries no repository, the
   * binary could not be resolved, or the index failed to build. The
   * agent runs regardless, with the filesystem and git tools it has
   * always had.
   */
  repositoryMcp?: RepositoryMcpServer;
  /**
   * The run this turn belongs to and the directory it may attach files
   * from, or absent when it has neither (EO-412).
   *
   * What lets the `eo` server offer `attachment_add` and answer a call
   * to it truthfully. Absent, the tool is not listed: a conversation or
   * a workspace with no disk has nothing to attach from.
   */
  attachFrom?: AttachmentSource;
  /**
   * The memory scopes this turn may read with `memory_read`, or absent
   * when it was delivered no memory (EO-478).
   *
   * The project's, and each workspace's the step works in — the scopes
   * the turn's memory section was drawn from. What lets the `eo` server
   * list the tool and hold it to those scopes; absent, it is not listed.
   */
  memoryScopes?: MemoryReadScope[];
  /**
   * Where this turn's `eo` server hands the writes an agent asks for —
   * `comment`, `attachment_add`, `memory_note` — and the bearer it
   * presents (EO-543). Absent when the process has no bridge listening,
   * and the tools then answer that nothing could be written.
   */
  writeBridge?: AgentWriteBridgeAddress;
  signal: AbortSignal;
}

/**
 * What a turn cost, as the backend reports it.
 *
 * Every field here is a total including cached tokens, because that is
 * the number that is actually sent: an agentic loop re-sends its whole
 * conversation on every turn, so a prompt EO assembles once is paid for
 * as many times as the agent takes turns. Reporting only the uncached
 * remainder — which is what this used to do on Claude, whose
 * `usage.input_tokens` excludes both cache figures — made a run that
 * cost real money record a couple of hundred input tokens.
 *
 * `cacheReadTokens` is a part *of* `tokensIn` on both backends, not an
 * addition to it, so `cacheReadTokens / tokensIn` is a share on either.
 * `cacheWriteTokens` is reported as each backend reports it and is not
 * known to obey the same rule on both — read it as a figure beside the
 * total rather than a slice of it.
 *
 * They are kept separately because they price differently and, more to
 * the point, because the read share is the only way to tell a prompt
 * that is being re-read cheaply from one that is being re-sent in full.
 */
export interface UsageEvent {
  type: "usage";
  /**
   * Whether this is a turn's own cost or the session's running total.
   *
   * The two backends differ and neither is wrong. Codex reports each
   * turn as it completes (`turn.completed`), so the totals accumulate.
   * The Claude SDK re-reports a running total for the whole query on
   * every result message and says so plainly — "read the latest result
   * rather than summing across results" — so adding them up counts the
   * early turns once per later turn.
   *
   * A consumer that treats both the same is wrong for one of them, and
   * silently: the numbers stay plausible. So the emitter says which it
   * is, and `runToCompletion` sums the one and replaces the other.
   */
  scope: "turn" | "session";
  /** Total input, cache included. */
  tokensIn: number;
  tokensOut: number;
  /** The part of `tokensIn` served from the prompt cache. */
  cacheReadTokens?: number;
  /** What was written *into* the prompt cache, as the backend reports it. */
  cacheWriteTokens?: number;
  /**
   * Model turns behind this event — the count `tokensIn` was paid over.
   *
   * The multiplier on everything EO puts in a dispatch prompt, and the
   * one number that says whether a context saving is worth one copy or
   * thirty. Omitted where a backend does not say; a turn-scoped event
   * without it counts as the one turn it describes.
   */
  turns?: number;
  /**
   * The model the backend says this usage was spent on, where it names
   * one model for the turn (EO-392).
   *
   * Said at the *end* of the turn, which is what makes it more than
   * `thread_started`'s: a backend can move a turn to another model after
   * the thread opened — Codex's `model/rerouted` — and the model that
   * answered is then this one and not the one the thread started on.
   *
   * Absent where a backend reports no single model for the turn. Claude
   * accounts for a query across every model it used, a subagent's
   * included, so there is no one name to give and it gives none.
   */
  model?: string;
  /**
   * What the turn cost, in cents: as the backend reports it (Claude), or
   * as EO prices the tokens it reports (Codex, which reports no money —
   * `providers/codexPricing.ts`, EO-374). Absent when neither is known.
   */
  costCents?: number;
  /**
   * The same cost in micro-cents — millionths of a cent, a whole number
   * — before it was rounded to `costCents` (EO-510). Present wherever
   * `costCents` is and the adapter knew better than whole cents.
   *
   * A run costs dollars and a cent either way is nothing, so a run's row
   * keeps `costCents`. A side call costs a fraction of a cent, and
   * rounded one at a time almost every one is recorded as nothing; its
   * row keeps this instead, so that two hundred of them at half a cent
   * add up to a dollar. Absent, it is `costCents` exactly.
   */
  costMicrocents?: number;
  /**
   * Set when the backend reported tokens but no money and EO has no price
   * for the model they were spent on (EO-374), so `costCents` is absent
   * and the budgets in cents cannot count this turn. `model` is the
   * model the backend named, or null when it named none.
   *
   * Said rather than left as a missing figure because a missing figure
   * sums as zero, and a run the budgets cannot see is something the
   * person who set them has to be told.
   */
  unpriced?: { model: string | null };
}

/**
 * How much of the backend's own allowance this account has used.
 *
 * Not money. EO's agents run on subscriptions, so what actually stops
 * work is a plan window filling up — and the plans do not agree on
 * units, which is why nothing here converts one to the other or to a
 * price. Claude reports a share of a named window; Codex's SDK reports
 * nothing of the kind, and its consumption has to be read from the
 * tokens its turns declare.
 *
 * Emitted whenever a backend volunteers a reading. It is a fact about
 * the account rather than about the run, and it arrives mid-run only
 * because that is when anyone is listening.
 */
export interface QuotaEvent {
  type: "quota";
  /** Whose allowance this is — the two backends are counted separately. */
  provider: string;
  /** The window that is filling: Claude's `five_hour`, `seven_day`, `seven_day_opus`, … */
  window: string;
  /**
   * Percentage of that window used, 0–100.
   *
   * The scale is not documented on the event that carries it, and the
   * first cut of this read it as a fraction — which would have rendered
   * a plan 83% through its week as "8300% used". It is a percentage on
   * the evidence of the same SDK documenting the same figure, from the
   * same claude.ai usage endpoint, as "Percentage of the window used,
   * 0-100" (`SDKControlGetUsageResponse.rate_limits.*.utilization`), and
   * of the sibling `surpassedThreshold`, which is only meaningful on
   * that scale. If a live reading ever shows a busy window sitting near
   * 1, this is the assumption to revisit.
   *
   * Optional since EO-172, and only because `status` outgrew it. A
   * reading with no share used to be nothing worth recording, so the
   * adapter dropped it; now that a `rejected` status is what stops a run
   * from being retried, dropping one would throw away the only signal
   * that says why. A refusal is worth reporting with the share missing.
   * An `allowed` reading with nothing in it still is not, and is still
   * dropped where it is mapped.
   */
  utilization?: number;
  status: "allowed" | "allowed_warning" | "rejected";
  /** As the backend gave it. Unit is the backend's own and is not documented — do not render a clock from it without checking. */
  resetsAt?: number;
}

/**
 * Which of the MCP servers the backend was handed actually came up
 * (EO-107).
 *
 * Reported, never judged. A provider says what its backend told it and
 * stops there; deciding that a missing server matters needs to know
 * which ones EO attached to this agent, and that is the engine's
 * knowledge rather than an adapter's (invariant #5 — where EO can check
 * a claim independently, it must, and this is the fact it checks
 * against).
 *
 * `status` is the backend's own word, passed through unmapped — with
 * one exception. `connected` is the one word that means "it came up",
 * and a backend with its own word for that says `connected` instead:
 * Codex's `ready` arrives here as `connected` (EO-373), so the
 * supervisor knows one word for success rather than one per backend.
 * Every other word is passed through. Claude's init message says
 * `connected`, `failed`, `needs-auth`, and Codex says `failed`,
 * `cancelled`, `starting`; a backend that grows another must reach the
 * comment on the item as itself rather than as "not connected".
 *
 * `name` is likewise the backend's, which is not always the name EO
 * wrote: a server delivered through a plugin directory is registered as
 * `plugin:<plugin>:<server>`. Matching the two up is the engine's job
 * for the same reason.
 */
export interface ServerStatusEvent {
  type: "server_status";
  servers: { name: string; status: string }[];
}

/**
 * A tool the agent invoked, as the backend announced it.
 *
 * `callId` is the backend's own identifier for this invocation, and it
 * is here for exactly one reason: it is what pairs a call with the
 * `ToolResultEvent` that answers it. A turn can have several calls in
 * flight at once — both backends batch them — so "the result after the
 * call" is not a pairing, and a transcript that guesses would be
 * confidently wrong about which grep returned what. Optional because it
 * is the backend's to supply: a backend that announces a call without an
 * id still gets recorded, unpaired.
 */
export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: unknown;
  callId?: string;
}

/**
 * The skills this turn was actually given (EO-715), by slug — reported by
 * the adapter that delivered them, as the first thing its stream says:
 * the skills in the generated directory's allowlist on Claude, the
 * folders `writeWorktreeSkills` wrote on Codex. Not said at all by a turn
 * given none. On a resumed turn as well as a fresh one, because both
 * deliver.
 *
 * The supervisor turns it into the run's `skills_delivered` event, with
 * the skills' ids; it is not recorded as it stands.
 */
export interface SkillsOfferedEvent {
  type: "skills_delivered";
  slugs: string[];
}

/**
 * The agent loaded one of EO's skills (EO-715), read off what the backend
 * did rather than what the agent said: a `Skill` call naming
 * `eo-attachments:<slug>` on Claude, and a `skill_read` call to EO's `eo`
 * server that EO answered on Codex (EO-721) — a tool call on both, and
 * exact on both. Emitted straight after the `tool_call` it was read from. Whether the turn was given that skill is
 * the supervisor's question, not the adapter's.
 */
export interface SkillLoadAgentEvent {
  type: "skill_loaded";
  slug: string;
}

/**
 * What that call returned (EO-169).
 *
 * A separate event rather than a field on `ToolCallEvent`, because the
 * two facts do not arrive together and one of them may never arrive at
 * all. Claude sends the call on an assistant message and the result on
 * the user message after it; Codex sends both inside one completed item.
 * Holding the call back until its result landed would delay everything
 * the supervisor keys off a `tool_call` — the comment tool most of all —
 * and would drop the call entirely from a turn that was interrupted
 * between the two. So each is recorded when it happens, and `callId`
 * joins them.
 *
 * `output` is the tool's own text, bounded before it gets here (see
 * `providers/toolResult.ts`, which also carries the decision about
 * source content that this event exists inside of). `truncated` says
 * whether that bound bit, because "this is what the tool said" and "this
 * is the end of what the tool said" are different claims.
 *
 * `name` is the tool the result belongs to, repeated from the call so a
 * reader does not have to resolve an id to know what they are looking
 * at. Optional for the case it cannot be answered: Claude's result
 * blocks carry the call's id and not its name, so a result whose call
 * was never seen — the only realistic cause being a replayed transcript
 * — says the honest nothing rather than a guess.
 *
 * `status` and `exitCode` are the backend's own words about how the call
 * ended, passed through where it has them and absent where it does not,
 * on the same rule as `ServerStatusEvent.status`. `ok` is the one
 * judgement, and it is here because it is the question every reader asks
 * first and neither backend answers in the same vocabulary.
 */
export interface ToolResultEvent {
  type: "tool_result";
  name?: string;
  callId?: string;
  ok: boolean;
  output: string;
  truncated: boolean;
  status?: string;
  exitCode?: number;
}

/**
 * EO answered one of this agent's tool calls with a suggestion (EO-168).
 *
 * The interception fires between the model asking for a call and the
 * call running. Nothing about that reached the run's log before this
 * event existed, and the consequence was not a missing detail but a
 * missing *distinction*: a run where the hook never fired — the matcher
 * missed, the vocabulary was absent, the feature was off — and a run
 * where it fired and the agent went on grepping anyway produced
 * identical evidence. One is a wiring problem and one is a persuasion
 * problem, and the fixes are opposite. This is what tells them apart.
 *
 * A new kind rather than a reused one, per D-02: `RunEvent.type` is an
 * open string and a new kind is a new payload shape, so nothing already
 * in the log is touched.
 *
 * **Only an adapter that really intercepts may emit this.** An event
 * implying an interception on a backend where none is possible would be
 * worse than the silence it replaces — the whole point is that the log
 * can be counted. Both adapters carry the hook now — Codex's since
 * EO-379 — and each emits this only from the hook itself, when it fires:
 * neither reads a finished command and decides it looked like a search.
 *
 * **What it carries, and the line it does not cross.** The triggering
 * call and the suggestion, and nothing read off the disk: the needle is
 * what the agent typed, which the `tool_call` event beside this one
 * already records verbatim. No file's contents ever reach here — the
 * interception happens *before* the search runs and has no results to
 * carry even if it wanted to.
 */
export interface SearchInterceptionEvent {
  type: "search_interception";
  /** The backend's own name for the call that triggered it — `Bash`, `Grep`, `Glob`. */
  tool: string;
  /**
   * The backend's own id for the individual call that triggered it —
   * `ToolCallEvent.callId`, and the same field a `ToolResultEvent`
   * pairs on.
   *
   * The exact answer to "which tool call", and it is here because the
   * approximate answers are not enough. A model can ask for several
   * tools in one message and the backend runs them in parallel, so a
   * message carrying two broad searches produces two `tool_call` events
   * and then two interceptions — the interception is not adjacent to
   * its own call, and if the two searches are textually identical then
   * `tool`, `kind` and `needle` are identical too and name the pair
   * rather than either one.
   *
   * With the id the pair is two calls with two ids rather than an
   * ambiguity, and each interception joins to the call it fired on
   * rather than to the batch. It is also the only thing that would show
   * a hook invoked twice for one call, which would otherwise inflate
   * the count silently — the failure this whole event exists to stop
   * being invisible.
   *
   * The same name as on the call and the result rather than a spelling
   * of this event's own (EO-169 got here first with a separate reason
   * for wanting it, which is a good sign the field is the right one):
   * three events, one word for the backend's identifier for a call.
   *
   * Null where a backend does not supply one. That is an honest gap
   * rather than a fabricated id: the count and the ordering still hold
   * without it.
   */
  callId: string | null;
  /**
   * What the search was after, in the classifier's own vocabulary — a
   * name (`symbol`), a filename (`file`), the tree itself (`layout`).
   *
   * A bare string rather than a union, and deliberately: the vocabulary
   * belongs to whichever adapter classifies a call, and this file must
   * not learn one adapter's spelling of it (ARCHITECTURE.md, "One interface, two backends").
   */
  kind: string;
  /**
   * What it was looking for, when the call said so. Null for a bare tree walk.
   *
   * What a person reads in a transcript to see which search was
   * interrupted. `callId` is what a query joins on; this is what a
   * human recognises.
   */
  needle: string | null;
  /** What EO said back to the agent, verbatim — the suggestion whose uptake is the measurement. */
  suggestion: string;
}

/**
 * The `run_events.type` a `SearchInterceptionEvent` is stored under.
 *
 * The emitter does not need this — its literal is checked against the
 * interface above — but the code that reads the log back does, because
 * there the type is an opaque string in a WHERE clause and a typo is a
 * count of zero rather than an error. So the query that counts
 * interceptions names this, and anything else asking the log about them
 * should too.
 */
export const SEARCH_INTERCEPTION_EVENT = "search_interception";

/** How long a warm backend waits for the turn it was started for before it is shut down. */
export const PREWARM_IDLE_MS = 60_000;

/**
 * A few more characters of what the agent is writing, before the block
 * they belong to is finished.
 *
 * **Transient by design, and the only event that is.** Every other event
 * is appended to `run_events`; this one never is. The block it is part
 * of arrives complete a moment later — as an `output`, a `reasoning` or
 * the answer's `tool_call` — and that is the record. Storing the pieces
 * as well would write the same words twice, once a token at a time, into
 * a table that is never pruned. The supervisor hands these to the window
 * that is watching and keeps only the block being written, in memory, so
 * a window that opens mid-sentence starts from the right place.
 *
 * What a person sees is what Claude Desktop shows: words as they are
 * generated rather than whole paragraphs every few seconds. Both
 * backends emit it (invariant 12) — Claude from its partial messages,
 * Codex from its item deltas.
 */
export interface OutputDeltaEvent {
  type: "output_delta";
  /**
   * Which kind of block is being written: a message — which under an
   * output schema is the answer's JSON, read through `liveMessageOf` —
   * or the model's summary of its reasoning.
   */
  stream: "text" | "reasoning";
  text: string;
}

/**
 * The backend is still at work, with nothing to say yet.
 *
 * Transient, like `output_delta`: never stored, never shown. It exists
 * for the inactivity guard, which ends a run whose backend has gone
 * quiet — and a tool that runs for minutes is not quiet in that sense,
 * it is working. Claude reports a running tool's progress; Codex streams
 * a command's output as it is printed. Both reach here.
 */
export interface HeartbeatEvent {
  type: "heartbeat";
  /**
   * A tool call has begun, where the backend says so before the call
   * itself is reported: the call's own id, which the `tool_result` that
   * ends it carries.
   *
   * Codex reports a command only once it has finished, so without this a
   * quiet command — a test suite that prints nothing for minutes — would
   * look to the inactivity guard like a backend that had stopped. Claude
   * reports a call as it is made and needs none.
   */
  callStarted?: string;
}

/**
 * The backend's request to the model failed and it is trying again.
 *
 * Stored and shown, because a turn waiting out an overloaded API or a
 * rate limit looks, from outside, exactly like a turn that has hung —
 * and a person deciding whether to wait or stop is owed the difference.
 * It also counts as the backend being at work.
 */
export interface RetryingEvent {
  type: "retrying";
  /** What went wrong, in the backend's words or a status code it gave. */
  reason: string;
  /** Which try this is, and of how many, where the backend says. */
  attempt?: number;
  maxAttempts?: number;
  /** How long the backend waits before this try, where it says. */
  delayMs?: number;
}

/**
 * The backend compacted the conversation: what was said so far is now a
 * summary of itself, to make room in the context window.
 *
 * Stored and shown, because it changes what the agent knows — the brief
 * a run was seeded with is part of what gets summarised — and a person
 * reading a long run is owed the point where that happened. It is also
 * what has EO restate the item to the agent, so it carries on knowing
 * what it is working on.
 */
export interface CompactedEvent {
  type: "compacted";
  /** Whether the backend did it because the window was filling, or because somebody asked. */
  trigger?: "auto" | "manual";
  /** How many tokens the conversation held before, where the backend says. */
  tokensBefore?: number;
}

/**
 * The model's reasoning, as the backend summarised it.
 *
 * Its own event rather than an `output`, because it is not something the
 * agent said: it can never be the answer, it does not retire a candidate
 * answer, and a transcript draws it folded under "Thought" rather than as
 * narration. Codex used to report it as `output`, which is how a
 * reasoning summary could reach the live text of a chat.
 *
 * Present only when the turn asked for summaries (`showReasoning`) and
 * the model reasoned at all.
 */
export interface ReasoningEvent {
  type: "reasoning";
  text: string;
}

export type AgentEvent =
  | {
      type: "thread_started";
      threadId: string;
      /**
       * The model the backend says this thread is running on (EO-392).
       *
       * The backend's own word, reported when the thread is opened or
       * resumed — never the model EO asked for. They differ in exactly
       * the case this exists for: an agent with no model configured
       * names none, the backend picks its default, and nothing above the
       * adapter would otherwise know which one answered.
       *
       * Absent where the backend does not say.
       */
      model?: string;
    }
  | ServerStatusEvent
  | QuotaEvent
  | SearchInterceptionEvent
  | {
      type: "output";
      text: string;
      /**
       * Written under an output schema that constrains the whole turn
       * rather than only its answer (EO-199).
       *
       * A fact about how the text was generated, reported by the adapter
       * that knows it, and the one thing that decides whether the text's
       * *shape* is evidence of anything. Where the schema applies to the
       * final message only — Claude's `outputFormat` — an agent that
       * writes JSON mid-turn chose to, and a mid-flight terminal outcome
       * is a real mistake worth catching. Where it applies to the turn —
       * Codex's `outputSchema`, handed to `runStreamed` — every message
       * the model emits comes out in the answer's shape whether it meant
       * one or not, so the preamble a reasoning model writes before its
       * first tool call is indistinguishable from an answer and is not
       * evidence of one.
       *
       * Absent on the ordinary case, which is the unconstrained one: a
       * backend that says nothing here is one whose messages mean what
       * they look like.
       */
      schemaConstrained?: boolean;
    }
  | OutputDeltaEvent
  | ReasoningEvent
  | HeartbeatEvent
  | RetryingEvent
  | CompactedEvent
  | ToolCallEvent
  | ToolResultEvent
  | SkillsOfferedEvent
  | SkillLoadAgentEvent
  | { type: "file_edit"; path: string }
  | UsageEvent
  | { type: "result"; data: unknown }
  | {
      type: "error";
      message: string;
      retryable: boolean;
      /**
       * `false` for an error the backend reported without ending the
       * turn (EO-369) — Codex's `ErrorItem`, which its SDK documents as
       * "a non-fatal error surfaced as an item" and which the CLI uses
       * for warnings. It is recorded like any other error, so a person
       * reading the run sees it, but the turn goes on and the run ends on
       * whatever the turn ends on.
       *
       * Absent is fatal, which is every error before this field existed:
       * the first one ends the turn. `retryable` is not this — a failed
       * turn is retryable and still over.
       */
      fatal?: false;
      /** The turn was stopped because it reached the budget it was given (`budgetCents`), not because anything went wrong. */
      budget?: true;
    };

/**
 * What a resumed turn needs beyond the thread id.
 *
 * Originally `resume` took only `(threadId, message)`, on the assumption
 * that a provider session carries its own context. A-06 showed that it
 * doesn't: the Claude CLI keys sessions by working directory and answers
 * "No conversation found" when resumed from elsewhere, and Codex
 * silently resumes in `process.cwd()` — so a resumed agent was editing
 * the EO checkout instead of the item's worktree. The run row already
 * knows where it was working; the provider has to be told.
 *
 * Optional so a caller with no workspace (tests, the fake provider) stays
 * as it was.
 */
export interface AgentProviderResumeOptions extends AgentTurnOverrides {
  /** The same worktree the run started in. Sessions are scoped to it. */
  cwd?: string;
  /**
   * Told the Skills section the adapter adds after the message, or an
   * empty string when it adds none — synchronously, before `resume`
   * returns, as `AgentProviderStartOptions.onSkillsSection` is on a start.
   * Codex adds it to every resumed turn it gives skills (EO-721): a
   * thread opened before EO served skills through `skill_read` was told
   * to read a `SKILL.md` that is no longer written, so the turn says how
   * to load one now. Debug mode's capture is the caller.
   */
  onSkillsSection?: (section: string) => void;
  /** Re-stated because a corrective turn (A-02) must produce the same shape as the original. */
  outputSchema?: JsonSchema;
  /**
   * Re-stated for a plainer reason than `outputSchema`'s: resuming a
   * thread spawns the backend's process again, and a process that is not
   * pointed at the directory does not have what is in it (EO-107).
   *
   * The session keeps the tool surface it was opened with — that is the
   * rule `findReusableThread` enforces — so what a caller passes here is
   * the same directory that turn was started with rather than a new
   * decision about what the agent may reach.
   */
  toolDirectory?: string;
  /**
   * Re-stated for the reason `toolDirectory` is: resuming spawns the
   * backend's process again, and a server it is not told about on this
   * invocation is a server that process does not start (EO-151).
   *
   * Deliberately *not* a reason to refuse a resume. Repository
   * intelligence is not part of the tool surface `findReusableThread`
   * holds a thread to — it comes and goes with an index EO rebuilds and
   * resyncs, and refusing a thread every time that moved would spend a
   * full context assembly to save a query server.
   */
  repositoryMcp?: RepositoryMcpServer;
  /**
   * Re-stated for the reason `repositoryMcp` is: the `eo` server is
   * started again by the process a resume spawns, and it offers
   * `attachment_add` only when it is told which run it is serving and
   * where that run works (EO-412).
   */
  attachFrom?: AttachmentSource;
  /**
   * Re-stated for `attachFrom`'s reason: the `eo` server a resume starts
   * lists `memory_read` only when it is told which scopes it may read
   * (EO-478).
   */
  memoryScopes?: MemoryReadScope[];
  /** Re-stated for `attachFrom`'s reason: the `eo` server a resume starts writes through this (EO-543). */
  writeBridge?: AgentWriteBridgeAddress;
  /** Cancels this resumed turn without making the persisted session eligible for reuse. */
  signal?: AbortSignal;
  /**
   * This turn is not served EO's administrative server (`eo_admin`),
   * whoever the agent is, and no bearer for it is minted (EO-717). For
   * the learning review on a fork of the system agent's thread, which
   * may write memory and nothing else: the system agent's every other
   * turn is given that server (invariant 11), and a review of its run is
   * not one of its turns. Both adapters honour it, and
   * `providerParity.test.ts` holds them to it.
   */
  withoutAdminServer?: boolean;
}

/**
 * A stream that can be asked to end its turn rather than be abandoned
 * (KAN-24).
 *
 * There is a real difference between the two. Abandoning an iterator
 * stops the consumer; the agent's turn is killed wherever it happened to
 * be, and anything the backend only reports at the end of a turn — for
 * the Claude SDK, the token counts and the cost — is never said. That is
 * how an escalated run came to record a spend of nothing at all while
 * the design's daily budget summed `cost_cents` and called itself exact.
 *
 * `interrupt` asks the backend to wind the turn up now and finish
 * reporting. The events it emits on the way out arrive through the same
 * iterator, so a caller drains as usual and stops when the stream ends.
 *
 * Optional, and callers must treat its absence as "abandon immediately":
 * a provider with no way to cut a turn short would otherwise be drained
 * until the agent finished on its own, holding a subprocess open and
 * spending money — the exact thing invariant 9 forbids.
 */
export interface InterruptibleStream<T> extends AsyncIterable<T> {
  /** Resolves once the backend has been told. The stream still has to be drained. */
  interrupt?: () => Promise<void>;
  /**
   * Says something to the agent *inside* the turn that is running
   * (EO-176).
   *
   * The other half of the pair `interrupt` started. That one ends a
   * turn; this one changes one without ending it — a person who can see
   * an implementer heading down the wrong road at minute three has, in
   * every other tool, the option of simply saying so, and had none here.
   * Nothing about the run changes: same run id, same thread, no
   * transition, no `Cancellation`. The message is pushed into the turn
   * and the agent's next step reflects it.
   *
   * The boolean is the whole contract. `true` means the backend took the
   * message and the turn has it; `false` means it did not — most often
   * because the turn ended between a person pressing Send and the push
   * landing, which is not a failure but *is* something the person has to
   * be told, since a message that went nowhere and a message that landed
   * look identical from the outside. A caller that gets `false` still
   * holds a comment on the item, and that comment is what the next
   * turn reads.
   *
   * Optional in the same sense `interrupt` is, and for a sharper reason:
   * a backend can genuinely lack this. Codex did until EO-373: the SDK's
   * whole surface was `run(input)` / `runStreamed(input)` against a
   * one-shot `codex exec`, so there was nothing to push into (the
   * app-server's `turn/steer` is what it uses now). **A caller must treat its absence
   * as "this backend cannot be spoken to mid-turn"** — queue the message
   * for the next turn and say so — rather than as a failure, and must
   * not offer a person a control that would do nothing.
   *
   * `attachments` are the files posted with the message (EO-395). The
   * backend names each one to the agent exactly as a turn's own prompt
   * does — id, name, MIME type and the tool that reads it — and never
   * sends the bytes. `message` may be empty when there are some: a
   * screenshot with nothing typed under it is a message.
   */
  steer?: (message: string, attachments?: AgentInputAttachment[]) => Promise<boolean>;
}

/**
 * What a turn's session would be opened with, by name (EO-392).
 *
 * The part of a send only an adapter can state: which model it names to
 * its backend once the per-turn override and the agent's configuration
 * are resolved, which sandbox and approval settings it pins, and which
 * servers, tools and skills it delivers. Everything above the adapter
 * knows what it *asked* for; this is what the adapter does with it.
 *
 * **Names, never values.** A server appears as the key it is registered
 * under and nothing else — not its command, its environment, its
 * headers or a token. An adapter answers this without reading a secret
 * at all, which is what lets the answer be recorded and shown.
 */
export interface AgentSessionDescription {
  /**
   * The backend's own name for where a thread's instructions go —
   * Claude's `systemPrompt`, Codex's `baseInstructions`. Said by the
   * adapter because it is the adapter's word, and so nothing above it
   * has to know which backend it is talking about to print one.
   */
  instructionsSlot: string;
  /** The model named to the backend. Null when none is named and the backend's own default applies. */
  model: string | null;
  reasoningEffort: string | null;
  /** Sandbox and approval settings in the backend's own words, in the order it is given them. */
  policy: { name: string; value: string }[];
  /** Every MCP server this turn's backend is told about, by the name it is registered under. */
  mcpServers: string[];
  /** The tool allowlist handed to the backend, or null where it is handed none. */
  allowedTools: string[] | null;
  /** The skills EO delivers to this turn, by name. */
  skills: string[];
  /** Whether the agent also runs on the person's own setup, which EO does not enumerate. */
  inheritsAmbientConfig: boolean;
}

/** The per-turn facts a session description depends on: the same fields `start` and `resume` are handed. */
export type AgentSessionQuery = Pick<AgentProviderStartOptions, "model" | "reasoningEffort" | "toolDirectory" | "repositoryMcp" | "skillScope"> & { cwd?: string };

/**
 * A turn a provider may start its backend for before it is asked to run
 * it: the options `start` or `resume` will be handed, minus what only the
 * dispatch knows — the prompt, the files posted with it, and the run's
 * cancellation.
 */
/**
 * One side call, as the adapter is handed it (EO-477).
 *
 * Deliberately not `AgentProviderStartOptions`: a side call has no tools,
 * no MCP servers, no skills, no tool directory, no thread to resume and no
 * session kept. Leaving those fields out of the type is what keeps a
 * caller from handing one over by habit. The adapter adds its own
 * lockdown — the Claude setting sources, the Codex home — and nothing
 * else.
 */
export interface AgentSideCallOptions {
  /**
   * The model the call runs on: the backend's small model for selection
   * and extraction, the system agent's for consolidation (EO-578,
   * `SIDE_CALL_MODELS`). Null leaves the backend's own default.
   */
  model: string | null;
  /**
   * How hard the model reasons, in the backend's own word for it —
   * Claude's `effort`, Codex's reasoning effort (EO-578). Absent leaves
   * the backend's default, which is what selection and extraction are
   * always given.
   */
  reasoningEffort?: string;
  /** The system prompt: what the question is for and how to answer. */
  system: string;
  /** The question itself, the one user turn. */
  input: string;
  /** What the answer must look like; the backend's own structured-output mechanism carries it. */
  outputSchema: JsonSchema;
  /** An empty temporary directory, made for this call and removed after it. */
  cwd: string;
  signal: AbortSignal;
  /** What the call may spend, in cents, where a budget applies — held as a turn's is (`AgentTurnOverrides.budgetCents`). */
  budgetCents?: number;
  /**
   * Asks the turn to end now, but to end as a turn does (EO-577): the
   * backend is interrupted rather than killed, and what it goes on to
   * report — above all what the turn spent, which Claude says only in its
   * closing result — is passed on before the stream ends. What the caller
   * aborts when an answer runs past its output-token cap, so the tokens
   * and cost it used are recorded rather than lost with the process. The
   * caller bounds how long it waits for that, and aborts `signal` after.
   */
  windDown?: AbortSignal;
}

export type AgentPrewarmTurn =
  | ({ kind: "start"; instructions: string } & Omit<AgentProviderStartOptions, "instructions" | "context" | "signal" | "attachments" | "onSkillsSection">)
  | ({ kind: "resume"; threadId: string } & Omit<AgentProviderResumeOptions, "signal" | "attachments" | "onSkillsSection">);

export interface AgentProvider {
  start: (opts: AgentProviderStartOptions) => InterruptibleStream<AgentEvent>;
  /**
   * Starts the backend for a turn a person is about to ask for, so the
   * first word arrives sooner — Claude Desktop starts its CLI while you
   * type.
   *
   * At most one warm backend per provider. The next `start` or `resume`
   * whose options match the warm one exactly adopts it; anything else —
   * different options, a different thread, a different `warmKey` — shuts
   * it down and starts as it always did. Unused, it shuts itself down
   * after a minute (`PREWARM_IDLE_MS`), and calling this again for the
   * same turn keeps it warm rather than starting another.
   *
   * No run exists while a backend is warm and nothing waits on a person
   * on its behalf: it is a process with no turn in it yet, shut down when
   * nobody sends. Optional; both real adapters implement it, and
   * `providerParity.test.ts` holds them to the same behaviour.
   */
  prewarm?: (turn: AgentPrewarmTurn) => void;
  /**
   * Shuts down whatever `prewarm` started and no turn has taken — on a
   * pause, on quitting, and when the provider is replaced by one built
   * for the agent's new configuration. A no-op with nothing warm.
   */
  dropWarm?: () => void;
  /** Resume an existing thread. The optional signal cancels this turn just like start(). */
  resume: (threadId: string, message: string, opts?: AgentProviderResumeOptions) => InterruptibleStream<AgentEvent>;
  /**
   * Says what a turn opened with these options is opened with (EO-392).
   *
   * Asked by debug mode's capture, immediately before the turn it
   * describes, with the very options that turn is then handed. Pure and
   * synchronous: it spawns nothing, reads no secret, and must not throw.
   *
   * Optional because a backend can have nothing to describe — the demo
   * provider names no model and delivers no servers. Both real adapters
   * implement it, and `providerParity.test.ts` holds them to it
   * (invariant 12); a caller that finds it absent records that the
   * session was not described rather than guessing at one.
   */
  describeSession?: (turn: AgentSessionQuery) => AgentSessionDescription;
  /**
   * Asks the model one short question and streams the one turn that
   * answers it (EO-477): usage, quota readings, and a `result` carrying
   * the schema-shaped answer, or an `error` — and, before them, the
   * answer's words as `output_delta`s as they are written, which the
   * caller holds to the call's output-token cap (EO-577).
   *
   * Not a run. Nothing above the adapter keeps the thread, and the
   * adapter keeps none either: no tools, no servers, no skills, no
   * session written to disk. `sideCalls/sideCall.ts` is the one caller,
   * and it is what records the call, enforces budgets and timeouts, and
   * turns these events into a `SideCallResult`.
   *
   * Optional because a backend can have no such thing — the demo provider
   * has none. Both real adapters and the fake implement it, and
   * `providerParity.test.ts` holds the real two to the same answer.
   */
  sideCall?: (opts: AgentSideCallOptions) => AsyncIterable<AgentEvent>;
  /**
   * Copies a thread into a new one carrying the same history, and sends
   * `message` as a turn on the copy (EO-716) — Claude's `forkSession`
   * (`resume` with `forkSession: true`), Codex's `thread/fork`.
   *
   * The original thread is not written to: nothing said on the fork,
   * and nothing the fork's turn does to its own history, is seen by a
   * later `resume` of `threadId`. That is the whole point — a review of
   * a finished run reads everything the run saw without the item's own
   * thread carrying the review into its next dispatch.
   *
   * Resolves once the backend has opened the fork, with its id and the
   * turn's events (beginning with that `thread_started`, as `start`'s
   * do). A thread that cannot be forked — gone, or refused — resolves to
   * a failure naming it, and never rejects: the caller's fallback is a
   * branch, not a catch. What goes wrong once the fork's turn is under
   * way arrives in its stream, as any turn's does.
   *
   * `opts` are a resume's, for a resume's reasons: the fork's turn
   * spawns the backend again, in the same worktree, with the same tool
   * surface the thread was opened with.
   *
   * Optional because a backend can lack it — the demo provider has no
   * threads to copy. Both real adapters implement it, and
   * `providerParity.test.ts` holds them to it (invariant 12).
   */
  fork?: (threadId: string, message: string, opts?: AgentProviderResumeOptions) => Promise<AgentForkResult>;
}

/**
 * What `AgentProvider.fork` answers (EO-716).
 *
 * `thread_not_found` is the backend saying it has no such thread — the
 * same answer a resume of it would have thrown as `ThreadNotFoundError`.
 * `failed` is every other way the fork was not opened, with the
 * backend's words in `message`.
 */
export type AgentForkResult =
  | { ok: true; threadId: string; events: InterruptibleStream<AgentEvent> }
  | { ok: false; reason: "thread_not_found" | "failed"; threadId: string; message: string };

/**
 * The brand `isThreadNotFound` recognises.
 *
 * A property rather than `instanceof`, because the point of this error
 * is to survive the trip from a provider to the supervisor intact, and
 * `instanceof` is the check that quietly stops being true — a second
 * copy of this module in the bundle, a structured-clone across a
 * boundary, a subclass rebuilt from a serialised error. Namespaced so
 * that "some other error happens to carry a `kind`" cannot pass.
 */
const THREAD_NOT_FOUND = "eo:thread-not-found";

/**
 * The backend has no such session (EO-93).
 *
 * A stored thread id is a claim about a file on disk EO does not own:
 * Claude keeps sessions under `~/.claude` and Codex under
 * `~/.codex/sessions`. Either can be cleaned up, and the machine can
 * change. Both backends say so in their own English — "No conversation
 * found with session ID" from one, "no rollout found for thread id"
 * from the other — and both of them mean this.
 *
 * The translation belongs to the provider, which is the whole reason
 * this type exists. The alternative is a supervisor matching prose from
 * two SDKs it does not own, where a wording change upstream silently
 * turns a recovered item back into an opaque run failure — and where
 * every new backend adds another phrase to a regex nobody remembers to
 * update.
 *
 * Thrown rather than emitted as an `AgentEvent`: the turn never began,
 * so there is no stream to put it in. Everything above the provider
 * already treats a throw out of the stream as the run failing; this is
 * that same throw, wearing a name the supervisor can act on.
 */
export class ThreadNotFoundError extends Error {
  readonly kind = THREAD_NOT_FOUND;
  /** The session the backend could not find. Kept because the caller marks it, not just reports it. */
  readonly threadId: string;
  /** Which backend said so — the same value `runs.provider` holds. */
  readonly provider: string;

  constructor(args: { threadId: string; provider: string; cause?: unknown }) {
    super(`The "${args.provider}" backend has no conversation with session id "${args.threadId}".`, { cause: args.cause });
    this.name = "ThreadNotFoundError";
    this.threadId = args.threadId;
    this.provider = args.provider;
  }
}

/** Is this the one error every backend's "no such session" is translated into? */
export function isThreadNotFound(error: unknown): error is ThreadNotFoundError {
  return error instanceof Error && (error as { kind?: unknown }).kind === THREAD_NOT_FOUND;
}

/** The brand `isTurnNotEnded` recognises — a property, for `THREAD_NOT_FOUND`'s reasons. */
const TURN_NOT_ENDED = "eo:turn-not-ended";

/**
 * A turn EO stopped reading whose process could not be confirmed gone
 * (EO-493).
 *
 * Every adapter ends a turn's process when EO is done with it — SIGTERM,
 * then SIGKILL after a grace — and waits for it to exit, because the next
 * turn on the same thread must never be spawned beside it. When the
 * process is still there after all of that, the adapter does not pretend
 * otherwise: it throws this, from the turn's `return()` or from the turn
 * itself, and the supervisor fails the run closed — no correction, and
 * the thread is not resumed again.
 *
 * Thrown by the provider and recognised by brand, as `ThreadNotFoundError`
 * is. The supervisor raises the same error itself for a backend that did
 * not settle its ending at all.
 */
export class TurnNotEndedError extends Error {
  readonly kind = TURN_NOT_ENDED;
  /** Which backend's turn it was — the same value `runs.provider` holds, or null when the supervisor could not tell. */
  readonly provider: string | null;
  /** The process that would not go, when the backend knows it. */
  readonly pids: number[];

  constructor(args: { provider: string | null; pids?: number[]; detail?: string; cause?: unknown }) {
    const who = args.pids && args.pids.length > 0 ? ` (pid ${args.pids.join(", ")})` : "";
    super(args.detail ?? `The ${args.provider === null ? "" : `"${args.provider}" `}turn EO stopped reading did not exit${who}, even after SIGKILL.`, { cause: args.cause });
    this.name = "TurnNotEndedError";
    this.provider = args.provider;
    this.pids = args.pids ?? [];
  }
}

/** Is this a turn whose process could not be confirmed gone? */
export function isTurnNotEnded(error: unknown): error is TurnNotEndedError {
  return error instanceof Error && (error as { kind?: unknown }).kind === TURN_NOT_ENDED;
}
