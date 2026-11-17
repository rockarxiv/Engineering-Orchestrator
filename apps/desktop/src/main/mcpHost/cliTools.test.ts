import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getAgentCliTools, getCliTool, listAgents, listCliTools, saveCliTool, setAgentCliTool } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { adminDeliveryFor } from "../agentAttachments/adminDelivery.js";
import { listAgentAttachmentsCommand, setAgentAttachmentCommand } from "../ipc/agentAttachmentCommands.js";
import {
  archiveCliToolCommand,
  listAgentCliToolsCommand,
  listCliToolsCommand,
  saveCliToolCommand,
  setAgentCliToolCommand,
} from "../ipc/cliToolCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { CLI_TOOL_ATTACH_ADMIN_REFUSAL, TOOLS } from "./catalog.js";
import { toolsFor } from "./gate.js";
import { answerToolCall } from "./server.js";

/**
 * The command-line tool catalogue over EO's MCP server (EO-822).
 *
 * An outside client lists, saves and archives CLIs and ticks them onto
 * agents, through the channels the Agent tools screen calls. EO's system
 * agent, over `eo_admin`, may read the catalogue and nothing more: it
 * proposes a CLI as a card a person presses (assistCliToolCards.test.ts).
 * And no step agent is served any of it.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  const opts = { exposeErrorDetails: true };
  registerHandler("cliTools:list", (payload) => listCliToolsCommand(handle.db, payload), opts);
  registerHandler("cliTools:save", (payload) => saveCliToolCommand(handle.db, payload), opts);
  registerHandler("cliTools:archive", (payload) => archiveCliToolCommand(handle.db, payload), opts);
  registerHandler("agentCliTools:list", (payload) => listAgentCliToolsCommand(handle.db, payload), opts);
  registerHandler("agentCliTools:set", (payload) => setAgentCliToolCommand(handle.db, payload), opts);
  registerHandler("agentAttachments:list", (payload) => listAgentAttachmentsCommand(handle.db, payload), opts);
  registerHandler("agentAttachments:set", (payload) => setAgentAttachmentCommand(handle.db, payload), opts);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(name: string, args: Record<string, unknown>, audience: "admin" | "external" = "external") {
  return answerToolCall({ name, arguments: args }, audience, false);
}

function textOf(result: CallToolResult): string {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function gh(): string {
  const saved = saveCliTool(handle.db, { name: "GitHub CLI", command: "gh", description: "Pull requests and issues on GitHub." });
  if (!saved.ok) throw new Error(saved.problems.join(" "));
  return saved.cliTool.id;
}

const agentOf = (role: string) => listAgents(handle.db).find((agent) => agent.role === role)!;

/** Every tool that writes the CLI catalogue or ticks a CLI on an agent. */
const CLI_WRITES = ["cli_tool_save", "cli_tool_archive"] as const;

describe("the CLI catalogue, from an outside client", () => {
  it("lists the catalogue, archived rows only when asked", async () => {
    const id = gh();
    saveCliTool(handle.db, { name: "Kubernetes", command: "kubectl", description: "" });
    archiveCliToolCommand(handle.db, { id: listCliTools(handle.db).find((tool) => tool.command === "kubectl")!.id });

    const live = textOf(await call("cli_tools_list", {}));
    expect(live).toContain(`GitHub CLI (command: \`gh\`, id: ${id})`);
    expect(live).toContain("Pull requests and issues on GitHub.");
    expect(live).not.toContain("kubectl");

    const all = textOf(await call("cli_tools_list", { includeArchived: true }));
    expect(all).toContain("kubectl");
    expect(all).toContain("archived");
  });

  it("saves one through cliTools:save, and edits it in place", async () => {
    const added = await call("cli_tool_save", { name: "GitHub CLI", command: "gh", description: "Pull requests." });
    expect(added.isError).toBe(false);
    expect(textOf(added)).toContain("Saved GitHub CLI (command: `gh`");
    expect(textOf(added)).toContain("no agent is told about it until it is attached");
    const [row] = listCliTools(handle.db);
    expect(row).toMatchObject({ name: "GitHub CLI", command: "gh", description: "Pull requests." });

    await call("cli_tool_save", { id: row!.id, name: "GitHub CLI", command: "gh", description: "Pull requests and issues." });
    expect(getCliTool(handle.db, row!.id)?.description).toBe("Pull requests and issues.");
    expect(listCliTools(handle.db)).toHaveLength(1);
  });

  it("answers a refusal as the channel's sentence, with nothing saved", async () => {
    gh();
    const twice = await call("cli_tool_save", { name: "Another", command: "gh", description: "" });
    expect(twice.isError).toBe(false);
    expect(textOf(twice)).toBe('Nothing was saved: "GitHub CLI" already runs `gh`. Nothing has changed.');

    const spaced = await call("cli_tool_save", { name: "PRs", command: "gh pr", description: "" });
    expect(textOf(spaced)).toContain("Nothing was saved:");
    expect(listCliTools(handle.db)).toHaveLength(1);
  });

  it("archives one through cliTools:archive, keeping the row", async () => {
    const id = gh();
    const archived = await call("cli_tool_archive", { id });
    expect(textOf(archived)).toContain("Command-line tool archived.");
    expect(getCliTool(handle.db, id)?.archivedAt).not.toBeNull();

    const missing = await call("cli_tool_archive", { id: "019a0000-0000-7000-8000-000000000822" });
    expect(textOf(missing)).toBe("Nothing was archived: That command-line tool no longer exists. Nothing has changed.");
  });

  it("is classed the way the MCP server tools are: a read, and two ordinary writes the archive of which warns", () => {
    const tool = (name: string) => TOOLS.find((candidate) => candidate.name === name)!;
    expect(tool("cli_tools_list").kind).toBe("read");
    expect(tool("cli_tools_list").channels).toEqual(["cliTools:list"]);
    expect(tool("cli_tool_save")).toMatchObject({ kind: "write", channels: ["cliTools:save"] });
    expect(tool("cli_tool_archive")).toMatchObject({ kind: "write", channels: ["cliTools:archive"] });
    expect(tool("cli_tool_archive").annotations.destructiveHint).toBe(true);
    expect(tool("mcp_server_archive")).toMatchObject({ kind: tool("cli_tool_archive").kind });
    expect(tool("mcp_server_save")).toMatchObject({ kind: tool("cli_tool_save").kind });
    // In front of a client that has not opened the destructive gate, as the MCP server writes are.
    const offered = toolsFor(false, "external").map((offeredTool) => offeredTool.name);
    for (const name of ["cli_tools_list", ...CLI_WRITES]) expect(offered).toContain(name);
  });
});

describe("an agent's CLIs, through agent_attachments_list and agent_attachments_set", () => {
  it("reports each agent's CLIs beside its servers and skills", async () => {
    const id = gh();
    const implementer = agentOf("implementer");
    setAgentCliTool(handle.db, { agentId: implementer.id, cliToolId: id, attached: true });

    const one = await call("agent_attachments_list", { agentId: implementer.id });
    expect(textOf(one)).toContain(`- agent ${implementer.id} — command-line tools: ${id}`);
    expect(one.structuredContent).toMatchObject({ attachments: [{ agentId: implementer.id, mcpServerIds: [], skillIds: [], cliToolIds: [id] }] });
    expect(textOf(one)).toContain("cli_tools_list");

    const all = await call("agent_attachments_list", {});
    expect(textOf(all)).toContain(`command-line tools: ${id}`);

    const reviewer = agentOf("reviewer");
    const none = await call("agent_attachments_list", { agentId: reviewer.id });
    expect(none.structuredContent).toMatchObject({ attachments: [{ agentId: reviewer.id, cliToolIds: [] }] });
  });

  it("attaches and detaches a CLI from an outside client", async () => {
    const id = gh();
    const implementer = agentOf("implementer");

    const attached = await call("agent_attachments_set", { agentId: implementer.id, kind: "cliTool", id, attached: true });
    expect(attached.isError).toBe(false);
    expect(textOf(attached)).toContain(`Agent ${implementer.id} will be told about:`);
    expect(textOf(attached)).toContain(`GitHub CLI (\`gh\`, id: ${id})`);
    expect(getAgentCliTools(handle.db, implementer.id).cliToolIds).toEqual([id]);

    const detached = await call("agent_attachments_set", { agentId: implementer.id, kind: "cliTool", id, attached: false });
    expect(textOf(detached)).toContain("is told about no command-line tools");
    expect(getAgentCliTools(handle.db, implementer.id).cliToolIds).toEqual([]);
  });

  it("says an archived CLI is attached and not told, and refuses one that does not exist", async () => {
    const id = gh();
    archiveCliToolCommand(handle.db, { id });
    const implementer = agentOf("implementer");

    const archived = await call("agent_attachments_set", { agentId: implementer.id, kind: "cliTool", id, attached: true });
    expect(textOf(archived)).toContain("Attached, and archived, so not told:");

    const missing = await call("agent_attachments_set", { agentId: implementer.id, kind: "cliTool", id: "019a0000-0000-7000-8000-000000000822", attached: true });
    expect(textOf(missing)).toBe("Nothing was attached or detached: That command-line tool no longer exists. Nothing has changed.");
  });
});

describe("EO's system agent and the CLI catalogue", () => {
  const admin = () => toolsFor(true, "admin").map((tool) => tool.name);

  it("may read the catalogue and each agent's CLIs", async () => {
    gh();
    expect(admin()).toContain("cli_tools_list");
    expect(admin()).toContain("agent_attachments_list");
    expect(textOf(await call("cli_tools_list", {}, "admin"))).toContain("GitHub CLI");
  });

  it("is offered no tool that saves or archives a CLI, and a call to one finds nothing", async () => {
    for (const name of CLI_WRITES) {
      expect(admin()).not.toContain(name);
      const answer = await call(name, { name: "GitHub CLI", command: "gh", description: "", id: "x" }, "admin");
      expect(answer.isError).toBe(true);
      expect(textOf(answer)).toBe(`EO has no tool named "${name}".`);
    }
    expect(listCliTools(handle.db, true)).toEqual([]);
  });

  it("is refused a CLI tick on agent_attachments_set, with nothing changed, and told to offer a card", async () => {
    const id = gh();
    const implementer = agentOf("implementer");

    const answer = await call("agent_attachments_set", { agentId: implementer.id, kind: "cliTool", id, attached: true }, "admin");
    expect(textOf(answer)).toBe(CLI_TOOL_ATTACH_ADMIN_REFUSAL);
    expect(CLI_TOOL_ATTACH_ADMIN_REFUSAL).toContain("`cliToolAttach` card");
    expect(getAgentCliTools(handle.db, implementer.id).cliToolIds).toEqual([]);

    // And a call that does not say which listener it came on is the
    // stricter answer, not the outside client's.
    const direct = await TOOLS.find((tool) => tool.name === "agent_attachments_set")!.run(
      (channel, payload) => dispatchIpc(channel, payload),
      { agentId: implementer.id, kind: "cliTool", id, attached: true },
    );
    expect(direct).toMatchObject({ ok: true, refused: true, text: CLI_TOOL_ATTACH_ADMIN_REFUSAL });
    expect(getAgentCliTools(handle.db, implementer.id).cliToolIds).toEqual([]);
  });
});

describe("step agents and the CLI catalogue", () => {
  it("serves no step-owning agent EO's administrative server, so none is offered a CLI tool there", () => {
    const host = () => ({ url: "http://127.0.0.1:1/mcp", lease: () => ({ token: "t", release: () => {} }) });
    const stepAgents = listAgents(handle.db).filter((agent) => agent.role !== "system");
    expect(stepAgents.map((agent) => agent.role)).toEqual(expect.arrayContaining(["implementer", "reviewer"]));
    for (const agent of stepAgents) expect(adminDeliveryFor(agent, host), agent.role).toBeNull();
  });

  it("offers no CLI tool on the `eo` server every step agent is dispatched with", () => {
    // The step agents' server is its own program, which reaches EO through
    // the write bridge and never through the catalogue's channels.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../mcp/eoServer.mjs"), "utf8");
    for (const word of ["cliTools", "agentCliTools", "cli_tool", "agent_attachments"]) expect(source, word).not.toContain(word);
  });
});
