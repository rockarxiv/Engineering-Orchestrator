import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ipcContract, McpServerDraftSchema, type Agent, type IpcChannel, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { deleteAgent, listAgents, resolveAgentAttachments, saveMcpServer, setAgentAttachment } from "../db/repos/index.js";
import { sectionLockFor } from "../managed/locks.js";
import {
  archiveCliToolCommand,
  detectCliToolCommand,
  draftCliToolCommand,
  listAgentCliToolsCommand,
  listCliToolsCommand,
  restoreCliToolCommand,
  saveCliToolCommand,
  setAgentCliToolCommand,
} from "./cliToolCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { resetSearchPathForTests, resolveSearchPath } from "../process/searchPath.js";

/**
 * The command-line tool catalogue over IPC (EO-819), against the real
 * migrations on an in-memory database.
 */
let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = agents.find((agent) => agent.role === "implementer")!;
  reviewer = agents.find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

function save(command: string, name = `${command} CLI`, description = "") {
  const answer = saveCliToolCommand(handle.db, { name, command, description });
  if (!answer.saved || answer.cliTool === null) throw new Error(answer.problem ?? "not saved");
  return answer.cliTool;
}

describe("cliTools:save", () => {
  it("creates a CLI with a client-side UUIDv7 and the fields as typed, trimmed", () => {
    const answer = saveCliToolCommand(handle.db, { name: " GitHub CLI ", command: " gh ", description: " Pull requests and issues. " });
    expect(answer.saved).toBe(true);
    expect(answer.problem).toBeNull();
    expect(answer.cliTool!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(answer.cliTool).toMatchObject({ name: "GitHub CLI", command: "gh", description: "Pull requests and issues.", archivedAt: null });
  });

  it("edits a CLI in place", () => {
    const gh = save("gh");
    const answer = saveCliToolCommand(handle.db, { id: gh.id, name: "GitHub", command: "gh", description: "Issues." });
    expect(answer.cliTool).toMatchObject({ id: gh.id, name: "GitHub", description: "Issues.", createdAt: gh.createdAt });
    expect(listCliToolsCommand(handle.db, {}).cliTools).toHaveLength(1);
  });

  it("refuses, as sentences, a missing name, a command with arguments and a relative path", () => {
    expect(saveCliToolCommand(handle.db, { name: "", command: "gh pr", description: "" })).toEqual({
      saved: false,
      cliTool: null,
      problem: 'A command-line tool needs a name.\n"gh pr" has a space in it: enter only the program, like `gh`, not its arguments.',
    });
    expect(saveCliToolCommand(handle.db, { name: "Tool", command: "bin/tool", description: "" }).problem).toContain("relative path");
    expect(saveCliToolCommand(handle.db, { name: "Tool", command: "", description: "" }).problem).toContain("needs the command");
    expect(listCliToolsCommand(handle.db, {}).cliTools).toEqual([]);
  });

  it("accepts an absolute path", () => {
    expect(saveCliToolCommand(handle.db, { name: "Tool", command: "/opt/acme/bin/acme", description: "" }).saved).toBe(true);
  });

  it("refuses a second CLI for a command the catalogue already has, and says to restore an archived one", () => {
    const gh = save("gh");
    expect(saveCliToolCommand(handle.db, { name: "Other", command: "gh", description: "" }).problem).toBe('"gh CLI" already runs `gh`.');
    archiveCliToolCommand(handle.db, { id: gh.id });
    expect(saveCliToolCommand(handle.db, { name: "Other", command: "gh", description: "" }).problem).toContain("Restore it instead");
  });

  it("refuses to edit a CLI that is gone", () => {
    expect(saveCliToolCommand(handle.db, { id: "01900000-0000-7000-8000-000000000000", name: "x", command: "x", description: "" }).problem).toBe(
      "That command-line tool no longer exists.",
    );
  });
});

describe("cliTools:list, archive and restore", () => {
  it("lists live CLIs by name, and archived ones only when asked", () => {
    const kubectl = save("kubectl", "Kubernetes");
    const gh = save("gh", "GitHub CLI");
    expect(listCliToolsCommand(handle.db, {}).cliTools.map((tool) => tool.id)).toEqual([gh.id, kubectl.id]);

    expect(archiveCliToolCommand(handle.db, { id: gh.id })).toEqual({ archived: true, problem: null });
    expect(listCliToolsCommand(handle.db, {}).cliTools.map((tool) => tool.id)).toEqual([kubectl.id]);
    const all = listCliToolsCommand(handle.db, { includeArchived: true }).cliTools;
    expect(all.map((tool) => tool.id)).toEqual([gh.id, kubectl.id]);
    expect(all[0]!.archivedAt).not.toBeNull();

    expect(restoreCliToolCommand(handle.db, { id: gh.id })).toEqual({ restored: true, problem: null });
    expect(listCliToolsCommand(handle.db, {}).cliTools.map((tool) => tool.id)).toEqual([gh.id, kubectl.id]);
  });

  it("is idempotent, and refuses an id nothing carries", () => {
    const gh = save("gh");
    archiveCliToolCommand(handle.db, { id: gh.id });
    expect(archiveCliToolCommand(handle.db, { id: gh.id })).toEqual({ archived: true, problem: null });
    restoreCliToolCommand(handle.db, { id: gh.id });
    expect(restoreCliToolCommand(handle.db, { id: gh.id })).toEqual({ restored: true, problem: null });
    expect(archiveCliToolCommand(handle.db, { id: "nope" })).toEqual({ archived: false, problem: "That command-line tool no longer exists." });
    expect(restoreCliToolCommand(handle.db, { id: "nope" })).toEqual({ restored: false, problem: "That command-line tool no longer exists." });
  });
});

describe("agentCliTools:set and list", () => {
  it("attaches and detaches, idempotently both ways", () => {
    const gh = save("gh");
    const kubectl = save("kubectl");

    expect(setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: true })).toEqual({
      attachments: { agentId: implementer.id, cliToolIds: [gh.id] },
      problem: null,
    });
    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: true });
    expect(setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: kubectl.id, attached: true }).attachments?.cliToolIds).toEqual([
      gh.id,
      kubectl.id,
    ]);

    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: false });
    expect(setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: false }).attachments).toEqual({
      agentId: implementer.id,
      cliToolIds: [kubectl.id],
    });
  });

  it("lists one agent's, even when empty, and every agent that has any", () => {
    const gh = save("gh");
    expect(listAgentCliToolsCommand(handle.db, { agentId: reviewer.id })).toEqual({ attachments: [{ agentId: reviewer.id, cliToolIds: [] }] });
    expect(listAgentCliToolsCommand(handle.db, {})).toEqual({ attachments: [] });

    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: true });
    setAgentCliToolCommand(handle.db, { agentId: reviewer.id, cliToolId: gh.id, attached: true });
    expect(listAgentCliToolsCommand(handle.db, {}).attachments).toEqual(
      [
        { agentId: implementer.id, cliToolIds: [gh.id] },
        { agentId: reviewer.id, cliToolIds: [gh.id] },
      ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
  });

  it("refuses a missing agent or CLI with a sentence", () => {
    const gh = save("gh");
    expect(setAgentCliToolCommand(handle.db, { agentId: "nope", cliToolId: gh.id, attached: true })).toEqual({
      attachments: null,
      problem: "That agent no longer exists.",
    });
    expect(setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: "nope", attached: true })).toEqual({
      attachments: null,
      problem: "That command-line tool no longer exists.",
    });
  });

  it("keeps an archived CLI attached, and the attachment goes with its agent", () => {
    const gh = save("gh");
    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: true });
    archiveCliToolCommand(handle.db, { id: gh.id });
    expect(listAgentCliToolsCommand(handle.db, { agentId: implementer.id }).attachments[0]!.cliToolIds).toEqual([gh.id]);

    deleteAgent(handle.db, implementer.id as Uuid);
    expect(listAgentCliToolsCommand(handle.db, {}).attachments).toEqual([]);
  });
});

describe("resolveAgentAttachments, with CLIs", () => {
  it("returns the agent's attached CLIs that are not archived, beside its servers and skills", () => {
    const gh = save("gh", "GitHub CLI");
    const kubectl = save("kubectl", "Kubernetes");
    save("psql", "Postgres");
    const server = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
    if (!server.ok) throw new Error("server not saved");
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: server.server.id, attached: true });
    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: gh.id, attached: true });
    setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: kubectl.id, attached: true });
    setAgentCliToolCommand(handle.db, { agentId: reviewer.id, cliToolId: kubectl.id, attached: true });

    const resolved = resolveAgentAttachments(handle.db, implementer.id);
    expect(resolved.servers.map((s) => s.name)).toEqual(["github"]);
    expect(resolved.cliTools.map((tool) => tool.command)).toEqual(["gh", "kubectl"]);

    archiveCliToolCommand(handle.db, { id: gh.id });
    expect(resolveAgentAttachments(handle.db, implementer.id).cliTools.map((tool) => tool.command)).toEqual(["kubectl"]);
    expect(resolveAgentAttachments(handle.db, reviewer.id).cliTools.map((tool) => tool.command)).toEqual(["kubectl"]);
  });
});

describe("the contract", () => {
  const options = { exposeErrorDetails: true, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(handle.db, channel, payload) };

  it("round-trips every channel through the IPC door, with its schemas", async () => {
    const saved = await handleIpcRequest("cliTools:save", { name: "GitHub CLI", command: "gh" }, (payload) => saveCliToolCommand(handle.db, payload), options);
    expect(saved.ok && saved.data.saved).toBe(true);
    const id = saved.ok ? saved.data.cliTool!.id : "";

    const calls: [IpcChannel, unknown, () => unknown][] = [
      ["cliTools:list", { includeArchived: true }, () => listCliToolsCommand(handle.db, { includeArchived: true })],
      ["agentCliTools:set", { agentId: implementer.id, cliToolId: id, attached: true }, () => setAgentCliToolCommand(handle.db, { agentId: implementer.id, cliToolId: id, attached: true })],
      ["agentCliTools:list", {}, () => listAgentCliToolsCommand(handle.db, {})],
      ["cliTools:archive", { id }, () => archiveCliToolCommand(handle.db, { id })],
      ["cliTools:restore", { id }, () => restoreCliToolCommand(handle.db, { id })],
    ];
    for (const [channel, payload, run] of calls) {
      const answer = await handleIpcRequest(channel, payload, run as never, options);
      expect(answer.ok, channel).toBe(true);
    }
    // A refusal is an answer the contract accepts, not an error.
    const refused = await handleIpcRequest("cliTools:save", { name: "", command: "" }, (payload) => saveCliToolCommand(handle.db, payload), options);
    expect(refused.ok && refused.data.problem).toContain("needs a name");
    expect(ipcContract["cliTools:save"].request.safeParse({ name: "x", command: "x" }).success).toBe(true);
  });

  // Windows searches the inherited PATH, as `cliTools.test.ts` holds.
  it.skipIf(process.platform === "win32")("answers detect found for a CLI only the login shell's PATH has, as an app started from the Dock inherits launchd's PATH (EO-906)", async () => {
    const bin = mkdtempSync(join(tmpdir(), "eo-cli-detect-"));
    writeFileSync(join(bin, "foo"), "#!/bin/sh\necho foo\n");
    chmodSync(join(bin, "foo"), 0o755);
    vi.stubEnv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    try {
      await resolveSearchPath({ shell: "/bin/zsh", run: async () => ({ code: 0, stdout: `__EO_LOGIN_SHELL_PATH_START__\n${bin}:/usr/bin\n__EO_LOGIN_SHELL_PATH_END__\n`, timedOut: false }) });

      const answer = await handleIpcRequest("cliTools:detect", { command: "foo" }, (payload) => detectCliToolCommand(payload), options);

      expect(answer.ok && answer.data).toEqual({ detection: { found: true, path: join(bin, "foo") } });
    } finally {
      resetSearchPathForTests();
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("answers detect and draft for this machine, and never throws for a command that is not there", async () => {
    const env = { PATH: dirname(process.execPath) };
    const node = process.execPath.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    const found = await detectCliToolCommand({ command: node }, { env });
    expect(found.detection).toMatchObject({ found: true, path: process.execPath });
    expect(ipcContract["cliTools:detect"].response.safeParse(found).success).toBe(true);

    expect(await detectCliToolCommand({ command: "eo-no-such-cli" }, { env })).toEqual({ detection: { found: false } });
    const draft = await draftCliToolCommand({ command: "eo-no-such-cli" }, { env });
    expect(draft).toEqual({ draft: { description: "" } });
    expect(ipcContract["cliTools:draft"].response.safeParse(draft).success).toBe(true);
  });
});
