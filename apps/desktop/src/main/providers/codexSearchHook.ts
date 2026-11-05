import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryMcpServer, SearchInterceptionEvent } from "@eo/core";
import { AppServerConnection, type AppServerSpawn } from "./codexAppServer.js";
import { configArguments } from "./codexClient.js";
import type { SearchNudge } from "./searchNudge.js";

/**
 * EO's broad-search interception, delivered to a Codex turn (EO-379).
 *
 * Claude agents have had this since EO-165: a `PreToolUse` hook that
 * answers a repository-wide `grep -r` with the index query that would
 * serve it better, and records each firing (EO-168). `searchInterception`
 * in `claude.ts` says why it is a hook and not a sentence in the prompt.
 * Codex agents got nothing, and `codexHooks.live.test.ts` had already
 * established that this was not for want of a route: an inline
 * `hooks.PreToolUse` fires on the pinned CLI, hands over the payload
 * Claude's does, and its `additionalContext` reaches the model.
 *
 * **What was missing was a way for a command to reach a function.** A
 * Codex hook is a command the CLI spawns, and the judgement — which calls
 * are broad searches, what to say about one — is a function in EO's main
 * process, supplied to an adapter by the composition root (KAN-126). The
 * command cannot import it, and a second copy of the rules inside the
 * command is the one outcome ruled out. So the command asks: this opens
 * a listener on the loopback interface for the length of one turn, the
 * command (`codexSearchHookCommand.mjs`) posts the payload to it, and the
 * answer is whatever the same `SearchNudge` the Claude hook calls says.
 * One classifier, two deliveries.
 *
 * **Per turn, not per provider.** A provider is cached and worked against
 * many items, and what a nudge is asked with — this checkout, this
 * index's vocabulary, this run's record of firings — is one turn's. A
 * listener shared between two turns would file one run's interceptions
 * under another's, which is the reason `claude.ts` gives for its queue
 * being per stream.
 *
 * **Loopback, and a bearer nobody else was given.** The listener binds
 * `127.0.0.1` on a port the OS picks, and answers only a request carrying
 * the token minted here — which reaches the command through the CLI's
 * environment and never its command line, for the reason every other
 * credential in `codex.ts` travels that way. What the token protects is
 * small — a stranger who had it could make EO record an interception
 * that did not happen — but the record is a measurement, and a count
 * anything on the machine can inflate is not one.
 *
 * **It never blocks, on either side.** The answer carries
 * `additionalContext` and no decision, so the call the agent made runs
 * exactly as it would have. And everything that can go wrong here — a
 * body that is not JSON, a nudge that throws — is answered as "nothing to
 * say", because what is waiting on the answer is a tool call.
 */
export interface CodexSearchHook {
  /** The command line Codex runs for the hook, as one string its shell is given. */
  command: string;
  /** What the command reads to find this listener. Goes into the CLI's environment, never its arguments. */
  env: Record<string, string>;
  /** Every firing recorded since the last call. Empty on a turn that intercepted nothing. */
  drain: () => SearchInterceptionEvent[];
  /** Stops listening. The turn is over and there is nobody left to answer. */
  close: () => Promise<void>;
}

/** The variable the command reads the listener's address from. */
export const SEARCH_HOOK_URL_ENV = "EO_SEARCH_HOOK_URL";
/** The variable the command reads the listener's bearer from. */
export const SEARCH_HOOK_TOKEN_ENV = "EO_SEARCH_HOOK_TOKEN";

/**
 * Which tool calls Codex offers the hook.
 *
 * `Bash` is what the pinned CLI calls its shell tool in a hook payload
 * (`codexHooks.live.test.ts`), and the shell is the only door a Codex
 * agent searches through — it has no `Grep` or `Glob` of its own. Claude's
 * matcher names those two as well; naming them here would be matching
 * tools this backend does not have.
 *
 * A filter and never the decision, as on Claude: the nudge classifies
 * whatever arrives and answers null for what it does not recognise.
 */
export const CODEX_SEARCH_TOOL_MATCHER = "Bash";

/** A payload is a tool name and a command line. Anything near this size is not one. */
const LARGEST_PAYLOAD_BYTES = 1_048_576;

export interface CodexSearchHookRequest {
  /** The judgement, from the composition root. Absent means there is none to apply. */
  nudge: SearchNudge | undefined;
  /** This turn's repository intelligence server, when the item has a ready index. */
  server: RepositoryMcpServer | undefined;
  /** The checkout the agent works in, so a path naming it reads as the whole tree. */
  cwd: string;
  /** Where `codexSearchHookCommand.mjs` is on this machine. Absent means there is no command to run. */
  commandPath: string | undefined;
  /** The Node that runs the command. EO's own executable, which is one when asked to be. */
  nodePath?: string;
  /** Seam for tests: the platform whose shell the command line is written for. */
  platform?: NodeJS.Platform;
}

/**
 * Opens this turn's listener, or answers null when the turn gets no hook.
 *
 * Null is the same absence `searchInterception` keeps on Claude, for the
 * same reasons and one more:
 *
 * - no nudge supplied — the adapter delivers a judgement and has none of
 *   its own (KAN-126);
 * - no index on this run, or one whose provider offered no vocabulary or
 *   no way of asking whether it has anything to say (EO-173);
 * - no command to run — a caller with no packaged resources, which is a
 *   test or the v1 gate.
 *
 * Null means *no hook is configured at all*: not a hook that stays quiet,
 * no `hooks` key in the CLI's configuration and no listener.
 */
export async function openCodexSearchHook(request: CodexSearchHookRequest): Promise<CodexSearchHook | null> {
  const { nudge, server, cwd, commandPath } = request;
  if (nudge === undefined || commandPath === undefined) return null;
  const answers = server?.answers;
  const knows = server?.knows;
  if (server === undefined || answers === undefined || knows === undefined) return null;

  // `<server>/<tool>` is how this backend spells a tool id wherever EO
  // meets one — it is what `mapCompletedItem` records a call under — and
  // it carries the two parts every backend agrees on, the server's name
  // and the provider's bare word, with none of Claude's punctuation
  // (EO-198).
  const qualify = (tool: string): string => `${server.name}/${tool}`;

  const pending: SearchInterceptionEvent[] = [];
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  const answer = async (body: string): Promise<string | null> => {
    const payload = asRecord(parseJson(body));
    if (payload === null || payload["hook_event_name"] !== "PreToolUse") return null;
    const tool = payload["tool_name"];
    if (typeof tool !== "string") return null;
    const interception = await nudge({ tool, input: payload["tool_input"], answers, knows, qualify, root: cwd });
    if (interception === null) return null;
    // Recorded before it is said, and only on the one path that says
    // something — the rule, and the reason, `searchInterception` gives
    // for the Claude hook (EO-168).
    const callId = payload["tool_use_id"];
    pending.push({
      type: "search_interception",
      tool,
      // Narrowed rather than trusted: a payload without one has to read
      // as "this backend did not say" rather than as an invented id.
      callId: typeof callId === "string" && callId !== "" ? callId : null,
      kind: interception.kind,
      needle: interception.needle,
      suggestion: interception.nudge,
    });
    // `additionalContext` and nothing else: no decision, no reason.
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: interception.nudge } });
  };

  const listener = createServer((incoming, outgoing) => {
    void respond(incoming, outgoing, expected, answer);
  });
  const port = await listening(listener);

  return {
    command: hookCommandLine(request.nodePath ?? process.execPath, commandPath, request.platform ?? process.platform),
    env: { [SEARCH_HOOK_URL_ENV]: `http://127.0.0.1:${port}/`, [SEARCH_HOOK_TOKEN_ENV]: token },
    drain: () => pending.splice(0, pending.length),
    close: () =>
      new Promise<void>((resolveClosed) => {
        listener.close(() => resolveClosed());
        // A hook still mid-request must not hold the turn's end open.
        listener.closeAllConnections();
      }),
  };
}

function listening(listener: Server): Promise<number> {
  return new Promise<number>((resolveListening, rejectListening) => {
    listener.once("error", rejectListening);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", rejectListening);
      resolveListening((listener.address() as AddressInfo).port);
    });
  });
}

async function respond(incoming: IncomingMessage, outgoing: ServerResponse, expected: Buffer, answer: (body: string) => Promise<string | null>): Promise<void> {
  const quiet = (status: number): void => {
    outgoing.writeHead(status).end();
  };
  try {
    const offered = Buffer.from(incoming.headers.authorization ?? "");
    if (incoming.method !== "POST" || offered.length !== expected.length || !timingSafeEqual(offered, expected)) return quiet(401);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > LARGEST_PAYLOAD_BYTES) return quiet(413);
      chunks.push(chunk);
    }
    const said = await answer(Buffer.concat(chunks).toString("utf8"));
    if (said === null) return quiet(204);
    outgoing.writeHead(200, { "content-type": "application/json" }).end(said);
  } catch {
    // A nudge that threw, or a connection that went away. Either way the
    // call the agent made must go on, so the answer is "nothing to say".
    if (!outgoing.headersSent) quiet(204);
    else outgoing.end();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The hook as one command line, because that is what Codex takes: a
 * string it hands to a shell, not an argument vector.
 *
 * `ELECTRON_RUN_AS_NODE` is set for this command alone, in the command
 * line itself. `eoMcpStdioConfig` sets it through an MCP entry's own
 * `env`, which a hook entry does not have, and the one other place it
 * could go — the CLI's whole environment — would hand it to everything
 * the agent runs, so an agent working on an Electron app would find its
 * own `electron .` starting as a bare Node. Harmless when the executable
 * is a real Node, which is what it is under test.
 *
 * Quoted, because both paths are a person's: an install under
 * `/Applications/EO Beta.app` or `C:\Program Files` has a space in it.
 */
export function hookCommandLine(nodePath: string, commandPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `set "ELECTRON_RUN_AS_NODE=1" && "${nodePath}" "${commandPath}"`;
  return `ELECTRON_RUN_AS_NODE=1 ${posixQuoted(nodePath)} ${posixQuoted(commandPath)}`;
}

function posixQuoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * What marks one hook as reviewed, in the CLI's own terms: the key it
 * files the hook under and the hash it took of it.
 */
export interface CodexHookTrust {
  key: string;
  hash: string;
}

export interface HookTrustProbe {
  executablePath: string;
  /** The `hooks` table exactly as the turn will be given it — the hash is of this. */
  hooks: Record<string, unknown>;
  /** Seam for tests: the process spawn. */
  spawn?: AppServerSpawn;
  /** Seam for tests: how long the CLI is given to answer. */
  timeoutMs?: number;
}

/** A listing is one request to a process that has just started. Longer than this and it is not coming. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Asks the CLI what would mark EO's hook as trusted (EO-379).
 *
 * Codex runs a hook only after a person has reviewed it, and what it
 * records is the hook's hash under `hooks.state.<key>.trusted_hash`. A
 * hook EO composes for an unattended turn has nobody to review it, and
 * the one switch that waives review — `bypass_hook_trust` — waives it for
 * every hook the CLI loaded, including ones in the person's own Codex
 * home that they never approved. So EO states the review for its own
 * hook and no other, and for that it needs the key and the hash.
 *
 * Both are the CLI's to say: the hash is over its own reading of the
 * entry, and a second implementation of it here would be a guess that
 * goes stale silently. `hooks/list` reports them, so this starts the
 * app-server with the hook configured, asks, and stops it. No thread is
 * opened and no model is called.
 *
 * In a home of its own, empty and thrown away afterwards: the answer is
 * about the hook on the command line and nothing in a home changes it,
 * so there is no reason for a listing to load a person's configuration —
 * or, in a locked-down agent's home, to be the second thing touching it
 * while a turn is being set up.
 *
 * Null when the CLI did not report the hook — an older binary with no
 * `hooks/list`, a process that would not start, an answer that never
 * came. The caller configures no hook then, because one without its
 * trust would be a hook that never runs.
 */
export async function probeHookTrust(probe: HookTrustProbe): Promise<CodexHookTrust | null> {
  const home = mkdtempSync(join(tmpdir(), "eo-codex-hook-probe-"));
  let connection: AppServerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    connection = new AppServerConnection({
      executablePath: probe.executablePath,
      args: configArguments({ hooks: probe.hooks }),
      env: { ...inherited(), CODEX_HOME: home },
      ...(probe.spawn ? { spawn: probe.spawn } : {}),
    });
    const open = connection;
    const listed = (async () => {
      await open.initialize();
      return open.request("hooks/list", { cwds: [home] });
    })();
    // Whichever loses is left unanswered, and must not become an
    // unhandled rejection when the process is closed under it.
    listed.catch(() => {});
    const answer = await Promise.race([
      listed,
      new Promise<null>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(null), probe.timeoutMs ?? PROBE_TIMEOUT_MS);
      }),
    ]);
    return sessionHookTrust(answer);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    connection?.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The one hook that came from the command line, out of a `hooks/list`
 * answer. The probe's home is empty, so that is EO's and only EO's; two
 * of them, or none, is an answer this does not understand and reads as
 * no answer.
 */
function sessionHookTrust(answer: unknown): CodexHookTrust | null {
  const data = asRecord(answer)?.["data"];
  if (!Array.isArray(data)) return null;
  const found: CodexHookTrust[] = [];
  for (const entry of data) {
    const hooks = asRecord(entry)?.["hooks"];
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const record = asRecord(hook);
      if (record === null || record["source"] !== "sessionFlags") continue;
      const key = record["key"];
      const hash = record["currentHash"];
      if (typeof key === "string" && key !== "" && typeof hash === "string" && hash !== "") found.push({ key, hash });
    }
  }
  const [only] = found;
  return found.length === 1 && only ? only : null;
}

/** `process.env` without the keys it types as possibly undefined, which a spawn's `env` has none of. */
function inherited(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
  return environment;
}
