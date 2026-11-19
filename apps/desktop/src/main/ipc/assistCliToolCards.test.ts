import { rmSync } from "node:fs";
import { AssistOutputSchema, pageDescriptorFor, type AssistCard, type IpcChannel, type IpcResponse, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getAgentCliTools, getItem, listAgents, listCliTools, listCommentsForItem, saveCliTool, setAgentCliTool, updateRun } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { toolsFor } from "../mcpHost/gate.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Command-line tools through the assistant's cards (EO-822).
 *
 * Which programs agents are told to reach for is a person's decision
 * (EO-818). EO's system agent proposes adding a CLI, or giving one to an
 * agent, as a card; returning the card changes nothing, and only the
 * person's press saves the row or ticks the agent — through
 * `cliTools:save` and `agentCliTools:set`, the Agent tools screen's
 * channels. Every test drives the app's own handlers and asserts against
 * the rows.
 */

let handle: DbHandle;
let userData: string;

/** A command no machine running these tests has. */
const ABSENT = "eo-822-no-such-program";

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  userData = platform.userDataPath;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

async function chat(body = "Can you do that?"): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run returning `card`, and what it posted. */
function turn(conversation: Item, card: AssistCard): { cardId: Uuid | undefined; rejections: string[] } {
  const output = { message: "That is yours to press.", card };
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardId: posted.find((comment) => comment.kind === PROPOSAL_KIND)?.id,
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

const press = (conversation: Item, messageId: string) => call("assist:applyCard", { conversationId: conversation.id, messageId });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });
const implementer = () => listAgents(handle.db).find((agent) => agent.role === "implementer")!;

function gh(): string {
  const saved = saveCliTool(handle.db, { name: "GitHub CLI", command: "gh", description: "Pull requests and issues on GitHub." });
  if (!saved.ok) throw new Error(saved.problems.join(" "));
  return saved.cliTool.id;
}

describe("adding a command-line tool", () => {
  const ADD: AssistCard = { kind: "cliToolAdd", name: "In-house deploy", command: ABSENT, description: "Deploys a service to staging." };

  it("is a card that saves nothing until a person presses it, and then saves through cliTools:save", async () => {
    const conversation = await chat("Tell the agents about our deploy tool.");
    const { cardId, rejections } = turn(conversation, ADD);

    expect(rejections).toEqual([]);
    expect(listCliTools(handle.db, true)).toEqual([]);
    const shown = await read(conversation, cardId!);
    expect(shown.card).toEqual({
      kind: "cliToolAdd",
      name: "In-house deploy",
      command: ABSENT,
      description: "Deploys a service to staging.",
      // Looked up on this machine when the card is read, not taken from the agent.
      detection: { found: false },
      problem: null,
    });

    const pressed = await press(conversation, cardId!);
    expect(pressed.applied).toBe(true);
    const [row] = listCliTools(handle.db);
    expect(row).toMatchObject({ name: "In-house deploy", command: ABSENT, description: "Deploys a service to staging." });
    expect(pressed.said).toContain(`id: ${row!.id}`);

    // Spent: it cannot be pressed twice.
    expect((await press(conversation, cardId!)).problem).toBe("That card has already been pressed.");
    expect(listCliTools(handle.db)).toHaveLength(1);
  });

  it("is not offered for a command the catalogue already has, and names the row to attach instead", async () => {
    const id = gh();
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, { kind: "cliToolAdd", name: "GH", command: "gh", description: "" });

    expect(cardId).toBeUndefined();
    expect(rejections).toEqual([
      `No card was offered: "GitHub CLI" already runs \`gh\`, with the id ${id}. To give it to an agent, offer a \`cliToolsAssign\` card naming that id in \`give\`.`,
    ]);
  });

  it("is not offered for a command the save would refuse", async () => {
    const conversation = await chat();
    const { rejections } = turn(conversation, { kind: "cliToolAdd", name: "PRs", command: "gh pr", description: "" });
    expect(rejections).toEqual(['No card was offered: "gh pr" has a space in it: enter only the program, like `gh`, not its arguments.']);
  });

  it("files the save's refusal under the card when the catalogue changed after it was offered", async () => {
    const conversation = await chat();
    const { cardId } = turn(conversation, ADD);
    saveCliTool(handle.db, { name: "Deployer", command: ABSENT, description: "" });

    expect((await read(conversation, cardId!)).card).toMatchObject({ problem: `"Deployer" already runs \`${ABSENT}\` (id: ${listCliTools(handle.db)[0]!.id}).` });
    const pressed = await press(conversation, cardId!);
    expect(pressed.applied).toBe(false);
    expect(pressed.said).toBe(`“In-house deploy” was not added: "Deployer" already runs \`${ABSENT}\`.`);
    expect(listCliTools(handle.db)).toHaveLength(1);
  });
});

describe("giving an agent a command-line tool", () => {
  it("is a card that ticks nothing until a person presses it, and then ticks through agentCliTools:set", async () => {
    const id = gh();
    const agent = implementer();
    const conversation = await chat("Give the implementer gh.");
    const { cardId, rejections } = turn(conversation, { kind: "cliToolAttach", agentId: agent.id, cliToolId: id, attached: true });

    expect(rejections).toEqual([]);
    expect(getAgentCliTools(handle.db, agent.id).cliToolIds).toEqual([]);
    expect((await read(conversation, cardId!)).card).toEqual({
      kind: "cliToolAttach",
      agentId: agent.id,
      agentName: agent.name,
      cliToolId: id,
      cliToolName: "GitHub CLI",
      command: "gh",
      attached: true,
      current: false,
      archived: false,
    });

    const pressed = await press(conversation, cardId!);
    expect(pressed.applied).toBe(true);
    expect(pressed.said).toContain(`Gave ${agent.name} “GitHub CLI”.`);
    expect(getAgentCliTools(handle.db, agent.id).cliToolIds).toEqual([id]);
  });

  it("takes one away the same way", async () => {
    const id = gh();
    const agent = implementer();
    setAgentCliTool(handle.db, { agentId: agent.id, cliToolId: id, attached: true });
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "cliToolAttach", agentId: agent.id, cliToolId: id, attached: false });

    expect((await press(conversation, cardId!)).applied).toBe(true);
    expect(getAgentCliTools(handle.db, agent.id).cliToolIds).toEqual([]);
  });

  it("is not offered for an agent or a CLI that is not here, an archived CLI, or a tick already as asked", async () => {
    const id = gh();
    const agent = implementer();
    const conversation = await chat();
    const absent = "019a0000-0000-7000-8000-000000000822";

    expect(turn(conversation, { kind: "cliToolAttach", agentId: absent, cliToolId: id, attached: true }).rejections[0]).toContain(`there is no agent with the ID "${absent}"`);
    expect(turn(conversation, { kind: "cliToolAttach", agentId: agent.id, cliToolId: absent, attached: true }).rejections[0]).toContain(
      `there is no command-line tool with the ID "${absent}"`,
    );
    expect(turn(conversation, { kind: "cliToolAttach", agentId: agent.id, cliToolId: id, attached: false }).rejections[0]).toContain(
      `${agent.name} does not have "GitHub CLI", so there is nothing to change.`,
    );
    await call("cliTools:archive", { id });
    expect(turn(conversation, { kind: "cliToolAttach", agentId: agent.id, cliToolId: id, attached: true }).rejections[0]).toContain('"GitHub CLI" is archived');
    expect(getAgentCliTools(handle.db, agent.id).cliToolIds).toEqual([]);
  });
});

describe("what the system agent can do about CLIs without a person", () => {
  it("has no eo_admin tool that saves, archives or attaches a CLI directly", async () => {
    const offered = toolsFor(true, "admin");
    // No tool on eo_admin reaches a channel that writes the catalogue.
    for (const tool of offered) {
      expect(tool.channels, tool.name).not.toContain("cliTools:save");
      expect(tool.channels, tool.name).not.toContain("cliTools:archive");
      expect(tool.channels, tool.name).not.toContain("cliTools:restore");
    }
    // The one that reaches the tick refuses it there (mcpHost/cliTools.test.ts holds the refusal itself).
    const ticking = offered.filter((tool) => tool.channels.includes("agentCliTools:set")).map((tool) => tool.name);
    expect(ticking).toEqual(["agent_attachments_set"]);
    const agent = implementer();
    const id = gh();
    const answer = await TOOLS.find((tool) => tool.name === "agent_attachments_set")!.run(dispatchIpc, { agentId: agent.id, kind: "cliTool", id, attached: true }, { audience: "admin" });
    expect(answer).toMatchObject({ ok: true, refused: true });
    expect(getAgentCliTools(handle.db, agent.id).cliToolIds).toEqual([]);
    expect(listCliTools(handle.db, true)).toHaveLength(1);
  });
});
