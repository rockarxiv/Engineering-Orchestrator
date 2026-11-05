import { ADMIN_MCP_SERVER_NAME, MCP_SERVER_NAME_PATTERN, reservedMcpServerName, type RunEvent, type Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { qualifiedServerName } from "../agentAttachments/pluginDirectory.js";
import { pipelineReadToolOf, pipelineReadVerdict } from "./pipelineRead.js";

/**
 * The plugin-qualified spelling of EO's admin server — and a name any
 * catalogue row may take, which is the whole point of the cases about it.
 */
const SPOOFABLE = qualifiedServerName(ADMIN_MCP_SERVER_NAME).replaceAll(":", "_");

/**
 * The evidence a draft is judged on (EO-208).
 *
 * Everything here is one question — *did this run read the graph it
 * proposes to replace?* — asked of the log the backends already write.
 * It is unit-tested away from the room because the two ways of being
 * wrong are not symmetric and neither is visible from an assist test:
 * being wrong in the strict direction throws away a card somebody was
 * owed, and no test built on one backend's spelling would show which one
 * did it; being wrong in the loose direction hands somebody a button
 * that deletes a step nobody read.
 */

let seq = 0;

function event(type: string, payload: unknown): RunEvent {
  seq += 1;
  return { runId: "run" as Uuid, seq, ts: seq, type, payload };
}

function call(name: string, callId: string, args: unknown = {}): RunEvent {
  return event("tool_call", { name, args, callId });
}

function answer(callId: string, ok: boolean): RunEvent {
  return event("tool_result", { callId, ok, output: "", truncated: false });
}

/** `pipeline_get`, as Claude Code advertises it, asking for one board. */
function readsGraph(pipelineId: string, callId = "c1"): RunEvent {
  return call(`mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`, callId, { pipelineId });
}

/** `view_current`, as Codex sends it. A read of the screen, whatever the screen was. */
function readsScreen(callId = "s1"): RunEvent {
  return call(`${ADMIN_MCP_SERVER_NAME}/view_current`, callId);
}

describe("which tool a name is", () => {
  /**
   * Invariant #12, and the reason it is stated as an invariant at all:
   * the two backends spell one tool id two ways, and a check written
   * around either alone would refuse every draft raised on the other
   * while every test still passed.
   */
  it("takes both backends' spellings of the same tool", () => {
    expect(pipelineReadToolOf(`mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`)).toBe("pipeline_get");
    expect(pipelineReadToolOf(`${ADMIN_MCP_SERVER_NAME}/pipeline_get`)).toBe("pipeline_get");
    expect(pipelineReadToolOf(`mcp__${ADMIN_MCP_SERVER_NAME}__view_current`)).toBe("view_current");
    expect(pipelineReadToolOf(`${ADMIN_MCP_SERVER_NAME}/view_current`)).toBe("view_current");
  });

  /**
   * What makes the accepted name worth accepting, and it is not that it
   * looks like EO's.
   *
   * `eo_admin` is reserved, so `readMcpServerDraft` will not save a
   * catalogue row by that name and `isDeliverableMcpServer` will not hand
   * one to a dispatch even if an older row still carries it. That — and
   * only that — is why a tool id qualified by it is one EO served.
   */
  it("accepts only a server name the catalogue refuses to hand out", () => {
    expect(reservedMcpServerName(ADMIN_MCP_SERVER_NAME)).not.toBeNull();
    // And the spelling that was accepted here for one round is not
    // reserved, which is precisely why it cannot be accepted.
    expect(reservedMcpServerName(SPOOFABLE)).toBeNull();
    expect(MCP_SERVER_NAME_PATTERN.test(SPOOFABLE)).toBe(true);
  });

  /**
   * The hole a plugin-qualified spelling left open.
   *
   * `plugin_eo-attachments_eo_admin` is what the same server *would* be
   * called if the plugin loader owned the connection — and it is also a
   * name anybody may give a catalogue server, since it satisfies the name
   * pattern and is not reserved. Accepting it meant a third-party server
   * could answer under an id the gate read as EO's own. An identity
   * anybody may adopt is not an identity.
   */
  it("refuses a catalogue server wearing the plugin-qualified spelling, in both syntaxes", () => {
    expect(pipelineReadToolOf(`mcp__${SPOOFABLE}__pipeline_get`)).toBeNull();
    expect(pipelineReadToolOf(`${SPOOFABLE}/pipeline_get`)).toBeNull();
    expect(pipelineReadToolOf(`mcp__${SPOOFABLE}__view_current`)).toBeNull();
    expect(pipelineReadToolOf(`${SPOOFABLE}/view_current`)).toBeNull();
  });

  /**
   * The hole this file's second cut left open, and the reason the match
   * is on the server rather than on the end of the string.
   *
   * An agent carries third-party MCP servers, "pipeline" is ordinary CI
   * vocabulary, and a server offering its own `pipeline_get` that takes
   * its own `pipelineId` is a thing that exists. Accepting one would hand
   * somebody a whole-graph replacement built from a graph EO never sent.
   */
  it("refuses the same tool name on somebody else's server", () => {
    expect(pipelineReadToolOf("other_server/pipeline_get")).toBeNull();
    expect(pipelineReadToolOf("mcp__other_server__pipeline_get")).toBeNull();
    expect(pipelineReadToolOf("mcp__ci__view_current")).toBeNull();
    // Nor a server whose name merely ends in EO's.
    expect(pipelineReadToolOf("mcp__not_eo_admin__pipeline_get")).toBeNull();
  });

  /**
   * Unqualified names name no server, so they establish nothing. The
   * earlier cut took one on the theory that an adapter might normalise
   * the prefix away — `normaliseToolName` does, but only for the `eo`
   * server, and neither adapter strips this one.
   */
  it("refuses a bare tool name, which names no server at all", () => {
    expect(pipelineReadToolOf("pipeline_get")).toBeNull();
    expect(pipelineReadToolOf("view_current")).toBeNull();
  });

  /** The tool half is matched whole, so a longer name is a different tool. */
  it("does not read a longer name as one of its own", () => {
    expect(pipelineReadToolOf(`mcp__${ADMIN_MCP_SERVER_NAME}__my_view_current`)).toBeNull();
    expect(pipelineReadToolOf(`${ADMIN_MCP_SERVER_NAME}/pipeline_get_all`)).toBeNull();
  });

  /**
   * `pipelines_list` names the pipelines and not the shape of any of
   * them, and `pipeline_validate` judges a graph the agent already had —
   * accepting that would let an invented graph vouch for itself.
   */
  it("knows nothing about a listing or a validation", () => {
    expect(pipelineReadToolOf(`mcp__${ADMIN_MCP_SERVER_NAME}__pipelines_list`)).toBeNull();
    expect(pipelineReadToolOf(`mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_validate`)).toBeNull();
    expect(pipelineReadToolOf("Read")).toBeNull();
  });
});

describe("whether a run read the graph it would replace", () => {
  it("is nothing for a run that called nothing, and for one that called something else", () => {
    expect(pipelineReadVerdict([], "default")).toEqual({ kind: "nothing" });
    expect(pipelineReadVerdict([call("Bash", "c1"), answer("c1", true)], "default")).toEqual({ kind: "nothing" });
  });

  it("is read when this board's graph was asked for by id and came back", () => {
    expect(pipelineReadVerdict([readsGraph("default"), answer("c1", true)], "default")).toEqual({ kind: "read" });
    // Whichever way the backend spells the tool.
    expect(pipelineReadVerdict([call(`${ADMIN_MCP_SERVER_NAME}/pipeline_get`, "c1", { pipelineId: "default" }), answer("c1", true)], "default")).toEqual({
      kind: "read",
    });
  });

  /**
   * The case EO-208 actually happened on.
   *
   * That installation could not reach the screen at all (EO-203), and a
   * gate satisfied by the asking is a gate satisfied by the original
   * bug. `callId` is what pairs a call to its answer (EO-169).
   */
  it("does not count a call the backend answered with an error", () => {
    expect(pipelineReadVerdict([readsGraph("default"), answer("c1", false)], "default")).toEqual({ kind: "nothing" });
    expect(pipelineReadVerdict([readsScreen(), answer("s1", false)], "default")).toEqual({ kind: "nothing" });
  });

  /**
   * Asked is not answered.
   *
   * A `tool_call` alone records that the agent reached for something, not
   * that anything came back — and "no result recorded" covers exactly the
   * shape of the failure this gate exists to catch. The cost is stated in
   * `pipelineRead.ts`: a backend that reports calls and not results can
   * raise no drafts, and `fake` is that backend precisely because its
   * calls are scripted rather than run.
   */
  it("does not count a call with no result recorded against it", () => {
    expect(pipelineReadVerdict([readsGraph("default")], "default")).toEqual({ kind: "nothing" });
    expect(
      pipelineReadVerdict([event("tool_call", { name: `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`, args: { pipelineId: "default" } })], "default"),
    ).toEqual({ kind: "nothing" });
    // The result names a different call, so it answers a different call.
    expect(pipelineReadVerdict([readsGraph("default", "c1"), answer("c2", true)], "default")).toEqual({ kind: "nothing" });
  });

  /** The hole the first cut of this left open: a read of *a* graph standing in for a read of *this* one. */
  it("does not accept a read of another pipeline", () => {
    expect(pipelineReadVerdict([readsGraph("delivery"), answer("c1", true)], "default")).toEqual({ kind: "elsewhere", what: "delivery" });
  });

  it("takes the right board out of a turn that read several", () => {
    const events = [readsGraph("delivery", "c1"), answer("c1", true), readsGraph("default", "c2"), answer("c2", true)];
    expect(pipelineReadVerdict(events, "default")).toEqual({ kind: "read" });
  });

  /**
   * The same hole, seen from the verdict rather than the name: a
   * successful call, the pinned board's id in its arguments, and a card
   * would have been offered on the strength of a graph EO never sent.
   */
  it("does not accept another server's pipeline_get, however well it answered", () => {
    const events = [call("other_server/pipeline_get", "c1", { pipelineId: "default" }), answer("c1", true)];
    expect(pipelineReadVerdict(events, "default")).toEqual({ kind: "nothing" });
  });

  /**
   * The same spoof at the verdict, where it would have bought a card: a
   * successful call from a catalogue server wearing the plugin-qualified
   * name, carrying the pinned board's id.
   */
  it("does not accept a spoofed plugin-qualified server, in either syntax", () => {
    for (const name of [`mcp__${SPOOFABLE}__pipeline_get`, `${SPOOFABLE}/pipeline_get`]) {
      expect(pipelineReadVerdict([call(name, "c1", { pipelineId: "default" }), answer("c1", true)], "default")).toEqual({ kind: "nothing" });
    }
  });

  /** A call that named no board at all establishes nothing, and is not mistaken for one that named another. */
  it("does not accept a graph read that named no pipeline", () => {
    expect(pipelineReadVerdict([call(`${ADMIN_MCP_SERVER_NAME}/pipeline_get`, "c1"), answer("c1", true)], "default")).toEqual({ kind: "nothing" });
  });

  /**
   * The screen is a read, and it is not this evidence.
   *
   * `view_current` answers about wherever the person is at the moment it
   * is called, and the panel survives a navigation (EO-193) — so it
   * cannot establish which board the agent was shown. Said as its own
   * verdict rather than folded into "nothing", because an agent told it
   * read nothing when it read the screen will argue instead of comply.
   */
  it("says so when the turn read the screen and nothing else", () => {
    expect(pipelineReadVerdict([readsScreen(), answer("s1", true)], "default")).toEqual({ kind: "screen" });
  });

  it("still accepts the graph read that came after the screen read", () => {
    const events = [readsScreen(), answer("s1", true), readsGraph("default", "c1"), answer("c1", true)];
    expect(pipelineReadVerdict(events, "default")).toEqual({ kind: "read" });
  });

  /** Payloads arrive as JSON text from a raw row as readily as they do as objects. */
  it("reads a payload that is still a string", () => {
    const rawCall: RunEvent = {
      runId: "run" as Uuid,
      seq: 98,
      ts: 98,
      type: "tool_call",
      payload: JSON.stringify({ name: `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`, args: { pipelineId: "default" }, callId: "c9" }),
    };
    const rawResult: RunEvent = { runId: "run" as Uuid, seq: 99, ts: 99, type: "tool_result", payload: JSON.stringify({ callId: "c9", ok: true }) };

    expect(pipelineReadVerdict([rawCall, rawResult], "default")).toEqual({ kind: "read" });
    expect(pipelineReadVerdict([{ ...rawCall, payload: "not json" }, rawResult], "default")).toEqual({ kind: "nothing" });
  });

  /**
   * A remembering agent is refused, and that is the answer (EO-210).
   *
   * An assist conversation is one provider thread now, so the model can
   * genuinely be holding a graph it read three turns ago — and this gate
   * asks *this run's* events, so it refuses anyway. Deliberate: the gate
   * is about freshness, not about knowledge. Between two turns a person
   * can publish a draft, drag a step or delete one, and a draft written
   * from a remembered graph proposes removing everything added since —
   * the same destructive shape EO-208 reported, arrived at with more
   * confidence and less to notice.
   *
   * Asserted rather than left to the comment, because "the events of one
   * run" is the whole of the decision and a widening of it would look
   * like a generosity rather than a regression.
   */
  it("refuses a turn that read the graph on an earlier turn of the same thread", () => {
    // Turn one read the board, properly, and its verdict says so.
    const first = [readsGraph("default", "c1"), answer("c1", true)];
    expect(pipelineReadVerdict(first, "default")).toEqual({ kind: "read" });

    // Turn two of the same conversation asked nothing. The model may
    // remember the graph perfectly; the log of this run establishes
    // nothing about what the board is *now*.
    expect(pipelineReadVerdict([], "default")).toEqual({ kind: "nothing" });
  });
});
