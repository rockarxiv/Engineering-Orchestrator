// Types only — erased at compile time. The SDK's runtime entry points
// come from claudeSdk.ts, which imports it by path from EO's cache
// rather than from the app's own node_modules: it is Anthropic's code,
// fetched on request, and EO ships none of it (A-08).
import type { HookInput, HookJSONOutput, Options, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeSdk, type ClaudeSdkModule } from "./claudeSdk.js";
import { claudeProcesses, withStderr, type ClaudeProcesses } from "./claudeProcess.js";
import { claudeCompatibilityHolds, type ClaudeSettingSources, type ClaudeSettingsReader } from "./claudeCompatibility.js";
import {
  ThreadNotFoundError,
  type AgentInputAttachment,
  withAliasedToolNames,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type AgentPrewarmTurn,
  PREWARM_IDLE_MS,
  type AgentProviderStartOptions,
  type AgentSideCallOptions,
  type AgentSessionDescription,
  type AgentSessionQuery,
  type AttachmentSource,
  type InterruptibleStream,
  type JsonSchema,
  type MemoryReadScope,
  type AgentWriteBridgeAddress,
  type RepositoryMcpServer,
  type SearchInterceptionEvent,
  type UsageEvent,
  eoToolName,
  MEMORY_READ_TOOL_NAME,
  MICROCENTS_PER_CENT,
  withoutReservedEnvironmentVariables,
  uuidv7,
} from "@eo/core";
import { agentMcpStdioConfig, eoMcpStdioConfig, type EoMcpServiceConfig } from "../mcp/serviceConfig.js";
import { toolResultEvent, toolResultText } from "./toolResult.js";
import { withAttachmentNote } from "./attachmentNote.js";
import { withSkillsSection } from "../agentAttachments/skillsPrompt.js";
import { readToolDirectoryServers, TOOL_PLUGIN_NAME, toolDirectoryMcpConfigPath, toolDirectoryServerToolPrefixes, toolDirectorySkillNames, toolDirectorySkillsPromptSection } from "../agentAttachments/pluginDirectory.js";
import { claudeSkillLoaded, leadingWith, skillsOffered } from "./skillUsage.js";
import type { SearchNudge } from "./searchNudge.js";
import type { AdminMcpDispatch } from "../agentAttachments/adminDelivery.js";

// Declared beside neither adapter now that both carry one (EO-379), and
// re-exported so that what imported them from here still does.
export type { SearchNudge, SearchNudgeInterception, SearchNudgeRequest } from "./searchNudge.js";

/** The shared MCP server EO registers. Tool calls arrive as `mcp__eo__<tool>`. */
export const EO_SERVER_NAME = "eo";

/**
 * EO's own two servers are exempt from tool search (EO-161).
 *
 * **What tool search is, and whose decision it is.** The CLI can keep MCP
 * tool schemas out of the prompt and offer a `ToolSearch` tool instead:
 * the tools surface as names in a system-reminder and have to be loaded
 * before they can be called. EO's agents have been running that way, and
 * it is what EO-160 found the prompts were untrue about. Two separate
 * switches decide it, and only one of them is EO's:
 *
 *   - *Whether tool search runs at all* is the CLI's. Measured from the
 *     binary EO downloads (claude@0.3.312 / Claude Code 2.1.312, re-read
 *     at EO-599, and unchanged at claude@0.3.318 / 2.1.318: with the
 *     variable unset, a capture server's request still carried
 *     `ToolSearch`, EO-644): the
 *     mode is `ENABLE_TOOL_SEARCH` when that variable is set and `tst`
 *     — on — when it is not, and the tool is then registered. Up to
 *     2.1.302 it was not registered when the session was pointed at a
 *     non-first-party host; 2.1.304 dropped that exception, and EO gives
 *     the old answer in that one case itself (`toolSearchHeldOff` in
 *     `claudeCompatibility.ts`,
 *     EO-599). Beyond holding that, EO sets nothing here and should
 *     not: turning it off globally would drag every server a person
 *     attached into the prompt with it, which is the opposite of what
 *     this story was scoped to.
 *   - *Which servers are exempt from it* is EO's, per server, and this
 *     is that. `alwaysLoad` is declared on the server config by both the
 *     runtime EO downloads and the pinned types
 *     (`McpStdioServerConfig.alwaysLoad`, both 0.3.318): "all
 *     tools from this server are always included in the prompt and never
 *     deferred behind tool search". (0.3.293 added one exception, still
 *     there at 0.3.318: a tool the server itself lists with `_meta`
 *     `anthropic/alwaysLoad: false` stays deferred.) The CLI splits its
 *     servers on it —
 *     `alwaysLoad === true` connects under `--mcp-config alwaysLoad
 *     servers` and the rest under `--mcp-config servers` — and stamps
 *     the tools so the request carries no `defer_loading` for them.
 *
 * **Why a per-server option is the right lever rather than a
 * workaround.** It names servers, so the split falls exactly where this
 * story was scoped: EO's own `eo` and `repo` go through
 * `options.mcpServers` here, and a server a person attached from the
 * catalogue reaches the CLI through the generated directory's
 * `.mcp.json` and `--mcp-config`, which this function never touches.
 * Somebody with ten attached servers keeps all ten deferred.
 *
 * **Measured at the wire, not read off the type** — see
 * `toolLoading.live.test.ts`, which captures the request body the CLI
 * sends. Same options otherwise, one stdio server per role, tool search
 * forced on:
 *
 *     alwaysLoad absent   mcp__eo__*, mcp__repo__* ABSENT from tools[],
 *                         ToolSearch present, one DeferredToolPlaceholder
 *     alwaysLoad: true    mcp__eo__*, mcp__repo__* present with no
 *                         defer_loading; the attached server's tool still
 *                         absent, ToolSearch still present
 *
 * **What it costs.** The SDK is explicit that this "blocks startup until
 * the server is connected (capped at the standard 5s connect timeout)",
 * because the schemas have to exist when the turn-1 prompt is built.
 * Both servers are local stdio processes EO spawns itself, so that is
 * milliseconds; a server that fails to come up in time loses its tools
 * for the turn, which is what already happened when it failed to come up
 * at all. The other cost is the schemas themselves, in every turn-1
 * prompt rather than on demand. Measured by asking each server for its
 * own `tools/list`: `eo` is 1,881 bytes over 4 tools for a step-owning
 * agent and 4,913 over 11 at its widest, `repo` is 6,937 over 9 — call
 * it 2.2k to 3k tokens, against a median 130k input tokens per turn
 * across the Claude runs in `run_events`. It buys back a turn that was
 * costing the same context to re-send.
 *
 * **A constant rather than a literal** so the two call sites cannot
 * drift, and so the thing to change is one line if a future CLI takes
 * the option away.
 */
const ALWAYS_LOAD_EO_SERVERS = true;

/** What a Claude-backed agent's `agents.config` may carry. */
export interface ClaudeAgentConfig {
  model?: string;
  effort?: NonNullable<Options["effort"]>;
  /**
   * Not `permissionMode` (EO-178). It was here, and it is pinned at the
   * spawn site now — `buildOptions` writes `"bypassPermissions"` and
   * reads nothing from this bag to do it. Declaring it again would be
   * declaring an option nothing obeys.
   */
  allowedTools?: string[];
  /**
   * Not `maxTurns` (EO-375). Codex has no equivalent, so it was removed
   * from both backends rather than kept on one; runs are bounded by the
   * attempt, wall-clock and budget guards instead. A stored config that
   * still carries the key is ignored by `buildOptions`, not migrated.
   */
  /**
   * Let this agent inherit the person's own Claude configuration
   * (EO-107). **Off by default**, which is a change: EO used to set
   * neither `settingSources` nor anything about skills, so every agent
   * it dispatched silently picked up `~/.claude/settings.json`, the
   * target repository's `.claude/settings.json`, and whatever skills
   * were installed on the machine.
   *
   * That made "this agent has these tools" untrue, and any test
   * asserting it meaningless — the answer depended on the developer's
   * home directory. Strict is the default for that reason, and this flag
   * is here for the person who relies on their own setup and knows they
   * do.
   *
   * What it restores is described where it is read (`buildOptions`),
   * because that is the only place the difference exists.
   */
  inheritAmbientConfig?: boolean;
}

/**
 * What an agent's attached servers are given in the CLI's environment
 * for one turn (EO-107, EO-488): the value behind each declared name EO
 * could fill, and the names that must arrive unset.
 */
export interface AttachedServerEnvironment {
  env: Record<string, string>;
  withheld?: readonly string[];
}

export interface ClaudeProviderOptions {
  config?: ClaudeAgentConfig;
  /** Seam for tests: where the settings files EO-599's compatibility holds read come from. The disk by default. */
  settingsReader?: ClaudeSettingsReader;
  /** Seam for tests — the real SDK spawns the `claude` CLI and spends money. */
  runQuery?: ClaudeSdkModule["query"];
  /** The loaded module itself. Wins over `sdkEntryPath`; used by tests that need the real thing. */
  sdk?: ClaudeSdkModule;
  /**
   * Where the fetched SDK lives (A-08).
   *
   * Distinct from `executablePath`: that is the `claude` binary the SDK
   * spawns, this is the SDK itself. A machine can have one without the
   * other — someone with Claude Code already installed still needs the
   * JavaScript EO drives it through.
   */
  sdkEntryPath?: string | null;
  onUnmappedMessage?: (message: SDKMessage) => void;
  /**
   * Registers the A-03 comment tool. **Off by default** since KAN-29
   * slice 3 — every reason to have it is gone, and keeping it made
   * asking non-deterministic.
   *
   * Two live intake runs on the same feature settled it. One returned
   * three questions as its result: separate, each with its own `why`
   * and options, each posted as its own comment a human can answer
   * individually. The other reached for the tool and posted a single
   * prose escalation with the questions buried in it. Same prompt, same
   * model, different mechanism — because both were available and
   * nothing said which to prefer.
   *
   * Everything the tool used to carry now has a home in a result:
   * questions (KAN-29), the implementer's handoff (KAN-31), intake's
   * understanding and settled decisions (KAN-32). The refine proposal
   * and review feedback were always posted by the engine.
   *
   * Kept rather than deleted, and still switchable per agent: a
   * pipeline stage nobody has written yet may want it, and the argument
   * for removing it is about *these* roles rather than about the
   * mechanism.
   */
  enableCommentTool?: boolean;
  /**
   * The shared EO stdio service. Claude launches the same implementation
   * as Codex; this adapter only translates the provider's config syntax.
   */
  eoMcp?: EoMcpServiceConfig;
  /**
   * The `claude` executable to run (A-08).
   *
   * Without this the SDK falls back to a binary bundled inside its own
   * package — which is the thing EO must not redistribute. Passing it is
   * what keeps a proprietary executable out of the installer, so there
   * is a test asserting it arrives.
   */
  executablePath?: string | null;
  /**
   * The API key to run with, read at spawn (EO-84).
   *
   * A function rather than a value because the provider is *cached* per
   * agent and outlives any number of key changes: a key read once at
   * construction would go on being injected after somebody removed it
   * from the Runtimes card and was told the runtime was signed out.
   * Called at the start of each turn, so the answer is always the one
   * the keychain holds now.
   *
   * Claude is the only backend that needs this. Codex takes its key
   * through `codex login --with-api-key` and stores it itself, so there
   * is nothing for EO to hold or inject.
   */
  apiKey?: () => string | null;
  /**
   * The values behind the `${VAR}` references in the generated
   * directory's `.mcp.json` (EO-107).
   *
   * A function for exactly the reason `apiKey` is one, and it is the
   * same rule rather than a similar one: the provider is cached per
   * agent and outlives any number of keychain edits, so a map read at
   * construction would go on injecting a token somebody has since
   * cleared. Called at the start of each turn.
   *
   * This is also what keeps a secret out of the provider cache key —
   * `engine.ts` records why that matters — and out of the generated
   * files, which carry names only.
   *
   * Handed the turn's environment variables (EO-488), which fill a
   * declared name neither the organisation nor the server holds a value
   * for; they are the run's step's, and this provider is the agent's.
   * `withheld` is the names nothing may stand in for — an organisation
   * value that cannot be read — and is taken out of the variables and
   * the inherited environment alike, as Codex takes out a name its
   * reader answers `SECRET_WITHHELD` for.
   */
  attachmentEnv?: (variables: Readonly<Record<string, string>>) => AttachedServerEnvironment;
  /**
   * The bearer for EO's own administrative server, for the one agent
   * whose allowlist names it — minted for this turn and let go of when it
   * is over (EO-444).
   *
   * Asked at the start of each turn, as Codex asks it, and applied after
   * `attachmentEnv` so a catalogue entry declaring the same name cannot
   * displace it. The URL is not here: it went into the generated
   * `.mcp.json` when the agent's directory was written. `release` is
   * called when the turn's query ends, however it ended, because the CLI
   * leaves without closing its session and the host's cap would
   * otherwise fill with turns that are over.
   *
   * Handed the directory the turn runs in (EO-700), which is the only
   * place a comment the agent posts through the server may name files
   * from. Undefined for a turn that says none.
   */
  admin?: (directory?: string) => AdminMcpDispatch | null;
  /**
   * What to say about a broad search of the checkout, when there is
   * something to say (EO-165, KAN-126).
   *
   * The adapter owns the *delivery* — a `PreToolUse` hook, the tool
   * matcher, the spelling of a tool id, the record of each firing — and
   * the caller owns the *judgement*: which calls are broad searches and
   * what sentence answers them. That judgement lives with repository
   * intelligence, which is on its way into the developer pack, and an
   * adapter is core; so it arrives here as data, supplied by the
   * composition root (`engine.ts`), rather than as an import.
   *
   * Omitted means there is no judgement to apply and so no hook at all —
   * the same absence as a turn handed no index, and for the same reason:
   * a hook that could only ever stay quiet is an option declaring hooks
   * where there were none.
   */
  searchNudge?: SearchNudge;
  /**
   * How long a turn's CLI is given after SIGTERM before SIGKILL, once EO
   * has stopped reading the turn (EO-493). Seam for tests; five seconds
   * otherwise, the SDK's own figure.
   */
  processGraceMs?: number;
  /** Seam for tests: what each turn spawns its CLI through (`claudeProcess.ts`). */
  turnProcesses?: () => ClaudeProcesses;
}

/** `mcp__eo__comment` -> `comment`: EO's own tools are recorded under their bare names on both backends. What a write tool did reaches EO over the agent write bridge, never from this (EO-543). */
/** The skills a turn pointed at this directory is given, as the `skills_delivered` event says them (EO-715). */
function offeredSkills(toolDirectory: string | undefined): AgentEvent[] {
  return skillsOffered(toolDirectory ? toolDirectorySkillNames(toolDirectory).map((name) => name.slice(TOOL_PLUGIN_NAME.length + 1)) : []);
}

export function normaliseToolName(name: string): string {
  const prefix = `mcp__${EO_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * What a result message says the query has cost so far.
 *
 * Read from `modelUsage` rather than `usage`, on the SDK's own
 * instruction: `usage` is documented "MAIN AGENT LOOP ONLY — excludes
 * Task subagent, sidechain, and auxiliary model calls ... Prefer
 * modelUsage for token/cost accounting". EO read `usage.input_tokens`,
 * which is *also* net of both cache figures, so an implement run that
 * spent an hour reading this repository recorded a couple of hundred
 * input tokens. Nothing downstream could have noticed: the number was
 * small, not absent.
 *
 * Summed across models because one query can use several — a subagent
 * on Haiku under an Opus main loop — and they are all this run's doing.
 *
 * Session-scoped: `total_cost_usd` and `modelUsage` are running totals
 * for the whole query, re-reported on every result, and the SDK says to
 * read the latest rather than add them up. On a resumed session they are
 * running totals for the whole *conversation* — the CLI restores the
 * session's cost state, so the first result already holds every earlier
 * run's spend — and `num_turns` alone counts the query. Taking the
 * earlier runs off is the tally's job, not this one's (EO-490,
 * `createUsageTally`): this reports what the CLI said.
 */
export function usageOf(message: SDKMessage & { type: "result" }): UsageEvent {
  const models = Object.values(message.modelUsage ?? {});
  // Zeroed counts as absent, not as "this query cost nothing". The SDK
  // documents that a crash or startup-error result may carry zeroed
  // values, and it is `modelUsage` that carries them — gating the
  // fallback on the *key* being missing would take the primary branch
  // for exactly the case the fallback exists for, and report zero.
  const reported = models.some((model) => model.inputTokens + model.outputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens > 0);

  // The fallback is the old, narrow reading, and it is here for a real
  // case rather than for tidiness: the zeroed result above, and an older
  // CLI that sends no `modelUsage` at all. An undercount beats a run
  // that reports nothing.
  const totals = !reported
    ? {
        tokensIn: (message.usage.input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
        tokensOut: message.usage.output_tokens ?? 0,
        // Only where the message actually carries them. Defaulting these
        // to zero would report a cold cache on a message that said
        // nothing about caching at all, and "0% cached" is a claim.
        //
        // `== null` rather than `=== undefined`: the underlying usage
        // shape declares both counters `number | null`, so null is its
        // own way of saying absent — as the `?? 0` on the line above
        // already assumes.
        ...(message.usage.cache_read_input_tokens == null ? {} : { cacheReadTokens: message.usage.cache_read_input_tokens }),
        ...(message.usage.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: message.usage.cache_creation_input_tokens }),
      }
    : {
        // Cache reads and writes are *added* here rather than assumed to
        // be inside `inputTokens`: the Anthropic API reports them as
        // three separate counters, and `inputTokens` is only the part
        // that was neither cached nor cacheable.
        tokensIn: models.reduce((total, model) => total + model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens, 0),
        tokensOut: models.reduce((total, model) => total + model.outputTokens, 0),
        cacheReadTokens: models.reduce((total, model) => total + model.cacheReadInputTokens, 0),
        cacheWriteTokens: models.reduce((total, model) => total + model.cacheCreationInputTokens, 0),
      };

  return {
    type: "usage",
    scope: "session",
    ...totals,
    // The multiplier: what EO puts in a dispatch prompt is re-sent on
    // every one of these.
    turns: message.num_turns,
    // Still recorded, and deliberately not built on. EO's agents run on
    // subscriptions, so money is not the budget anyone is spending — the
    // readings that matter are the tokens above and the plan window in
    // `quota`, counted per backend and never converted between them.
    // But E-05's daily and per-item guards are denominated in cents
    // and this is the only backend that reports any, so leaving it out
    // would quietly switch those guards off.
    costCents: Math.round(message.total_cost_usd * 100),
    // And unrounded, to the micro-cent (EO-510): a side call on the small
    // model costs a fraction of a cent, which the whole cents above
    // record as nothing.
    costMicrocents: Math.round(message.total_cost_usd * 100 * MICROCENTS_PER_CENT),
  };
}

/**
 * Whether a `result` the CLI wrote is the answer to the turn EO opened,
 * or the close of something else it ran first (EO-495).
 *
 * **Why a turn can see a result that is not its own.** A resumed CLI
 * winds up what the session left behind before it reads EO's message. On
 * EO-487's restart recovery the session had been killed mid-tool-call
 * with background shells running: the resumed CLI reported them as
 * orphaned, answered the dangling call itself, and wrote a `result` —
 * `success`, empty text, 0 turns, no model call — and only then opened
 * the turn carrying EO's recovery prompt. Taken as the turn's answer,
 * that result failed the schema, opened a correction, and killed the
 * process that was about to do the recovery. Measured against the pinned
 * CLI (0.3.302) with a capture server, and again at 0.3.312 (EO-599) and
 * 0.3.318 (EO-644, `recoveryResult.live.test.ts`): the stale result echoes no user
 * message, and the next one echoes EO's.
 *
 * **So identity decides, as it does on Codex.** Every message a turn
 * sends carries a uuid (`said`), and the CLI echoes the ones a result
 * answers in `user_message_uuid(s)` — the same thing Codex's `turnId`
 * filter does (`isOurTurn`, codexClient.ts). A result naming messages,
 * none of them this turn's, is someone else's.
 *
 * **And the turn count where nothing is echoed.** The SDK documents the
 * echo as absent on zeroed and delivery-failure results and from older
 * CLIs, so a result naming nobody is still this turn's — a failure must
 * not be skipped as if it were a stranger's — unless it is a success that
 * never asked the model anything (`num_turns: 0`). EO's own messages
 * always ask, so a turn that answered one has at least one round-trip.
 * Never the result's text: "No response requested." is the CLI's
 * wording, and wording changes.
 */
export function answersTurn(message: SDKMessage & { type: "result" }, said: ReadonlySet<string>): boolean {
  const echoed = [...(message.user_message_uuids ?? []), ...(message.user_message_uuid === undefined ? [] : [message.user_message_uuid])];
  if (echoed.length > 0) return echoed.some((uuid) => said.has(uuid));
  return !(message.subtype === "success" && !message.is_error && message.num_turns === 0);
}

/**
 * Which of EO's two delta streams a content block feeds, or null for one
 * whose words are not for a person — any tool's input but the answer's.
 */
export type DeltaStream = "text" | "reasoning";

/**
 * One streaming event of the Messages API, as the delta a person sees.
 *
 * `blocks` remembers what each open content block is, by its index, from
 * the `content_block_start` that opened it — a `content_block_delta`
 * says only its index and what kind of delta it carries, and an
 * `input_json_delta` is the answer when it belongs to the structured-
 * output tool and a tool's arguments otherwise. Per query, so an index
 * is never read against another message's blocks.
 */
export function deltaOf(event: unknown, blocks: Map<number, DeltaStream | null>): AgentEvent[] {
  if (event === null || typeof event !== "object") return [];
  const { type, index } = event as { type?: unknown; index?: unknown };
  if (typeof index !== "number") {
    // A new message starts its indexes again from nothing.
    if (type === "message_start") blocks.clear();
    return [];
  }
  if (type === "content_block_start") {
    const block = (event as { content_block?: { type?: unknown; name?: unknown } }).content_block;
    const stream: DeltaStream | null =
      block?.type === "text" ? "text" : block?.type === "thinking" ? "reasoning" : block?.type === "tool_use" && block.name === "StructuredOutput" ? "text" : null;
    blocks.set(index, stream);
    return [];
  }
  if (type === "content_block_stop") {
    blocks.delete(index);
    return [];
  }
  if (type !== "content_block_delta") return [];
  const stream = blocks.get(index);
  if (stream === null || stream === undefined) return [];
  const delta = (event as { delta?: { type?: unknown; text?: unknown; thinking?: unknown; partial_json?: unknown } }).delta;
  const text =
    delta?.type === "text_delta" ? delta.text : delta?.type === "thinking_delta" ? delta.thinking : delta?.type === "input_json_delta" ? delta.partial_json : undefined;
  return typeof text === "string" && text !== "" ? [{ type: "output_delta", stream, text }] : [];
}

/** The fewest milliseconds between two heartbeats from one turn. */
const HEARTBEAT_EVERY_MS = 5_000;

/** The fields of the SDK's `system/api_retry` message EO reads. */
interface ApiRetry {
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
  no_response?: unknown;
}

/** What the CLI's retry says, in words a person can read. */
const RETRY_REASONS: Record<string, string> = {
  rate_limit: "rate limited",
  overloaded: "the API is overloaded",
  server_error: "the API returned a server error",
};

function retryingOf(retry: ApiRetry): AgentEvent {
  const reason =
    retry.no_response !== undefined
      ? "the API sent no response in time"
      : (retry.error && RETRY_REASONS[retry.error]) ??
        (retry.error_status === null ? "the connection failed" : retry.error_status ? `the API answered ${retry.error_status}` : (retry.error ?? "the request failed"));
  return {
    type: "retrying",
    reason,
    ...(typeof retry.attempt === "number" ? { attempt: retry.attempt } : {}),
    ...(typeof retry.max_retries === "number" ? { maxAttempts: retry.max_retries } : {}),
    ...(typeof retry.retry_delay_ms === "number" ? { delayMs: retry.retry_delay_ms } : {}),
  };
}

/**
 * Maps one `SDKMessage` onto our `AgentEvent` union.
 *
 * Returns an array because one message can carry several of ours — an
 * assistant turn holds a list of content blocks — or none. `recognised`
 * is false only for a genuinely unknown message type, so a future SDK
 * version shows up in the logs instead of vanishing.
 *
 * `pendingCalls` is the one fact this mapper cannot get from the message
 * in front of it (EO-169). A call arrives on an assistant message
 * carrying its name and its id; its result arrives on the user message
 * after it carrying the id alone. So the caller owns a map for the life
 * of a query and lends it here, and a result can say which tool it came
 * from. Entries are removed as they are answered, so this holds only the
 * calls still in flight — a handful, even for an agent batching greps.
 *
 * Defaulted so every existing caller and test still passes one message
 * and gets an answer; the cost of not passing one is a result event with
 * no tool name on it, which is what the field being optional is for.
 */
export function mapSdkMessage(
  message: SDKMessage,
  pendingCalls: Map<string, string> = new Map(),
  blocks: Map<number, DeltaStream | null> = new Map(),
): { mapped: AgentEvent[]; recognised: boolean } {
  switch (message.type) {
    case "system": {
      // A request to the model failed and the CLI is trying again: shown,
      // because a turn waiting out a rate limit looks from outside just
      // like one that has hung (`RetryingEvent`).
      if (message.subtype === "api_retry") return { mapped: [retryingOf(message as unknown as ApiRetry)], recognised: true };
      // The conversation was compacted (`CompactedEvent`).
      if (message.subtype === "compact_boundary") {
        const metadata = (message as { compact_metadata?: { trigger?: unknown; pre_tokens?: unknown } }).compact_metadata;
        return {
          mapped: [
            {
              type: "compacted",
              ...(metadata?.trigger === "auto" || metadata?.trigger === "manual" ? { trigger: metadata.trigger } : {}),
              ...(typeof metadata?.pre_tokens === "number" ? { tokensBefore: metadata.pre_tokens } : {}),
            },
          ],
          recognised: true,
        };
      }
      // `init` carries the session id, which is what E-04 resumes from.
      if (message.subtype !== "init") return { mapped: [], recognised: true };
      // With the model the CLI says it is running (EO-392): `init` names
      // it whether or not EO did, which is the only place an agent with
      // no model configured has its actual one stated.
      const running = (message as { model?: unknown }).model;
      const mapped: AgentEvent[] = [
        { type: "thread_started", threadId: message.session_id, ...(typeof running === "string" && running !== "" ? { model: running } : {}) },
      ];
      // And which MCP servers actually came up (EO-107). Reported as the
      // backend gave it — names and statuses both — because the name a
      // plugin-delivered server is registered under is not the name EO
      // wrote, and deciding that a missing one matters needs to know what
      // was attached, which is the supervisor's knowledge and not this
      // file's.
      //
      // Emitted whenever the field is an array, empty included: "nothing
      // came up" is the answer that matters most, and a run whose only
      // attached server never appeared would otherwise look exactly like
      // a run on a CLI too old to say.
      if (Array.isArray(message.mcp_servers)) {
        mapped.push({
          type: "server_status",
          servers: message.mcp_servers.map((server) => ({ name: server.name, status: server.status })),
        });
      }
      return { mapped, recognised: true };
    }

    case "assistant": {
      const mapped: AgentEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim() !== "") {
          mapped.push({ type: "output", text: block.text });
        } else if (block.type === "thinking" && block.thinking.trim() !== "") {
          // Only ever non-empty when the turn asked for summaries
          // (`showReasoning`); otherwise the CLI sends the block with its
          // text omitted, and there is nothing to record.
          mapped.push({ type: "reasoning", text: block.thinking });
        } else if (block.type === "tool_use") {
          const name = normaliseToolName(block.name);
          pendingCalls.set(block.id, name);
          // `callId` is EO-169's, put here to pair a call with its
          // result. An interception joins on the same field rather than
          // on a second one of its own (EO-168): one name for the
          // backend's identifier for a call, and one thing to keep
          // right when a backend changes how it spells them.
          mapped.push({ type: "tool_call", name, args: block.input, callId: block.id });
          // A `Skill` call naming one of EO's skills is that skill loaded
          // (EO-715) — said here, from the call itself, so the count is
          // what the backend did and not what the agent reports.
          mapped.push(...claudeSkillLoaded(name, block.input));
          // A file-touching tool is also a file edit, which is what the
          // transcript and G-02 care about.
          const path = (block.input as { file_path?: unknown } | null)?.file_path;
          if (typeof path === "string" && (name === "Write" || name === "Edit" || name === "NotebookEdit")) {
            mapped.push({ type: "file_edit", path });
          }
        }
      }
      return { mapped, recognised: true };
    }

    case "result": {
      const mapped: AgentEvent[] = [];
      mapped.push(usageOf(message));

      if (message.subtype === "success") {
        mapped.push({ type: "result", data: message.structured_output ?? message.result });
      } else if (message.subtype === "error_max_budget_usd") {
        // The cap EO gave it (`budgetCents`): a budget stop, not a failure.
        mapped.push({ type: "error", message: "Claude run stopped at the budget it was given.", retryable: false, budget: true });
      } else {
        mapped.push({ type: "error", message: `Claude run ended: ${message.subtype}`, retryable: true });
      }
      return { mapped, recognised: true };
    }

    // Status chatter: real messages we deliberately don't persist. The
    // streaming partials used to be on this list and are now passed on as
    // transient deltas (`deltaOf`) — still never stored, since the final
    // assistant message carries the same text. A `user` message used to
    // be on it too and no longer is: it carries what the tools returned
    // (EO-169).
    //
    // Listed one by one rather than collapsed into the default branch so
    // that a message type this SDK version doesn't declare still comes
    // out as unrecognised. `SDKMessage` is a union of 38 interfaces but
    // only these top-level `type` values; the rest are `system` subtypes.
    // What the subscription has left, which is the only budget that
    // actually stops work here: EO runs on a claude.ai plan, so a run is
    // paid for in someone's five-hour and seven-day windows rather than
    // in money. The SDK volunteers this and it used to be dropped on the
    // floor with the streaming chatter.
    case "rate_limit_event": {
      // Both fields are optional in the type — as, in practice, is the
      // reading itself: a CLI version that sends the event bare is still
      // sending a message this mapper recognises, and must not take the
      // stream down over a field it did not fill in.
      //
      // **The status is what is worth recording, not the share.** That
      // took two goes to get right. A share was once the whole point, so
      // a reading without one was dropped; EO-172 then kept the refusals
      // and went on dropping share-less `allowed` readings, on the
      // reasoning that they said nothing. They say the one thing that
      // matters: a refusal is remembered for the length of a run, and an
      // `allowed` reading for the same provider and window is the only
      // thing that can take it back. Drop the share-less recovery and a
      // window that came back is never recorded — so a stale refusal
      // goes on suppressing the correction attempts a genuinely
      // malformed result should still get, and parks the item as
      // rate-limited when nothing is limiting it any more.
      //
      // So: anything carrying a status is recorded, share or no share. A
      // reading with no status says nothing about whether the backend is
      // answering, and is the only one dropped.
      const info = message.rate_limit_info as SDKRateLimitInfo | undefined;
      if (info?.status === undefined) return { mapped: [], recognised: true };
      return {
        mapped: [{
          type: "quota",
          provider: PROVIDER,
          // A plan has several windows running at once (five-hour,
          // seven-day, seven-day-opus) and they exhaust independently, so
          // the window is part of the reading rather than a detail of it.
          window: info.rateLimitType ?? "unknown",
          // Passed through on the SDK's own scale, 0–100. See `QuotaEvent`.
          ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
          status: info.status,
          // Passed through exactly as given. The SDK types it as a bare
          // number and documents no unit, and a window that resets at
          // the wrong hour is worse than one that does not claim to know
          // — so nothing here converts it, and `quotaResetsAt` is
          // recorded raw for whoever establishes what it means.
          ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }),
        }],
        recognised: true,
      };
    }

    // What the tools gave back (EO-169). The SDK delivers a result as a
    // `tool_result` block on a user message — the same envelope the API
    // uses to hand results to the model — and this branch used to drop
    // the whole message, so a Claude transcript said what was asked and
    // never what was answered.
    //
    // Only `tool_result` blocks are read. A user message also carries
    // the prompt itself and the CLI's synthetic notices, and neither is
    // something the agent produced: mapping those to `output` would put
    // EO's own dispatch text in the transcript as though the agent had
    // said it.
    //
    // Nothing here dedupes. If a future CLI replays a session's history
    // on resume, these results replay with it — but so would the
    // assistant messages that carry the calls, which this file has
    // always mapped unconditionally, so a duplicated result would be the
    // visible half of a problem that already exists rather than one this
    // introduced.
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return { mapped: [], recognised: true };

      const mapped: AgentEvent[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const name = pendingCalls.get(block.tool_use_id);
        // Answered, so no longer in flight. Leaving it would make this
        // map grow for the length of a session that can run for hours.
        pendingCalls.delete(block.tool_use_id);
        mapped.push(
          toolResultEvent({
            ...(name === undefined ? {} : { name }),
            callId: block.tool_use_id,
            // The backend's own word and the only one it says: a tool
            // that threw and a tool that returned an error both come
            // back with this set.
            ok: block.is_error !== true,
            output: toolResultText(block.content),
          }),
        );
      }
      return { mapped, recognised: true };
    }

    // The words of a block as they are generated (`includePartialMessages`).
    // Passed on as transient deltas and never stored: the finished block
    // arrives as an `assistant` message a moment later, and that is the
    // record (`OutputDeltaEvent`). A subagent's stream is its own
    // conversation and is not the agent writing to the person, so only
    // the top level's is passed.
    case "stream_event":
      return { mapped: message.parent_tool_use_id === null ? deltaOf(message.event, blocks) : [], recognised: true };
    // A tool still running: nothing to show, but the backend is at work,
    // which is what the inactivity guard needs to know (`HeartbeatEvent`).
    case "tool_progress":
      return { mapped: [{ type: "heartbeat" }], recognised: true };
    case "tool_use_summary":
    case "auth_status":
    case "prompt_suggestion":
    case "conversation_reset":
      return { mapped: [], recognised: true };

    default:
      return { mapped: [], recognised: false };
  }
}

/**
 * The schema as the Claude CLI will accept it.
 *
 * `z.toJSONSchema()` stamps `$schema: "https://json-schema.org/draft/2020-12/schema"`
 * on everything A-02 generates, and the CLI's validator rejects the whole
 * document with `no schema with key or ref "..."` — it resolves refs
 * against its own registry and that URL isn't in it. The dialect
 * declaration carries no constraints, so dropping it changes nothing
 * about what the schema *means*.
 *
 * Only the top level: a nested `$schema` would be part of a subschema
 * that we have no business rewriting.
 */
export function stripSchemaDialect(schema: JsonSchema): JsonSchema {
  if (!("$schema" in schema)) return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema"));
}

/**
 * The lockdown, and how a server reaches an agent underneath it.
 *
 * Three flags and a path, and the path is forced by the first flag
 * rather than chosen.
 *
 * **`strictMcpConfig`.** The ambient-configuration decision requires it:
 * without it an agent inherits the person's own MCP servers and the
 * target repository's, and "this agent has these tools" is not true of
 * anything. What it also does — measured against the binary EO
 * downloads, not read off a type — is ignore a plugin directory's
 * `.mcp.json` outright:
 *
 *     --plugin-dir X --strict-mcp-config   ->  "mcp_servers": []
 *     --plugin-dir X                       ->  "mcp_servers": [{"name":"plugin:eo-attachments:probe","status":"connected"}]
 *
 * So the plugin loader cannot be what finds the servers.
 *
 * **The path.** `--mcp-config` is documented by the CLI's own help as
 * "Load MCP servers from JSON **files** or strings", and EO gives it the
 * generated directory's `.mcp.json` by path. The plugin is still loaded
 * for its skills and manifest, with `skipMcpDiscovery` so exactly one
 * party owns each connection. Nothing about a server is serialised onto
 * the command line: argv carries `--plugin-dir <dir>` and
 * `--mcp-config <dir>/.mcp.json`, and the engine reads the rest off
 * disk — which is the arrangement this story asked for, reached the only
 * way the strict flag leaves open.
 *
 * Verified whole rather than argued: strict on, EO's own server and the
 * attached one both `connected`, the attached one under the plain name a
 * person typed with `mcp__probe__probe_ping` advertised, the plugin's
 * skill offered as `eo-attachments:probe-skill`, and `${VAR}` in the
 * file still expanded from the environment below — a server started this
 * way received a value that appears in no argument and in no file.
 *
 * **`settingSources: ["project"]`** stops the rest — the person's own
 * `~/.claude/settings.json` and their per-project
 * `settings.local.json` — and deliberately stops short of `[]`.
 *
 * `[]` was what this set first, and it silently took the repository's
 * `CLAUDE.md` with it: the SDK documents that a source list "must
 * include `'project'` to load CLAUDE.md files", and that file is how a
 * repository states the rules its agents work under. EO supplies no
 * substitute — `buildDispatchContext` does not read it — so an agent
 * would have gone on working in a repository whose own invariants it
 * could no longer see. Measured against `claude@0.3.227` with a marker
 * in `CLAUDE.md` and the outgoing request body captured, EO's own option
 * shape (a `systemPrompt` string, which replaces the preset) and nothing
 * else varied:
 *
 *     no settingSources    99,163 B   marker present
 *     settingSources: []   94,702 B   marker ABSENT
 *     ["project"]          95,097 B   marker present
 *
 * What `"project"` readmits besides `CLAUDE.md` is the repository's own
 * `.claude/settings.json`, and the lockdown this file exists for goes on
 * holding — measured in the same way rather than reasoned from the
 * documentation. With a project `.mcp.json`, a project
 * `settings.json` declaring `mcpServers` *and*
 * `enableAllProjectMcpServers: true`, and a project skill, the session
 * reported `mcp_servers: []` and neither the server nor the skill's
 * description appeared anywhere in the body that went to the model. The
 * ambient skill is *discovered* — it is in the init message's list — and
 * the `skills` allowlist keeps it out of what the model is offered,
 * which is the SDK's own description of that option: "a context filter,
 * not a sandbox".
 *
 * The rest of a project `settings.json` — its hooks, its permission
 * rules — is readmitted, and that is a restoration rather than a
 * widening: it is what EO did before this story, and it is narrower than
 * before by the two scopes above. It grants a repository nothing it did
 * not already have either, since EO already runs that repository's own
 * `test`, `lint` and `build` commands to verify a run.
 *
 * The line `"project"` draws is the decision's own, and that is worth
 * being explicit about because a person's `CLAUDE.md` is on the far side
 * of it. Measured with a throwaway `CLAUDE_CONFIG_DIR` holding a global
 * `CLAUDE.md` and a marker in the repository's:
 *
 *     no settingSources    global present, repository present
 *     ["project"]          global ABSENT,  repository present
 *
 * So somebody who keeps standing instructions in `~/.claude/CLAUDE.md`
 * stops having them apply to EO's agents, and the repository they are
 * working in goes on stating its own rules. That is what the
 * ambient-configuration decision asks for — the person's own setup off,
 * the work's own context on — rather than a compromise between them, and
 * `inheritAmbientConfig` is how somebody who wants the first back gets
 * it.
 *
 * **`skills`** has to be stated even when it is empty — the SDK is
 * explicit that omitting it "is **not** 'skills off'", because the CLI's
 * own defaults still apply.
 *
 * `options.mcpServers` carries EO's own servers and nothing else — the
 * `eo` service, and the `repo` query server on a dispatch whose item
 * has an index (EO-151). Those are inline because they always were, they
 * hold no secret, and they are EO's rather than a person's — an attached
 * server never goes there.
 */
function applyAttachments(
  options: Options,
  toolDirectory: string | undefined,
  config: ClaudeAgentConfig | undefined,
  repositoryMcp: RepositoryMcpServer | undefined,
  /** Whether this turn's `eo` server lists `memory_read` (EO-478). */
  servesMemoryRead = false,
): void {
  if (toolDirectory) {
    // Skills, commands and the manifest from the directory; the servers
    // are named separately, and saying so is what stops the loader
    // finding them a second time when the strict flag is off (the
    // opt-out below).
    options.plugins = [{ type: "local", path: toolDirectory, skipMcpDiscovery: true }];

    const mcpConfig = toolDirectoryMcpConfigPath(toolDirectory);
    if (mcpConfig) {
      // `extraArgs` because the SDK has no typed way to name a config
      // *file* — `mcpServers` is the inline route and serialises the
      // whole configuration into argv. Merged rather than assigned, so
      // this cannot quietly drop an argument somebody else set.
      options.extraArgs = { ...options.extraArgs, "mcp-config": mcpConfig };
    }
  }

  // An agent with an allowlist is told about every server EO gave it, in
  // either mode.
  //
  // **Before the opt-out returns, and that ordering is the whole of it.**
  // The two switches answer different questions: `inheritAmbientConfig`
  // is about what EO *suppresses*, and this is about what EO *delivers*.
  // Ticking the first used to skip the second, so an agent that both
  // opted out and carried an allowlist was handed a directory and an
  // `--mcp-config` naming servers it was then not permitted to call —
  // the loudest possible way to give somebody nothing.
  //
  // Not load-bearing under EO's pinned `bypassPermissions`, and that is
  // measured rather than assumed: an agent allowlisted to `["Read"]`
  // called an attached server's tool anyway. Kept regardless: the
  // allowlist is what the *CLI* is told this agent may call, and an
  // agent handed a server its list does not name would be a silent
  // failure if the CLI ever started enforcing it — the catalogue screen
  // would still say the server was attached. EO-178 pinned the mode, so
  // nobody can tighten it per agent any more; that removed the way this
  // could bite today, not the reason to keep it right.
  //
  // Only ever adds. An agent with no allowlist keeps having none, which
  // is the CLI permitting everything advertised; writing one would be a
  // restriction nobody asked for — which is also why this is guarded on
  // the allowlist rather than on what EO is delivering.
  // Widened so that a grant of either spelling of an aliased EO tool is
  // a grant of both (KAN-162). The prompts name `mcp__eo__item_detail`
  // and five migrations wrote `mcp__eo__ticket_detail` into the roles EO
  // ships — without this, EO would point an agent at a tool its own
  // allowlist does not permit.
  const allowed = config?.allowedTools ? withAliasedToolNames(config.allowedTools) : undefined;
  if (allowed) {
    // Everything EO put in front of this agent that its allowlist does
    // not already name: the servers out of the generated directory, and
    // the repository query server EO registered inline (EO-151).
    //
    // The query server belongs here for the same reason an attached one
    // does, and leaving it out was the sharper version of the same bug:
    // an allowlisted agent would be *configured* with a working index
    // and then not permitted to ask it anything — the server connects,
    // the tools are advertised, and every call is refused. A grant
    // covers the whole server (`mcp__repo`), which is the spelling Claude
    // Code takes and the one `toolDirectoryServerToolPrefixes` already
    // produces for a catalogue name.
    const offered = [
      ...(toolDirectory ? toolDirectoryServerToolPrefixes(toolDirectory) : []),
      ...(repositoryMcp ? [`mcp__${repositoryMcp.name}`] : []),
      // And `memory_read`, which EO serves on a turn it delivered memory
      // to (EO-478): a tool EO put in front of the agent, not one the
      // agent's allowlist chose, so it is granted with what it serves.
      ...(servesMemoryRead ? [eoToolName(MEMORY_READ_TOOL_NAME)] : []),
    ];
    const grants = offered.filter((grant) => !allowed.includes(grant));
    if (grants.length > 0) options.allowedTools = [...allowed, ...grants];
  }

  // The opt-out, whole: nothing suppressed, every skill the machine
  // offers enabled, and the person's own MCP servers back. Somebody who
  // ticks this is asking for their own setup, and half of it would be
  // worse than none. What EO was asked to *give* is above and is not
  // conditional on this — this restores what EO takes away.
  if (config?.inheritAmbientConfig === true) {
    options.skills = "all";
    return;
  }

  // "project" rather than `[]`: CLAUDE.md rides on that source, and a
  // repository's own rules are not ambient configuration EO was asked to
  // suppress. The measurements are in the block above.
  options.settingSources = ["project"];
  options.strictMcpConfig = true;
  options.skills = toolDirectory ? toolDirectorySkillNames(toolDirectory) : [];
}

/**
 * Which tool calls the interception looks at (EO-165).
 *
 * `Bash` is the one that matters and is the reason this exists at all:
 * EO's agents explore through the shell, and EO-162 was 176 Bash calls
 * with `grep -rn` inside them against a single index query. A hook keyed
 * on `Grep` and `Glob` — which is how the tool that solved this problem
 * elsewhere does it — would never have fired once on that run.
 *
 * `Grep` and `Glob` are here anyway because they are the same question
 * asked through a tidier door, and because their arguments make the
 * scope test exact rather than parsed.
 *
 * The matcher is a filter and never the decision. The callback
 * classifies whatever arrives and answers null for anything it does not
 * recognise, so a CLI that reads this pattern differently — or ignores
 * it — changes what the hook is *offered*, not what it says.
 */
const SEARCH_TOOL_MATCHER = "Bash|Grep|Glob";

/**
 * EO's own `PreToolUse` hook: the interception that answers a broad
 * search with the call that would answer it better (EO-165).
 *
 * **Why a hook rather than a sentence in the prompt.** Because the
 * prompt was measured. EO-164 tried the wording route on a real
 * navigation task, three runs against three, and moved the opening
 * exploration from 3.7 repo-searches to 4.0 — inside the noise, and in
 * the wrong direction. A bullet asking an agent to prefer the index
 * competes with an ingrained habit once, at the top of a run, and loses.
 * A hook fires on the call.
 *
 * **In EO's own process, and nothing is written anywhere.** The SDK
 * takes hook callbacks directly (`Options.hooks`), so this lives where
 * the rest of EO lives. The alternative — writing
 * `.claude/settings.json` into the worktree — also works and is
 * deliberately not taken: that file is designed to be committed, so an
 * agent running `git add -A` would land EO's configuration on somebody's
 * default branch, where it would go on applying to every human working
 * in that repository afterwards.
 *
 * **It composes rather than replaces.** A repository's own hooks arrive
 * through `settingSources: ["project"]`, which `applyAttachments`
 * readmits; this adds one of EO's beside them and takes none of theirs
 * away.
 *
 * **It never blocks.** No `permissionDecision` is returned, so the call
 * the agent made runs exactly as it would have. EO-165 says to build the
 * nudge, measure it, and let the numbers argue for anything stronger —
 * and a block-once-then-revert mode is the *next* step rather than this
 * one.
 *
 * **It says nothing on a run without an index.** No server, or a server
 * whose provider offered no vocabulary, and there is no hook at all —
 * not a hook that stays quiet, no `hooks` option on the query. That is
 * the same silence every other part of this feature keeps when the
 * feature is off, the binary is missing or the index failed to build.
 *
 * **The judgement is the caller's, the delivery is this adapter's
 * (KAN-126).** Which calls count as broad searches and what sentence
 * answers them is `repositoryIntelligence/broadSearch.ts`'s decision,
 * and that directory is on its way into the developer pack. So the
 * classifier arrives as `ClaudeProviderOptions.searchNudge`, supplied
 * by the composition root, and this function imports nothing from it;
 * what stays here is the hook itself, the matcher, Claude's spelling of
 * a tool id and the record of each firing. No nudge supplied is the
 * same silence as no index.
 *
 * **It leaves no trace of its own in the message stream, so EO records
 * one (EO-168).** The SDK's `hook_started` and `hook_response` messages
 * carry `stdout`, `stderr` and `exit_code`: they describe a *command*
 * hook. An in-process callback is invoked over the control protocol and
 * announced nowhere, so no SDK message says this fired — two attempts
 * at instrumenting `scripts/index-adoption-trial.mjs` recorded zero on
 * runs that had fired before that was understood. So the callback
 * reports each firing to `record`, and the stream folds it into the
 * run's events beside the `tool_call` that triggered it. Without that
 * an unfired hook and an ignored one leave identical evidence, which is
 * the mistake this project has already made twice.
 *
 * **Every time, not once per session.** A message delivered once, near
 * the start, and never again is a prompt bullet with extra steps — the
 * exact thing EO-164 measured as inert. What makes this different is
 * that it arrives *at* the habit, so it has to arrive as often as the
 * habit does. The cost is bounded by how narrow the classifier is: a
 * run that searches broadly twenty times pays for twenty short
 * sentences, and a run that does not pay nothing.
 */
function searchInterception(
  nudge: SearchNudge | undefined,
  server: RepositoryMcpServer | undefined,
  cwd: string,
  record: (event: SearchInterceptionEvent) => void,
): Options["hooks"] | undefined {
  // No judgement supplied, no hook (KAN-126): the adapter delivers a
  // nudge and does not have one of its own.
  if (nudge === undefined) return undefined;
  const answers = server?.answers;
  const knows = server?.knows;
  // Both, or neither and no hook at all (EO-173). A provider that named
  // its tools but offered no way of asking whether they have anything to
  // say is a provider whose suggestions could not be checked, and an
  // unchecked suggestion is the thing this stopped making.
  if (server === undefined || answers === undefined || knows === undefined) return undefined;

  // `mcp__<server>__<tool>` is Claude's spelling of a tool id, and this
  // adapter is the right place to know it. The provider supplied bare
  // names precisely so the next backend can spell them its own way.
  const qualify = (tool: string): string => `mcp__${server.name}__${tool}`;

  const hook = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const interception = await nudge({
      tool: input.tool_name,
      input: input.tool_input,
      answers,
      knows,
      qualify,
      // The worktree, so a search that spells the checkout out in full
      // reads as the whole tree rather than as a deep, deliberate path.
      root: cwd,
    });
    if (interception === null) return {};
    // Recorded before it is said, so the log cannot end up describing an
    // interception the model never received — and only ever here, on the
    // one path that actually intercepts something. Every `return {}`
    // above records nothing, which is what makes a zero on this run mean
    // "never fired" rather than "fired unobserved" (EO-168).
    //
    // The needle and nothing around it: this fires *before* the search
    // runs, so there are no results to leak, and what it does carry is
    // the agent's own words out of the `tool_call` event beside it.
    record({
      type: "search_interception",
      tool: input.tool_name,
      // Narrowed rather than trusted, though the SDK types it as a
      // required string: this arrives off a wire from a CLI EO does not
      // version-lock, and a missing id has to read as "this backend did
      // not say" rather than as the string "undefined" in the log.
      callId: typeof input.tool_use_id === "string" && input.tool_use_id !== "" ? input.tool_use_id : null,
      kind: interception.kind,
      needle: interception.needle,
      suggestion: interception.nudge,
    });
    // `additionalContext` and nothing else: no decision, no reason, no
    // `systemMessage`. The call proceeds and the agent is told one
    // thing it did not know.
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: interception.nudge } };
  };

  return { PreToolUse: [{ matcher: SEARCH_TOOL_MATCHER, hooks: [hook] }] };
}

/**
 * Firings, held between two messages (EO-168).
 *
 * The hook runs on the SDK's control protocol while this adapter is
 * parked on the next `SDKMessage`, so there is no message to attach a
 * firing to at the moment it happens and nowhere to yield from. It is
 * queued instead and drained at the next message boundary.
 *
 * **What that guarantees, exactly**, because the obvious stronger claim
 * is false and was written down here once. An assistant message can
 * carry several `tool_use` blocks — the model asking for parallel calls
 * — and `mapSdkMessage` turns all of them into `tool_call` events
 * before any hook has run. So a message with two broad searches emits
 * `tool_call A, tool_call B` and then, at the next boundary,
 * `interception A, interception B`. The guarantee is that an
 * interception follows the `tool_call` for its own call and precedes
 * any `tool_call` from a later message, and that a batch keeps the
 * calls' own order — not that the two are adjacent. Adjacency holds
 * only for the common one-call-per-message shape, and buying it in
 * general would mean holding every `tool_call` back until its tool
 * finished, which would strip the transcript of the "running Bash now"
 * it is read for.
 *
 * Which is why the event carries `callId`: ordering is how a person
 * reads it, and the id is how anything else joins it. Two identical
 * parallel greps are otherwise two indistinguishable interceptions.
 *
 * Per stream rather than per provider — a provider is cached and worked
 * against many items, and a queue shared between two turns would file
 * one run's interceptions under another's.
 */
interface InterceptionQueue {
  record: (event: SearchInterceptionEvent) => void;
  /** Everything recorded since the last call. Empty on a turn that intercepted nothing. */
  drain: () => SearchInterceptionEvent[];
}

function interceptionQueue(): InterceptionQueue {
  const pending: SearchInterceptionEvent[] = [];
  return {
    record: (event) => void pending.push(event),
    drain: () => pending.splice(0, pending.length),
  };
}

/** One turn's own facts: where it runs, what it must produce, what it may reach. */
interface ClaudeTurn {
  cwd: string;
  outputSchema?: JsonSchema | undefined;
  signal?: AbortSignal | undefined;
  resume?: string;
  model?: string;
  reasoningEffort?: string;
  /** Whether thinking comes back summarised (`AgentTurnOverrides.showReasoning`); omitted leaves the CLI's default. */
  showReasoning?: boolean | undefined;
  /** Whether the words are streamed as they are generated (`AgentTurnOverrides.streamDeltas`). */
  streamDeltas?: boolean | undefined;
  /** Whether the answer is streamed as it is written too (`AgentTurnOverrides.streamAnswer`). */
  streamAnswer?: boolean | undefined;
  /** What the turn may spend, in cents (`AgentTurnOverrides.budgetCents`). */
  budgetCents?: number | undefined;
  /** The generated directory this turn's servers and skills come out of (EO-107). */
  toolDirectory?: string | undefined;
  /**
   * The repository intelligence server for this item's checkout, when
   * there is one (EO-151).
   *
   * On the turn rather than on the adapter below, which is the same
   * split `cwd` is on: the adapter is what this agent always has, the
   * turn is what this dispatch is about. A cached provider works every
   * item that agent is given, and an index is one item's.
   */
  repositoryMcp?: RepositoryMcpServer | undefined;
  /** The run this turn belongs to and where it may attach files from (EO-412). On the turn for the reason `repositoryMcp` is. */
  attachFrom?: AttachmentSource | undefined;
  /** The memory scopes this turn may read with `memory_read` (EO-478). On the turn for the same reason. */
  memoryScopes?: MemoryReadScope[] | undefined;
  /** Where this turn's `eo` server hands what the agent writes (EO-543). On the turn for the same reason. */
  writeBridge?: AgentWriteBridgeAddress | undefined;
  /** The run's environment variables (EO-487, `AgentTurnOverrides.environmentVariables`). On the turn because they are the step's, read as it opens. */
  environmentVariables?: Record<string, string> | undefined;
  /** Names the CLI must start without, inherited or not (EO-584, `AgentTurnOverrides.withheldEnvironmentVariables`). On the turn for the reason the variables are. */
  withheldEnvironmentVariables?: string[] | undefined;
  /**
   * Where this turn's interceptions are reported, so they can be
   * recorded as run events (EO-168).
   *
   * On the turn for the same reason `repositoryMcp` is: the hook belongs
   * to one dispatch, and a sink shared across dispatches would file one
   * run's firings under another's. Omitted means nobody is listening —
   * the interception still happens and the agent is still told, it is
   * simply not observed, which is what a test that only inspects the
   * options is doing.
   */
  onInterception?: ((event: SearchInterceptionEvent) => void) | undefined;
}

/**
 * What the adapter brings to every turn, as one object.
 *
 * Grouped rather than added to the tail of a positional list, which had
 * reached six and would have reached eight — the arrangement
 * `ProviderIdentity` in `engine.ts` was written to avoid, where two
 * arguments of the same type can be transposed without the compiler
 * noticing.
 */
interface ClaudeAdapter {
  config: ClaudeAgentConfig | undefined;
  enableCommentTool: boolean;
  executablePath: string | null | undefined;
  eoMcp?: EoMcpServiceConfig | undefined;
  apiKey?: string | null;
  /** Values for the `${VAR}` names in the generated `.mcp.json`, read at spawn. */
  attachmentEnv?: Record<string, string> | undefined;
  /** The names that must arrive unset, from EO and from anything the CLI inherits (EO-488). */
  withheld?: readonly string[] | undefined;
  /** The caller's judgement about broad searches, if it supplied one (KAN-126). */
  searchNudge?: SearchNudge | undefined;
  /** Where the settings files the compatibility holds read come from; the disk unless a test says otherwise (EO-599). */
  settingsReader?: ClaudeSettingsReader | undefined;
}

/**
 * The defaults claude@0.3.312 and claude@0.3.318 changed, held to what the
 * pin before each did (EO-599, EO-644, `claudeCompatibility.ts`):
 * variables added to the spawn environment, and the flag settings
 * (`--settings`) that switch off a built-in plugin. Runs on the finished
 * environment, so a run's own variables count, and never sets a name the
 * person, a settings file or EO already set.
 */
function applyCompatibilityHolds(options: Options, sources: ClaudeSettingSources, reader: ClaudeSettingsReader | undefined, model?: string | null): void {
  const holds = claudeCompatibilityHolds({
    spawnEnv: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    sources,
    model: model ?? options.model ?? null,
    ...(reader ? { reader } : {}),
  });
  if (Object.keys(holds.env).length > 0) options.env = { ...(options.env ?? process.env), ...holds.env };
  // Nothing else in EO hands the CLI flag settings; were that to change,
  // this would have to merge into them rather than replace them.
  if (Object.keys(holds.settings).length > 0) options.settings = holds.settings;
}

/** An environment less every name that must arrive unset (EO-488); the same object when there are none. */
function withoutNames<T extends Record<string, string | undefined>>(environment: T, names: ReadonlySet<string>): T | Record<string, string | undefined> {
  if (names.size === 0) return environment;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !names.has(name)));
}

function buildOptions(opts: ClaudeTurn, adapter: ClaudeAdapter): Options {
  const { config, enableCommentTool, executablePath, eoMcp, apiKey } = adapter;
  const model = opts.model ?? config?.model;
  const effort = (opts.reasoningEffort ?? config?.effort) as NonNullable<Options["effort"]> | undefined;
  const options: Options = {
    cwd: opts.cwd, // the G-01 worktree
    // A-08: EO resolves this rather than letting the SDK reach for the
    // copy inside its own package, which is Anthropic's binary and not
    // ours to redistribute.
    ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // Unattended by design, so there is nobody to answer a permission
    // prompt: under the CLI's default mode every Write, Edit and Bash
    // call is simply denied and the agent escalates saying it cannot
    // write anything. `acceptEdits` is not enough either — an
    // implementer has to run git and the check commands.
    //
    // What makes this defensible is the surrounding machinery, not
    // trust in the agent: its claims are checked independently by G-02,
    // the design's guards cap attempts, wall-clock and spend, and its work is
    // reviewed before anything merges.
    //
    // **A literal, and `config` is not consulted (EO-178).** It used to
    // resolve `config?.permissionMode ?? "bypassPermissions"`, which
    // made every word above an argument for a *default* — one anybody
    // holding `agents.config` could overrule, and the failure then is an
    // agent that runs, is denied every write, and escalates. The
    // machinery that makes bypass defensible does not become more true
    // because someone picked `plan` from a list, so there is no list and
    // no key: this is where the process is spawned, and pinning it
    // anywhere else would only be presentation. `agents.config` is an
    // open bag — the editor writes it, MCP `agent_save` writes it,
    // anyone with the SQLite file writes it — so a stale
    // `"permissionMode"` left in a row reaches here and is ignored.
    //
    // Not to be confused with a step's `planMode`, which is an
    // instruction carried in the dispatch context and shares nothing
    // with this but a word.
    //
    // Note what is *not* on that list. The G-01 worktree is where the
    // agent is pointed, not a fence it is held behind: it can read and
    // write anywhere the user can, including every other item's
    // checkout. This comment used to lead with the worktree as though
    // it contained anything, until a real run had one story copy a
    // sibling's unmerged file verbatim (KAN-27). Confining the process
    // was considered and rejected — git and npm legitimately read
    // `~/.gitconfig` and `~/.npm`, and Bash makes a tool-level deny
    // evadable anyway — so `borrowedFiles` checks the result instead.
    permissionMode: "bypassPermissions",
    // EO-120: the companion the SDK's own declaration asks for — "Must
    // be set to `true` when using `permissionMode: 'bypassPermissions'`.
    // This is a safety measure to ensure intentional bypassing of
    // permissions" (sdk.d.ts:2080 at 0.3.318).
    //
    // **It is not enforced.** Established against
    // @anthropic-ai/claude-agent-sdk 0.3.227 driving Claude Code CLI
    // 2.1.238, and re-established at EO-179 against 0.3.251 driving CLI
    // 2.1.251, from the shipped code and a live run rather than from the
    // type:
    // sdk.mjs builds the argv in two independent branches —
    // `if(b)G.push("--permission-mode",b)` and
    // `if(v)G.push("--allow-dangerously-skip-permissions")` — with
    // nothing tying them together, and a query with the option unset
    // reaches the CLI's `init` event still reporting
    // `"permissionMode":"bypassPermissions"`. Nothing refuses, nothing
    // warns, nothing downgrades the mode. That is why EO ran without it
    // and never noticed.
    //
    // Across those releases the declaration's wording is unchanged and
    // so is the argv construction — only the minifier's names for the
    // two branches moved. Twice measured, two dozen releases apart, is
    // the SDK's settled behaviour rather than a gap due to be closed.
    //
    // EO-342 re-read the shipped code at the pin this file now compiles
    // and runs against — 0.3.280 driving CLI 2.1.280 — and found both
    // halves standing: the declaration's wording is still the sentence
    // quoted above, and the two argv branches are still independent
    // (they are the ones quoted, the minifier's names having moved again
    // from `y`/`S`/`Z`). The *live* half — that an unset option still
    // reaches `init` reporting `bypassPermissions` — was not re-run
    // here; it stands as last measured at 0.3.251.
    //
    // EO-370 re-read it again at 0.3.293 driving CLI 2.1.293, with the
    // same result. The sentence is unchanged and the branches are still
    // independent — now `if(S)K.push("--permission-mode",S)` and
    // `if(b)K.push("--allow-dangerously-skip-permissions")`. The live
    // half was not re-run at this pin either.
    //
    // EO-453 re-read it at 0.3.302 driving CLI 2.1.302. The sentence is
    // unchanged and the branches are still independent —
    // `if(y)W.push(Be("--permission-mode",y))` and
    // `if(b)W.push("--allow-dangerously-skip-permissions")` — with one
    // difference in spelling: 0.3.295 passes a typed option's value as
    // `--flag=value`, so the CLI is now handed
    // `--permission-mode=bypassPermissions` as one argument (`extraArgs`
    // keep the old rule, `=` only for a value starting with `-`). Driven
    // through this file against a capture server, that argv still
    // reaches `init` reporting `"permissionMode":"bypassPermissions"`.
    //
    // EO-599 re-read it at 0.3.312 driving CLI 2.1.312, and re-ran the
    // live half. The sentence is unchanged (now at sdk.d.ts:2055) and the
    // branches are still independent — `if(S)V.push(qe("--permission-mode",S))`
    // and `if(E)V.push("--allow-dangerously-skip-permissions")` — and a
    // query with `bypassPermissions` and the companion option unset, sent
    // to a capture server, still reaches `init` reporting
    // `"permissionMode":"bypassPermissions"`.
    // That is the mode EO sets arriving, not the unset-option half above,
    // which was not re-run.
    //
    // EO-644 re-read it at 0.3.318 driving CLI 2.1.318. The sentence is
    // unchanged (now at sdk.d.ts:2080) and the branches are still
    // independent — `if(S)q.push(qe("--permission-mode",S))` and
    // `if(E)q.push("--allow-dangerously-skip-permissions")`. Neither live
    // half was re-run through the SDK; the CLI itself, handed
    // `--permission-mode bypassPermissions` against a capture server, still
    // reports `"permissionMode":"bypassPermissions"` on `init`.
    //
    // So setting it is a judgement, not a fix, and the judgement is to
    // set it: EO was relying on a stated requirement going unapplied,
    // and a version bump is free to start applying it — on every
    // dispatch at once. EO is entitled to declare it on the argument
    // above: there is nobody to answer a prompt, and what makes that
    // defensible is G-02's independent verification of an agent's
    // claims, the design's caps on attempts and spend, and review before
    // anything merges. That is the "intentional bypassing" this option
    // exists to record, so recording it costs EO nothing it has not
    // already argued for.
    //
    // Unconditional, and that is EO-178 rather than a simplification.
    // It used to be tied to the resolved mode, because an agent could
    // override to `plan` and a declared intent to skip permissions
    // beside a tighter mode would simply be false. The mode can no
    // longer vary, so deriving this from it would be a branch with one
    // reachable side — and a dead branch is how the two halves of the
    // bypass come apart the day somebody edits one of them. Inert today
    // — passed alone the CLI still reports `default` — but a bump that
    // gives the flag teeth must not find it missing.
    allowDangerouslySkipPermissions: true,
    // Both spellings of an aliased EO tool, for the reason
    // `withAliasedToolNames` gives (KAN-162). Applied here as well as
    // where the server grants are added, because whichever of the two
    // writes `options.allowedTools` last is the list the CLI is handed.
    ...(config?.allowedTools ? { allowedTools: withAliasedToolNames(config.allowedTools) } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
    ...(opts.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: stripSchemaDialect(opts.outputSchema) } } : {}),
    // The words as they are generated, not a block at a time: what lets
    // a person watching a chat read the answer while it is written, the
    // way Claude Desktop does — which asks the CLI for exactly this. The
    // pieces come back as `stream_event`s, become `output_delta`s, and
    // are never stored (`OutputDeltaEvent`); the finished block is.
    //
    // Asked for on every turn, watched or not. A turn nobody is watching
    // shows no words (`stream` turns them into heartbeats), but they are
    // still the only sign it is at work while the model writes a long
    // block — minutes of nothing otherwise, which the inactivity guard
    // would take for a hang.
    includePartialMessages: true,
    // The turn's budget, held by the CLI itself so it stops mid-turn at
    // the cap rather than the cap being checked once the turn is over.
    //
    // Held to this process's own spend, not the session's, on a resumed
    // turn too (EO-490). Checked against the CLI EO pins (0.3.302, and
    // re-read at 0.3.312 for EO-599, where the two are `p0`/`kTe`, and at
    // 0.3.318 for EO-644, where `BIe` is the second): a
    // resumed session restores its cost state from the transcript, and
    // `total_cost_usd` goes on from it — but the budget check compares
    // the cap with that total *less* the restored cost (`r0`/`iSe` in
    // the bundle: `totalCost() - costLedger.restoredCostUSD()`). So the
    // remaining budget passed here is the turn's own, as it is on a fresh
    // one, and is not raised by what earlier runs on the thread spent.
    // If a CLI upgrade ever compared the restored total instead, a
    // resumed turn would stop at once on spend it did not make.
    ...(opts.budgetCents !== undefined ? { maxBudgetUsd: Math.max(0.01, opts.budgetCents / 100) } : {}),
    // Thinking, summarised, when the conversation wants it shown — and
    // only then. Hiding it is leaving the CLI's own setting alone, whose
    // display is already omitted when it streams JSON; sending adaptive
    // thinking to hide it would turn thinking on for a model, or for a
    // person's `alwaysThinkingEnabled: false`, that had it off.
    ...(opts.showReasoning === true ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
  };

  // Both of EO's own servers, and only EO's own: an attached server
  // reaches this backend through the generated directory and the
  // `--mcp-config` argument beside it, never through here.
  //
  // Written in this order so that `eo` is last, which is a guarantee
  // rather than tidiness — the service every agent talks to EO through
  // cannot be displaced by anything above it, whatever a name turns out
  // to be. `repo` is reserved in the catalogue and cannot be typed by a
  // person, and this ordering means a future server that got its name
  // wrong would lose to `eo` rather than take it.
  const mcpServers: NonNullable<Options["mcpServers"]> = {};
  if (opts.repositoryMcp) {
    mcpServers[opts.repositoryMcp.name] = { type: "stdio", ...agentMcpStdioConfig(opts.repositoryMcp), alwaysLoad: ALWAYS_LOAD_EO_SERVERS };
  }
  if (eoMcp) {
    // `attachFrom` is the turn's and the rest is the agent's (EO-412):
    // which run this is and where it works is what lets the service
    // offer `attachment_add`, and a cached adapter cannot know either.
    mcpServers[EO_SERVER_NAME] = {
      type: "stdio",
      ...eoMcpStdioConfig({
        ...eoMcp,
        enableCommentTool,
        ...(opts.attachFrom ? { attachFrom: opts.attachFrom } : {}),
        // And the memory scopes, which are what list `memory_read` (EO-478).
        ...(opts.memoryScopes && opts.memoryScopes.length > 0 ? { memoryScopes: opts.memoryScopes } : {}),
        // And where it hands what the agent writes (EO-543).
        ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}),
      }),
      alwaysLoad: ALWAYS_LOAD_EO_SERVERS,
    };
  }
  // Omitted entirely when there is nothing to say, rather than set to an
  // empty object: `mcpServers` serialises into argv, and an empty one is
  // an argument declaring no servers where there was previously no
  // argument at all.
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;

  applyAttachments(options, opts.toolDirectory, config, opts.repositoryMcp, eoMcp !== undefined && (opts.memoryScopes?.length ?? 0) > 0);

  // EO-165. Omitted entirely rather than set empty when there is nothing
  // to intercept, for the reason `mcpServers` is: an option declaring no
  // hooks where there was previously no option is a difference nobody
  // asked for.
  const hooks = searchInterception(adapter.searchNudge, opts.repositoryMcp, opts.cwd, opts.onInterception ?? (() => {}));
  if (hooks) options.hooks = hooks;

  // EO-84: the CLI has no flag for a key — it reads `ANTHROPIC_API_KEY`
  // from its environment — so this is where a key EO stores is spent.
  //
  // `process.env` is spread rather than replaced, and that is the SDK's
  // own instruction rather than caution: "When set, this value REPLACES
  // the subprocess environment entirely — it is not merged with
  // `process.env`". An env of one variable would take PATH and HOME away
  // from a child that needs both.
  //
  // Set only when there is a key. Writing the variable as empty or
  // undefined would *override* an `ANTHROPIC_API_KEY` the person had
  // exported for themselves, which is a credential EO was never asked to
  // have an opinion about.
  //
  // The attached servers' secrets travel the same way and for the same
  // reason (EO-107): the generated `.mcp.json` names `${GITHUB_TOKEN}`,
  // the CLI expands it out of this environment, and the value reaches
  // the server subprocess — so nothing anybody could read out of
  // `/proc/<pid>/cmdline` ever carried it. Applied before the API key so
  // that a catalogue entry declaring `ANTHROPIC_API_KEY` cannot displace
  // the credential EO is signing this run in with.
  const injected: Record<string, string> = {
    ...(adapter.attachmentEnv ?? {}),
    // The answer, word by word (`streamDeltas`). EO's answer is a call
    // to the structured-output tool, and the API streams a tool's input
    // in a few large chunks unless eager input streaming is on — so
    // without this a watched turn's text streamed and its answer still
    // landed whole, three pieces for a page. The CLI's own switch for it;
    // only for a turn whose answer somebody is reading (`streamAnswer`):
    // it streams every tool's input, not only the answer's.
    ...(opts.streamAnswer ? { CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: "1" } : {}),
    // EO-453: fork subagents stay off, as they were before 0.3.302
    // turned them on by default in SDK sessions. Measured against a
    // capture server (no credit): with the default, the `Agent` tool
    // the CLI offers gains a `"fork"` subagent type — "forks yourself
    // (the fork inherits your full conversation context …)" — and with
    // `CLAUDE_CODE_FORK_SUBAGENT=0` it is byte-identical to the one
    // claude@0.3.293 offered. Holding it is the bump keeping an agent's
    // tools as they were, not a judgement about forks. Re-measured at
    // claude@0.3.312 (EO-599): the variable still takes the fork type
    // out of the `Agent` tool, and nothing else. At claude@0.3.318
    // (EO-644) the `Agent` tool is byte-identical to 0.3.312's both ways,
    // with the variable unset and at `0`.
    //
    // Only when the variable is unset: the CLI read a person's own
    // `CLAUDE_CODE_FORK_SUBAGENT=1` before this pin too, and the old
    // default is what is being held, not an override of their choice.
    ...(process.env["CLAUDE_CODE_FORK_SUBAGENT"] === undefined ? { CLAUDE_CODE_FORK_SUBAGENT: "0" } : {}),
    ...(apiKey !== null && apiKey !== undefined && apiKey !== "" ? { ANTHROPIC_API_KEY: apiKey } : {}),
    // EO-468: Claude Code's own auto-memory is off, on every turn, so
    // EO's memory is the only one an agent has. Left on, the CLI keeps a
    // per-project directory (`~/.claude/projects/<cwd>/memory/`) that it
    // reads into every session started in that checkout and writes to as
    // it goes — what one run learned would reach the next through a
    // channel EO cannot see, attribute or retire, and on a
    // person's own machine it would be mixed with theirs.
    //
    // Read from the pinned CLI (2.1.302, again at 2.1.312 for EO-599 and
    // at 2.1.318 for EO-644) rather than assumed: the switch
    // is checked before any setting is, a truthy value ("1") answers
    // "off" whatever `autoMemoryEnabled` a settings file holds, and the
    // background consolidation ("auto-dream") is gated on auto-memory
    // being on, so it goes with it. The CLI's own default is on.
    //
    // Unconditional, unlike the fork pin above, and last but for nothing:
    // a person's own `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` would *force* it
    // on (the CLI reads a falsy value as "forced_on"), and an attached
    // server declaring the name must not be able to do the same. Set for
    // an agent on the person's own setup too — that opt-out restores
    // their tools and settings, not a second memory beside EO's.
    // `claude.test.ts` and `providerParity.test.ts` both fail without it.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  // The run's environment variables (EO-487) between the two: over what
  // EO inherited, which is the point of a person setting one, and under
  // everything above, so none of them can displace a value EO sets for
  // the run — an attached server's, the key, the pins, the admin bearer.
  // The names EO always owns are dropped outright, because PATH and HOME
  // come from the inherited environment and a variable spread over it
  // would replace them.
  //
  // A withheld name (EO-488) is taken out of both layers beneath: an
  // organisation value that cannot be read must not be stood in for by a
  // variable, or by the person's shell, of the same name.
  //
  // And so is a name a redirected step on a trial withholds (EO-584): the
  // step's own value is not given, and neither is whatever EO inherited.
  const withheld = new Set([...(adapter.withheld ?? []), ...(opts.withheldEnvironmentVariables ?? [])]);
  options.env = {
    ...withoutNames(process.env, withheld),
    ...withoutNames(withoutReservedEnvironmentVariables(opts.environmentVariables ?? {}), withheld),
    ...injected,
  };
  // EO-599 and EO-644: the defaults claude@0.3.312 and claude@0.3.318
  // changed, held to what the pin before each did
  // (`claudeCompatibility.ts`). Decided on what the CLI will see — this
  // environment, a run's own variables (EO-487) included, with the env
  // blocks of the settings files the turn loads laid over it, which
  // `applyAttachments` above has decided.
  applyCompatibilityHolds(options, config?.inheritAmbientConfig === true ? "all" : "project", adapter.settingsReader);

  // The SDK cancels through an AbortController rather than a signal, so
  // the supervisor's signal (A-01) is bridged onto one here.
  if (opts.signal) {
    const controller = new AbortController();
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    options.abortController = controller;
  }

  return options;
}

/**
 * What a side call is spawned with (EO-477): one question, one answer,
 * and nothing an agent is given.
 *
 * Built on its own rather than from `buildOptions`, because almost every
 * line there is about something a side call must not have, and a side
 * call that inherited them by being a variant of a turn would be one edit
 * away from having them:
 *
 * - **No tools.** `tools: []` is the SDK's "disable all built-in tools";
 *   no `mcpServers`, no `plugins`, no `--mcp-config`, and
 *   `strictMcpConfig` so the person's own servers and the empty
 *   directory's cannot arrive either. `skills: []`, stated, because the
 *   SDK says omitting it is not "skills off".
 * - **No setting sources at all**, `[]` rather than the agents'
 *   `["project"]`: that source is what loads a repository's `CLAUDE.md`,
 *   and a side call answers the question it is given, in a directory
 *   that has no repository in it.
 * - **No session kept.** `persistSession: false`, so nothing is written
 *   under `~/.claude/projects` and there is no thread anybody could
 *   resume — which also means no `resume` option, ever.
 * - **One turn**, from a string prompt: the SDK closes the CLI's input
 *   after it, so the CLI answers and exits.
 * - **The answer through the structured-output option**, as a run's is.
 *
 * What it keeps of an agent's lockdown is the environment: the API key
 * EO holds, and auto-memory off, which a side call must not read from or
 * write to any more than an agent may (EO-468).
 */
export function buildSideCallOptions(
  opts: AgentSideCallOptions,
  adapter: { executablePath?: string | null | undefined; apiKey?: string | null | undefined; settingsReader?: ClaudeSettingsReader | undefined },
): Options {
  const options: Options = {
    cwd: opts.cwd,
    ...(adapter.executablePath ? { pathToClaudeCodeExecutable: adapter.executablePath } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // The SDK's own option, as a turn's is (EO-578): consolidation's, from
    // the system agent; selection and extraction set none.
    ...(opts.reasoningEffort ? { effort: opts.reasoningEffort as NonNullable<Options["effort"]> } : {}),
    systemPrompt: opts.system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    persistSession: false,
    outputFormat: { type: "json_schema", schema: stripSchemaDialect(opts.outputSchema) },
    // Nothing to approve with no tools, and nobody to approve it: pinned
    // as a run's is, so the structured-output call is never the one
    // thing the CLI stops to ask about.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(opts.budgetCents !== undefined ? { maxBudgetUsd: Math.max(0.01, opts.budgetCents / 100) } : {}),
    // The answer's words as they are written (EO-577), as on a turn: the
    // caller counts them against the call's output-token cap, and cuts off
    // an answer running away while it is still being written.
    includePartialMessages: true,
  };
  options.env = {
    ...process.env,
    ...(adapter.apiKey !== null && adapter.apiKey !== undefined && adapter.apiKey !== "" ? { ANTHROPIC_API_KEY: adapter.apiKey } : {}),
    // EO-468, as on every turn: last, so nothing above can turn it on.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  // EO-599, as on a turn. A side call loads no settings source and has no
  // tools, so of the holds only the model's matter here — the prompt, the
  // refusal fallback and the catalogue — but deciding them all the one way
  // is simpler than saying which apply.
  applyCompatibilityHolds(options, "none", adapter.settingsReader);
  const controller = new AbortController();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  options.abortController = controller;
  return options;
}

/** A query started ahead of its turn (`AgentProvider.prewarm`), with its stdin open and nothing said into it. */
interface WarmQuery {
  /** The options it was started with, as `warmKeyOf` reads them; a turn adopts it only on an exact match. */
  key: string;
  query: ReturnType<ClaudeSdkModule["query"]>;
  input: { messages: AsyncIterable<SDKUserMessage>; push: (message: SDKUserMessage) => boolean; close: () => void };
  controller: AbortController;
  interceptions: InterceptionQueue;
  options: Options;
  /** The CLI it spawned, which whoever is done with it ends (EO-493). */
  processes: ClaudeProcesses;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Lets go of the admin bearer the warm process was spawned with
   * (EO-444): when it is dropped unadopted, or when the turn that adopted
   * it is over. The process authenticates with this bearer and no other.
   */
  release?: () => void;
}

/**
 * What a warm query must have been started with for a turn to adopt it:
 * every option the CLI is spawned with — its arguments, its environment,
 * its servers, the thread it resumes — and the caller's own `warmKey`.
 * Functions and the cancellation are not options the CLI sees, and are
 * left out. Null when the options cannot be read as data, which is no
 * warm-up rather than a wrong one.
 */
function warmKeyOf(options: Options, warmKey: string | undefined, perTurn: readonly string[] = []): string | null {
  // A bearer minted for each turn (EO-444) differs between the warm-up
  // and its turn by design, so its value is not part of the match — but
  // its name is: a process spawned without one is not the turn's.
  const env = options.env && perTurn.length > 0 ? { ...options.env, ...Object.fromEntries(perTurn.filter((name) => name in options.env!).map((name) => [name, "<per turn>"])) } : options.env;
  try {
    return JSON.stringify([{ ...options, env }, warmKey ?? null], (key, value: unknown) => (key === "abortController" ? undefined : value));
  } catch {
    return null;
  }
}

/** The SDK cancels through an AbortController rather than a signal, so the supervisor's signal (A-01) is bridged onto one. */
function bridgeSignal(signal: AbortSignal | undefined, onto?: AbortController): AbortController | undefined {
  if (!signal) return onto;
  const controller = onto ?? new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** The name this provider records in `runs.provider`, and answers to in `agents.provider`. */
const PROVIDER = "claude";

/**
 * What the CLI says when the session it was handed is not on this
 * machine (EO-93).
 *
 * It reaches EO inside the SDK's own wrapper — the CLI writes the line
 * to stderr and exits non-zero, and the SDK throws "Claude Code process
 * exited with code 1" with the stderr tail appended — so this reads the
 * whole message rather than comparing it, and follows `cause` for a
 * build that wraps rather than concatenates.
 *
 * Matching English here is the point: it is this file that knows which
 * backend produced the sentence, and the translation is what spares the
 * supervisor from knowing (`ThreadNotFoundError`). One phrase, because
 * one is what the CLI says; a second wording is a change to this line
 * and to nothing else.
 *
 * Deliberately not extended to `mapSdkMessage`'s error events: an
 * interrupted or failed turn is reported as `result`/`error_during_execution`,
 * which carries no session text at all — there is nothing there to
 * recognise, and a turn that got far enough to have a subtype found its
 * session.
 *
 * The CLI says the same thing about a session resumed from the wrong
 * directory, which it can find but will not open. Treating that as gone
 * is deliberate: it is not resumable from where the work is happening,
 * which is the only place EO will ever ask. The cost of being wrong is
 * one full-context run — and `findReusableThread` refuses a thread whose
 * worktree differs from this dispatch's before it ever gets here.
 */
export function isMissingClaudeSession(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (/no conversation found with session id/i.test(current.message)) return true;
  }
  return false;
}

/**
 * The same turn, with "this session is gone" told apart from every other
 * way a resume can fail (EO-93).
 *
 * Wraps rather than re-implements, so a provider error that is not this
 * one arrives at the supervisor exactly as it always did — which is what
 * keeps recovery off the catch-all path.
 */
function translatingLostSession(threadId: string, stream: InterruptibleStream<AgentEvent>): InterruptibleStream<AgentEvent> {
  // Called once, like `stream()` above: two iterators over one turn would
  // each consume half of it.
  const inner = stream[Symbol.asyncIterator]();

  // A plain forwarding iterator rather than a generator around `next()`:
  // a generator that pulls by hand never tells the turn it wraps that
  // nobody is reading any more (EO-492). `return` is passed straight on —
  // also for a turn a steer built before anybody read it, which a
  // generator not yet started would swallow — so the inner turn's
  // `finally` closes its input and lets its admin bearer go, exactly as
  // a fresh `start()` turn does when the supervisor walks away.
  const iterator: AsyncIterator<AgentEvent> = {
    async next() {
      try {
        return await inner.next();
      } catch (error) {
        if (!isMissingClaudeSession(error)) throw error;
        throw new ThreadNotFoundError({ threadId, provider: PROVIDER, cause: error });
      }
    },
    async return(value?: unknown) {
      return (await inner.return?.(value)) ?? { done: true, value: value as AgentEvent };
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    async interrupt() {
      await stream.interrupt?.();
    },
    async steer(message: string, attachments?: AgentInputAttachment[]) {
      return stream.steer?.(message, attachments) ?? false;
    },
  };
}

// `checkClaudeAuth` lived here and tested for `~/.claude/.credentials.json`
// and `~/.claude.json` — wrong in both directions, and blind to which
// executable would run. `runtimes/auth.ts` asks the binary now (EO-82).

/**
 * AgentProvider backed by the Claude Agent SDK (A-06).
 *
 * Claude launches EO's same stdio MCP service as Codex. Tool events are
 * still normalised back to their bare EO names so the supervisor owns
 * comment side effects and both read tools return directly to the agent.
 */
/**
 * An interruptible stream whose construction is itself async.
 *
 * `start` has to load the SDK before it has a query to interrupt, but it
 * must return the stream synchronously so the caller can hold on to
 * `interrupt`. This bridges the two: iteration and interruption both
 * wait on the same build, so an interrupt arriving before the SDK
 * finished loading still reaches the query once it exists rather than
 * being dropped on the floor.
 */
function deferred<T>(build: () => Promise<InterruptibleStream<T>>): InterruptibleStream<T> {
  let built: Promise<InterruptibleStream<T>> | null = null;
  const once = () => (built ??= build());
  let reading: Promise<AsyncIterator<T>> | null = null;
  const reader = () => (reading ??= once().then((stream) => stream[Symbol.asyncIterator]()));

  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => (await reader()).next(),
      // Passed on only to a turn that was built — by a steer or an
      // interrupt before anybody read it — which then lets go of what
      // was minted for it (EO-444); one never built minted nothing.
      return: async (value?: unknown) => {
        if (built === null) return { done: true, value: value as T };
        const iterator = await reader();
        return (await iterator.return?.(value)) ?? { done: true, value: value as T };
      },
    }),
    async interrupt() {
      await (await once()).interrupt?.();
    },
    // Steering waits on the same build, and for the same reason
    // (EO-176). Somebody who says something a second after pressing
    // Start is talking to a turn that exists — the SDK is still being
    // loaded, which is EO's business and not theirs — and dropping the
    // message because of where the load had got to would be the exact
    // "accepted and then does nothing" this story is about.
    async steer(message: string, attachments?: AgentInputAttachment[]) {
      return (await once()).steer?.(message, attachments) ?? false;
    },
  };
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): AgentProvider {
  const enableCommentTool = options.enableCommentTool ?? options.eoMcp?.enableCommentTool ?? false;

  // Loaded on first dispatch rather than at construction: the engine
  // builds a provider per agent whether or not it ever runs one, and
  // constructing must not depend on a download having happened.
  const sdkFor = async (): Promise<ClaudeSdkModule> => {
    const base = options.sdk ?? (options.runQuery ? standInSdk() : await loadClaudeSdk(options.sdkEntryPath ?? null));
    return options.runQuery ? { ...base, query: options.runQuery } : base;
  };

  /**
   * One user message, in the shape the SDK writes for a string prompt.
   *
   * Copied deliberately rather than invented. `sdk.query()` given a
   * plain string writes exactly this — `session_id: ""`, one text block,
   * a null `parent_tool_use_id` — straight to the CLI's stdin, so the
   * turn EO opens by hand is byte-for-byte the turn it used to get, and
   * the only thing that changed is who closes the stream.
   */
  function userMessage(text: string): SDKUserMessage {
    return {
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
  }

  /**
   * The same message, marked so the CLI folds it into the turn that is
   * already running (EO-176).
   *
   * **Both fields were chosen by measurement, and the obvious reading of
   * the SDK's own vocabulary is wrong.** `SDKUserMessage.priority` is
   * `'now' | 'next' | 'later'`, and "now" sounds like the one that means
   * "into this turn". First driven against the CLI EO-176 pinned
   * (claude@0.3.227, capture server, no credit spent).
   * `steering.live.test.ts` keeps the `next` and `shouldQuery: false`
   * halves of that measurement, and they passed again at claude@0.3.312
   * (EO-599) and at the current pin, claude@0.3.318 (EO-644). The `now`
   * and `later` readings are not
   * in that file, and no bump since EO-176 has re-driven them:
   *
   *   - `now` **interrupts**. The running turn ends immediately with an
   *     empty `result`, and a fresh `system/init` opens a second turn
   *     carrying the message. For EO that is fatal, not merely untidy:
   *     `processStream` ends the run on the first `result` it sees, so
   *     steering would have finished every run it touched on an empty
   *     result and thrown away the work the agent had done.
   *   - `later` waits for the turn to finish and then starts another —
   *     a second turn, a second result, and a second bill.
   *   - `next` is the one that means what this story asked for. The CLI
   *     surfaces it *inside* the running turn, alongside the next tool
   *     result, in its own words: "The user sent a new message while you
   *     were working: … Address the message above as you continue this
   *     turn." One turn, one result, one routing decision.
   *
   * **`shouldQuery: false` is what makes the late case harmless.** A
   * message that arrives when the turn has no boundary left to fold it
   * into would otherwise start a turn of its own — the `later` shape,
   * arrived at by accident. With this, the CLI appends it to the
   * transcript and asks the model nothing: no second turn, no second
   * result, no spend. Measured the same way, and the difference is
   * visible at the wire as an entire request that does not happen.
   */
  function steeredMessage(text: string): SDKUserMessage {
    return { ...userMessage(text), priority: "next", shouldQuery: false };
  }

  /**
   * What the CLI's environment is given beyond its own: the attached
   * servers' values, then this turn's admin bearer over them (EO-444) —
   * last, so a catalogue entry declaring the same name cannot displace
   * the credential EO authenticates its own server with.
   */
  function turnEnvironment(admin: AdminMcpDispatch | null, variables: Readonly<Record<string, string>> | undefined): AttachedServerEnvironment | undefined {
    // Stripped of EO's own names first, as the CLI's environment is: a
    // declared server name is filled from what the run is actually given.
    const attached = options.attachmentEnv?.(withoutReservedEnvironmentVariables(variables ?? {}));
    if (admin === null) return attached;
    return { env: { ...(attached?.env ?? {}), ...admin.environment }, ...(attached?.withheld ? { withheld: attached.withheld } : {}) };
  }

  /**
   * Builds a turn's options, letting the admin bearer go if that throws
   * (EO-444): no query will be opened to let it go at the end of.
   */
  function withAdminLease(admin: AdminMcpDispatch | null, build: () => Options): Options {
    try {
      return build();
    } catch (error) {
      admin?.release();
      throw error;
    }
  }

  /**
   * The turn's input, as a stream EO holds open (EO-176).
   *
   * **Why this exists at all.** The SDK's control requests — interrupt,
   * and now steering — are, in its own words, "only supported when
   * streaming input/output is used". A string prompt is not that: the
   * SDK writes the one message, marks the query single-turn, and closes
   * the CLI's stdin the moment the first result arrives. There is
   * nothing left to push a message into. Handing it an async iterable
   * instead leaves stdin open for as long as this object goes on
   * yielding, which is what makes a person able to say something to an
   * agent mid-turn.
   *
   * **And why closing it is not optional.** With the string gone, so is
   * the SDK's own reason to end the session: it now ends when this
   * stream ends. A run that walked away without closing would leave a
   * CLI process sitting on an open stdin waiting for input nobody will
   * send. So the turn's terminal `result` closes it, and so does the
   * generator's `finally` — an escalation that drains a few events and
   * stops is exactly the case that would otherwise strand a subprocess.
   */
  function turnInput(first?: SDKUserMessage): {
    messages: AsyncIterable<SDKUserMessage>;
    /** Queues a further message for the open turn. False once the stream has been closed. */
    push: (message: SDKUserMessage) => boolean;
    close: () => void;
  } {
    // Empty for a warm query (`prewarm`), which is started before anybody
    // has said anything and is handed its first message on adoption.
    const pending: SDKUserMessage[] = first ? [first] : [];
    let closed = false;
    let wake: (() => void) | null = null;

    const woken = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };

    async function* messages(): AsyncIterable<SDKUserMessage> {
      for (;;) {
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }

    return {
      messages: messages(),
      push(message) {
        if (closed) return false;
        pending.push(message);
        woken();
        return true;
      },
      close() {
        closed = true;
        woken();
      },
    };
  }

  /**
   * One turn, as an iterable that can be cut short (KAN-24).
   *
   * The SDK reports a turn's tokens and cost only on its terminal
   * `result` message. A consumer that simply walks away — which is what
   * an escalation used to do — never sees it, so the run recorded a
   * spend of nothing while the design's budget summed those figures and called
   * itself exact.
   *
   * So the query handle is kept, and `interrupt` passes the request
   * through to it. The SDK then winds the turn up and emits its result
   * through this same iterator, which the caller is already draining.
   *
   * And one a person can say something to (EO-176). Both controls need
   * the same thing of this function — a session that is still being
   * spoken to — which is why the input below is a stream EO holds open
   * rather than the string it used to hand over and forget.
   */
  function stream(
    prompt: string,
    sdkOptions: Options,
    sdk: ClaudeSdkModule,
    interceptions: InterceptionQueue,
    /** What a query opened on `sdkOptions` spawns its CLI through — ended when the turn is (EO-493). */
    processes: ClaudeProcesses,
    /** Called once the turn is over, whatever ended it — what a turn's admin bearer is let go by (EO-444). */
    onEnd?: () => void,
    /**
     * A warm query (`prewarm`) to run the turn on, started for exactly
     * these options. `sdkOptions` and `interceptions` are then what the
     * turn falls back to if it has died.
     */
    adopted: WarmQuery | null = null,
    /**
     * Whether the words are passed on as they are written. Off, each is
     * the backend at work and nothing more: a heartbeat, not a delta.
     */
    showWords = true,
  ): InterruptibleStream<AgentEvent> {
    // Assigned on the first `next()`, which is before any caller could
    // have a reason to interrupt: there is nothing to cut short until
    // the agent has said something.
    let handle: { interrupt?: () => Promise<unknown> } | null = null;
    // Every message this turn says to the CLI, by the uuid it is sent
    // with: what tells the turn's own result from one the CLI wrote for
    // something it was finishing first (EO-495, `answersTurn`).
    const said = new Set<string>();
    const sent = (message: SDKUserMessage): SDKUserMessage => {
      const uuid = uuidv7();
      said.add(uuid);
      return { ...message, uuid: uuid as NonNullable<SDKUserMessage["uuid"]> };
    };
    // A warm query is already running with its input open and nothing
    // said into it; the prompt becomes its first message.
    let input = adopted?.input ?? turnInput(sent(userMessage(prompt)));
    if (adopted) input.push(sent(userMessage(prompt)));
    // Whose hooks report this turn's interceptions: the warm query's, or
    // the turn's own once it has fallen back to a query of its own.
    let intercepted = adopted?.interceptions ?? interceptions;
    // Whether the warm query is still the one the turn runs on, so its
    // bearer is let go once, here or at the end.
    let warm = adopted;
    // What was steered into the warm query before it had said anything:
    // the turn's own if the warm one turns out to have died.
    const steeredEarly: SDKUserMessage[] = [];
    const letWarmGo = () => {
      const going = warm;
      warm = null;
      going?.release?.();
    };

    /**
     * The CLI's messages for this turn: the warm query's, unless it ends
     * or fails before it has said anything — a process that died while it
     * waited, which the SDK does not otherwise tell of — in which case the
     * turn is opened afresh on its own options, as Codex's is.
     */
    async function* messages(): AsyncGenerator<SDKMessage> {
      // Over before it was read — cancelled, or let go of — and its
      // bearers with it: nothing is spawned under them now.
      if (finished) return;
      if (warm) {
        const query = warm.query;
        handle = query as unknown as { interrupt?: () => Promise<unknown> };
        let heard = false;
        try {
          for await (const message of query) {
            heard = true;
            steeredEarly.length = 0;
            yield message;
          }
          if (heard) return;
        } catch (error) {
          if (heard || warm.controller.signal.aborted) throw error;
          console.warn("[eo] the Claude process started ahead of this turn had stopped; starting another:", error);
        }
        if (warm.controller.signal.aborted) return;
        warm.input.close();
        warm.controller.abort();
        // Gone before the turn's own CLI is spawned on the same thread,
        // however it stopped answering (EO-493).
        await warm.processes.end(options.processGraceMs);
        letWarmGo();
        input = turnInput(sent(userMessage(prompt)));
        for (const steered of steeredEarly.splice(0)) input.push(steered);
        intercepted = interceptions;
      }
      const query = sdk.query({ prompt: input.messages, options: sdkOptions });
      handle = query as unknown as { interrupt?: () => Promise<unknown> };
      yield* query;
    }
    /**
     * Set the instant the turn's terminal `result` is read, and the
     * whole of what `steer` can honestly answer.
     *
     * A message pushed after this has no turn left to join, so a steer
     * arriving here is refused — and refusing it is not a failure: the
     * caller still holds the comment, and the comment is what the next
     * turn reads.
     *
     * It cannot close the window entirely, and says so rather than
     * pretending. Between the CLI deciding a turn is over and this line
     * reading the message that says so, a push is written to a stdin
     * nobody is listening to any more. That gap is one pipe read wide,
     * and the alternative — a receipt from the backend — is not
     * something either the SDK or the CLI offers. What is on the other
     * side of it is deliberately mild: `shouldQuery: false` means a
     * message that misses its turn is appended to the session and asked
     * about nothing, rather than opening a turn EO is no longer reading.
     */
    let turnOver = false;

    // The bearer goes however the turn ended — including a query that
    // threw before its first message — so the release wraps the whole of
    // it rather than sitting in the finally below (EO-444).
    let started = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onEnd?.();
      letWarmGo();
    };

    // The warm query's CLI, if the turn adopted one: the turn's to end
    // as much as its own is, whichever of the two it ran on.
    const adoptedProcesses = adopted?.processes ?? null;

    async function* events(): AsyncGenerator<AgentEvent> {
      started = true;
      try {
        yield* queried();
      } finally {
        // However the turn ended — its result read, a correction about
        // to be opened, an escalation drained, a throw — EO reads no more
        // of it, so its CLI is ended here and the turn is not over until
        // it has exited (EO-493). The query's own `finally` above has
        // closed its stdin by now, and that is not enough: a CLI waiting
        // on background tasks, or with a turn already queued, works on
        // through a closed stdin. The bearer goes after, as on Codex: by
        // then nothing it was minted for is running.
        //
        // A CLI still there after SIGKILL makes this throw
        // (`TurnNotEndedError`), so the turn's `return()` rejects and the
        // supervisor fails the run closed rather than open another turn
        // beside it. Its bearer is let go all the same: a process EO can
        // no longer vouch for is the last thing that should keep EO's
        // administrative authority.
        try {
          const ending = await Promise.allSettled([processes.end(options.processGraceMs), adoptedProcesses?.end(options.processGraceMs)]);
          const failed = ending.find((outcome) => outcome.status === "rejected");
          // In a `finally` on purpose: the only way a generator answers
          // `return()` with a failure, and a survivor outranks whatever
          // else ended the turn.
          // eslint-disable-next-line no-unsafe-finally -- see above
          if (failed) throw failed.reason;
        } finally {
          finish();
        }
      }
    }

    async function* queried(): AsyncIterable<AgentEvent> {
      const query = messages();
      // The calls this turn has made and not yet had answered, so a
      // result can name the tool it came from (EO-169). Per query, not
      // per provider: ids are only unique within one, and a map that
      // outlived the turn would be a leak with nothing to gain by it.
      const pendingCalls = new Map<string, string>();
      // The open content blocks of the message being streamed, for
      // `deltaOf`. Per query, as `pendingCalls` is.
      const blocks = new Map<number, DeltaStream | null>();
      // At most one heartbeat every few seconds: a streamed turn says
      // something with every token, and the inactivity guard needs to
      // hear only that it is still going.
      let lastBeat = 0;
      const beating = (): boolean => {
        const at = Date.now();
        if (at - lastBeat < HEARTBEAT_EVERY_MS) return false;
        lastBeat = at;
        return true;
      };
      // A result the CLI wrote for something other than this turn, kept
      // back rather than read as the turn's answer (EO-495). Dropped
      // when the turn's own result comes, which re-reports the session's
      // running totals anyway; passed on if none ever does, so a turn
      // that answered nothing still reaches the supervisor's result
      // validation exactly as it did before.
      let notOurs: AgentEvent[] | null = null;
      try {
        for await (const message of query) {
          // Before the message, not after: a hook fires while this
          // generator is parked here, so anything queued belongs to a
          // call announced by the message *before* this one (EO-168) and
          // has to be emitted before this message's own events. Which
          // puts an interception between its own `tool_call` and the
          // `tool_result` that answers it (EO-169) — the order it
          // happened in, since the agent was told before the tool ran.
          yield* intercepted.drain();
          const { mapped, recognised } = mapSdkMessage(message, pendingCalls, blocks);
          if (!recognised) options.onUnmappedMessage?.(message);
          // Not this turn's result: the turn is not over, its input stays
          // open for the message the CLI has yet to read, and nothing
          // the supervisor would end the turn on is passed on.
          if (message.type === "result" && !answersTurn(message, said)) {
            notOurs = mapped;
            if (beating()) yield { type: "heartbeat" };
            continue;
          }
          if (message.type === "result") notOurs = null;
          // Before the events are yielded rather than after, because a
          // yield is where a consumer walks away: `processStream`
          // returns on the first `result` it sees, and the session has
          // to already be winding itself up by then.
          if (message.type === "result") {
            turnOver = true;
            input.close();
          }
          for (const event of mapped) {
            if (event.type === "output_delta" && !showWords) {
              if (beating()) yield { type: "heartbeat" };
              continue;
            }
            yield event;
          }
          // A message that says nothing EO records — a status line, a
          // thinking block whose text is withheld, a streamed piece of a
          // tool's input — is still the CLI at work.
          if (mapped.length === 0 && beating()) yield { type: "heartbeat" };
        }
        // And once more at the end, for a firing with no message after it
        // — the last search of a turn, whose result the agent never got
        // round to acting on, is exactly the case worth counting.
        yield* intercepted.drain();
        if (notOurs !== null) yield* notOurs;
      } catch (error) {
        // EO spawns the CLI (`claudeProcess.ts`), so the SDK has no stderr
        // to append to a failed exit; it is put back here (EO-93).
        throw withStderr(error, processes.stderr() || adoptedProcesses?.stderr() || "");
      } finally {
        // Whatever ended this — the result above, an abandoned drain, a
        // throw — the CLI is no longer being spoken to and must not be
        // left waiting on stdin for a message that will never come.
        turnOver = true;
        input.close();
      }
    }

    // A turn never read — cancelled first, or let go of unread — has no
    // `finally` that will run, and lets its bearers go here instead.
    const unread = () => {
      if (!started) finish();
    };
    const cancelled = sdkOptions.abortController?.signal;
    if (cancelled?.aborted) unread();
    else cancelled?.addEventListener("abort", unread, { once: true });
    const iterator = events();
    const reader: AsyncIterator<AgentEvent> = {
      next: () => iterator.next(),
      return: (value?: unknown) => {
        unread();
        return iterator.return(value);
      },
    };
    return {
      [Symbol.asyncIterator]: () => reader,
      async interrupt() {
        // Best effort by design. An SDK build without `interrupt`, or a
        // turn already over, must not turn "stop now" into a throw on a
        // path that is already handling an escalation.
        try {
          await handle?.interrupt?.();
        } catch {
          // The caller drains and stops either way.
        }
      },
      steer(message: string, attachments?: AgentInputAttachment[]) {
        // Into the turn that is running — see `steeredMessage` for which
        // of the SDK's three priorities actually does that, and why the
        // one that sounds like it does not. Queuing is not asked of the
        // backend at all: EO queues by leaving the message a comment for
        // the next dispatch, so a run stays one turn and one result.
        //
        // The files that came with it are named the way a turn's own
        // prompt names them (EO-395), so a screenshot sent a moment
        // after the message it belongs to is something the agent can
        // open, and one sent with no text is still a message.
        if (turnOver) return Promise.resolve(false);
        const steered = sent(steeredMessage(withAttachmentNote(message, attachments)));
        if (warm) steeredEarly.push(steered);
        return Promise.resolve(input.push(steered));
      },
    };
  }

  /**
   * What every turn's options are built with, read now: the key and the
   * attachment environment can change between turns, and the admin
   * bearer is the turn's own (EO-444).
   */
  const adapterNow = (admin: AdminMcpDispatch | null, variables: Readonly<Record<string, string>> | undefined): ClaudeAdapter => {
    const attached = turnEnvironment(admin, variables);
    return {
      config: options.config,
      enableCommentTool,
      executablePath: options.executablePath,
      eoMcp: options.eoMcp,
      apiKey: options.apiKey?.() ?? null,
      attachmentEnv: attached?.env,
      withheld: attached?.withheld,
      searchNudge: options.searchNudge,
      settingsReader: options.settingsReader,
    };
  };
  /** A turn's options, the attached servers' values read for this turn's own variables (EO-488). */
  const turnOptions = (spec: ClaudeTurn, admin: AdminMcpDispatch | null): Options => buildOptions(spec, adapterNow(admin, spec.environmentVariables));

  /** A fresh turn's half of the options, the signal left to the caller. */
  const startSpec = (opts: Omit<AgentProviderStartOptions, "context" | "signal">, onInterception: InterceptionQueue["record"]): ClaudeTurn => ({
    cwd: opts.cwd,
    outputSchema: opts.outputSchema,
    onInterception,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.showReasoning === undefined ? {} : { showReasoning: opts.showReasoning }),
    ...(opts.streamDeltas ? { streamDeltas: true } : {}),
    ...(opts.streamAnswer ? { streamAnswer: true } : {}),
    ...(opts.budgetCents !== undefined ? { budgetCents: opts.budgetCents } : {}),
    ...(opts.toolDirectory ? { toolDirectory: opts.toolDirectory } : {}),
    ...(opts.repositoryMcp ? { repositoryMcp: opts.repositoryMcp } : {}),
    ...(opts.attachFrom ? { attachFrom: opts.attachFrom } : {}),
    ...(opts.memoryScopes ? { memoryScopes: opts.memoryScopes } : {}),
    ...(opts.writeBridge ? { writeBridge: opts.writeBridge } : {}),
    ...(opts.environmentVariables ? { environmentVariables: opts.environmentVariables } : {}),
    ...(opts.withheldEnvironmentVariables ? { withheldEnvironmentVariables: opts.withheldEnvironmentVariables } : {}),
  });

  /**
   * A resumed turn's half of the options. A resumed turn spawns the CLI
   * again, so the directory, the query server and the run all have to be
   * named again — the session remembers what it was told, not where the
   * files were (EO-107, EO-151, EO-412).
   */
  const resumeSpec = (threadId: string, opts: Omit<AgentProviderResumeOptions, "signal"> | undefined, onInterception: InterceptionQueue["record"]): ClaudeTurn => ({
    cwd: opts?.cwd ?? process.cwd(),
    outputSchema: opts?.outputSchema,
    resume: threadId,
    onInterception,
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts?.showReasoning === undefined ? {} : { showReasoning: opts.showReasoning }),
    ...(opts?.streamDeltas ? { streamDeltas: true } : {}),
    ...(opts?.streamAnswer ? { streamAnswer: true } : {}),
    ...(opts?.budgetCents !== undefined ? { budgetCents: opts.budgetCents } : {}),
    ...(opts?.toolDirectory ? { toolDirectory: opts.toolDirectory } : {}),
    ...(opts?.repositoryMcp ? { repositoryMcp: opts.repositoryMcp } : {}),
    ...(opts?.attachFrom ? { attachFrom: opts.attachFrom } : {}),
    // Re-stated for `attachFrom`'s reason: the `eo` server is started
    // again by the process a resume spawns (EO-478).
    ...(opts?.memoryScopes ? { memoryScopes: opts.memoryScopes } : {}),
    // And where the `eo` server it starts hands what the agent writes (EO-543).
    ...(opts?.writeBridge ? { writeBridge: opts.writeBridge } : {}),
    // And the run's environment variables, for that reason too (EO-487):
    // they are in the environment of the process the resume spawns.
    ...(opts?.environmentVariables ? { environmentVariables: opts.environmentVariables } : {}),
    ...(opts?.withheldEnvironmentVariables ? { withheldEnvironmentVariables: opts.withheldEnvironmentVariables } : {}),
  });

  /**
   * The one query started ahead of its turn (`prewarm`), and the count of
   * turns started since, which is how a warm-up that finishes loading
   * after the turn it was for has already begun knows to stand down.
   */
  let warm: WarmQuery | null = null;
  let turnsStarted = 0;
  /** Shuts the warm query down if its turn does not come. */
  const idleTimer = (): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(dropWarm, PREWARM_IDLE_MS);
    timer.unref?.();
    return timer;
  };

  const dropWarm = (): void => {
    if (!warm) return;
    const going = warm;
    warm = null;
    clearTimeout(going.timer);
    // Its stdin closed and its process stopped: nothing was ever said
    // into it, so there is nothing to wind up.
    going.input.close();
    going.controller.abort();
    // Nobody waits on a warm query, so a survivor is said here rather
    // than thrown to no one; nothing was ever said into it.
    going.processes.end(options.processGraceMs).catch((error: unknown) => console.warn("[eo] a Claude process started ahead of its turn did not exit:", error));
    going.release?.();
  };

  /** The warm query, if it was started for exactly these options; otherwise none, and the warm one is let go. */
  const takeWarm = (key: string | null): WarmQuery | null => {
    if (warm && key !== null && warm.key === key) {
      const taken = warm;
      warm = null;
      clearTimeout(taken.timer);
      return taken;
    }
    dropWarm();
    return null;
  };

  /**
   * Opens a turn: on the warm query when one was started for exactly
   * these options, otherwise on a new one. Either way the run's signal
   * cancels it, and every bearer minted for it is let go when it is over
   * (EO-444): the turn's own, and on a warm query the warm query's too.
   */
  const open = (
    sdk: ClaudeSdkModule,
    prompt: string,
    sdkOptions: Options,
    interceptions: InterceptionQueue,
    admin: AdminMcpDispatch | null,
    warmKey: string | undefined,
    signal: AbortSignal | undefined,
    /** Whether the turn's words are shown as they are written (`streamDeltas`). */
    showWords: boolean,
  ): InterruptibleStream<AgentEvent> => {
    turnsStarted += 1;
    const adopted = takeWarm(warmKeyOf(sdkOptions, warmKey, Object.keys(admin?.environment ?? {})));
    if (adopted) bridgeSignal(signal, adopted.controller);
    // The turn's own options stay ready either way: a warm query that
    // turns out to have died is replaced by a query opened on them.
    const controller = bridgeSignal(signal);
    if (controller) sdkOptions.abortController = controller;
    // Spawned by EO rather than by the SDK, so the turn can end its CLI
    // and know when it has gone (EO-493).
    const processes = options.turnProcesses?.() ?? claudeProcesses();
    sdkOptions.spawnClaudeCodeProcess = processes.spawn;
    return stream(prompt, sdkOptions, sdk, interceptions, processes, admin?.release, adopted, showWords);
  };

  return {
    start(opts: AgentProviderStartOptions): InterruptibleStream<AgentEvent> {
      // The skills the directory offers, named in the turn that opens the
      // thread as Codex names its own (EO-602): offered only in the Skill
      // tool's list, an attached skill went unused. Read and reported
      // before `start` returns, which is when debug mode records it. A
      // resumed turn sends none — the thread already has it.
      const skillsSection = opts.toolDirectory ? toolDirectorySkillsPromptSection(opts.toolDirectory) : "";
      opts.onSkillsSection?.(skillsSection);
      // Deferred rather than resolved here, because the SDK has to be
      // loaded before a query exists and `start` is not async. The
      // returned stream is what the caller drives.
      // Which of EO's skills this turn is given (EO-715), said first: the
      // allowlist read off the directory, the same list the SDK is handed.
      return leadingWith(offeredSkills(opts.toolDirectory), deferred(async () => {
        const sdk = await sdkFor();
        // One queue per turn, built before the options it is wired into
        // and handed to the stream that drains it (EO-168).
        const interceptions = interceptionQueue();
        const admin = options.admin?.(opts.cwd) ?? null;
        const sdkOptions = withAdminLease(admin, () => turnOptions(startSpec(opts, interceptions.record), admin));
        // The agent's own instructions replace the SDK's default framing,
        // and this is the only place they are sent: `assembleContext` no
        // longer repeats them at the foot of the context, which is what
        // made every fresh dispatch carry the role prompt twice.
        sdkOptions.systemPrompt = opts.instructions;
        const prompt = withAttachmentNote(withSkillsSection(opts.context, skillsSection), opts.attachments);
        return open(sdk, prompt, sdkOptions, interceptions, admin, opts.warmKey, opts.signal, opts.streamDeltas === true);
      }));
    },

    resume(threadId: string, message: string, resumeOpts?: AgentProviderResumeOptions): InterruptibleStream<AgentEvent> {
      // Sessions persist under ~/.claude, which is what makes resume
      // cheap after a crash (ARCHITECTURE.md, "Reconciling on launch", E-04) — but they live under
      // a directory derived from the cwd they started in. Resuming from
      // anywhere else fails with "No conversation found with session ID",
      // so the caller's worktree is not optional in practice.
      //
      // The same sentence is what a session that has simply been cleaned
      // up produces, so this turn is wrapped: EO does not own ~/.claude
      // and cannot assume a thread it stored is still there (EO-93).
      // A resumed turn is handed the directory's skills again, so it is
      // given them as a fresh one is (EO-715).
      return leadingWith(offeredSkills(resumeOpts?.toolDirectory), translatingLostSession(threadId, deferred(async () => {
        const sdk = await sdkFor();
        // A resumed turn intercepts exactly as a fresh one does, and is
        // counted the same way — its firings are this row's, not the
        // ones the session opened with (EO-168).
        const interceptions = interceptionQueue();
        const admin = options.admin?.(resumeOpts?.cwd) ?? null;
        const sdkOptions = withAdminLease(admin, () => turnOptions(resumeSpec(threadId, resumeOpts, interceptions.record), admin));
        return open(sdk, withAttachmentNote(message, resumeOpts?.attachments), sdkOptions, interceptions, admin, resumeOpts?.warmKey, resumeOpts?.signal, resumeOpts?.streamDeltas === true);
      })));
    },

    dropWarm,

    prewarm(turn: AgentPrewarmTurn): void {
      // Not for a turn with a repository index, as on Codex, whose search
      // hook is opened per turn: the two backends warm the same turns.
      // Conversations have none.
      if (turn.repositoryMcp) return;
      const startedBefore = turnsStarted;
      // The bearer this warm process would be spawned with (EO-444), held
      // here until the warm query owns it and let go on every way out
      // that leaves it with no process.
      let admin: AdminMcpDispatch | null = null;
      void (async () => {
        const sdk = await sdkFor();
        // A turn began while the SDK loaded: this warm-up was for it, or
        // for nothing, and either way is not wanted now.
        if (turnsStarted !== startedBefore) return;
        const interceptions = interceptionQueue();
        admin = options.admin?.(turn.cwd) ?? null;
        const lease = admin;
        const sdkOptions =
          turn.kind === "start"
            ? turnOptions(startSpec(turn, interceptions.record), lease)
            : turnOptions(resumeSpec(turn.threadId, turn, interceptions.record), lease);
        if (turn.kind === "start") sdkOptions.systemPrompt = turn.instructions;
        const key = warmKeyOf(sdkOptions, turn.warmKey, Object.keys(lease?.environment ?? {}));
        if (key === null) return;
        if (warm?.key === key) {
          // Still the same turn being typed: kept warm, not started twice.
          clearTimeout(warm.timer);
          warm.timer = idleTimer();
          return;
        }
        dropWarm();
        const controller = new AbortController();
        sdkOptions.abortController = controller;
        const processes = options.turnProcesses?.() ?? claudeProcesses();
        sdkOptions.spawnClaudeCodeProcess = processes.spawn;
        const input = turnInput();
        const query = sdk.query({ prompt: input.messages, options: sdkOptions });
        warm = { key, query, input, controller, interceptions, options: sdkOptions, processes, timer: idleTimer(), ...(lease ? { release: lease.release } : {}) };
        admin = null;
      })()
        .finally(() => {
          // Not handed to a warm query: nothing will be spawned with it.
          admin?.release();
        })
        .catch((error: unknown) => {
          // A warm-up is a saving, never a requirement: the turn starts the
          // ordinary way if this could not.
          console.warn("[eo] could not start Claude ahead of a turn:", error);
        });
    },

    async *sideCall(opts: AgentSideCallOptions): AsyncIterable<AgentEvent> {
      const sdk = await sdkFor();
      const sdkOptions = buildSideCallOptions(opts, { executablePath: options.executablePath, apiKey: options.apiKey?.() ?? null, settingsReader: options.settingsReader });
      const pendingCalls = new Map<string, string>();
      const blocks = new Map<number, DeltaStream | null>();
      // The question as a stream EO holds open and closes at the result,
      // rather than a string, so the turn can be interrupted (EO-577):
      // the SDK interrupts only a turn whose input is a stream. Wound
      // down, the CLI ends the turn and says what it spent in its result,
      // which is read like any other — the tokens and cost of an answer
      // cut off at its cap are recorded rather than lost with a killed
      // process. The caller bounds the wait and aborts `signal` after.
      const input = turnInput(userMessage(opts.input));
      const query = sdk.query({ prompt: input.messages, options: sdkOptions });
      // Interrupted over the input, which stays open until the result: a
      // closed input would let the CLI finish the answer instead.
      const windDown = () => {
        void Promise.resolve((query as { interrupt?: () => Promise<unknown> }).interrupt?.()).catch(() => undefined);
      };
      if (opts.windDown?.aborted) windDown();
      else opts.windDown?.addEventListener("abort", windDown, { once: true });
      try {
        for await (const message of query) {
          const { mapped, recognised } = mapSdkMessage(message, pendingCalls, blocks);
          if (!recognised) options.onUnmappedMessage?.(message);
          // One question, one answer: nothing more is said to the CLI.
          if (message.type === "result") input.close();
          // Nobody watches a side call, but its words are passed on: what
          // the caller holds the answer's length to (EO-577).
          yield* mapped;
        }
      } finally {
        opts.windDown?.removeEventListener("abort", windDown);
        input.close();
      }
    },

    describeSession(turn: AgentSessionQuery): AgentSessionDescription {
      // Read off the options a turn is really opened with, rather than
      // worked out a second time beside them (EO-392): `buildOptions` is
      // where the override, the agent's configuration and the pinned
      // permission mode meet, and a description that reasoned about them
      // separately would be right until the day one of them moved.
      //
      // Built with no key and no attachment environment, which is the
      // whole of where a secret enters these options — so there is none
      // here to leave out. And with no search nudge: a hook is a
      // callback, not a name, and building one would open a listener
      // for a turn this is not.
      const built = buildOptions(
        {
          cwd: turn.cwd ?? process.cwd(),
          ...(turn.model ? { model: turn.model } : {}),
          ...(turn.reasoningEffort ? { reasoningEffort: turn.reasoningEffort } : {}),
          ...(turn.toolDirectory ? { toolDirectory: turn.toolDirectory } : {}),
          ...(turn.repositoryMcp ? { repositoryMcp: turn.repositoryMcp } : {}),
        },
        { config: options.config, enableCommentTool, executablePath: options.executablePath, eoMcp: options.eoMcp, apiKey: null },
      );
      return {
        instructionsSlot: "systemPrompt",
        model: built.model ?? null,
        reasoningEffort: built.effort ?? null,
        policy: [{ name: "permissionMode", value: String(built.permissionMode) }],
        // EO's own servers go inline; the attached ones are in the
        // generated directory's `.mcp.json`, which the CLI is pointed
        // at. Their names are that file's keys — and its values are
        // `${VAR}` references, which this does not read anyway.
        mcpServers: [...Object.keys(built.mcpServers ?? {}), ...(turn.toolDirectory ? Object.keys(readToolDirectoryServers(turn.toolDirectory)) : [])],
        allowedTools: built.allowedTools ?? null,
        skills: Array.isArray(built.skills) ? [...built.skills] : [],
        inheritsAmbientConfig: options.config?.inheritAmbientConfig === true,
      };
    },
  };
}

/**
 * Enough of the SDK to build options without loading it.
 *
 * Used only when a caller injects `runQuery` — which means a test, since
 * the real SDK is what supplies `query`. The MCP helpers are unused now
 * that Claude launches the provider-neutral stdio service, but remain as
 * structural members because this stand-in implements the SDK module type.
 *
 * A test that needs the genuine article passes `sdk` instead.
 */
function standInSdk(): ClaudeSdkModule {
  return {
    query: (() => {
      throw new Error("standInSdk.query should have been replaced by the injected runQuery.");
    }) as unknown as ClaudeSdkModule["query"],
    tool: ((name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler })) as unknown as ClaudeSdkModule["tool"],
    createSdkMcpServer: ((config: unknown) => ({ type: "sdk", ...(config as object) })) as unknown as ClaudeSdkModule["createSdkMcpServer"],
  };
}
