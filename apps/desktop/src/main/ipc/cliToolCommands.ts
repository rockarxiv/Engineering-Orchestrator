import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { archiveCliTool, assignCliTools, getAgentCliTools, listAgentCliTools, listCliTools, restoreCliTool, saveCliTool, setAgentCliTool } from "../db/repos/index.js";
import { detectCliTool, draftCliToolDescription, type CliToolProbeOptions } from "../agentAttachments/cliTools.js";

/**
 * The command-line tool catalogue and which agents have which, over IPC
 * (EO-819). The shapes of `mcpServerCommands.ts` and
 * `agentAttachmentCommands.ts`: a refusal is a sentence in the answer,
 * never a throw, because everything that can go wrong here is something
 * a person typed or a race with another window.
 *
 * These are a person's channels: what goes in this catalogue is a
 * person's decision (EO-818). An outside client of EO's MCP server reaches
 * them as cli_tools_list, cli_tool_save, cli_tool_archive and the CLI
 * kind on agent_attachments_* (EO-822). EO's system agent reads the
 * catalogue and proposes the rest as a card a person presses
 * (roles/cliToolCards.ts).
 */

export function listCliToolsCommand(db: Db, input: IpcPayload<"cliTools:list">): IpcResponse<"cliTools:list"> {
  return { cliTools: listCliTools(db, input.includeArchived ?? false) };
}

export function saveCliToolCommand(db: Db, input: IpcPayload<"cliTools:save">): IpcResponse<"cliTools:save"> {
  const result = saveCliTool(db, input);
  if (!result.ok) return { saved: false, cliTool: null, problem: result.problems.join("\n") };
  return { saved: true, cliTool: result.cliTool, problem: null };
}

export function archiveCliToolCommand(db: Db, input: IpcPayload<"cliTools:archive">): IpcResponse<"cliTools:archive"> {
  if (!archiveCliTool(db, input.id)) return { archived: false, problem: "That command-line tool no longer exists." };
  return { archived: true, problem: null };
}

export function restoreCliToolCommand(db: Db, input: IpcPayload<"cliTools:restore">): IpcResponse<"cliTools:restore"> {
  if (!restoreCliTool(db, input.id)) return { restored: false, problem: "That command-line tool no longer exists." };
  return { restored: true, problem: null };
}

export function listAgentCliToolsCommand(db: Db, input: IpcPayload<"agentCliTools:list">): IpcResponse<"agentCliTools:list"> {
  // One agent asked about by name answers with its row even when empty,
  // as `agentAttachments:list` does.
  if (input.agentId !== undefined) return { attachments: [getAgentCliTools(db, input.agentId)] };
  return { attachments: listAgentCliTools(db) };
}

export function setAgentCliToolCommand(db: Db, input: IpcPayload<"agentCliTools:set">): IpcResponse<"agentCliTools:set"> {
  const result = setAgentCliTool(db, input);
  if (!result.ok) return { attachments: null, problem: result.problem };
  return { attachments: result.attachments, problem: null };
}

/**
 * Several CLIs added and ticked in one transaction (EO-859) — a
 * `cliToolsAssign` card's press. All or nothing: `problem` names the
 * row that was refused, and nothing is written.
 */
export function assignAgentCliToolsCommand(db: Db, input: IpcPayload<"agentCliTools:assign">): IpcResponse<"agentCliTools:assign"> {
  const result = assignCliTools(db, input);
  if (!result.ok) return { applied: false, problem: result.problem, added: [], ticks: [] };
  return { applied: true, problem: null, added: result.added, ticks: result.ticks };
}

/** Whether the command is installed here, on the PATH an agent is spawned with. */
export async function detectCliToolCommand(input: IpcPayload<"cliTools:detect">, options: CliToolProbeOptions = {}): Promise<IpcResponse<"cliTools:detect">> {
  return { detection: await detectCliTool(input.command, options) };
}

/** A suggested description for the editor to pre-fill. Saves nothing. */
export async function draftCliToolCommand(input: IpcPayload<"cliTools:draft">, options: CliToolProbeOptions = {}): Promise<IpcResponse<"cliTools:draft">> {
  return { draft: await draftCliToolDescription(input.command, options) };
}
