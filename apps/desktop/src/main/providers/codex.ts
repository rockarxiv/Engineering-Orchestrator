// The Codex adapter. Turns run over `codex app-server --stdio` through
// EO's own client (`codexClient.ts`, EO-372), which replaced
// `@openai/codex-sdk` and the one-shot `codex exec` it wrapped.
import { join } from "node:path";
import type { AppServerNotification } from "./codexAppServer.js";
import { dropWarmCodexThread,
  CodexClient,
  type CodexClientOptions,
  type CodexThread,
  type CodexThreadOptions,
  type CodexTurn,
  type McpServerStartup,
  type ModelReasoningEffort,
  type RateLimitSnapshot,
  type RateLimitWindow,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from "./codexClient.js";
import {
  ADMIN_MCP_SERVER_NAME,
  RESERVED_MCP_SERVER_NAME,
  ThreadNotFoundError,
  type AgentInputAttachment,
  isDeliverableMcpServer,
  type AgentEvent,
  type AgentProvider,
  type AgentProviderResumeOptions,
  type AgentPrewarmTurn,
  type AgentProviderStartOptions,
  type AgentSideCallOptions,
  type AgentSessionDescription,
  type AgentSessionQuery,
  type AttachmentSource,
  type MemoryReadScope,
  type AgentWriteBridgeAddress,
  type InterruptibleStream,
  type JsonSchema,
  type McpServer,
  type QuotaEvent,
  type RepositoryMcpServer,
  type SearchInterceptionEvent,
  type ServerStatusEvent,
  type Skill,
  type UsageEvent,
  skillsForRun,
  withoutReservedEnvironmentVariables,
} from "@eo/core";
import type { AdminMcpDispatch } from "../agentAttachments/adminDelivery.js";
import { deliverableSkills, writeWorktreeSkills, worktreeSkillsPromptSection, type WorktreeSkillDelivery } from "../agentAttachments/worktreeSkills.js";
import { agentMcpStdioConfig, eoMcpStdioConfig, type EoMcpServiceConfig } from "../mcp/serviceConfig.js";
import { codexModelPrice, codexTurnCostCents, codexTurnCostMicrocents } from "./codexPricing.js";
import { personCodexHome } from "./codexHome.js";
import { CODEX_SIDE_CALL_SWITCHES, writeSideCallCatalog } from "./codexSideCallLockdown.js";

/** The catalogue Codex caches in every home it runs in, which a side call copies its model's entry from. */
const CODEX_MODELS_CACHE = "models_cache.json";
import { CODEX_SEARCH_TOOL_MATCHER, openCodexSearchHook, probeHookTrust, type CodexHookTrust, type CodexSearchHook } from "./codexSearchHook.js";
import type { SearchNudge } from "./searchNudge.js";
import { toolResultEvent, toolResultText } from "./toolResult.js";
import { withAttachmentNote } from "./attachmentNote.js";
import { withSkillsSection } from "../agentAttachments/skillsPrompt.js";

/**
 * What a Codex-backed agent's `agents.config` may carry. Everything is
 * optional — the CLI's own defaults apply otherwise.
 */
export interface CodexAgentConfig {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  /*
   * Not `sandboxMode` and not `approvalPolicy` (EO-178). Both were here
   * and both are pinned where the thread is opened; declaring them
   * again would be declaring options nothing obeys.
   *
   * Nor `networkAccessEnabled` (EO-372). The SDK turned it into
   * `sandbox_workspace_write.network_access`, a setting of the
   * workspace-write sandbox, and EO pins `danger-full-access` — so it
   * never did anything here, and a stale value left in a row is ignored.
   */
  webSearchEnabled?: boolean;
  /**
   * Let this agent use the person's own Codex setup (EO-378), under the
   * key Claude agents already use for theirs (EO-107). **Off by default.**
   *
   * Locked down, an agent runs with a Codex home of its own
   * (`codexHome` below, `providers/codexHome.ts`), which carries the
   * person's sign-in and saved conversations and nothing else — not their
   * `config.toml` and the MCP servers in it, not their global `AGENTS.md`,
   * not their skills. Ticked, `CODEX_HOME` is left exactly as the app
   * inherited it, which is how every Codex agent ran before this.
   */
  inheritAmbientConfig?: boolean;
}

/**
 * The MCP server name EO registers with Codex. Tool calls arrive as
 * `${EO_MCP_SERVER}/<tool>`.
 *
 * Defined as the catalogue's reserved name rather than beside it: they
 * are one fact — the name every agent's own tools come through, which is
 * therefore the name a catalogue entry may not take (EO-104) and the one
 * an attached server cannot displace here (EO-108). Two spellings of it
 * could drift apart, and the failure would be silent on both sides.
 *
 * The repository intelligence server has no constant here on purpose
 * (EO-151): its name arrives with the server, from the port that
 * composed it. Writing a second spelling of `repo` in this file would be
 * this adapter having an opinion about a name it is only carrying, and
 * the reservation that stops an attached server taking it is asked of
 * `packages/core`'s list rather than of anything here.
 */
export const EO_MCP_SERVER = RESERVED_MCP_SERVER_NAME;

/**
 * What `serverSecret` answers for one declared name (EO-377).
 *
 * `SECRET_WITHHELD` exists for one case: an organisation value that is
 * there but cannot be read (EO-328). That must stop every fallback — the
 * person's stored value of the same name, and equally a variable of that
 * name the Codex CLI inherited from the person's shell, which a stdio
 * server's `env_vars` and a `${VAR}` header would otherwise both pick
 * up. Null cannot say that, because null is also "never set", where the
 * inherited value is exactly what the other backend would use.
 */
export type ServerSecretRead = string | null | typeof SECRET_WITHHELD;

/** The variable must arrive unset — not from EO, and not from the CLI's inherited environment. */
export const SECRET_WITHHELD = Object.freeze({ withheld: true as const });

export interface CodexProviderOptions {
  /**
   * The shared EO stdio service. Codex launches the same implementation
   * as Claude; this adapter only translates the provider's config syntax.
   */
  eoMcp?: EoMcpServiceConfig;
  /**
   * The catalogue servers attached to this agent (EO-106), resolved
   * where the provider is built.
   *
   * Rows, and rows only. A catalogue entry holds the *names* of the
   * environment variables it needs and never a value (EO-104), so
   * nothing secret is captured here for the life of a cached provider —
   * the values arrive through `serverSecret` below, at spawn.
   */
  attachedServers?: McpServer[];
  /**
   * The value behind one declared name, read at the moment a Codex
   * client is constructed.
   *
   * A function rather than a bag of values, for the reason
   * `providers/claude.ts` reads its API key through one: this provider
   * is cached for the life of the process under a key that deliberately
   * carries no secret (`engine.ts` records why), so a value captured
   * here would be one the cache outlives.
   *
   * Three answers, and they differ in what the CLI's *inherited*
   * environment may do with the name (`ServerSecretRead`): a string is
   * the value, the empty string included; null is "EO holds nothing",
   * which leaves whatever the person's own environment has; and
   * `SECRET_WITHHELD` is "there is a value and it must not be
   * substituted", which takes the name out of the inherited environment
   * as well.
   *
   * `variables` are the run's environment variables (EO-488), less the
   * names EO always owns: the last layer a declared name is filled from,
   * after the organisation's value and the server's own secret. Passed
   * per client because they are the turn's step's, and the provider is
   * the agent's.
   */
  serverSecret?: (serverId: string, name: string, variables: Readonly<Record<string, string>>) => ServerSecretRead;
  /**
   * The catalogue skills attached to this agent (EO-207), resolved where
   * the provider is built — the same arrangement, and the same place, as
   * `attachedServers` above.
   *
   * Rows rather than a path, because this backend has no plugin loader
   * to point at a generated directory: the adapter writes the files into
   * the worktree itself and names the choices in the prompt, and both
   * need what a row holds. Safe to capture for the life of a cached
   * provider for the reason the servers are: `providerCacheKey` carries
   * a fingerprint of the resolved *content*, so an edited body or a
   * detached skill discards the provider built for the old one.
   *
   * Unfiltered, like the servers: `isDeliverable` is applied where the
   * files are written, so exactly one rule decides what a disabled or
   * archived skill does — the one the generated directory already asks.
   */
  attachedSkills?: Skill[];
  /**
   * EO's own administrative server, for the one agent whose allowlist
   * names it, and the bearer for it (EO-203).
   *
   * A function for the reason `serverSecret` is one: this provider is
   * cached for the life of the process, and both halves belong to a
   * loopback listener that can be restarted under it — a URL captured
   * here would be a port the cache outlives, and a token captured here
   * would be a credential it outlives. Called where a Codex client is
   * constructed, which is once per turn.
   *
   * Null is the ordinary answer, from both kinds of nothing: an agent
   * that holds no grant, and a host that is not listening. Neither is a
   * failure — see `adminDeliveryFor` on why a dispatch with no entry
   * beats a dispatch pointed at a server that cannot answer.
   *
   * The bearer is the turn's own (EO-444), and its `release` goes to the
   * client as `afterTurn`, which calls it once the app-server process is
   * over.
   */
  admin?: () => AdminMcpDispatch | null;
  /** Per-agent settings from `agents.config` (ARCHITECTURE.md, "An agent is a row": roles are configuration, not code). */
  config?: CodexAgentConfig;
  /**
   * This agent's own Codex home, made ready and named (EO-378).
   *
   * Called where a Codex client is constructed — once per turn — because
   * that is the last moment before the app-server reads it, and a link
   * in it can go stale between turns (`prepareCodexHome` on Windows'
   * hard links), and what an earlier turn wrote into the home is
   * cleared before the next one reads it. Throws when no home could be
   * made, which fails the turn rather than running it in the person's
   * own home; the dispatch preflight refuses that case first, with a
   * comment.
   *
   * Null is "run in the person's own home after all", for the one reason
   * a person agreed to: their sign-in is in the OS keyring, which no
   * other home can reach (`chooseCodexHome`). The item is told so by a
   * dispatch notice rather than here.
   *
   * Not called at all when `config.inheritAmbientConfig` is ticked, and
   * absent — every test that is not about this, and an engine with no
   * root to put homes under — leaves `CODEX_HOME` as inherited.
   */
  codexHome?: () => string | null;
  /**
   * What to say about a broad search of the checkout, when there is
   * something to say (EO-165, KAN-126, EO-379).
   *
   * The same option, taking the same function, as
   * `ClaudeProviderOptions.searchNudge`: the caller owns the judgement —
   * which calls are broad searches and what sentence answers them — and
   * this adapter owns the delivery, which on this backend is a
   * `PreToolUse` hook Codex runs as a command (`codexSearchHook.ts`).
   * Supplied by the composition root, never imported.
   *
   * Omitted means no hook at all, as it does there.
   */
  searchNudge?: SearchNudge;
  /**
   * Where the command Codex runs for that hook is on this machine
   * (`codexSearchHookCommand.mjs`), shipped beside the bundle because
   * another process executes it by path.
   *
   * Absent means no hook, like a missing nudge: a caller with no packaged
   * resources — a test, the v1 gate — has no command to name.
   */
  searchHookCommandPath?: string;
  /**
   * Seam for tests — how EO learns what marks its own hook as trusted
   * (`probeHookTrust`), which the real one asks the CLI by spawning it.
   * Null means it could not be learned, and the turn gets no hook.
   */
  searchHookTrust?: (command: string) => Promise<CodexHookTrust | null>;
  /**
   * Seam for tests — the real client spawns `codex app-server`, which a
   * unit test must not do.
   *
   * Takes this turn's repository intelligence server, because the real
   * one does: a Codex client is constructed per turn and its
   * `mcp_servers` are what the CLI is launched with, so the per-item
   * server has to arrive here rather than at provider construction
   * (EO-151). A stand-in that ignores the argument is still assignable,
   * which is what every test that is not about this wants.
   *
   * And this turn's search hook, when it has one (EO-379), for the same
   * reason: the hook is part of what the CLI is launched with, and the
   * listener behind it is one turn's.
   *
   * And the run the turn belongs to with the directory it may attach
   * files from (EO-412), once more for that reason: it becomes part of
   * the `eo` server's environment, which is written per launch.
   *
   * And the memory scopes the turn may read with `memory_read` (EO-478),
   * for that reason exactly.
   *
   * And the run's environment variables (EO-487), which are its step's
   * and read as the turn opens — never the provider's to hold. And the
   * names a redirected step on a trial withholds from it (EO-584).
   */
  createCodex?: (
    repositoryMcp?: RepositoryMcpServer,
    searchHook?: CodexSearchHookDelivery,
    attachFrom?: AttachmentSource,
    memoryScopes?: readonly MemoryReadScope[],
    environmentVariables?: Readonly<Record<string, string>>,
    writeBridge?: AgentWriteBridgeAddress,
    withheldEnvironmentVariables?: readonly string[],
  ) => Pick<CodexClient, "startThread" | "resumeThread"> & Partial<Pick<CodexClient, "prewarm">>;
  /**
   * Seam for tests — the client a side call runs on (EO-477), built from
   * `codexSideCallClientOptions` in production. Its own seam because a
   * side call's client is not a turn's: it is launched with none of the
   * servers, hooks or attachments `createCodex` is handed.
   */
  createSideCallCodex?: (catalogPath: string) => Pick<CodexClient, "startThread">;
  /**
   * Where a side call copies its model's catalogue entry from (EO-477),
   * in order. Absent: the side calls' own home's `models_cache.json`,
   * then the person's (`personCodexHome`). A seam for tests.
   */
  sideCallModelCaches?: (home: string | null) => string[];
  /**
   * The `codex` executable to run (A-08).
   *
   * There is no fallback. The SDK used to reach for the copy inside its
   * own package; with the SDK gone there is none, so a turn without a
   * path fails saying the CLI is not installed. EO resolves the binary
   * itself so nothing has to be shipped inside the installer, so there
   * is a test asserting this arrives.
   */
  executablePath?: string | null;
  /**
   * Anything EO does not map is surfaced here rather than dropped: an
   * event `mapThreadEvent` does not know, or an app-server notification
   * that is neither translated nor deliberately ignored (`codexClient.ts`).
   */
  onUnmappedEvent?: (event: ThreadEvent | AppServerNotification) => void;
  /*
   * No `pricing` (EO-374). It was a price the caller could supply, and
   * no caller ever did, so every Codex run cost nothing and no budget
   * stopped one. Prices now come from the table EO ships
   * (`codexPricing.ts`), at the model each turn ran on.
   */
}

/**
 * The half of a turn's search hook the CLI is launched with: the command
 * it runs, and what that command reads to find EO (EO-379).
 */
export type CodexSearchHookDelivery = Pick<CodexSearchHook, "command" | "env"> & {
  /** What marks this one hook as reviewed, so the CLI runs it and no other it has not been told to. */
  trust: CodexHookTrust;
};

/**
 * Says so when an attached skill did not reach the worktree (EO-207).
 *
 * Two ways that happens, and both are reported the same way because
 * they cost the same thing: the checkout already had a folder under
 * that slug and EO will not write over what it finds, or the write
 * failed outright — a read-only tree, a file where the directory goes.
 *
 * Loud for the reason the missing MCP bridge below is loud, and for the
 * reason this whole story exists: the agent runs, the skill is attached
 * and is listed on the screen as attached, and without this nothing
 * about the turn would say that one of them is not there. A silent
 * filesystem error would put back exactly the failure EO-207 was written
 * to remove.
 */
function warnAboutUndeliveredSkills(delivery: WorktreeSkillDelivery, cwd: string): void {
  if (delivery.undelivered.length === 0) return;
  const named = delivery.undelivered.map((skill) => `  - "${skill.slug}": ${skill.reason}`).join("\n");
  console.warn(
    `[codex] ${delivery.undelivered.length} attached skill(s) did not reach ${cwd} and this turn runs without them:\n${named}`,
  );
}

/** The name this provider records in `runs.provider`, and answers to in `agents.provider`. */
const PROVIDER = "codex";

/**
 * What the CLI says when the thread it was handed is not on this machine
 * (EO-93).
 *
 * Three phrasings because the CLI has three: `no rollout found for
 * thread id` when `thread/resume` cannot find the transcript on disk,
 * `session not found` from the server side of the same question,
 * and — from 0.155.1 — `rollout at <path> is empty` when the transcript
 * is there but holds nothing (EO-369). The last is what a first turn cut
 * off before Codex wrote anything leaves behind: the thread id was
 * recorded, the file was created, and every resume of it is refused
 * with "failed to read session metadata … rollout at … is empty". All
 * three mean the conversation EO stored a pointer to cannot be carried
 * on, and a fresh thread is the only way forward.
 *
 * Re-checked at 0.161.0 (EO-370) by resuming a real thread after its
 * rollout had been emptied. The wording is unchanged —
 * "thread/resume failed: failed to read thread: thread-store internal
 * error: failed to read session metadata <path>: … rollout at <path> is
 * empty (code -32603)" — and `resume()` raised `ThreadNotFoundError`.
 *
 * Re-checked at 0.163.0 (EO-453), over `codex app-server`, by resuming
 * two real threads through `createCodexProvider`: one whose rollout had
 * been emptied and one whose rollout had been deleted. Both sentences
 * are word for word the ones quoted here — "… rollout at <path> is
 * empty (code -32603)" and "no rollout found for thread id <id> (code
 * -32600)" — and both resumes raised `ThreadNotFoundError`, so the regex
 * is unchanged.
 *
 * Re-checked at 0.166.0 (EO-644) the same way, beside 0.165.0, and
 * with the same result at both: the missing one word for word, the
 * emptied one prefixed "failed to read thread: thread-store internal
 * error: …" at both pins (the "…" below), the clause the regex reads
 * unchanged.
 *
 * Re-checked at 0.165.0 (EO-599) the same way, and with the same result:
 * both sentences word for word, both resumes `ThreadNotFoundError`. The
 * emptied one, in full, names the path twice before the clause the regex
 * reads — "… failed to read session metadata <path>: thread-store
 * internal error: failed to read session metadata <path>: rollout at
 * <path> is empty (code -32603)" — which 0.163.0, asked again beside it,
 * does too.
 *
 * Matching English here is the point — this file is the one that knows
 * which backend produced the sentence, and translating it is what spares
 * the supervisor from knowing (`ThreadNotFoundError`). A wording change
 * upstream is a change to this regex and to nothing else.
 *
 * Re-checked over `codex app-server` at 0.161.0 (EO-372): `thread/resume`
 * answers a missing rollout with "no rollout found for thread id <id>"
 * (code -32600) and an emptied one with the "… rollout at <path> is
 * empty" sentence above (code -32603). `AppServerRequestError` words
 * both as "thread/resume failed: <message> (code <n>)", the form quoted
 * above.
 *
 * `cause` is followed because the sentence can arrive either in an
 * error's own message or wrapped behind another one.
 */
const MISSING_CODEX_SESSION = /no rollout found for thread id|session not found|rollout at .+ is empty/i;

export function isMissingCodexSession(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (MISSING_CODEX_SESSION.test(current.message)) return true;
  }
  return false;
}

/**
 * What the CLI says when the plan's usage window is spent (EO-340).
 *
 * **This is the only place in EO that reads a limit out of English, and
 * it began here because under `codex exec` there was nowhere else to
 * read it from.** Claude's SDK volunteers a `rate_limit_event` carrying a
 * status, a window and a reset, and `providers/claude.ts` copies those
 * three fields across untouched. Codex's `exec` stream carried no
 * equivalent: the only event that could report a refusal was
 * `turn.failed`, and its `error` was `{ message: string }` and nothing
 * else.
 *
 * The app-server carries both halves of what Claude's event does, and
 * EO reads them (EO-373): `account/rateLimits/updated` is a reading of
 * every window as the run goes (`codexRateLimitReadings`), and a failed
 * turn says `codexErrorInfo: "usageLimitExceeded"` outright
 * (`codexErrorRefusal`). The sentence is still read first, because it is
 * the one place the CLI names the window it refused on and the time it
 * comes back; the classification is what catches a refusal worded in a
 * way these patterns have not seen.
 *
 * Two other sources were weighed and rejected. The rollout transcript
 * under `$CODEX_HOME/sessions` does record that snapshot, but it is the
 * CLI's private on-disk format, EO has no supported way to ask which
 * file the turn in front of it is writing, and a limit notice that
 * depends on a layout no version promises to keep would fail silently
 * the day it moved. The process exit code says a turn failed and never
 * which way.
 *
 * So: the backend's own sentence, matched narrowly. These patterns are
 * anchored on the fixed part of the CLI's wording and on nothing looser
 * — "rate limited", "429", "quota", "too many requests" are all
 * deliberately absent, because a pattern wide enough to catch those is
 * wide enough to park a run that plainly failed, and a run parked as
 * awaiting a window that was never full waits for a person who has
 * nothing to do. `isMissingCodexSession` above reads English for the
 * same reason and on the same terms: this file is the one that knows
 * which backend produced the sentence, so translating it is what spares
 * the supervisor from knowing, and a wording change upstream is a change
 * to these three constants and to nothing else.
 */
const CODEX_USAGE_LIMIT = /you(?:'|\u2019)ve (?:hit|reached) your usage limit|usage limit reached/i;

/**
 * The allowance the CLI names, when it names one: "You've hit your usage
 * limit for <x>. Switch to another model now, or try again at …".
 *
 * Passed on as the window unmapped, for the reason `quota.ts` gives for
 * keeping Claude's `seven_day_opus` as itself — a name EO has never
 * heard of must still reach the item as itself. Bounded in length
 * because this is a sentence fragment rather than a field: an upstream
 * rewording that puts half a paragraph after "for" should fall back to
 * the unnamed phrasing rather than paste itself into the item.
 */
const CODEX_LIMIT_WINDOW = /usage limit for ([^.,]+)/i;
const LONGEST_WINDOW_NAME = 40;

/**
 * When the CLI says the window comes back: "… or try again at Sep 22,
 * 2026 3:00 PM".
 *
 * A local wall-clock time with no zone on it, written by a process on
 * this machine, so reading it in this process's zone is reading it in
 * the zone it was written in. Nothing here decides whether the result is
 * believable: `quotaResetAt` already refuses an instant that does not
 * land near now, which is exactly the check that catches a fragment this
 * parse read as a date and should not have.
 */
const CODEX_LIMIT_RESET = /try again at ([^.]+)/i;

/**
 * A `turn.failed` message read as a refusal, or null when it is an
 * ordinary failure (EO-340).
 *
 * Null is the common case and deliberately so. Everything downstream of
 * a refusal — the run parked rather than failed, the attempt budget left
 * unspent, the option to carry on — is EO-172's machinery, which was
 * written backend-neutral and needed only this event to reach it.
 */
export function codexUsageLimitRefusal(message: string): QuotaEvent | null {
  if (!CODEX_USAGE_LIMIT.test(message)) return null;
  const named = CODEX_LIMIT_WINDOW.exec(message)?.[1]?.trim() ?? "";
  const stamp = CODEX_LIMIT_RESET.exec(message)?.[1]?.trim();
  const resetsAt = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return {
    type: "quota",
    provider: PROVIDER,
    window: named !== "" && named.length <= LONGEST_WINDOW_NAME ? named : "unknown",
    // No share, and no stand-in for one. Codex says nothing about how
    // much of the window was used, and `quotaStopReason` leaves the
    // "(100% used)" clause out when it is absent rather than asserting a
    // figure the backend never gave.
    status: "rejected",
    // Absent rather than undefined when unreadable, so the comment says
    // "the backend did not say" in the words `describeQuotaReset`
    // already uses for a Claude reading that arrives without one.
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
  };
}

/**
 * A failed turn's own classification read as a refusal, or null (EO-373).
 *
 * The app-server marks a turn refused for the plan's allowance with
 * `codexErrorInfo: "usageLimitExceeded"`. Only that one: `rateLimitExceeded`
 * is the short-term request rate a retry a minute later gets past, which
 * is exactly what the English patterns above refuse to match for the
 * same reason. Which window refused is not in the classification —
 * `codexRateLimitReadings` says that, from the reading at 100% — so this
 * names none.
 */
export function codexErrorRefusal(info: unknown): QuotaEvent | null {
  if (info !== "usageLimitExceeded") return null;
  return { type: "quota", provider: PROVIDER, window: "unknown", status: "rejected" };
}

/**
 * A window's name, from its length (EO-373).
 *
 * The app-server does not name its windows; it says how long each one
 * is. `primary` was 300 minutes and `secondary` 10080 on a Plus account
 * at 0.161.0, and still were at 0.163.0 (EO-453), 0.165.0 (EO-599) and
 * 0.166.0 (EO-644, `account/rateLimits/read`), so these read `5_hour`
 * and `7_day` — Claude's `five_hour`
 * and `seven_day` in other words, and phrased the same way on the item
 * ("its 5-hour usage window"). A length nobody has seen still names
 * itself rather than being rounded into a familiar one, and a window
 * with no length is named by its slot.
 *
 * A limit other than the plan's own — `limitId` is `codex` for that one —
 * carries its name in front, so that two limits with a five-hour window
 * are two allowances and not one, and a refusal from one is never taken
 * back by a reading from the other (`createQuotaRefusals` keys on the
 * window).
 */
function codexWindowName(snapshot: RateLimitSnapshot, window: RateLimitWindow, slot: "primary" | "secondary"): string {
  const minutes = window.windowDurationMins;
  const length =
    minutes === null || minutes <= 0
      ? slot
      : minutes % 1440 === 0
        ? `${minutes / 1440}_day`
        : minutes % 60 === 0
          ? `${minutes / 60}_hour`
          : `${minutes}_minute`;
  const limit = snapshot.limitId !== null && snapshot.limitId !== "codex" ? (snapshot.limitName ?? snapshot.limitId) : null;
  return limit ? `${limit}_${length}` : length;
}

/**
 * One `account/rateLimits/updated` reading as EO's `quota` events, one
 * per window it carries (EO-373) — the same events Claude's
 * `rate_limit_event` becomes, recorded the same way.
 *
 * - **utilization** is `usedPercent`, already on `QuotaEvent`'s 0–100
 *   scale;
 * - **resetsAt** is passed on as given, Unix seconds — `quotaResetAt`
 *   reads seconds and milliseconds alike;
 * - **status** is the one field the app-server does not send, and is
 *   derived from the share and nothing else: a window at 100% is
 *   `rejected`, because the next request on it is refused, and any other
 *   is `allowed`. There is no `allowed_warning`: Claude's backend decides
 *   when to warn, this one does not say, and a threshold invented here
 *   would be EO's opinion recorded as the backend's.
 *
 * The `allowed` readings are the half that matters as much as the
 * refusals — a window that has come back is what takes an outstanding
 * refusal away (`createQuotaRefusals`), which is why every window is
 * passed on and not only a full one.
 */
export function codexRateLimitReadings(snapshot: RateLimitSnapshot): QuotaEvent[] {
  const readings: QuotaEvent[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const window = snapshot[slot];
    if (!window) continue;
    readings.push({
      type: "quota",
      provider: PROVIDER,
      window: codexWindowName(snapshot, window, slot),
      utilization: window.usedPercent,
      status: window.usedPercent >= 100 ? "rejected" : "allowed",
      ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }),
    });
  }
  return readings;
}

/**
 * The MCP startup report as the `server_status` Claude's init message
 * becomes (EO-373), which is what the supervisor judges an attached
 * server against (EO-107).
 *
 * One word is translated: Codex's `ready` is the `connected` the
 * supervisor reads as "came up", because it means exactly that and a
 * second word for success would be a second thing the supervisor has to
 * know about a backend. Every other word — `failed`, `cancelled`, a
 * server still `starting` when the turn ended, one EO has never heard of
 * — goes through as Codex said it, which is what a person reading the
 * note needs to act on.
 */
export function codexServerStatus(servers: readonly McpServerStartup[]): ServerStatusEvent {
  return { type: "server_status", servers: servers.map((server) => ({ name: server.name, status: server.status === "ready" ? "connected" : server.status })) };
}

/**
 * A turn's tokens as EO's `usage` event: one turn's own cost, not a
 * running total — the run's figure is the sum of them.
 *
 * Priced at the model the turn ran on, from the table EO ships
 * (EO-374). A model the table does not hold — or a turn whose model the
 * app-server never named — is not priced at zero: the event says it is
 * `unpriced`, and the supervisor tells the item the budgets cannot
 * count the run.
 */
function usageEvent(usage: Usage, model: string | undefined): UsageEvent {
  const price = model === undefined ? null : codexModelPrice(model);
  // In whole cents, and unrounded (EO-510) — which is what a side call
  // records: one on the small model costs a fraction of a cent.
  const cost = price ? { costCents: codexTurnCostCents(usage, price), costMicrocents: codexTurnCostMicrocents(usage, price) } : undefined;
  return {
    type: "usage",
    // One turn's own cost, not a running total: Codex reports this as
    // each turn completes, so the run's figure is the sum of them. That
    // sum is also the clearest statement of what a dispatch prompt
    // really costs — a 16k prompt on a fourteen-turn review is 16k sent
    // fourteen times.
    scope: "turn",
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    // Codex counts cached input inside `input_tokens` and names the
    // cached share separately, which is the opposite of the Anthropic
    // API's three-counter split. Both arrive here as "total, and how
    // much of it was cached".
    cacheReadTokens: usage.cached_input_tokens,
    // Recorded as the backend reports it, and deliberately not folded
    // into `tokensIn`. The SDK documented all three fields identically
    // ("used during the turn") and stated no containment for this one
    // either way. If it turns out to sit *beside* `input_tokens` rather
    // than inside it, Codex runs undercount by this much and the fix
    // belongs here.
    cacheWriteTokens: usage.cache_write_input_tokens,
    turns: 1,
    // The model the turn ended on, a reroute included (EO-392): the
    // client names the one `model/rerouted` moved the turn to.
    ...(model === undefined ? {} : { model }),
    ...(cost ?? { unpriced: { model: model ?? null } }),
  };
}

function threadOptionsFrom(
  opts: { cwd?: string; model?: string; reasoningEffort?: string; showReasoning?: boolean },
  config: CodexAgentConfig | undefined,
): CodexThreadOptions {
  const model = opts.model ?? config?.model;
  const reasoningEffort = opts.reasoningEffort ?? config?.reasoningEffort;
  return {
    ...(opts.cwd ? { workingDirectory: opts.cwd } : {}), // the G-01 worktree
    // Claude's `thinking.display`, in Codex's words: a conversation that
    // shows reasoning asks for summaries, one that hides it asks for
    // none, and a turn that says nothing leaves the CLI's default.
    ...(opts.showReasoning === undefined ? {} : { reasoningSummary: opts.showReasoning ? ("auto" as const) : ("none" as const) }),
    ...(model ? { model } : {}),
    ...(reasoningEffort
      ? { modelReasoningEffort: reasoningEffort as ModelReasoningEffort }
      : {}),
    // Pinned, and passed on every thread rather than only when
    // configured (EO-178).
    //
    // **This widens what a Codex agent may do.** EO used to pass neither
    // unless somebody had set them, so a Codex agent inherited the SDK's
    // own defaults — a workspace sandbox and an approval policy written
    // for a person sitting at the keyboard, who is exactly who is not
    // here. An unattended agent asked to approve its own commands does
    // not refuse, it stalls; one held inside a workspace sandbox cannot
    // run the git and check commands an implementer's whole job is.
    //
    // It is the same trade Claude agents have run under since A-04, and
    // the same machinery makes it defensible: G-02 checks independently
    // what the agent claimed, the design's guards cap attempts, wall-clock and
    // spend, and nothing merges unreviewed. Saying it plainly all the
    // same — this is a real change to the surface a Codex run has, not a
    // consistency tidy-up.
    //
    // Literals, with no `config` read: `agents.config` is an open bag,
    // and a guarantee that can be edited out of a row is not one. A
    // stale `"sandboxMode"` left behind reaches here and is ignored.
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    ...(config?.webSearchEnabled !== undefined ? { webSearchEnabled: config.webSearchEnabled } : {}),
  };
}

/**
 * Maps one Codex `ThreadEvent` onto our `AgentEvent` union.
 *
 * Returns an array because a single Codex event can carry several of
 * ours (a file_change item lists multiple paths), or none at all.
 * Anything unrecognised returns null so the caller can report it rather
 * than silently dropping it — an SDK that adds an event type should show
 * up in the logs, not vanish.
 */
export function mapThreadEvent(event: ThreadEvent): { mapped: AgentEvent[]; recognised: boolean } {
  switch (event.type) {
    case "thread.started":
      // With the model the app-server opened the thread on, when it named
      // one (EO-392) — its default, where EO asked for none.
      return { mapped: [{ type: "thread_started", threadId: event.thread_id, ...(event.model ? { model: event.model } : {}) }], recognised: true };

    case "turn.started":
      return { mapped: [], recognised: true }; // no counterpart; a turn boundary isn't an agent event

    case "turn.completed":
      return { mapped: [usageEvent(event.usage, event.model)], recognised: true };

    // Both fatal channels, and both read for a refusal first (EO-340).
    // The error event still goes out unchanged behind it: the refusal is
    // a *reading*, not an outcome, and it is the error that ends the
    // turn. The supervisor is what decides that a turn which ended badly
    // with a refusal standing against it is a run stopped by a limit
    // rather than a run that failed — the same decision, in the same
    // place, as for a Claude run.
    //
    // Order matters and is the whole of the wiring: the quota event is
    // yielded before the error, so the refusal is recorded by the time
    // the error is turned into an outcome.
    //
    // The non-fatal `ErrorItem` below is deliberately not read this way.
    // It does not end the turn, so a refusal taken from one would stand
    // against work that went on to finish.
    //
    // A failed turn that reported tokens says so first (EO-373), so what
    // it spent is recorded before the error decides anything. That is
    // the escalation case above all: EO interrupts a turn whose agent has
    // escalated, the turn ends `interrupted`, and the supervisor is still
    // draining for exactly this event.
    case "turn.failed": {
      const refusal = codexUsageLimitRefusal(event.error.message) ?? codexErrorRefusal(event.error.codex_error_info);
      return {
        mapped: [
          ...(event.usage ? [usageEvent(event.usage, event.model)] : []),
          ...(refusal ? [refusal] : []),
          { type: "error", message: event.error.message, retryable: true },
        ],
        recognised: true,
      };
    }

    case "error": {
      const refusal = codexUsageLimitRefusal(event.message) ?? codexErrorRefusal(event.codex_error_info);
      return {
        mapped: [...(refusal ? [refusal] : []), { type: "error", message: event.message, retryable: false }],
        recognised: true,
      };
    }

    case "rate_limits.updated":
      return { mapped: codexRateLimitReadings(event.rate_limits), recognised: true };

    case "mcp_servers.started":
      return { mapped: [codexServerStatus(event.servers)], recognised: true };

    case "item.started":
      // A tool call begun: not reported — it has no outcome yet — but the
      // inactivity guard is told it is running, because nothing else will
      // say so until it ends (`HeartbeatEvent.call`).
      return { mapped: TOOL_ITEMS.has(event.item.type) ? [{ type: "heartbeat", callStarted: event.item.id }] : [], recognised: true };
    case "item.updated":
      // Only completed items are reported: an in-progress command has no
      // exit code and a partial patch has applied nothing, so emitting
      // them would put claims in run_events that may never come true.
      return { mapped: [], recognised: true };

    case "item.completed":
      return mapCompletedItem(event.item);

    // The words of an item as they are generated — transient, never
    // stored; `item.completed` is the record (`OutputDeltaEvent`).
    case "item.delta":
      return { mapped: event.text === "" ? [] : [{ type: "output_delta", stream: event.stream, text: event.text }], recognised: true };

    // At work with nothing to show, and trying the model again: the one
    // transient and for the inactivity guard, the other shown (`RetryingEvent`).
    case "heartbeat":
      return { mapped: [{ type: "heartbeat" }], recognised: true };
    // Read by `streamTurn`, which holds the turn to its budget; nothing
    // is recorded until the turn's own usage at its end.
    case "turn.usage":
      return { mapped: [], recognised: true };
    case "retrying":
      return { mapped: [{ type: "retrying", reason: event.message }], recognised: true };
    case "compacted":
      // With no trigger: the app-server does not say why it compacted.
      return { mapped: [{ type: "compacted" }], recognised: true };

    default:
      return { mapped: [], recognised: false };
  }
}

/**
 * The items whose start the inactivity guard is told: a tool at work,
 * which nothing reports until it ends — and whose completion reports a
 * `tool_result` under the item's id, which is what ends it again.
 */
const TOOL_ITEMS = new Set<ThreadItem["type"]>(["command_execution", "mcp_tool_call"]);

/** How long a turn stopped at its budget is read for while the interrupt lands. */
const BUDGET_WIND_DOWN_MS = 5_000;

/**
 * The last usage a turn reported while it was being stopped, read until
 * the turn ends or `BUDGET_WIND_DOWN_MS` has passed — whichever is first.
 */
async function lastReadingWhileStopping(
  iterator: AsyncIterator<ThreadEvent>,
  usage: Usage,
  model: string | undefined,
): Promise<{ usage: Usage; model: string | undefined }> {
  let latest = { usage, model };
  const deadline = Date.now() + BUDGET_WIND_DOWN_MS;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return latest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = await Promise.race([
      iterator.next(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), left);
      }),
    ]);
    clearTimeout(timer);
    if (step === null || step.done) return latest;
    const event = step.value;
    if (event.type === "turn.usage") latest = { usage: event.usage, model: event.model ?? latest.model };
    else if (event.type === "turn.completed" || event.type === "turn.failed") {
      if (event.usage) latest = { usage: event.usage, model: event.model ?? latest.model };
      return latest;
    }
  }
}

function mapCompletedItem(item: ThreadItem): { mapped: AgentEvent[]; recognised: boolean } {
  switch (item.type) {
    case "agent_message":
      // Carries the final answer — and, when an outputSchema was given,
      // the JSON the engine is waiting for. Parsing is the caller's job
      // (it knows whether it asked for a schema).
      return { mapped: [{ type: "output", text: item.text }], recognised: true };

    // Its own event since the chat learned to fold reasoning under
    // "Thought" (`ReasoningEvent`). It was an `output`, which is how a
    // summary could be drawn as narration, or read as a candidate answer.
    case "reasoning":
      return { mapped: item.text.trim() === "" ? [] : [{ type: "reasoning", text: item.text }], recognised: true };

    case "command_execution":
      // Two events for one item, which is how this backend comes to mean
      // the same as the other (EO-169). The call describes what was
      // asked; the exit code, the status and the output describe what
      // came back, and they used to sit in `args` beside the command as
      // though they were part of the asking. Claude cannot record them
      // that way — it sends the answer in a separate message — so
      // recording them as a result here is what makes a measurement
      // taken across the two backends a measurement of one thing.
      //
      // The output is bounded on its way through `toolResultEvent`,
      // where it was not bounded at all before: this branch was already
      // putting a whole `pnpm test` transcript in an append-only table.
      return {
        mapped: [
          { type: "tool_call", name: "command_execution", callId: item.id, args: { command: item.command } },
          toolResultEvent({
            name: "command_execution",
            callId: item.id,
            // Both halves, because they disagree usefully: a command
            // killed by the sandbox is `failed` with no exit code, and a
            // command that ran and returned 1 is `completed`.
            ok: item.status === "completed" && item.exit_code === 0,
            status: item.status,
            ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
            output: item.aggregated_output,
          }),
        ],
        recognised: true,
      };

    case "file_change":
      return { mapped: item.changes.map((change) => ({ type: "file_edit", path: change.path })), recognised: true };

    case "mcp_tool_call": {
      // A call to *our* server is reported under the bare tool name, the
      // name the transcript shows it by. It is recorded and nothing more:
      // what a write tool did reached EO over the agent write bridge as
      // the call was made (EO-543, ARCHITECTURE.md §13.1). Anything from
      // a third-party MCP server keeps its qualified name.
      const name = item.server === EO_MCP_SERVER ? item.tool : `${item.server}/${item.tool}`;
      // The server's answer, which this branch used to see and drop
      // (EO-169). This is the case the story was written about: a
      // repository intelligence query is an MCP tool call, and what it
      // returned was only ever establishable by running it again
      // afterwards and hoping the index had not moved on.
      const failure = item.error?.message;
      const content = toolResultText(item.result?.content);
      // A tool that answers in structured content only — permitted by
      // the protocol, and silence in the log if this fell through to the
      // empty string.
      const structured = item.result?.structured_content;
      const output = failure ?? (content === "" && structured !== undefined && structured !== null ? JSON.stringify(structured) : content);
      return {
        mapped: [
          { type: "tool_call", name, callId: item.id, args: item.arguments },
          toolResultEvent({ name, callId: item.id, ok: item.status === "completed" && failure === undefined, status: item.status, output }),
        ],
        recognised: true,
      };
    }

    case "web_search":
      return { mapped: [{ type: "tool_call", name: "web_search", args: { query: item.query } }], recognised: true };

    case "todo_list":
      return { mapped: [{ type: "output", text: item.items.map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.text}`).join("\n") }], recognised: true };

    case "error":
      // Non-fatal by the SDK's own definition, and used by the CLI for
      // warnings — the one that surfaced this was about enterprise-managed
      // requirements in the config (EO-369). Under the app-server a
      // warning is a `warning` or `configWarning` notification instead,
      // and `codexClient.ts` translates both into this item, so the rule
      // here is the rule for both (EO-372). Mapped as an error so the
      // run's events carry the words, and marked non-fatal so the
      // supervisor does not cut off a turn the backend is still running.
      return { mapped: [{ type: "error", message: item.message, retryable: true, fatal: false }], recognised: true };

    default:
      return { mapped: [], recognised: false };
  }
}

/**
 * The final `agent_message` of a turn, parsed as the structured result
 * when a schema was requested.
 *
 * Codex returns structured output as JSON *text* in an agent_message
 * rather than as a distinct event, so recognising the result means
 * parsing the last message. A-02 validates whatever comes back; an
 * unparseable message is passed through as a raw string so that
 * validation reports a schema failure the agent can act on, rather than
 * this layer throwing something opaque.
 */
export function parseStructuredResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// `checkCodexAuth` lived here and tested for `~/.codex/auth.json`, which
// described neither the executable EO resolved nor where the credential
// reliably lives. `runtimes/auth.ts` asks the binary now (EO-82).

/**
 * The attached servers this dispatch actually hands to Codex (EO-108).
 *
 * `resolveAgentAttachments` answers with everything an agent points at,
 * archived and disabled included, and says in as many words that what
 * is *delivered* is the provider stories' question. This is EO-108's
 * half of that answer:
 *
 * - **disabled** is the switch a person flips while they work out
 *   whether a server is behaving, so it is off for this dispatch and
 *   for every other;
 * - **archived** is "I am done with this", and the row survives only so
 *   that an attachment made before still resolves to something a screen
 *   can name;
 * - **a name EO has reserved** — `eo`, its own server, and `repo`, the
 *   repository intelligence server a dispatch with an index carries
 *   (EO-151). The catalogue already refuses both at save time, and they
 *   are refused again here because the two checks answer different
 *   questions: one is about what a person may type, this one is about
 *   what may reach the dispatch — a row written before a name was
 *   reserved, or restored from a backup, must still not be able to take
 *   the name an agent's own tools come through.
 *
 * All three are `isDeliverableMcpServer` in `packages/core`, shared with
 * the generated-directory path Claude is delivered through. Two copies
 * of this rule is how one of them came to be missing a name the other
 * refused (EO-151), so there is now one.
 *
 * It is also the set whose declared values are read at spawn: a server
 * this dispatch does not deliver has no business putting a value into
 * the CLI's environment.
 */
function deliveredServers(servers: readonly McpServer[]): McpServer[] {
  return servers.filter(isDeliverableMcpServer);
}

/**
 * The variable a bearer server's token is read from, or null when this
 * is not a server with one (EO-118).
 *
 * Null covers three different things on purpose, because all three mean
 * "there is no name to hand Codex here": a stdio server, which the type
 * gives no authentication at all; a `none` or `header` server, which
 * authenticates by something other than a bearer token; and a `bearer`
 * row whose name is missing. The last is reachable — `mcpServersRepo`
 * answers a bearer row with a null column as an empty name, so that the
 * catalogue screen can show it and the person can fix it — and emitting
 * `bearer_token_env_var=""` for it would put a malformed override on the
 * CLI's command line in place of a field simply left out.
 */
function bearerTokenEnvName(server: McpServer): string | null {
  const config = server.config;
  if (config.transport === "stdio" || config.auth.kind !== "bearer") return null;
  const name = config.auth.tokenEnvName.trim();
  return name === "" ? null : name;
}

/**
 * `${NAME}`, or `${NAME:-fallback}`: a reference to a variable inside a
 * header a person typed.
 *
 * The spelling the Claude CLI expands when it reads a generated
 * `.mcp.json` (`agentAttachments/pluginDirectory.ts`), so a header
 * written once in the catalogue means the same thing on either backend.
 */
const ENV_REFERENCE = /\$\{([^}]+)\}/g;
/** The same, unanchored to any position — a global expression's `test` carries `lastIndex` between calls. */
const HAS_ENV_REFERENCE = /\$\{[^}]+\}/;

/**
 * A header's value with its `${…}` references filled in from `source`,
 * the way the Claude CLI fills them in (EO-377).
 *
 * The same three answers it gives, so a header behaves alike whichever
 * backend sends it: a variable that is set — even to nothing — is its
 * value; one that is not falls back to what follows `:-`; and one with
 * neither is left as the characters that were typed, which is what the
 * server then receives and rejects. Nothing here invents an empty
 * credential where the person's own configuration would not.
 */
function expandEnvReferences(text: string, source: Readonly<Record<string, string>>): string {
  return text.replace(ENV_REFERENCE, (reference, body: string) => {
    const split = body.indexOf(":-");
    const name = split === -1 ? body : body.slice(0, split);
    const value = source[name];
    if (value !== undefined) return value;
    return split === -1 ? reference : body.slice(split + 2);
  });
}

/**
 * The prefix of the variables EO makes for an expanded header (EO-377).
 *
 * Numbered rather than named after the server and the header, because a
 * server's name and a header's name can both hold characters a variable
 * name cannot, and two different pairs would fold onto one name. The
 * number is only ever read back by the entry written beside it, in the
 * same `buildCodexOptions` call.
 */
const HEADER_VARIABLE_PREFIX = "EO_MCP_HEADER_";

/** The variables made for expanded headers, and how the next one is named. */
interface HeaderVariables {
  values: Record<string, string>;
  /** A name nothing else in the CLI's environment is using, for one header. */
  allocate(): string;
}

/**
 * Names for expanded headers that cannot land on a variable somebody
 * else meant (EO-377).
 *
 * The CLI's environment is flat, so a generated name is one more name in
 * it, and a person may declare any name at all — `EO_MCP_HEADER_1`
 * included. A stdio server declaring that name would otherwise be handed
 * an expanded header in place of its own secret, because `env_vars`
 * copies whatever the variable holds. So the numbering skips every name
 * already `taken`: what the CLI inherits, what any delivered server
 * declares (whether or not EO holds a value for it — the person's own
 * environment may), and the administrative bearer's.
 */
function headerVariables(taken: ReadonlySet<string>): HeaderVariables {
  const values: Record<string, string> = {};
  let next = 1;
  return {
    values,
    allocate: () => {
      let name = `${HEADER_VARIABLE_PREFIX}${next++}`;
      while (taken.has(name)) name = `${HEADER_VARIABLE_PREFIX}${next++}`;
      return name;
    },
  };
}

/**
 * One catalogue row as Codex's own `mcp_servers` entry, and the values
 * that entry reads out of the CLI's environment.
 *
 * Codex has one remote transport where EO stores two: `http` and `sse`
 * differ in how a client talks over the connection, which is the CLI's
 * business, and not in anything EO holds — so both become a URL and its
 * headers.
 *
 * **No value of any kind belongs in the entry.** Everything under
 * `config` is flattened into `-c key=value` on the app-server's command
 * line (`configArguments` in `codexClient.ts`), where any other process
 * running as this person can read it out of `/proc/<pid>/cmdline` for as
 * long as the run lasts. So every channel below is a *name* on the
 * command line and a value in the environment `codexSpawnEnvironment`
 * builds, which no other process can read:
 *
 * - **A stdio server lists its declared names under `env_vars` (EO-377).**
 *   Codex spawns a stdio child into a fixed environment of its own —
 *   HOME, LANG, LOGNAME, PATH, SHELL, TZ, USER — and copies in exactly
 *   the names this lists, from the CLI's environment, which is where the
 *   values were put. It is the counterpart of the `${NAME}` the Claude
 *   delivery writes into a stdio server's `env`, and it reverses EO-108's
 *   decision not to use this channel. Every declared name is listed,
 *   including one EO holds no value for: Codex skips a name that is not
 *   set, and one the person set in their own environment arrives, as it
 *   does on the other backend.
 * - **A bearer server names the variable its token is in (EO-118).**
 *   `bearer_token_env_var` is read by the CLI for a connection it opens
 *   itself. Never `bearer_token`, the field beside it, which takes the
 *   secret itself.
 * - **A header that refers to a variable is sent through
 *   `env_http_headers` (EO-377).** Codex takes that header's *whole*
 *   value from the variable it names, and does not expand `${…}` itself,
 *   so `Authorization: Bearer ${LINEAR_TOKEN}` is expanded here into a
 *   variable of EO's own (`EO_MCP_HEADER_<n>`) and that variable is what
 *   the entry names. A header with no reference in it holds nothing
 *   secret by the catalogue's own rule (`McpServerDraftSchema`'s
 *   `headers`) and travels as typed, under `http_headers`.
 *
 * `source` is the CLI's environment as it will be — what it inherits,
 * with the declared values over it — which is the environment the Claude
 * CLI expands the same header from. `headers` names and collects the
 * variables made here, across every server of one call.
 */
function codexServerEntry(server: McpServer, source: Readonly<Record<string, string>>, headers: HeaderVariables): Record<string, unknown> {
  const config = server.config;
  if (config.transport === "stdio") {
    return {
      command: config.command,
      args: config.args,
      // Names, never values: this key is flattened onto the command line.
      ...(server.envNames.length > 0 ? { env_vars: [...server.envNames] } : {}),
    };
  }
  const tokenEnvName = bearerTokenEnvName(server);
  const typed: Record<string, string> = {};
  const fromEnvironment: Record<string, string> = {};
  for (const [header, value] of Object.entries(config.headers)) {
    if (!HAS_ENV_REFERENCE.test(value)) {
      typed[header] = value;
      continue;
    }
    const variable = headers.allocate();
    // Set even when it expands to nothing; an empty variable is a header
    // Codex leaves out, which is what an empty credential deserves.
    headers.values[variable] = expandEnvReferences(value, source);
    fromEnvironment[header] = variable;
  }
  return {
    url: config.url,
    // A name, and only ever a name — see the note above about the field
    // next to this one in the binary.
    ...(tokenEnvName !== null ? { bearer_token_env_var: tokenEnvName } : {}),
    // Each omitted rather than sent empty: an empty object flattens to
    // `http_headers={}`, which is one more argument saying nothing.
    ...(Object.keys(typed).length > 0 ? { http_headers: typed } : {}),
    ...(Object.keys(fromEnvironment).length > 0 ? { env_http_headers: fromEnvironment } : {}),
  };
}

/**
 * EO's own administrative server as a Codex `mcp_servers` entry (EO-203).
 *
 * The whole of what this backend was missing. EO-182 built the server and
 * EO-185 wrote the grant that turns it on, and both were delivered
 * through the generated tool directory — a `.mcp.json` and a plugin path,
 * which are the Claude CLI's arrangement and nothing else's. A
 * Codex-backed system agent therefore answered `adminToolsEnabled` yes,
 * had a delivery built for it, and was dispatched without it: granted a
 * surface it could not reach, on the same run in which its prompt told it
 * to call a tool on that surface first.
 *
 * No new mechanism for it, deliberately. This is the shape EO-118 already
 * ships for a remote catalogue row — a URL and the *name* of the variable
 * the bearer is in — because that is exactly what the admin host is: an
 * HTTP server on a loopback port that authenticates a bearer token. So it
 * rides the same field the CLI already reads a token out of its own
 * environment for, and `bearer_token_env_var` keeps the credential off a
 * command line that `/proc/<pid>/cmdline` publishes to everything running
 * as this person.
 *
 * `http_headers` is not written here, which is where this diverges from
 * the Claude spelling. That path expands `Authorization: Bearer ${VAR}`
 * out of the CLI's environment as it reads the file; a header on this
 * path would be flattened into `--config` verbatim, so writing one would
 * mean either putting the token on the command line or sending the CLI a
 * literal `${EO_ADMIN_TOKEN}` for the server to reject.
 */
function codexAdminEntry(admin: AdminMcpDispatch): Record<string, unknown> {
  return { url: admin.server.url, bearer_token_env_var: admin.server.envName };
}

/**
 * The values behind every name the delivered servers declare, read now.
 *
 * Through `serverSecret`, which `engine.ts` builds so that an
 * organisation's value for a name is asked first and wins over this
 * machine's own (EO-328) — and an organisation value that is there but
 * unreadable stops the fallback rather than handing the server the
 * person's value of the same name.
 *
 * A stored value is kept exactly as stored, the empty string included:
 * an organisation that set a name to nothing has set it, and an
 * inherited variable of the same name must not show through (EO-377).
 * A name EO holds nothing for is left out of `values`, so what the CLI
 * inherits for it — the person's own environment — still applies, as it
 * does on the other backend. And a name `serverSecret` withholds is put
 * in `withheld`, which takes it out of the inherited environment too.
 *
 * A name neither the organisation nor the server holds is filled from
 * the run's environment variables (EO-488), which `serverSecret` is
 * handed for that: the fourth layer, asked last — after every server's
 * secrets, so a variable never displaces another server's secret of the
 * same name.
 *
 * Where two servers declare the same name, the later of them wins. That
 * is a consequence of one flat environment, which is all Codex offers:
 * `env_vars` names a variable, it does not scope one to a server.
 */
function declaredValues(
  options: CodexProviderOptions,
  servers: readonly McpServer[],
  variables: Readonly<Record<string, string>>,
): { values: Record<string, string>; withheld: Set<string> } {
  const read = options.serverSecret;
  // A Map, for `agentRunVariables`' reason: a declared `__proto__` would
  // otherwise call a setter rather than make a property.
  const values = new Map<string, string>();
  const withheld = new Set<string>();
  if (!read) return { values: {}, withheld };
  for (const server of servers) {
    for (const name of server.envNames) {
      // No variables on this pass: the secrets alone, as before EO-488.
      const answer = read(server.id, name, {});
      if (answer === null) continue;
      if (typeof answer === "string") {
        values.set(name, answer);
        withheld.delete(name);
      } else {
        values.delete(name);
        withheld.add(name);
      }
    }
  }
  // The variables only once every server's secrets have answered, and
  // only for a name none of them filled or withheld (EO-488). Asked in
  // the same walk, a later server's variable overwrote an earlier
  // server's secret of the same name, because the environment is flat.
  for (const server of servers) {
    for (const name of server.envNames) {
      if (values.has(name) || withheld.has(name)) continue;
      const answer = read(server.id, name, variables);
      if (typeof answer === "string") values.set(name, answer);
    }
  }
  return { values: Object.fromEntries(values), withheld };
}

/** The inherited environment, less every name that must not be filled from it. */
function withoutNames(environment: Record<string, string>, names: ReadonlySet<string>): Record<string, string> {
  if (names.size === 0) return environment;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !names.has(name)));
}

/**
 * `process.env`, without the keys it types as possibly undefined.
 *
 * A spawn's `env` has no such keys, and a key set to undefined is not
 * the same as an absent one once it is spread over something.
 */
function inheritedEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) inherited[key] = value;
  return inherited;
}

/**
 * The environment the Codex CLI is spawned with, or nothing at all.
 *
 * This is where a declared secret is spent, and it is a different route
 * from the one the config takes for one reason: `config` becomes
 * command-line arguments and an environment does not. The pinned
 * decision behind that is not about hiding anything from the agent —
 * the agent can read whatever the person can — but about the other
 * processes on the machine, which can read a command line and cannot
 * read another process's environment.
 *
 * Every value in here is spent by the CLI through a name its config
 * carries (`codexServerEntry`): a stdio server's declared values are
 * copied into the child by `env_vars`, a bearer token is read for the
 * connection by `bearer_token_env_var`, and an expanded header is sent
 * by `env_http_headers` (EO-377, which reversed EO-108's decision to
 * stop at the CLI).
 *
 * **`process.env` is spread, never replaced.** An `env` handed to a
 * spawn *is* the child's environment — Node inherits nothing beside it.
 * An env of one variable would take PATH and HOME away from a CLI that
 * needs both, which is the identical trap `providers/claude.ts`
 * documents for the Claude SDK.
 *
 * Undefined when there is nothing to add and nothing to take away, so
 * the ordinary case leaves the app-server inheriting the environment
 * itself rather than being handed a copy this file took. A `withheld`
 * name is the one thing taken away: an organisation value that could
 * not be read must not be stood in for by a variable of the same name
 * the person's shell happened to export (EO-328, EO-377).
 *
 * The order is the precedence. A declared value wins over an inherited
 * one of the same name — that is the point of a person setting it. A
 * header EO expanded never shares a name with either: `headerVariables`
 * numbers around every name already in use, because the environment is
 * flat and a collision would hand one server another's value. And the
 * bearer for EO's own administrative server (EO-203) is last, so a
 * catalogue entry that declared a variable of the same name cannot
 * displace the credential EO authenticates its own server with — the
 * ordering `engine.ts` applies on the Claude path for the same reason.
 * It arrives already resolved rather than through `serverSecret`,
 * because nobody typed it: it is minted per launch and held in memory.
 *
 * `home` is the agent's own Codex home (EO-378), and is what makes the
 * ordinary case of a locked-down agent an environment rather than
 * nothing: `CODEX_HOME` is set over the inherited environment, PATH and
 * HOME included, never instead of it.
 *
 * `variables` are the run's environment variables (EO-487), already
 * stripped of every name EO always owns
 * (`withoutReservedEnvironmentVariables`). They go over what the CLI
 * inherited and under everything EO sets for the run, so none of them
 * displaces a declared value, a header, the admin bearer, the search
 * hook or `CODEX_HOME`; and a `withheld` name is taken out of them as it
 * is out of the inherited environment, for the same reason.
 */
function codexSpawnEnvironment(
  inherited: Record<string, string>,
  declared: { values: Record<string, string>; withheld: ReadonlySet<string> },
  headers: Record<string, string>,
  admin: Record<string, string>,
  home: string | undefined,
  searchHook: Record<string, string> = {},
  variables: Record<string, string> = {},
): Record<string, string> | undefined {
  // The agent's own home last of all (EO-378): a catalogue entry that
  // declared a variable called `CODEX_HOME` must not be able to point the
  // CLI back at the person's configuration.
  //
  // And where this turn's search hook finds EO (EO-379), after the
  // declared values for the reason the administrative bearer is: a
  // catalogue entry that declared a variable of the same name must not
  // be able to point EO's own hook somewhere else.
  const spawn = { ...declared.values, ...headers, ...admin, ...searchHook, ...(home === undefined ? {} : { CODEX_HOME: home }) };
  if (Object.keys(spawn).length === 0 && Object.keys(variables).length === 0 && declared.withheld.size === 0) return undefined;
  return { ...withoutNames({ ...inherited, ...variables }, declared.withheld), ...spawn };
}

/**
 * Codex's own memories, off, on every turn EO starts (EO-468), so EO's
 * memory is the only one an agent has.
 *
 * Codex can extract memories from finished threads in the background,
 * consolidate them, and read them into later threads, keeping them in
 * its home. Left on, what one run learned would reach the next through a
 * channel EO cannot see, attribute or retire — and on an agent using the
 * person's own setup, the person's own memories would reach it.
 *
 * Read from the pinned CLI (0.165.0, EO-599, and again at 0.166.0 for
 * EO-644), where `codex features list` reports `memories` as stable and
 * **off** by default, as 0.163.0 did.
 * 0.165.0 "enabled memory v2 by default for fresh profiles": a home whose
 * memories are on now gets a second store (`memories_v2/`,
 * `memories_v2_1.sqlite`). Measured with one real turn in an empty home
 * each way: `-c features.memories=true` makes them, and the three
 * switches below — over a `config.toml` that turns memories on — make
 * neither, so they still cover the v2 store. A default is
 * exactly what this must not lean on: a release that turns a stable
 * feature on would turn it on for every EO agent at once. So all three
 * switches are sent, whatever the default is:
 *
 * - `features.memories` — the feature itself. `-c features.memories=true`
 *   was seen to turn it on and `false` off, so the override reaches the
 *   flag.
 * - `memories.generate_memories` and `memories.use_memories` — writing
 *   and reading, under the `[memories]` table the CLI parses as typed
 *   fields (a non-boolean is refused when the configuration loads). The
 *   second line of defence, should a release keep the table and retire
 *   the flag.
 *
 * Sent to an agent on the person's own setup too: on the command line
 * they win over that person's `config.toml`, and the opt-out restores
 * their tools and settings, not a second memory beside EO's. An unknown
 * key is accepted silently by this CLI, so the day one of these is
 * renamed nothing fails here: `codex.test.ts` and `providerParity.test.ts`
 * hold what EO sends, and the binary is what to re-read on a bump.
 */
const CODEX_MEMORY_OFF = {
  features: { memories: false },
  memories: { generate_memories: false, use_memories: false },
} as const;

/** EO's hook as the CLI's configuration spells it — the one shape both the turn and the trust probe are given. */
function searchHookEntries(command: string): Record<string, unknown> {
  return { PreToolUse: [{ matcher: CODEX_SEARCH_TOOL_MATCHER, hooks: [{ type: "command", command, timeout: SEARCH_HOOK_TIMEOUT_SECONDS }] }] };
}

/**
 * How long Codex waits for the hook before running the call without it.
 *
 * Its own default is ten minutes, which is a tool call held for ten
 * minutes by advice. The command gives up by itself well inside this
 * (`codexSearchHookCommand.mjs`); this is the bound for a command that
 * never started.
 */
const SEARCH_HOOK_TIMEOUT_SECONDS = 15;

/**
 * Whether a turn would be given EO's administrative server. Asking mints
 * that turn's bearer (EO-444), so a question that opens no turn lets it
 * go at once.
 */
function hasAdmin(options: CodexProviderOptions): boolean {
  const admin = options.admin?.() ?? null;
  admin?.release();
  return admin !== null;
}

/**
 * What the Codex client is constructed with.
 *
 * Exported so the one thing that must not silently regress can be
 * asserted: the executable EO resolved (A-08) is the one the client
 * spawns. Under the SDK a missing path quietly ran the copy inside its
 * package; now it fails the turn, which is louder, but the assertion is
 * still what says the resolved binary arrives.
 *
 * Called once per Codex client rather than once per provider, which is
 * what makes `serverSecret` a lazy read of the keychain at spawn and not
 * a value the cached provider is holding.
 */
/**
 * The names `buildCodexOptions` registers servers under, and nothing
 * about them (EO-392).
 *
 * For debug mode's record of what a turn was opened with. A function of
 * its own rather than the keys of what `buildCodexOptions` returns,
 * because building those options reads every declared secret out of the
 * keychain and readies the agent's Codex home — and describing a session
 * must do neither. The same four sources in the same order, so a name
 * written over by a later one appears once, as it does there;
 * `providerParity.test.ts` holds the two to each other against the
 * launch itself.
 */
export function codexServerNames(options: CodexProviderOptions, repositoryMcp?: RepositoryMcpServer): string[] {
  return [
    ...new Set([
      ...deliveredServers(options.attachedServers ?? []).map((server) => server.name),
      ...(repositoryMcp ? [repositoryMcp.name] : []),
      ...(options.eoMcp ? [EO_MCP_SERVER] : []),
      ...(hasAdmin(options) ? [ADMIN_MCP_SERVER_NAME] : []),
    ]),
  ];
}

export function buildCodexOptions(
  options: CodexProviderOptions,
  repositoryMcp?: RepositoryMcpServer,
  searchHook?: CodexSearchHookDelivery,
  attachFrom?: AttachmentSource,
  memoryScopes?: readonly MemoryReadScope[],
  environmentVariables?: Readonly<Record<string, string>>,
  writeBridge?: AgentWriteBridgeAddress,
  withheldEnvironmentVariables?: readonly string[],
): Pick<CodexClientOptions, "executablePath" | "config" | "env" | "afterTurn" | "perTurnEnv"> {
  // Asked once per client, and let go of again if the options cannot be
  // built (EO-444): no process will be spawned to let it go after.
  const admin = options.admin?.() ?? null;
  try {
    return codexOptionsWith(options, admin, repositoryMcp, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldEnvironmentVariables);
  } catch (error) {
    admin?.release();
    throw error;
  }
}

function codexOptionsWith(
  options: CodexProviderOptions,
  admin: AdminMcpDispatch | null,
  repositoryMcp?: RepositoryMcpServer,
  searchHook?: CodexSearchHookDelivery,
  attachFrom?: AttachmentSource,
  memoryScopes?: readonly MemoryReadScope[],
  environmentVariables?: Readonly<Record<string, string>>,
  writeBridge?: AgentWriteBridgeAddress,
  withheldEnvironmentVariables?: readonly string[],
): Pick<CodexClientOptions, "executablePath" | "config" | "env" | "afterTurn" | "perTurnEnv"> {
  const attached = deliveredServers(options.attachedServers ?? []);
  const mcpServers: Record<string, unknown> = {};
  // Read once, here, and spent twice: on the stdio servers' `env_vars`
  // through the environment, and on expanding the headers that refer to
  // them (EO-377).
  const inherited = inheritedEnvironment();
  // The run's environment variables (EO-487), less the names EO always
  // owns. One more layer of the CLI's environment, over what it inherits.
  const variables = withoutReservedEnvironmentVariables(environmentVariables ?? {});
  // And the last layer a declared name is filled from (EO-488), which is
  // why they are read before the declared values are.
  // A name a redirected step on a trial withholds (EO-584) is taken out of
  // the same layers an unreadable organisation value is: what the CLI
  // inherits and the run's variables beneath it.
  const read = declaredValues(options, attached, variables);
  const declared =
    withheldEnvironmentVariables === undefined || withheldEnvironmentVariables.length === 0
      ? read
      : { ...read, withheld: new Set([...read.withheld, ...withheldEnvironmentVariables]) };
  // What the CLI's environment will hold, which is what a header expands
  // from — so a withheld name expands from nothing here either.
  const expansionSource = { ...withoutNames({ ...inherited, ...variables }, declared.withheld), ...declared.values };
  // The admin bearer is named before the headers are, because it is one
  // more name in the CLI's environment a generated one must not take.
  const headers = headerVariables(
    new Set([
      ...Object.keys(inherited),
      ...Object.keys(variables),
      ...Object.keys(declared.values),
      ...attached.flatMap((server) => server.envNames),
      ...attached.flatMap((server) => bearerTokenEnvName(server) ?? []),
      ...Object.keys(admin?.environment ?? {}),
      ...Object.keys(searchHook?.env ?? {}),
    ]),
  );
  for (const server of attached) mcpServers[server.name] = codexServerEntry(server, expansionSource, headers);
  // The query server for this dispatch's checkout, when the item has a
  // ready index (EO-151). A second argument rather than a field on
  // `options`, because `options` is what the *agent* is configured with
  // and a cached provider works every item that agent is given — the
  // server is one item's, and it is resolved per turn.
  if (repositoryMcp) mcpServers[repositoryMcp.name] = agentMcpStdioConfig(repositoryMcp);
  // Last, and that is the guarantee rather than a tidiness: whatever
  // `deliveredServers` let through, EO's own service is written over it.
  // The filter there and this ordering are two answers to the same
  // question, because one of them being edited away must not be enough
  // to lose the service every agent talks to EO through.
  //
  // `attachFrom` is the one part of it that is this turn's rather than
  // the agent's (EO-412): which run this is and where it works, which is
  // what lets the service offer `attachment_add`. An argument for the
  // reason `repositoryMcp` is one.
  //
  // And the memory scopes, which are what list `memory_read` (EO-478) —
  // the turn's for the same reason.
  if (options.eoMcp) {
    mcpServers[EO_MCP_SERVER] = eoMcpStdioConfig({
      ...options.eoMcp,
      ...(attachFrom ? { attachFrom } : {}),
      ...(memoryScopes && memoryScopes.length > 0 ? { memoryScopes } : {}),
      // And where it hands what the agent writes (EO-543), the turn's too.
      ...(writeBridge ? { writeBridge } : {}),
    });
  }
  // And EO's own administrative server, for the one agent whose allowlist
  // names it (EO-203). Resolved here rather than at provider construction
  // for the reason the repository server above is: this is per turn, and
  // the listener it points at can be restarted under a cached provider.
  //
  // After the merge for the same reason `eo` is: `ADMIN_MCP_SERVER_NAME`
  // is reserved, so no catalogue row can be saved under it — but a row
  // written before the reservation, or restored from an older database,
  // must lose to EO's own server rather than take its name.
  if (admin) mcpServers[ADMIN_MCP_SERVER_NAME] = codexAdminEntry(admin);

  // No tool-search exemption here, and that is a finding rather than an
  // omission (EO-161).
  //
  // The Claude adapter marks these same two servers `alwaysLoad`, so
  // their tools are in the prompt instead of behind a `ToolSearch`
  // round-trip. Codex was checked for the equivalent and has none, on
  // two independent readings:
  //
  //   - Its per-server configuration has no such key. From the binary EO
  //     downloads (codex 0.161.0), an `mcp_servers` entry accepts
  //     `command, env, cwd, url, http_headers, http_headers_helper,
  //     bearer_token, bearer_token_env_var, environment_id,
  //     startup_timeout_sec, startup_timeout_ms, startup_readiness,
  //     supports_parallel_tool_calls, tool_input_schema_max_bytes,
  //     omit_tools_from, default_tools_approval_mode, enabled_tools,
  //     disabled_tools, scopes, oauth, oauth_resource` — nothing about
  //     loading or deferral. `@openai/codex-sdk` declares no such option
  //     either.
  //
  //     Re-read at EO-342's bump: 0.155.1 added `http_headers_helper`,
  //     `default_tools_approval_mode`, `enabled_tools` and
  //     `disabled_tools` to that list (and renamed `oauth_resources` to
  //     `oauth_resource`). They decide *which* tools a server offers and
  //     how their calls are approved — not whether the ones it offers
  //     are in the prompt or behind a search — so the reading below is
  //     unchanged and there is still no counterpart to `alwaysLoad`.
  //
  //     Re-read at EO-370's bump: 0.161.0 added `startup_readiness`
  //     (its values are `connection` and `catalog`, which are about when
  //     a server counts as started) and `tool_input_schema_max_bytes`.
  //     Neither one is about deferral, and the binary still has no
  //     `always_load` or `alwaysLoad` string anywhere, so the reading
  //     still stands.
  //
  //     Re-measured at EO-453's bump rather than re-read: 0.163.0's
  //     strings no longer list these fields in one run, so each key was
  //     offered to both binaries as `-c mcp_servers.<name>.<key>` under
  //     `--strict-config`, which exits on a field it does not know. 0.161.0
  //     and 0.163.0 answered every key identically. Each key above was
  //     offered except `command`, which the probe server was given, and
  //     `url`, which would have made it an HTTP one; all are known fields
  //     (the HTTP-only ones are refused on a stdio server by name, "is
  //     not supported for stdio"), and `always_load`, `alwaysLoad` and
  //     `defer_loading` are refused by both as "unknown configuration
  //     field". 0.163.0 has
  //     no `always_load` or `alwaysLoad` string either, so the reading
  //     still stands.
  //
  //     Re-measured at EO-599's bump the same way: 0.165.0 answered every
  //     key above exactly as 0.163.0 did, beside it — the stdio ones
  //     accepted, the HTTP-only ones refused by name as "not supported
  //     for stdio", and `always_load`, `alwaysLoad` and `defer_loading`
  //     refused as unknown. The binary still has no `always_load` or
  //     `alwaysLoad` string, so the reading still stands.
  //
  //     And again at EO-644's: 0.166.0 answered every one of those keys
  //     exactly as 0.165.0 did, beside it, and has neither string.
  //   - It does not defer them in the first place. Across 338 Codex runs
  //     in `run_events` there is not one `ToolSearch` call, and EO's own
  //     tools were called 130 times directly — `ticket_detail` 88,
  //     `comment_search` 26, `comment_read` 13, `attachment_read` 3. On
  //     the Claude side the same tools were reached only after 80
  //     `ToolSearch` calls across 70 runs.
  //
  // So the deferral EO-160 found in the prompts is the Claude harness's,
  // and on this backend EO already has what EO-161 went to get. The
  // binary does carry a `tool_search_always_defer_mcp_tools` flag name,
  // which is theirs to turn on and not something EO can set — if it ever
  // fires, this is the comment that says where to look.
  // The agent's own Codex home, unless it was ticked over to the person's
  // own setup (EO-378). Asked here, per client, for the reason the
  // administrative server is: a link in it can go stale between turns.
  const home = options.config?.inheritAmbientConfig === true ? undefined : (options.codexHome?.() ?? undefined);
  const env = codexSpawnEnvironment(inherited, declared, headers.values, admin?.environment ?? {}, home, searchHook?.env, variables);

  // EO's own `PreToolUse` hook, on a turn that has one (EO-379). Inline,
  // as configuration, for the reason the Claude hook is a callback and
  // not a file: `.codex/hooks.json` in the checkout is designed to be
  // committed, and an agent running `git add -A` would land EO's
  // configuration on somebody's default branch. `codexHooks.live.test.ts`
  // is what established that an inline entry fires.
  //
  // Absent — no key at all, not an empty list — on a turn without one.
  //
  // **Trusted alone (EO-379).** Codex runs a hook only once a person has
  // reviewed it, and records that as the hook's hash under
  // `hooks.state.<key>.trusted_hash`. EO's hook is named there, by the
  // key and hash the CLI itself reports for it (`probeHookTrust`), so
  // this one hook runs and nothing else changes: a hook in the person's
  // own Codex home that they have not reviewed stays unrun on an agent
  // using their setup. The thread-wide `bypass_hook_trust` would have run
  // those too, which is why it is not what this sends.
  const hooks = searchHook
    ? { ...searchHookEntries(searchHook.command), state: { [searchHook.trust.key]: { trusted_hash: searchHook.trust.hash } } }
    : undefined;
  const config = {
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    ...(hooks ? { hooks } : {}),
    ...CODEX_MEMORY_OFF,
  };

  return {
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    // Codex launches MCP servers itself, over stdio for a local one and
    // over HTTP for a remote one. Beside them the CLI is told nothing but
    // that its memory is off (EO-468), which leaves it with whatever its
    // home holds otherwise: nothing of the person's for a locked-down
    // agent, their own configuration for one using their setup (EO-378).
    config,
    ...(env ? { env } : {}),
    // The administrative bearer above is this turn's alone (EO-444), and
    // the client is what knows when the app-server it was spawned into
    // has gone: the CLI sends no DELETE on its way out, so letting the
    // bearer go is what closes the session it opened on EO's host.
    ...(admin ? { afterTurn: admin.release } : {}),
    // And differs from the bearer a warm process was spawned with by
    // design, so a warm-up matches its turn on the name alone.
    ...(admin ? { perTurnEnv: Object.keys(admin.environment) } : {}),
  };
}

/**
 * Everything one turn's `CodexClient` is constructed with: what
 * `buildCodexOptions` launches the app-server with, and where a
 * notification nothing translates is reported.
 *
 * The provider's own construction, named so that a test which swaps only
 * the spawn underneath it still exercises everything else.
 */
export function codexClientOptions(
  options: CodexProviderOptions,
  repositoryMcp?: RepositoryMcpServer,
  searchHook?: CodexSearchHookDelivery,
  attachFrom?: AttachmentSource,
  memoryScopes?: readonly MemoryReadScope[],
  environmentVariables?: Readonly<Record<string, string>>,
  writeBridge?: AgentWriteBridgeAddress,
  withheldEnvironmentVariables?: readonly string[],
): CodexClientOptions {
  return {
    ...buildCodexOptions(options, repositoryMcp, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldEnvironmentVariables),
    ...(options.onUnmappedEvent ? { onUnmappedNotification: options.onUnmappedEvent } : {}),
  };
}

/**
 * What a side call's app-server is launched with (EO-477): the binary,
 * the agent-free lockdown — its own Codex home, memories off — and
 * nothing else. No `mcp_servers` at all, not EO's own: a side call has
 * no tools to call and nobody to report to.
 *
 * Built by handing `buildCodexOptions` only the two fields a side call
 * keeps, so the home and the environment are made exactly as a locked
 * -down agent's are, and an attached server, an admin grant or a search
 * hook on the provider cannot reach the launch.
 */
export function codexSideCallClientOptions(options: CodexProviderOptions, catalogPath: string): CodexClientOptions {
  const bare: CodexProviderOptions = {
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
  };
  const built = buildCodexOptions(bare);
  // And its tools and skills off, which no agent's turn is
  // (`codexSideCallLockdown.ts` says how that was found): the feature
  // switches merged beside memories' own, the skills table, and the
  // one-model catalogue with the tool-bearing keys taken out.
  const config = built.config ?? {};
  const features = (config["features"] as Record<string, unknown> | undefined) ?? {};
  return {
    ...built,
    config: {
      ...config,
      features: { ...features, ...CODEX_SIDE_CALL_SWITCHES.features },
      skills: CODEX_SIDE_CALL_SWITCHES.skills,
      model_catalog_json: catalogPath,
    },
    ...(options.onUnmappedEvent ? { onUnmappedNotification: options.onUnmappedEvent } : {}),
  };
}

/**
 * The thread a side call opens (EO-477): ephemeral, so nothing is kept to
 * resume; on the model and reasoning effort it was given (EO-578); in the
 * empty directory it was given; read-only, where a turn
 * is `danger-full-access`, because a side call has no work to write; no
 * approvals to wait on; web search off; and the question's own system
 * prompt in place of the CLI's.
 */
export function codexSideCallThreadOptions(opts: AgentSideCallOptions): CodexThreadOptions {
  return {
    workingDirectory: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    // `effort` on `turn/start`, as a turn's is (EO-578): consolidation's,
    // from the system agent; selection and extraction set none.
    ...(opts.reasoningEffort ? { modelReasoningEffort: opts.reasoningEffort as ModelReasoningEffort } : {}),
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchEnabled: false,
    baseInstructions: opts.system,
    ephemeral: true,
  };
}

/**
 * OpenAI Structured Outputs accepts only its strict JSON Schema subset:
 * every object rejects unknown keys and declares every property required,
 * and union branches use `anyOf` rather than JSON Schema's `oneOf`.
 * Keep that provider constraint here rather than weakening the shared Zod
 * schemas, where omitted fields still intentionally receive defaults.
 *
 * "Every property required" is about the key, not the value, and on its
 * own it would make a Codex agent invent something for every field a
 * Claude agent may simply leave out — a `parent` matching `-\d+$` on a
 * bug that has none (EO-376). So a property the shared schema does not
 * require is listed like the rest but also accepts `null`, and
 * `fromStrictCodexAnswer` takes those nulls back out of the answer before
 * EO validates it. A property the shared schema requires gains nothing:
 * it still cannot be null unless it could be already.
 *
 * "Every object lists its properties" leaves no way to write a map — a
 * `z.record`, which arrives as an object with `propertyNames` and a
 * schema under `additionalProperties`. The first keyword is refused
 * outright (`invalid_json_schema`, on every turn of the action that
 * carries it), and forcing the second to `false` would leave an object
 * nothing can be put in (EO-387). So a map is sent as what the subset
 * can say: a list of `{ name, value }` entries, one per key.
 * `fromStrictCodexAnswer` folds the list back into the map before EO
 * validates the answer, so the shared schema and everything downstream
 * of it see the same document a Claude agent writes directly.
 */
export function strictCodexOutputSchema(schema: JsonSchema): JsonSchema {
  return normalizeSchemaNode(schema) as JsonSchema;
}

/** The two keys of one entry of a map written as a list (EO-387). */
const MAP_ENTRY_NAME = "name";
const MAP_ENTRY_VALUE = "value";

/** Keywords whose value is a table of schemas by name, so its keys are names and not keywords. */
const SCHEMA_TABLES = new Set(["properties", "$defs", "definitions"]);

/** Keywords whose value is data rather than a schema, and is passed through as written. */
const SCHEMA_DATA = new Set(["const", "enum", "required"]);

/**
 * Whether a node describes a map: an object with no properties of its
 * own, whose keys are whatever the answer chooses and whose values are
 * held to `additionalProperties`.
 *
 * An object that names its properties *and* allows others is not one —
 * it has a fixed part the strict subset can still express, and that part
 * is what it is sent as.
 */
function isMapSchema(node: Record<string, unknown>): boolean {
  if (node["type"] !== "object") return false;
  const properties = node["properties"];
  if (isSchemaObject(properties) && Object.keys(properties).length > 0) return false;
  const values = node["additionalProperties"];
  return values === true || isSchemaObject(values);
}

/** A map, as the list of entries the strict subset can express. */
function mapAsEntries(source: Record<string, unknown>): Record<string, unknown> {
  const names = source["propertyNames"];
  const values = source["additionalProperties"];
  const said = typeof source["description"] === "string" ? `${source["description"]} ` : "";
  return {
    type: "array",
    ...(typeof source["title"] === "string" ? { title: source["title"] } : {}),
    description: `${said}A map, written as a list of its entries: one entry per key, with \`${MAP_ENTRY_NAME}\` the key and \`${MAP_ENTRY_VALUE}\` what it maps to. No key twice.`,
    items: {
      type: "object",
      properties: {
        [MAP_ENTRY_NAME]: isSchemaObject(names) ? normalizeSchemaNode(names) : { type: "string" },
        [MAP_ENTRY_VALUE]: isSchemaObject(values) ? normalizeSchemaNode(values) : {},
      },
      required: [MAP_ENTRY_NAME, MAP_ENTRY_VALUE],
      additionalProperties: false,
    },
  };
}

function normalizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchemaNode);
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  if (isMapSchema(source)) return mapAsEntries(source);
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    // Neither contributes to constrained generation. `default` is a Zod
    // parsing concern; the strict schema requires the model to emit the key.
    if (key === "$schema" || key === "default") continue;
    // Refused by name, and only ever a constraint on a map's keys — which
    // `mapAsEntries` has already carried onto the entry's `name`.
    if (key === "propertyNames") continue;
    if (SCHEMA_DATA.has(key)) {
      normalized[key] = child;
      continue;
    }
    // The keys of these are names somebody chose, not keywords: a
    // property called `default` — a module input's — is a property, and
    // dropping it as the keyword took the field away from a Codex agent
    // without a word (EO-387).
    if (SCHEMA_TABLES.has(key) && isSchemaObject(child)) {
      normalized[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, normalizeSchemaNode(schema)]));
      continue;
    }
    // Zod emits discriminated unions as `oneOf`. OpenAI's supported
    // Structured Outputs subset permits nested `anyOf`, not `oneOf`.
    normalized[key === "oneOf" ? "anyOf" : key] = normalizeSchemaNode(child);
  }
  if (source["type"] === "object") {
    normalized["additionalProperties"] = false;
    const properties = normalized["properties"];
    if (isSchemaObject(properties)) {
      const required = requiredKeys(source);
      normalized["properties"] = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, required.has(key) ? child : nullable(child)]));
      normalized["required"] = Object.keys(properties);
    } else {
      normalized["required"] = [];
    }
  }
  return normalized;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredKeys(node: Record<string, unknown>): Set<string> {
  const required = node["required"];
  return new Set(Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : []);
}

const NULL_SCHEMA = { type: "null" } as const;
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/**
 * The same property, also accepting `null`.
 *
 * A primitive is widened in place — `type: ["string", "null"]`, which is
 * how OpenAI's own documentation spells an optional field — and anything
 * else is offered beside `null` in an `anyOf`, never a `oneOf`, which the
 * strict subset refuses.
 */
function nullable(child: unknown): unknown {
  if (!isSchemaObject(child) || acceptsNull(child)) return child;
  const type = child["type"];
  if (typeof type === "string" && PRIMITIVE_TYPES.has(type) && !("const" in child)) {
    const enumValues = child["enum"];
    return { ...child, type: [type, "null"], ...(Array.isArray(enumValues) ? { enum: [...enumValues, null] } : {}) };
  }
  const union = child["anyOf"];
  if (Array.isArray(union) && Object.keys(child).every((key) => key === "anyOf" || key === "description" || key === "title")) {
    return { ...child, anyOf: [...union, NULL_SCHEMA] };
  }
  return { anyOf: [child, NULL_SCHEMA] };
}

/**
 * Whether a schema already lets `null` through.
 *
 * Read from the node alone: a `$ref` is answered "no", which costs at
 * most a redundant `null` branch beside it and never a missing one.
 */
function acceptsNull(node: Record<string, unknown>): boolean {
  const type = node["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  if ("const" in node) return node["const"] === null;
  const enumValues = node["enum"];
  if (Array.isArray(enumValues)) return enumValues.includes(null);
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) return branches.some((branch) => isSchemaObject(branch) && acceptsNull(branch));
  }
  // A schema that constrains nothing — zod's `unknown` — accepts null too.
  return type === undefined && !("$ref" in node) && !("allOf" in node) && !("not" in node);
}

/**
 * A Codex answer, put back into the shape the shared schema describes.
 *
 * Undoes the two things `strictCodexOutputSchema` did to that schema so
 * the API would take it, guided by the shared schema it was made from so
 * that it undoes exactly those and nothing else:
 *
 * - **A null in place of an absent field is taken out** (EO-376): a
 *   `null` under a key the shared schema does not require and whose own
 *   schema does not already accept `null`. A null anywhere else is left
 *   where it is — a required field that came back null still fails
 *   validation, and a field that may legitimately be null keeps its
 *   value.
 * - **A list of entries where the shared schema has a map is folded into
 *   the map** (EO-387): `[{ name: "ciWaitSeconds", value: 2400 }]`
 *   becomes `{ ciWaitSeconds: 2400 }`. Only a list that is entirely
 *   well-formed entries with no key twice is folded; anything else is
 *   left as it arrived, so validation refuses it and says so rather than
 *   EO guessing which half of a malformed answer was meant.
 *
 * The result then means what the same answer from a Claude agent — which
 * omits the field, and writes the map — would mean.
 */
export function fromStrictCodexAnswer(value: unknown, schema: JsonSchema): unknown {
  return readStrictAnswer(value, schema, schema, 0);
}

/** Deep enough for any answer EO asks for, and a stop on a schema that refers to itself. */
const MAX_SCHEMA_DEPTH = 64;

function readStrictAnswer(value: unknown, node: unknown, root: JsonSchema, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) return value;
  const schema = resolveLocalRef(node, root);
  if (!schema) return value;

  if (Array.isArray(value)) {
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = schema[key];
      if (Array.isArray(branches)) {
        // A list where the schema offers alternatives: the one that is a
        // list, and failing that the map this list is the entries of.
        const resolved = branches.map((candidate) => resolveLocalRef(candidate, root));
        const branch = resolved.find((candidate) => candidate?.["type"] === "array") ?? resolved.find((candidate) => candidate !== undefined && isMapSchema(candidate));
        return branch === undefined ? value : readStrictAnswer(value, branch, root, depth + 1);
      }
    }
    if (isMapSchema(schema)) return entriesAsMap(value, schema, root, depth);
    const prefix = schema["prefixItems"];
    const items = schema["items"];
    return value.map((entry, index) => {
      const entrySchema = Array.isArray(prefix) && index < prefix.length ? prefix[index] : Array.isArray(items) ? items[index] : items;
      return entrySchema === undefined ? entry : readStrictAnswer(entry, entrySchema, root, depth + 1);
    });
  }
  if (!isSchemaObject(value)) return value;

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const branch = branches.find((candidate) => branchFits(value, candidate, root, depth));
      return branch === undefined ? value : readStrictAnswer(value, branch, root, depth + 1);
    }
  }

  const properties = schema["properties"];
  if (!isSchemaObject(properties)) return value;
  const required = requiredKeys(schema);
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (propertySchema === undefined) {
      stripped[key] = entry;
      continue;
    }
    if (entry === null && !required.has(key)) {
      const resolved = resolveLocalRef(propertySchema, root);
      if (resolved && !acceptsNull(resolved)) continue;
    }
    stripped[key] = readStrictAnswer(entry, propertySchema, root, depth + 1);
  }
  return stripped;
}

/**
 * The map a list of `{ name, value }` entries spells, or the list
 * untouched when it is not one.
 *
 * Each value is read against the map's own value schema on the way, so
 * an optional field inside it written as null is taken out like any
 * other.
 */
function entriesAsMap(entries: readonly unknown[], schema: Record<string, unknown>, root: JsonSchema, depth: number): unknown {
  const valueSchema = schema["additionalProperties"];
  const folded = new Map<string, unknown>();
  for (const entry of entries) {
    if (!isSchemaObject(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, MAP_ENTRY_VALUE)) return entries;
    const name = entry[MAP_ENTRY_NAME];
    if (typeof name !== "string" || folded.has(name)) return entries;
    folded.set(name, isSchemaObject(valueSchema) ? readStrictAnswer(entry[MAP_ENTRY_VALUE], valueSchema, root, depth + 1) : entry[MAP_ENTRY_VALUE]);
  }
  // `fromEntries` defines each key as the answer's own, `__proto__` included.
  return Object.fromEntries(folded);
}

/**
 * Whether an object answer is one a union branch describes: the branch
 * itself, or — where the branch is a union of its own, as a review's
 * three verdicts are inside the outcome's union with a clarification —
 * any of its branches (EO-597). Without the second, nothing in a nested
 * union's answer had its nulls taken out.
 */
function branchFits(value: Record<string, unknown>, candidate: unknown, root: JsonSchema, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  const branch = resolveLocalRef(candidate, root);
  if (objectBranchFits(value, branch)) return true;
  return (["anyOf", "oneOf"] as const).some((key) => {
    const nested = branch?.[key];
    return Array.isArray(nested) && nested.some((inner) => branchFits(value, inner, root, depth + 1));
  });
}

/**
 * Whether an object answer is the one this union branch describes: an
 * object schema naming every key the answer has, whose constants — a
 * discriminated union's `action`, the clarification's `status` — agree.
 */
function objectBranchFits(value: Record<string, unknown>, branch: Record<string, unknown> | undefined): boolean {
  if (!branch) return false;
  const properties = branch["properties"];
  if (!isSchemaObject(properties)) return false;
  if (!Object.keys(value).every((key) => key in properties)) return false;
  const required = requiredKeys(branch);
  return Object.entries(properties).every(([key, property]) => {
    if (!isSchemaObject(property)) return true;
    if (!(key in value)) return !(("const" in property || "enum" in property) && required.has(key));
    if ("const" in property) return property["const"] === value[key];
    const enumValues = property["enum"];
    return !Array.isArray(enumValues) || enumValues.includes(value[key]);
  });
}

/** A node, or what its local `$ref` (`#/$defs/...`) points at. Anything else is not followed. */
function resolveLocalRef(node: unknown, root: JsonSchema): Record<string, unknown> | undefined {
  let current = node;
  for (let hops = 0; hops < MAX_SCHEMA_DEPTH && isSchemaObject(current); hops++) {
    const ref = current["$ref"];
    if (typeof ref !== "string") return current;
    if (!ref.startsWith("#")) return undefined;
    let target: unknown = root;
    for (const segment of ref.slice(1).split("/").filter(Boolean)) {
      const key = decodeURIComponent(segment).replace(/~1/g, "/").replace(/~0/g, "~");
      target = isSchemaObject(target) ? target[key] : undefined;
    }
    current = target;
  }
  return undefined;
}

/**
 * AgentProvider backed by the real Codex CLI (A-04).
 *
 * Codex has no in-process tool-registration API, so EO mounts its shared
 * stdio service in the CLI configuration. `AgentProviderStartOptions.tools`
 * remains a signal for comment-capable roles; a missing service is logged
 * loudly rather than silently dropping that capability.
 */
export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const createCodex =
    options.createCodex ??
    ((
      repositoryMcp?: RepositoryMcpServer,
      searchHook?: CodexSearchHookDelivery,
      attachFrom?: AttachmentSource,
      memoryScopes?: readonly MemoryReadScope[],
      environmentVariables?: Readonly<Record<string, string>>,
      writeBridge?: AgentWriteBridgeAddress,
      withheldEnvironmentVariables?: readonly string[],
    ) => new CodexClient(codexClientOptions(options, repositoryMcp, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldEnvironmentVariables)));

  /**
   * What marks EO's hook as trusted, learned once per command line.
   *
   * The hash is the CLI's own, of the hook as configured, so it is the
   * same for every turn of this process; only an answer is kept, so a
   * probe that failed is tried again on the next turn.
   */
  const learnedTrust = new Map<string, CodexHookTrust>();
  async function trustFor(command: string): Promise<CodexHookTrust | null> {
    const known = learnedTrust.get(command);
    if (known) return known;
    const executablePath = options.executablePath;
    const learned = options.searchHookTrust
      ? await options.searchHookTrust(command)
      : executablePath
        ? await probeHookTrust({ executablePath, hooks: searchHookEntries(command) })
        : null;
    if (learned) learnedTrust.set(command, learned);
    return learned;
  }

  /** One turn's hook: the listener behind it, and what the CLI is told so that it runs. */
  type TurnSearchHook = CodexSearchHook & { trust: CodexHookTrust };

  /**
   * This turn's search hook, or null on a turn that gets none (EO-379):
   * no nudge supplied, no command to run, or no index on this item.
   *
   * A listener that could not be opened is the same null, and so is a
   * hook the CLI would not say how to trust — configured anyway it would
   * be a hook that never runs. The turn is the work and the nudge is
   * advice beside it, so either costs the advice and says so here rather
   * than failing the run.
   */
  async function searchHookFor(repositoryMcp: RepositoryMcpServer | undefined, cwd: string | undefined): Promise<TurnSearchHook | null> {
    if (cwd === undefined) return null;
    let hook: CodexSearchHook | null = null;
    try {
      hook = await openCodexSearchHook({ nudge: options.searchNudge, server: repositoryMcp, cwd, commandPath: options.searchHookCommandPath });
      if (hook === null) return null;
      const trust = await trustFor(hook.command);
      if (trust === null) throw new Error("the Codex CLI did not report the hook, so it cannot be marked as trusted");
      return { ...hook, trust };
    } catch (error) {
      await hook?.close();
      console.warn(`[codex] the broad-search hook could not be set up, so this turn runs without it: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The client for one turn, handed the hook only when there is one — so
   * a stand-in that takes one argument still sees one — and, by the same
   * rule, the run's attachment source only on a turn that has one
   * (EO-412).
   */
  function clientFor(
    repositoryMcp: RepositoryMcpServer | undefined,
    searchHook: TurnSearchHook | null,
    attachFrom?: AttachmentSource,
    memoryScopes?: readonly MemoryReadScope[],
    environmentVariables?: Readonly<Record<string, string>>,
    writeBridge?: AgentWriteBridgeAddress,
    withheldEnvironmentVariables?: readonly string[],
  ) {
    const hook = searchHook ? { command: searchHook.command, env: searchHook.env, trust: searchHook.trust } : undefined;
    // And the names a redirected step withholds only on a turn that
    // withholds some (EO-584).
    if (withheldEnvironmentVariables && withheldEnvironmentVariables.length > 0) {
      return createCodex(repositoryMcp, hook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheldEnvironmentVariables);
    }
    // And the run's environment variables only on a turn that has some
    // (EO-487).
    // And where the `eo` server hands what the agent writes only on a
    // turn that has somewhere (EO-543).
    if (writeBridge) return createCodex(repositoryMcp, hook, attachFrom, memoryScopes, environmentVariables, writeBridge);
    if (environmentVariables && Object.keys(environmentVariables).length > 0) return createCodex(repositoryMcp, hook, attachFrom, memoryScopes, environmentVariables);
    // And the memory scopes only on a turn that has them (EO-478).
    if (memoryScopes && memoryScopes.length > 0) return createCodex(repositoryMcp, hook, attachFrom, memoryScopes);
    if (attachFrom) return createCodex(repositoryMcp, hook, attachFrom);
    return hook ? createCodex(repositoryMcp, hook) : createCodex(repositoryMcp);
  }

  async function* streamTurn(
    thread: CodexThread,
    input: string,
    outputSchema: JsonSchema | undefined,
    signal: AbortSignal | undefined,
    reach: (turn: CodexTurn) => void,
    searchHook: CodexSearchHook | null = null,
    /**
     * Whether the words are passed on as they are generated
     * (`AgentTurnOverrides.streamDeltas`). The app-server sends them
     * either way; a turn nobody is watching drops them here.
     */
    streamDeltas = false,
    /** The caller's part of what a warm process must match to be adopted (`prewarm`). */
    warmKey?: string,
    /** What the turn may spend, in cents (`AgentTurnOverrides.budgetCents`). */
    budgetCents?: number,
  ) {
    const interceptions = (): SearchInterceptionEvent[] => searchHook?.drain() ?? [];
    const turn = await thread.runStreamed(input, {
      ...(outputSchema ? { outputSchema: strictCodexOutputSchema(outputSchema) } : {}),
      ...(signal ? { signal } : {}),
      ...(warmKey ? { warmKey } : {}),
    });
    // Handed to the stream the supervisor holds before a single event is
    // read, so an escalation or a person's message has a turn to reach
    // from the first event on (EO-373).
    reach(turn);
    const events = turn.events;

    let lastMessage: string | undefined;
    const pendingInterceptions: SearchInterceptionEvent[] = [];

    const iterator = events[Symbol.asyncIterator]();
    // Read by hand rather than with `for await`, so a budget stop can go on
    // reading the turn while it winds down — and closed by hand on every way
    // out, as `for await` would have, so the turn's process is shut down
    // and what it was lent let go of (`CodexClient.afterTurn`).
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        const event = step.value;
        // Held to its budget while it runs (`AgentTurnOverrides.budgetCents`):
        // priced as the turn's usage is priced at its end, and stopped at
        // the cap the way Claude's CLI stops itself — interrupted, and said
        // to be a budget stop. A model EO has no price for cannot be held to
        // one; the supervisor already tells the item the budgets cannot count it.
        if (event.type === "turn.usage" && budgetCents !== undefined) {
          const price = event.model === undefined ? null : codexModelPrice(event.model);
          if (price && codexTurnCostCents(event.usage, price) >= budgetCents) {
            await turn.interrupt?.().catch(() => undefined);
            // What it spent, all of it: the readings that arrive while the
            // interrupt lands are spending too, so the turn is read until it
            // ends — for a few seconds at most — and its last reading is the
            // one recorded, once.
            const spent = await lastReadingWhileStopping(iterator, event.usage, event.model);
            yield usageEvent(spent.usage, spent.model);
            // And any search it intercepted, which happened (EO-168).
            yield* [...pendingInterceptions.splice(0), ...interceptions()];
            yield { type: "error", message: "Codex run stopped at the budget it was given.", retryable: false, budget: true } satisfies AgentEvent;
            return;
          }
        }
        const { mapped: all, recognised } = mapThreadEvent(event);
        if (!recognised) options.onUnmappedEvent?.(event);
        const mapped = streamDeltas ? all : all.filter((agentEvent) => agentEvent.type !== "output_delta");

        if (event.type === "item.completed" && event.item.type === "agent_message") {
          lastMessage = event.item.text;
        }

        // `outputSchema` above went to the *turn*, not to its last message,
        // so everything the model says while working comes out in the
        // answer's shape — including the preamble a reasoning model writes
        // before its first tool call (EO-199). Said here rather than in
        // `mapThreadEvent`, which maps one item and has no idea what the
        // turn was asked for.
        //
        // Without it the supervisor kept every such message as a candidate
        // answer and then dropped it on the next tool call, reporting the
        // drop on the item: five reviews on EO-194, five engine notes,
        // none of them a mistake anybody made. Nothing is lost by saying
        // so, because the answer on this backend is not guessed from a
        // message's shape — `lastMessage` below names it outright.
        for (const agentEvent of withInterceptions(mapped, pendingInterceptions, interceptions())) {
          yield outputSchema && agentEvent.type === "output" ? { ...agentEvent, schemaConstrained: true } : agentEvent;
        }
      }
    } finally {
      // Awaited (EO-493): the turn's process is ended inside this, and a
      // caller that stops reading here — the supervisor, about to open a
      // correction on the same thread — must not get on before it has
      // gone. Nor swallowed: a process that would not go
      // (`TurnNotEndedError`) is the caller's to know about.
      await iterator.return?.(undefined);
    }

    // Whatever no completed call claimed — a hook whose command never
    // reported back as an item, or an id this backend spelled differently
    // in the two places. Recorded all the same, ahead of the result: a
    // firing that happened is never dropped for want of somewhere tidy to
    // put it (EO-168).
    yield* [...pendingInterceptions.splice(0), ...interceptions()];

    // The turn's final message is the result. Emitted last so the
    // supervisor sees a complete event log before it acts on it.
    if (lastMessage !== undefined) {
      // Put back into the shared schema's shape before A-02 validates it:
      // a null where the strict schema allowed one for an absent field is
      // removed (EO-376), and a map sent as a list of entries is a map
      // again (EO-387).
      yield { type: "result", data: outputSchema ? fromStrictCodexAnswer(parseStructuredResult(lastMessage), outputSchema) : lastMessage } satisfies AgentEvent;
    }
  }

  async function* resumedTurn(threadId: string, message: string, resumeOpts: AgentProviderResumeOptions | undefined, reach: (turn: CodexTurn) => void): AsyncIterable<AgentEvent> {
    // This agent's skills, put back where its own first turn said they
    // would be (EO-207).
    //
    // Written again rather than assumed to have survived, because they
    // demonstrably do not. Every action on an item shares one worktree
    // and `.agent/skills` holds one delivery: an agent dispatched after
    // this thread's first turn sweeps what this one wrote and leaves its
    // own. This thread is then resumed with a prompt naming skills by
    // slug — `findReusableThread` keeps the conversation, and the
    // conversation still says "read `.agent/skills/<slug>/SKILL.md`" —
    // against a directory that now holds somebody else's. The agent
    // reads a path that is not there, and nothing says why.
    //
    // No prompt section goes with it: the choices were named in the turn
    // that opened this thread and are in the conversation the CLI
    // resumes. What has to be restored is the files.
    if (resumeOpts?.cwd) {
      const restored = writeWorktreeSkills(resumeOpts.cwd, skillsForRun(options.attachedSkills ?? [], resumeOpts.skillScope));
      warnAboutUndeliveredSkills(restored, resumeOpts.cwd);
    }

    // Threads persist in ~/.codex/sessions, which is what makes resume
    // cheap after a crash (ARCHITECTURE.md, "Reconciling on launch", E-04) — and an agent's own
    // Codex home links
    // its `sessions` there, so that stays true under it (EO-378). The *thread* is found by id, but
    // the working directory is not part of it: without one the resumed
    // turn runs wherever the app happens to be, so a resumed agent
    // edited the EO checkout instead of the item's worktree.
    // The query server is named again on a resume for the reason the cwd
    // is: this constructs a fresh client and the CLI it launches starts
    // the servers *this* invocation declares, not the ones the session
    // was opened with (EO-151).
    //
    // And the search hook again, for the same reason once more (EO-379):
    // a hook is part of what this invocation is launched with, so a
    // resumed turn that did not name one would be a turn without it.
    const searchHook = await searchHookFor(resumeOpts?.repositoryMcp, resumeOpts?.cwd);
    try {
      yield* resumedWith(searchHook);
    } finally {
      await searchHook?.close();
    }

    async function* resumedWith(hook: TurnSearchHook | null): AsyncIterable<AgentEvent> {
      const thread = clientFor(resumeOpts?.repositoryMcp, hook, resumeOpts?.attachFrom, resumeOpts?.memoryScopes, resumeOpts?.environmentVariables, resumeOpts?.writeBridge, resumeOpts?.withheldEnvironmentVariables).resumeThread(
        threadId,
        threadOptionsFrom(
          {
            ...(resumeOpts?.cwd ? { cwd: resumeOpts.cwd } : {}),
            ...(resumeOpts?.model ? { model: resumeOpts.model } : {}),
            ...(resumeOpts?.reasoningEffort ? { reasoningEffort: resumeOpts.reasoningEffort } : {}),
            ...(resumeOpts?.showReasoning === undefined ? {} : { showReasoning: resumeOpts.showReasoning }),
          },
          options.config,
        ),
      );
      const prompt = withAttachmentNote(message, resumeOpts?.attachments);
      for await (const event of streamTurn(thread, prompt, resumeOpts?.outputSchema, resumeOpts?.signal, reach, hook, resumeOpts?.streamDeltas === true, resumeOpts?.warmKey, resumeOpts?.budgetCents)) {
        // A turn that fails before it starts is reported as an event
        // rather than by exiting, and `mapThreadEvent` has already turned
        // it into an ordinary `error`. Re-thrown with the backend's own
        // words so the one translation site above decides what it was:
        // yielding it would leave the run failing on a message about a
        // session id, which is the opaque failure this exists to stop.
        //
        // Only a fatal one: a warning item that happens to use the words
        // did not end the turn, so it did not lose the thread either.
        if (event.type === "error" && event.fatal !== false && MISSING_CODEX_SESSION.test(event.message)) throw new Error(event.message);
        yield event;
      }
    }
  }

  /*
   * Both `interrupt` and `steer`, since EO-373.
   *
   * **What there was.** `@openai/codex-sdk` wrapped `codex exec`, which is
   * one-shot by design: its whole `Thread` surface was `run(input)` and
   * `runStreamed(input)`, with no handle on a turn that had started. And
   * `codex queue --thread <id> --message <text>`, measured against 0.149.1
   * and 0.151.0 (EO-176, EO-179), reported "Queued message … for thread
   * …" while neither the running `exec` turn nor the next one ever saw
   * the message. So an escalated Codex run was walked away from and
   * recorded no tokens, and a person could not speak to a Codex agent.
   *
   * **What there is now.** The app-server this adapter speaks (EO-372)
   * has `turn/interrupt` and `turn/steer` on the very connection a turn
   * runs over, and `codexClient.ts` hands both back with the turn. This
   * is the seam between them and the supervisor: `start` and `resume`
   * return before the turn exists, so the two controls wait here for it,
   * and `providerSteersLiveTurns` in `capabilities.ts` says yes for Codex
   * — checked against this stream in `capabilities.test.ts`.
   */
  return {
    start(opts: AgentProviderStartOptions): InterruptibleStream<AgentEvent> {
      // The skills this agent has attached, written into the worktree and
      // named — slug and description — in the turn they belong to
      // (EO-207). Written here rather than beside the generated tool
      // directory because this is the adapter that knows the delivery:
      // Codex has no plugin loader, so the files go where an agent finds
      // them by listing, and the choosing is done by the prompt. Nothing
      // is written when nothing is attached, and never the bodies —
      // `worktreeSkills.ts` carries why.
      // Only those whose scope takes this run in — its project, or the
      // workspace its step works in (EO-470). Claude's tool directory is
      // narrowed by the same rule before it is written.
      //
      // Before `start` returns (EO-602), so the section can be reported
      // from what was actually written — a skill refused for a folder the
      // checkout already holds is in neither the prompt nor debug mode's
      // record of it. `writeWorktreeSkills` never throws.
      const skills = writeWorktreeSkills(opts.cwd, skillsForRun(options.attachedSkills ?? [], opts.skillScope));
      warnAboutUndeliveredSkills(skills, opts.cwd);
      const skillsSection = worktreeSkillsPromptSection(skills.delivered);
      opts.onSkillsSection?.(skillsSection);
      return reachableTurn((reach) => startedTurn(opts, skillsSection, reach));
    },

    resume(threadId: string, message: string, resumeOpts?: AgentProviderResumeOptions): InterruptibleStream<AgentEvent> {
      return reachableTurn((reach) => lostThreadTranslated(threadId, message, resumeOpts, reach));
    },

    dropWarm(): void {
      dropWarmCodexThread();
    },

    prewarm(turn: AgentPrewarmTurn): void {
      // Not for a turn with a repository index: its broad-search hook is
      // opened per turn, so a process started without it would never be
      // the one the turn asks for. Conversations have none.
      if (turn.repositoryMcp) return;
      const thread =
        turn.kind === "start"
          ? { ...threadOptionsFrom(turn, options.config), ...(turn.instructions ? { baseInstructions: turn.instructions } : {}) }
          : threadOptionsFrom(
              {
                ...(turn.cwd ? { cwd: turn.cwd } : {}),
                ...(turn.model ? { model: turn.model } : {}),
                ...(turn.reasoningEffort ? { reasoningEffort: turn.reasoningEffort } : {}),
                ...(turn.showReasoning === undefined ? {} : { showReasoning: turn.showReasoning }),
              },
              options.config,
            );
      try {
        clientFor(undefined, null, turn.attachFrom, turn.memoryScopes, turn.environmentVariables, turn.writeBridge, turn.withheldEnvironmentVariables).prewarm?.(turn.kind === "start" ? null : turn.threadId, thread, turn.warmKey);
      } catch (error) {
        // A warm-up is a saving, never a requirement, as on Claude: the
        // turn builds its options again and says what was wrong.
        console.warn("[eo] could not start Codex ahead of a turn:", error);
      }
    },

    async *sideCall(opts: AgentSideCallOptions): AsyncIterable<AgentEvent> {
      // A home of the side calls' own, or no call (EO-477). Never the
      // person's: an unset `CODEX_HOME` — no `codexHome` given, or one
      // that answers null for the keyring the way an agent's does — is
      // their own home and their `config.toml`, whose MCP servers Codex
      // starts whatever this launch declares. Made ready once, here, so
      // the catalogue is read from the home the call then runs in.
      let home: string | null = null;
      try {
        home = options.codexHome?.() ?? null;
      } catch (error) {
        yield { type: "error", message: error instanceof Error ? error.message : String(error), retryable: false } satisfies AgentEvent;
        return;
      }
      if (home === null) {
        yield {
          type: "error",
          message: "A Codex side call runs only in a Codex home of its own, and none was given, so the call was not made: in the person's own home it would start their MCP servers and read their settings.",
          retryable: false,
        } satisfies AgentEvent;
        return;
      }
      const sideCallOptions: CodexProviderOptions = { ...options, codexHome: () => home };
      const caches = options.sideCallModelCaches
        ? options.sideCallModelCaches(home)
        : [join(home, CODEX_MODELS_CACHE), join(personCodexHome(), CODEX_MODELS_CACHE)];
      const catalog = writeSideCallCatalog(opts.model, caches);
      // Refused rather than run with the tools on (`writeSideCallCatalog`).
      if (!catalog.ok) {
        yield { type: "error", message: catalog.problem, retryable: false } satisfies AgentEvent;
        return;
      }
      try {
        const client = options.createSideCallCodex ? options.createSideCallCodex(catalog.path) : new CodexClient(codexSideCallClientOptions(sideCallOptions, catalog.path));
        const thread = client.startThread(codexSideCallThreadOptions(opts));
        // The same turn loop a run's turn reads, so the answer is parsed
        // back out of the strict schema and the budget is held the same
        // way. Nothing can reach a side call mid-turn, so the turn is not kept.
        // Its words are passed on as they are written, as Claude's are:
        // what the caller holds the answer's length to (EO-577). Wound
        // down, the turn is interrupted rather than killed, as a budget
        // stop is, and read to its end — whose usage is what it spent.
        const reach = (turn: CodexTurn) => {
          const windDown = () => void turn.interrupt?.().catch(() => undefined);
          if (opts.windDown?.aborted) windDown();
          else opts.windDown?.addEventListener("abort", windDown, { once: true });
        };
        yield* streamTurn(thread, opts.input, opts.outputSchema, opts.signal, reach, null, true, undefined, opts.budgetCents);
      } finally {
        catalog.remove();
      }
    },

    describeSession(turn: AgentSessionQuery): AgentSessionDescription {
      // The thread's own options, from the function both `start` and
      // `resume` build them with (EO-392) — so the model, the effort and
      // the two pinned settings are the ones a turn is opened with, not
      // a second reading of the same configuration.
      const thread = threadOptionsFrom(turn, options.config);
      return {
        instructionsSlot: "baseInstructions",
        model: thread.model ?? null,
        reasoningEffort: thread.modelReasoningEffort ?? null,
        policy: [
          { name: "sandboxMode", value: String(thread.sandboxMode) },
          { name: "approvalPolicy", value: String(thread.approvalPolicy) },
        ],
        mcpServers: codexServerNames(options, turn.repositoryMcp),
        // Codex is handed no allowlist: what a server offers is what the
        // agent may call.
        allowedTools: null,
        // The same list `writeWorktreeSkills` delivers, by slug — which
        // is the name the prompt section calls each one.
        skills: deliverableSkills(skillsForRun(options.attachedSkills ?? [], turn.skillScope)).map((skill) => skill.slug),
        inheritsAmbientConfig: options.config?.inheritAmbientConfig === true,
      };
    },
  };

  async function* startedTurn(opts: AgentProviderStartOptions, skillsSection: string, reach: (turn: CodexTurn) => void): AsyncIterable<AgentEvent> {
    if (opts.tools && opts.tools.length > 0 && !options.eoMcp) {
      // Deliberately loud: silently dropping the comment tool would
      // look like an agent that simply never escalates. With the MCP
      // bridge configured (A-05) the tool does reach the agent, so
      // this only fires when it isn't.
      console.warn(
        `[codex] ${opts.tools.length} tool(s) requested but no MCP bridge is configured, so they are ` +
          `not available to the agent. Configure the EO MCP service to enable the comment tool.`,
      );
    }

    // Opened before the client is, because the client is constructed
    // with it: the listener's address is part of what the CLI is launched
    // with (EO-379). Closed when the turn is over, however it ended.
    const searchHook = await searchHookFor(opts.repositoryMcp, opts.cwd);
    try {
      yield* startedWith(searchHook);
    } finally {
      await searchHook?.close();
    }

    async function* startedWith(hook: TurnSearchHook | null): AsyncIterable<AgentEvent> {
      // The instructions are the thread's system prompt (EO-385), as
      // `systemPrompt` is on Claude: `baseInstructions` on `thread/start`,
      // which replaces the CLI's built-in prompt rather than adding to it.
      //
      // This used to say Codex had no system-prompt slot, and led the
      // first turn with the instructions instead. That was true of
      // `codex exec` and stopped being true when EO-372 moved this
      // adapter onto the app-server. As a user message they ranked below
      // the CLI's own prompt wherever the two disagreed, and were ordinary
      // history that a long thread's compaction could summarise away —
      // and one thread per item is how an implementer runs.
      //
      // Measured on 0.161.0, not read off the schema
      // (`codexInstructions.live.test.ts` keeps asking — its two cases,
      // the first two points below, passed again at 0.163.0 (EO-453),
      // 0.165.0 (EO-599) and 0.166.0 (EO-644); the
      // third is not in that file and was not re-run):
      //
      // - Under EO's instructions alone the agent still edits files and
      //   calls an EO MCP tool. The built-in prompt is not what teaches
      //   the model its tools.
      // - They are kept with the thread. A `thread/resume` that sends
      //   none is still governed by them, so `resume()` sends none and
      //   `AgentProviderResumeOptions` carries none — the arrangement
      //   Claude has always had.
      // - `thread/resume` does accept different ones, and they govern
      //   that one resumed turn only: the next resume that sends none is
      //   back on the originals. EO never uses that. An agent whose
      //   instructions were edited gets a fresh thread
      //   (`findReusableThread`), which is the only way the edit sticks.
      const thread = clientFor(opts.repositoryMcp, hook, opts.attachFrom, opts.memoryScopes, opts.environmentVariables, opts.writeBridge, opts.withheldEnvironmentVariables).startThread({
        ...threadOptionsFrom(opts, options.config),
        ...(opts.instructions ? { baseInstructions: opts.instructions } : {}),
      });
      // Only what is per turn. The instructions are not here: they went
      // out above as the thread's `baseInstructions` (EO-385), and
      // `assembleContext` deliberately does not append them to the
      // context either, so they are said exactly once.
      const prompt = withAttachmentNote(withSkillsSection(opts.context, skillsSection), opts.attachments);
      yield* streamTurn(thread, prompt, opts.outputSchema, opts.signal, reach, hook, opts.streamDeltas === true, opts.warmKey, opts.budgetCents);
    }
  }

  async function* lostThreadTranslated(threadId: string, message: string, resumeOpts: AgentProviderResumeOptions | undefined, reach: (turn: CodexTurn) => void): AsyncIterable<AgentEvent> {
    // "This thread is gone" told apart from every other way a resume
    // can fail (EO-93). Only the recognised sentence is translated;
    // anything else leaves here exactly as it arrived, which is what
    // keeps the supervisor's recovery off the catch-all path.
    //
    // One translation site, reached from both directions: the CLI can
    // report the missing thread by refusing `thread/resume` — the
    // client throws the refusal — or as a failed turn in the event stream,
    // which `resumedTurn` re-throws with the backend's own words so
    // that both arrive here.
    try {
      yield* resumedTurn(threadId, message, resumeOpts, reach);
    } catch (error) {
      if (!isMissingCodexSession(error)) throw error;
      throw new ThreadNotFoundError({ threadId, provider: PROVIDER, cause: error });
    }
  }
}

/**
 * One event's worth of mapped events, with each interception put beside
 * the call it fired on (EO-379).
 *
 * On Claude a firing is drained at the next message boundary, which puts
 * it after its own `tool_call` and before that call's result. This
 * backend reports a shell call once, when it has finished, as a call and
 * its result together — and the hook fired before the command ran, so by
 * then the firing has been waiting. It is placed between the two, joined
 * on the id both carry, which is the same order a Claude run records:
 * `tool_call`, `search_interception`, `tool_result`.
 *
 * A firing whose id matches no call here stays in `pending` for a later
 * one, and `streamTurn` records whatever is left when the turn ends.
 */
function withInterceptions(mapped: AgentEvent[], pending: SearchInterceptionEvent[], arrived: SearchInterceptionEvent[]): AgentEvent[] {
  pending.push(...arrived);
  if (pending.length === 0) return mapped;
  const woven: AgentEvent[] = [];
  for (const event of mapped) {
    woven.push(event);
    if (event.type !== "tool_call" || event.callId === undefined) continue;
    for (let index = 0; index < pending.length; ) {
      const firing = pending[index];
      if (firing !== undefined && firing.callId === event.callId) woven.push(...pending.splice(index, 1));
      else index++;
    }
  }
  return woven;
}

/**
 * A turn's events, with the two controls that reach it while it runs
 * (EO-373).
 *
 * The stream is returned synchronously and the turn it controls exists
 * only once the generator has opened it, so both controls wait for the
 * turn rather than finding nothing there — the arrangement Claude's
 * `deferred` makes for the same reason. Somebody who speaks a second
 * after pressing Start is talking to a turn that exists as far as they
 * can tell, and an escalation's interrupt always follows an event from
 * the turn it interrupts. Once the events are over, neither waits:
 * `interrupt` does nothing and `steer` answers false, which is the
 * contract's "the turn had already ended".
 */
function reachableTurn(run: (reach: (turn: CodexTurn) => void) => AsyncIterable<AgentEvent>): InterruptibleStream<AgentEvent> {
  let turn: CodexTurn | null = null;
  let over = false;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const reached = async (): Promise<CodexTurn | null> => {
    while (!turn && !over) await new Promise<void>((resolveWait) => waiters.push(resolveWait));
    return turn;
  };

  async function* events(): AsyncIterable<AgentEvent> {
    try {
      yield* run((opened) => {
        turn = opened;
        wake();
      });
    } finally {
      over = true;
      wake();
    }
  }

  const iterator = events()[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]: () => iterator,
    async interrupt() {
      // Best effort, like Claude's: "stop now" must not become a throw
      // on a path that is already handling an escalation.
      try {
        await (await reached())?.interrupt?.();
      } catch {
        // The caller drains and stops either way.
      }
    },
    async steer(message: string, attachments?: AgentInputAttachment[]) {
      const current = await reached();
      if (!current?.steer) return false;
      try {
        // Named the way a turn's own prompt names them (EO-395): the
        // note is text, so `turn/steer` carries it as it carries the
        // message, and a file with nothing typed under it still steers
        // something.
        return await current.steer(withAttachmentNote(message, attachments));
      } catch {
        return false;
      }
    },
  };
}
