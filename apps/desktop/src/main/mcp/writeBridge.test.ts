import type { AgentWriteAnswer, AgentWriteRequest } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — the service is plain JavaScript, deliberately: it ships
// unbundled because Codex spawns it by path.
import { createEoMcpService } from "./eoServer.mjs";
import { agentWriteToolResult, sendAgentWrite, startAgentWriteBridge, type AgentWriteBridge } from "./writeBridge.js";

/**
 * The agent write bridge (EO-543): where the `eo` server hands every
 * write an agent asks for, and the only way one reaches EO.
 */

const open: AgentWriteBridge[] = [];
afterEach(async () => {
  for (const bridge of open.splice(0)) await bridge.close();
});

async function bridgeAnswering(answer: (itemId: string, request: AgentWriteRequest) => Promise<AgentWriteAnswer>) {
  const asked: { itemId: string; request: AgentWriteRequest }[] = [];
  const bridge = await startAgentWriteBridge(async (itemId, request) => {
    asked.push({ itemId, request });
    return answer(itemId, request);
  });
  open.push(bridge);
  return { bridge, asked };
}

const NOTED: AgentWriteAnswer = { ok: true, text: "EO noted this.", data: { entryId: "m-1" } };

describe("the agent write bridge", () => {
  it("opens a credential minted for some writes to those alone, and tells the handler which (EO-717)", async () => {
    const seen: (readonly string[] | null | undefined)[] = [];
    const bridge = await startAgentWriteBridge(async (_itemId, _request, writes) => {
      seen.push(writes);
      return NOTED;
    });
    open.push(bridge);

    const scoped = bridge.tokenFor("item-1", ["memory_note"]);
    expect(scoped.writes).toEqual(["memory_note"]);
    expect(await sendAgentWrite(scoped, { tool: "memory_note", args: { scope: "project", text: "A fact." } })).toEqual(NOTED);
    for (const tool of ["comment", "attachment_add", "repository_checkout"] as const) {
      expect(await sendAgentWrite(scoped, { tool, args: {} }), tool).toMatchObject({ ok: false, code: "TOOL_NOT_SERVED" });
    }
    // The list is signed: one widened by hand is not a credential this bridge minted.
    const widened = { ...scoped, token: scoped.token.replace("~memory_note.", "~memory_note,comment.") };
    expect(await sendAgentWrite(widened, { tool: "comment", args: { body: "x" } })).toMatchObject({ ok: false, code: "UNRECOGNISED_CREDENTIAL" });
    // An unscoped credential is what it always was.
    expect(bridge.tokenFor("item-1").writes).toBeUndefined();
    expect(await sendAgentWrite(bridge.tokenFor("item-1"), { tool: "comment", args: { body: "x" } })).toEqual(NOTED);
    expect(seen).toEqual([["memory_note"], null]);
  });

  it("answers a write with the handler's own answer, for the item its credential was minted for", async () => {
    const { bridge, asked } = await bridgeAnswering(() => Promise.resolve(NOTED));

    const answer = await sendAgentWrite(bridge.tokenFor("item-1"), { tool: "memory_note", args: { scope: "project", text: "A fact." } });

    expect(answer).toEqual(NOTED);
    expect(asked).toEqual([{ itemId: "item-1", request: { tool: "memory_note", args: { scope: "project", text: "A fact." } } }]);
  });

  it("opens nothing to a credential it did not mint, one for another item, or one from a bridge that has gone", async () => {
    const { bridge, asked } = await bridgeAnswering(() => Promise.resolve(NOTED));
    const other = await startAgentWriteBridge(() => Promise.resolve(NOTED));
    const { url } = bridge.tokenFor("item-1");
    const forItem2 = bridge.tokenFor("item-2").token;

    const forged = await sendAgentWrite({ url, token: `item-1.${"0".repeat(64)}` }, { tool: "comment", args: { body: "x" } });
    // Another process's secret, for the same item.
    const elsewhere = await sendAgentWrite({ url, token: other.tokenFor("item-1").token }, { tool: "comment", args: { body: "x" } });
    // The signature of one item's credential, presented for another.
    const swapped = await sendAgentWrite({ url, token: `item-1.${forItem2.slice(forItem2.lastIndexOf(".") + 1)}` }, { tool: "comment", args: { body: "x" } });
    await other.close();

    for (const answer of [forged, elsewhere, swapped]) expect(answer).toMatchObject({ ok: false, code: "UNRECOGNISED_CREDENTIAL" });
    expect(asked).toEqual([]);

    const address = bridge.tokenFor("item-1");
    await bridge.close();
    open.splice(open.indexOf(bridge), 1);
    expect(await sendAgentWrite(address, { tool: "comment", args: { body: "x" } })).toMatchObject({ ok: false, code: "EO_UNREACHABLE" });
  });

  it("refuses a request for a tool that does not write, and a body it cannot read, without asking the handler", async () => {
    const { bridge, asked } = await bridgeAnswering(() => Promise.resolve(NOTED));
    const { url, token } = bridge.tokenFor("item-1");
    const post = async (body: string) => (await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body })).json() as Promise<unknown>;

    expect(await post(JSON.stringify({ tool: "item_detail", args: {} }))).toMatchObject({ ok: false });
    expect(await post("not json")).toMatchObject({ ok: false, code: "UNREADABLE" });
    expect(asked).toEqual([]);
  });

  it("says a handler that threw wrote nothing, rather than leaving the tool to guess", async () => {
    const { bridge } = await bridgeAnswering(() => Promise.reject(new Error("the record is unreachable")));

    expect(await sendAgentWrite(bridge.tokenFor("item-1"), { tool: "memory_note", args: {} })).toEqual({
      ok: false,
      code: "WRITE_FAILED",
      problem: "EO could not write it: the record is unreachable",
    });
  });
});

/**
 * The fake provider makes the tool's answer the way the real server does
 * (`agentWriteToolResult`), because it has no server of its own to ask.
 * This is what holds the two to one shape.
 */
describe("agentWriteToolResult is the eo server's answer, exactly", () => {
  it.each([
    ["a write", NOTED],
    ["a refusal", { ok: false, code: "MEMORY_NOTE_REFUSED", problem: "A note needs some text. Nothing was written." } as AgentWriteAnswer],
  ])("for %s", async (_name, answer) => {
    const { bridge } = await bridgeAnswering(() => Promise.resolve(answer));
    const eo = (createEoMcpService as (options: Record<string, unknown>) => { handle(request: unknown): Promise<{ result: unknown }>; close(): void })({
      dbPath: undefined,
      memoryScopes: [{ kind: "project", id: "project-p", name: "P" }],
      enableMemoryNote: true,
      writeBridge: bridge.tokenFor("item-1"),
    });
    try {
      const { result } = await eo.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_note", arguments: { scope: "project", text: "A fact." } } });
      expect(result).toEqual(agentWriteToolResult(answer));
    } finally {
      eo.close();
    }
  });
});
