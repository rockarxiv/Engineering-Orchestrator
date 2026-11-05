import { ADMIN_MCP_SERVER_NAME, mcpToolId, type RunEvent } from "@eo/core";

/**
 * Did this run read the pipeline it proposes to replace?
 *
 * `PipelineDraftSchema` is a whole graph and there is deliberately no
 * patch form, so **omission is deletion**: a draft that simply fails to
 * mention a step is a proposal to remove it, and it reads identically to
 * a considered decision to remove it. That is defensible for an agent
 * that has read the current graph and dangerous for one that has not —
 * EO-208, where a turn that had answered "I cannot inspect the screen"
 * went on to emit a complete graph anyway, and the button offered to
 * delete two steps holding nine items between them.
 *
 * EO-209 narrowed that without replacing it. A draft now declares what it
 * removes, and one that drops a step without saying so is refused — so an
 * omission is no longer silently a decision. It does not make this gate
 * redundant: `removes` asks an agent what it meant, and this asks whether
 * it had anything to mean it *about*. A turn that read nothing can still
 * type out a graph and declare its removals with perfect confidence, and
 * the declaration would be as invented as the graph.
 *
 * The durable rule is not "parse the message for a question mark". It is
 * that a draft must be **derived from a graph the run actually read**,
 * which the engine can check for itself rather than take an agent's word
 * for (invariant #5). It subsumes the prose case for free: an agent that
 * could not read the graph has nothing to derive from, whichever field
 * it put its question in.
 *
 * Two things decide whether that check is worth anything, and the first
 * cut of this file got both wrong:
 *
 *   * **Which graph.** A read of some *other* board is not evidence
 *     about the board this draft would overwrite. The screen is live and
 *     the panel survives a navigation — that is the whole premise of
 *     EO-193 — so a person can walk to another pipeline while the turn
 *     is thinking, while the draft stays pinned to where they *asked* by
 *     `assistBoardFor`. Accepting any read at all would leave exactly
 *     the hole this gate exists to close, one board along.
 *   * **Whether it answered.** A `tool_call` records that the agent
 *     asked. It does not record that anything came back. EO-208's run
 *     happened on an installation where the screen could not be read at
 *     all (EO-203) — precisely a turn that asked and was told nothing —
 *     so a gate satisfied by the asking is a gate satisfied by the
 *     original bug. `callId` pairs a call with its answer (EO-169), and
 *     an unpaired call is an attempt.
 *
 * The cost of that second rule, said out loud: a backend that reports
 * calls and not results can raise no drafts at all. Of the three EO
 * ships, `fake` is the one — and its tool calls are scripted rather than
 * run, so it never read anything either. A backend that genuinely
 * answers its agent and declines to say so would be refused here, and
 * the honest place to fix that is the adapter, not a gate that assumes
 * silence means success.
 *
 * Everything is read from `run_events`, which is append-only and already
 * carries what each backend announced. It is written down beside the
 * room that asks it rather than inside it, so "what counts as a read" is
 * one fact with one test rather than a condition buried in a renderer.
 *
 * **A remembering agent is refused, and that is the answer rather than an
 * oversight** (EO-210). An assist conversation is now one provider
 * thread across every turn, so on turn six the model may genuinely hold
 * a `pipeline_get` answer from turn two — and this gate, which asks
 * *this run's* events, will refuse a draft derived from it. Widening it
 * to the thread was considered and rejected on the gate's own premise: a
 * graph read four turns ago is a graph as it was four turns ago, and in
 * between the person can have published a draft, dragged a step or
 * deleted one from the very screen they are asking about. Omission is
 * deletion, so a draft written from a remembered graph proposes removing
 * whatever has been added since — the same destructive shape EO-208
 * reported, arrived at by a different route and rather harder to see
 * coming, because the agent is not confused about the board, it is
 * confident about a board that has stopped existing.
 *
 * The gate is therefore about freshness rather than about knowledge, and
 * "this run" is exactly the window over which freshness can be
 * established. The cost is one extra tool call on a turn that proposes a
 * graph, which is the cheapest thing in this whole exchange; the prompt
 * asks for that read *this turn* in those words, and the refusal says so
 * again when it happens.
 */

/**
 * The read that establishes a graph: `pipeline_get`, and only it.
 *
 * It takes the pipeline's id, so *which* board it answered about is a
 * fact about the call rather than an inference from the answer. That is
 * the whole reason it is the one accepted here.
 *
 * **`view_current` is not evidence, though it does read a board.** The
 * screen is what an assist turn is told to consult first (EO-192) and on
 * a pipeline page it renders the same steps and routes — so leaving it
 * out is a real cost, paid deliberately. Two things make it unusable as
 * proof:
 *
 *   * It answers about *wherever the person is now*, which the tool's
 *     own description insists on. It takes no pipeline id, so the only
 *     record of which board it described is the prose it returned.
 *   * That prose is bounded on its way into the log
 *     (`providers/toolResult.ts`, 4 000 characters, keeping the tail),
 *     and the sentence naming the board is the first line rendered. A
 *     twelve-step board already renders past that bound, so the naming
 *     survives on small pipelines and vanishes on ordinary ones —
 *     evidence that works until an installation grows, which is the
 *     worst kind.
 *
 * So a turn that read the screen and drafted from it is refused, once,
 * with a sentence naming the board's id and this tool. That costs a
 * round trip on a path an agent can take deliberately; the alternative
 * costs a step nobody read.
 *
 * `pipelines_list` is absent for a different reason: it names the
 * pipelines, not the graph of any of them. `pipeline_validate` is absent
 * for a sharper one — it judges a graph the agent already had, so
 * accepting it would let an invented graph vouch for itself.
 */
export const PIPELINE_GRAPH_TOOL = "pipeline_get";

/** The screen read, named here only so a refusal can say why it was not enough. */
export const SCREEN_TOOL = "view_current";

const READ_TOOLS = [PIPELINE_GRAPH_TOOL, SCREEN_TOOL] as const;

type ReadTool = (typeof READ_TOOLS)[number];

/**
 * **The server has to be EO's, not merely the tool's name.**
 *
 * This began as a suffix match — anything ending in `pipeline_get` — and
 * that was a hole rather than a shortcut. An agent can carry third-party
 * MCP servers (`mcp_servers_list`, and the whole of EO-106), "pipeline"
 * is ordinary CI vocabulary, and a server offering its own `pipeline_get`
 * taking its own `pipelineId` is a thing that exists. Under a suffix
 * match, a successful call to *that* tool with the pinned board's id
 * satisfied the gate, and the agent got an approvable whole-graph
 * replacement without EO's graph ever having reached it. The evidence has
 * to name the server that answers with EO's pipelines.
 *
 * So a tool id is split into the server and the tool, and both are
 * checked.
 *
 * **One parser, in `packages/core` (EO-314).** This used to be a local
 * split, and a second one grew up beside it — the pack import gate,
 * reading the same two spellings to decide whether a document is asking
 * for `eo_admin`. Two readers of one id is how a grant comes to be
 * refused on one backend and admitted on the other, which is the thing
 * invariant #12 is about, so `mcpToolId` is now the only thing that
 * reads either spelling and this asks it.
 *
 * A whole-server grant (`mcp__eo_admin`, no tool) answers `tool: null`
 * and is refused here: this function is about evidence that a *read
 * happened*, and a server named without a tool is not a call.
 */
function splitToolId(name: string): { server: string; tool: string } | null {
  const id = mcpToolId(name);
  return id === null || id.tool === null ? null : { server: id.server, tool: id.tool };
}

/**
 * Is this the server EO serves its own administrative tools on?
 *
 * One name, and the reason it is one is that `eo_admin` is the only
 * spelling EO can *guarantee* nobody else is answering under. It is
 * reserved (`schemas/mcpServers.ts`) and refused twice: `readMcpServerDraft`
 * will not save a catalogue row by that name, and `isDeliverableMcpServer`
 * will not hand one to a dispatch even if a row written before the
 * reservation, or restored from a backup, still carries it. Both adapters
 * apply the second check. So a tool id qualified by this server is a tool
 * id EO served.
 *
 * **The plugin-qualified spelling used to be accepted here and was a
 * hole.** `plugin_eo-attachments_eo_admin` is what the same server would
 * be called if the plugin loader owned the connection — but it is also a
 * perfectly legal catalogue name: it satisfies `MCP_SERVER_NAME_PATTERN`
 * and it is not on the reserved list, so a person, or an agent proposing
 * a server, can create one and have it delivered. Its `pipeline_get`
 * would then have arrived under the exact id this function was accepting,
 * and the card would have been offered on a graph EO never sent. An
 * identity that anybody may adopt is not an identity.
 *
 * That spelling was speculative as well as spoofable: it is not what this
 * build produces. The generated directory is handed to the CLI by path
 * with `--strict-mcp-config` and `skipMcpDiscovery`, so servers keep
 * their plain names — `mcp__eo_admin__pipeline_get` on Claude, and
 * `eo_admin/pipeline_get` on Codex, which writes `${server}/${tool}` for
 * anything that is not the `eo` server. Invariant #12: one capability,
 * two spellings, and a check written around either alone would refuse
 * every draft raised on the other while every test still passed.
 *
 * **If that delivery ever changes, this fails closed and you will see
 * it** — every draft refused, none wrongly offered. Do not fix it by
 * adding the new name here unless that name is also reserved. The
 * property this depends on is not "the string looks like EO's", it is
 * "no other server can be answering under it".
 */
function isAdminServer(server: string): boolean {
  return server === ADMIN_MCP_SERVER_NAME;
}

/**
 * Which read this tool id names, or null if it is not one of EO's.
 *
 * A bare `pipeline_get` is deliberately **not** accepted. The earlier
 * cut took one, reasoning that an adapter might normalise a server
 * prefix away — `normaliseToolName` does exactly that, but only for the
 * `eo` server, and neither adapter strips this one. An unevidenced
 * spelling is not generosity here; it is the same hole with no server
 * name at all in front of it.
 */
export function pipelineReadToolOf(name: string): ReadTool | null {
  const split = splitToolId(name);
  if (split === null || !isAdminServer(split.server)) return null;
  return READ_TOOLS.find((tool) => tool === split.tool) ?? null;
}

/**
 * The bare name of a tool EO's administrative server answered, from a
 * call as either backend reports it — `mcp__eo_admin__x` on Claude,
 * `eo_admin/x` on Codex — or null for any other server's tool.
 *
 * The same reading `pipelineReadToolOf` makes, without its list of graph
 * reads: what a run's log says an agent asked EO, whichever backend it
 * ran on (invariant #12).
 */
export function adminToolOf(name: string): string | null {
  const split = splitToolId(name);
  return split === null || !isAdminServer(split.server) ? null : split.tool;
}

/** The server those reads answer on, for the sentence a refusal has to write. */
export const PIPELINE_READ_SERVER = ADMIN_MCP_SERVER_NAME;

/**
 * What a run's log says about the graph behind a draft.
 *
 * Four answers rather than a boolean, because the refusal has to be
 * actionable and these are different mistakes with different sentences
 * (invariant #8). An agent told "you read nothing" when it had read the
 * screen will argue rather than comply, and an agent told nothing about
 * *which* board it read will make the same graph again.
 */
export type PipelineReadVerdict =
  /** It asked for this board's graph by id, and got an answer. */
  | { kind: "read" }
  /** Nothing in the turn read anything that answers with a graph. */
  | { kind: "nothing" }
  /** It read the screen, which does not establish which board it was shown. */
  | { kind: "screen" }
  /** It read a graph — somebody else's. `what` is that board's id. */
  | { kind: "elsewhere"; what: string };

/**
 * The three verdicts that refuse a draft.
 *
 * Named so the refusal can be written against exactly them: a sentence
 * that had to answer for `read` as well would carry a branch nobody can
 * reach, and the compiler would stop noticing if that ever changed.
 */
export type PipelineNotRead = Exclude<PipelineReadVerdict, { kind: "read" }>;

function payloadOf(event: RunEvent): Record<string, unknown> {
  const { payload } = event;
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** The pipeline a `pipeline_get` call asked for, or null when it named none. */
function pipelineIdIn(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const id = (args as { pipelineId?: unknown }).pipelineId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * What this run read, judged against the board a draft would replace.
 *
 * Results are indexed first because a call is answered later in the log
 * than it is made, and pairing is by `callId` rather than by adjacency:
 * a turn can have several calls in flight at once — both backends batch
 * them — so "the result after the call" is not a pairing, and a reader
 * that guessed would be confidently wrong about which read returned
 * what.
 *
 * One successful, on-target read is enough and the walk returns on it.
 * What it remembers along the way is the near miss, so a turn that read
 * the wrong board, or only the screen, can be told which it did.
 */
export function pipelineReadVerdict(events: readonly RunEvent[], pipelineId: string): PipelineReadVerdict {
  const answers = new Map<string, boolean>();
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const payload = payloadOf(event);
    const callId = payload["callId"];
    if (typeof callId === "string") answers.set(callId, payload["ok"] === true);
  }

  let otherBoard: string | null = null;
  let readTheScreen = false;

  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const payload = payloadOf(event);
    const name = payload["name"];
    if (typeof name !== "string") continue;
    const tool = pipelineReadToolOf(name);
    if (tool === null) continue;

    // Asked is not answered. An unpaired call, or one the backend
    // answered with an error, establishes nothing about what the agent
    // was holding when it wrote the graph.
    const callId = payload["callId"];
    if (typeof callId !== "string" || answers.get(callId) !== true) continue;

    if (tool === SCREEN_TOOL) {
      readTheScreen = true;
      continue;
    }

    const asked = pipelineIdIn(payload["args"]);
    if (asked === pipelineId) return { kind: "read" };
    if (asked !== null) otherBoard = asked;
  }

  // Most specific first: naming the board it actually read is the most
  // useful thing to say, and "you read the screen" beats "you read
  // nothing" for a turn that did.
  if (otherBoard !== null) return { kind: "elsewhere", what: otherBoard };
  return readTheScreen ? { kind: "screen" } : { kind: "nothing" };
}
