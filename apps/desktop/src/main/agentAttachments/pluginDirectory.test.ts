import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_MCP_SERVER_NAME, McpServerDraftSchema, SkillDraftSchema, type Agent, type McpServer, type Skill, UNSCOPED_RUN, type SkillScope } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, saveMcpServer, saveSkill, setAgentAttachment } from "../db/repos/index.js";
import { archiveMcpServer, setMcpServerEnabled } from "../db/repos/mcpServersRepo.js";
import { setSkillEnabled } from "../db/repos/skillsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { adminDeliveryFor } from "./adminDelivery.js";
import {
  qualifiedSkillName,
  readToolDirectoryServers,
  releaseItemToolDirectories,
  toolDirectoryFiles,
  toolDirectoryPath,
  toolDirectoryServerToolPrefixes,
  toolDirectorySkillNames,
  toolDirectorySkillsPromptSection,
  writeAgentToolDirectory,
  writeToolDirectory,
} from "./pluginDirectory.js";
import { readTree } from "../testing/tree.js";

/**
 * The generated directory, against a fixture (EO-107).
 *
 * A fixture rather than a set of assertions about fields, because what
 * this file produces is a contract with a binary EO downloads rather
 * than with a type it compiles against: no `.d.ts` says that
 * `.claude-plugin/plugin.json` is where the manifest goes, and nothing
 * would fail to compile if it moved. The fixture is checked in beside
 * this test, and the way to change it is to look at every line of the
 * diff and decide the binary still reads it.
 *
 * The layout it pins was established by running that binary: the same
 * directory, `--plugin-dir`, and the session's own init message
 * reporting the server connected and `eo-attachments:pr-review` among
 * its skills. How the servers in it are *delivered* changed after that —
 * `providers/claude.ts` says why — but what is written here did not.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tool-directory");

/** A token that only ever exists in this test's memory — nothing generated may contain it. */
const SECRET_VALUE = "ghp_liveSecretValue_0000";

function stdioServer(): McpServer {
  return {
    id: "0199cf00-0000-7000-8000-00000000000a",
    name: "github",
    description: "",
    config: { transport: "stdio", command: "gh-mcp", args: ["serve", "--stdio"] },
    envNames: ["GITHUB_TOKEN"],
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    connector: null,
  };
}

function remoteServer(): McpServer {
  return {
    id: "0199cf00-0000-7000-8000-00000000000b",
    name: "linear",
    description: "",
    config: { transport: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_KEY}" }, auth: { kind: "header" } },
    envNames: ["LINEAR_KEY"],
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    connector: null,
  };
}

function reviewSkill(): Skill {
  return {
    id: "0199cf00-0000-7000-8000-00000000000c",
    slug: "pr-review",
    name: "PR review",
    description: "How this house reviews a pull request.",
    body: "# PR review\n\nRead the whole diff before writing anything.\n",
    files: [{ path: "checklist.md", content: "- [ ] tests\n- [ ] docs\n" }],
    disableModelInvocation: false,
    enabled: true,
    scope: { kind: "global" },
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
  };
}

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo tool directory "));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the generated directory", () => {
  it("is the fixture, file for file and byte for byte", () => {
    const written = writeToolDirectory(join(scratch, "plugin"), {
      servers: [stdioServer(), remoteServer()],
      skills: [reviewSkill()],
    });

    expect(written).not.toBeNull();
    // Servers keep the name a person typed — the adapter hands them over
    // rather than letting the CLI discover them. A skill is offered
    // plugin-qualified, which is not what a person typed and is the
    // whole reason `qualifiedSkillName` exists.
    expect(written?.serverNames).toEqual(["github", "linear"]);
    expect(written?.skillNames).toEqual(["eo-attachments:pr-review"]);

    const generated = readTree(join(scratch, "plugin"));
    // The three the acceptance criteria name, present rather than merely
    // equal to something: a fixture that lost a file would otherwise
    // still match a generator that lost the same one.
    expect(Object.keys(generated).sort()).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "skills/pr-review/SKILL.md",
      "skills/pr-review/checklist.md",
    ]);
    expect(generated).toEqual(readTree(FIXTURE));
  });

  it("names a declared secret and never carries its value", () => {
    writeToolDirectory(join(scratch, "plugin"), { servers: [stdioServer(), remoteServer()], skills: [reviewSkill()] });
    const generated = readTree(join(scratch, "plugin"));

    // The reference is what reaches disk; the value arrives through the
    // provider's environment at spawn (`serverEnvironment.ts`).
    expect(generated[".mcp.json"]).toContain("${GITHUB_TOKEN}");
    expect(generated[".mcp.json"]).toContain("Bearer ${LINEAR_KEY}");
    for (const [path, content] of Object.entries(generated)) {
      expect(content, `${path} must not carry a secret`).not.toContain(SECRET_VALUE);
    }
  });

  it("delivers nothing that is disabled or archived, and no directory at all when that leaves nothing", () => {
    const disabled = { ...stdioServer(), enabled: false };
    const archived = { ...reviewSkill(), archivedAt: 1_700_000_000 };

    expect(toolDirectoryFiles({ servers: [disabled], skills: [archived] })).toEqual([]);
    expect(writeToolDirectory(join(scratch, "plugin"), { servers: [disabled], skills: [archived] })).toBeNull();
    expect(existsSync(join(scratch, "plugin"))).toBe(false);
  });

  /**
   * A row wearing a name EO keeps for itself never reaches the CLI
   * (EO-151).
   *
   * `readMcpServerDraft` refuses `eo` and `repo` at save time, so this
   * row is one that predates the reservation or arrived in a restored
   * database — written here the way the database would hold it rather
   * than through the validator that now refuses it, which is the only
   * way the case is reachable at all.
   *
   * It matters because these two names are *injected* servers: EO writes
   * `eo` and `repo` into the options the CLI is launched with, and this
   * directory is named to the same CLI with `--mcp-config`. Two entries
   * under one key is a collision the person cannot see and EO cannot
   * predict the winner of — the agent either loses the tools it talks to
   * EO through or queries somebody else's server believing it is the
   * index.
   *
   * Codex filtered these on its own merge and this path did not, which
   * is exactly the asymmetry that made the check worth sharing:
   * `isDeliverableMcpServer` is now one rule in `packages/core` and both
   * delivery mechanisms ask it.
   */
  it("withholds a server wearing a name EO keeps for its own, however the row got there", () => {
    const legacy = { ...stdioServer(), id: "0199cf00-0000-7000-8000-00000000000f", name: "repo", envNames: [] };
    const alsoEo = { ...stdioServer(), id: "0199cf00-0000-7000-8000-0000000000ee", name: "eo", envNames: [] };

    const written = writeToolDirectory(join(scratch, "plugin"), { servers: [legacy, alsoEo, stdioServer()], skills: [] });

    // The one legitimate server is still delivered, so this is a
    // reservation rather than a refusal of everything.
    expect(written?.serverNames).toEqual(["github"]);
    const config = readFileSync(join(scratch, "plugin", ".mcp.json"), "utf8");
    expect(Object.keys(JSON.parse(config).mcpServers)).toEqual(["github"]);
    // And the allowlist grant follows what is on disk, so an agent is
    // never permitted a server it was not given.
    expect(toolDirectoryServerToolPrefixes(join(scratch, "plugin"))).toEqual(["mcp__github"]);
  });

  it("writes no directory at all when a reserved name was the only thing attached", () => {
    // Not an empty `.mcp.json`: EO writes no directory rather than
    // pointing a backend at one with nothing in it, so a provider can
    // tell "nothing to deliver" from "delivered nothing".
    const legacy = { ...stdioServer(), name: "repo", envNames: [] };

    expect(toolDirectoryFiles({ servers: [legacy], skills: [] })).toEqual([]);
    expect(writeToolDirectory(join(scratch, "plugin"), { servers: [legacy], skills: [] })).toBeNull();
    expect(existsSync(join(scratch, "plugin"))).toBe(false);
  });

  it("rewrites rather than accumulates, so a detached skill stops being on disk", () => {
    const path = join(scratch, "plugin");
    writeToolDirectory(path, { servers: [], skills: [reviewSkill(), { ...reviewSkill(), id: "x", slug: "release-notes" }] });
    expect(existsSync(join(path, "skills", "release-notes", "SKILL.md"))).toBe(true);

    writeToolDirectory(path, { servers: [], skills: [reviewSkill()] });

    expect(existsSync(join(path, "skills", "pr-review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(path, "skills", "release-notes"))).toBe(false);
  });

  it("refuses a supporting file whose path would climb out of the directory", () => {
    const escaping: Skill = { ...reviewSkill(), files: [{ path: "../../escaped.md", content: "no" }] };

    writeToolDirectory(join(scratch, "plugin"), { servers: [], skills: [escaping] });

    expect(existsSync(join(scratch, "escaped.md"))).toBe(false);
    expect(Object.keys(readTree(join(scratch, "plugin")))).toEqual([".claude-plugin/plugin.json", "skills/pr-review/SKILL.md"]);
  });

  it("reads its own skills and servers back in the names the backend uses", () => {
    const path = join(scratch, "plugin");
    writeToolDirectory(path, { servers: [stdioServer()], skills: [reviewSkill()] });

    // Plugin-qualified, which is how a plugin's skill is offered.
    expect(toolDirectorySkillNames(path)).toEqual([qualifiedSkillName("pr-review")]);
    // The servers are handed to the SDK by the adapter rather than
    // discovered by the CLI (`--strict-mcp-config` would ignore them), so
    // they keep the plain name a person typed and their tools are
    // `mcp__github__*` — which is what an allowlist has to hold.
    expect(readToolDirectoryServers(path)).toEqual({
      github: { type: "stdio", command: "gh-mcp", args: ["serve", "--stdio"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    });
    expect(toolDirectoryServerToolPrefixes(path)).toEqual(["mcp__github"]);
  });

  it("refuses to read back an entry that is not one, rather than handing the SDK a half-formed server", () => {
    const path = join(scratch, "plugin");
    writeToolDirectory(path, { servers: [stdioServer(), remoteServer()], skills: [] });
    // The file is under `userData` and a person can edit it.
    writeFileSync(
      join(path, ".mcp.json"),
      JSON.stringify({ mcpServers: { github: { type: "stdio" }, linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
    );

    expect(Object.keys(readToolDirectoryServers(path))).toEqual(["linear"]);
  });

  it("rewrites nothing when the directory already holds exactly this", () => {
    const path = join(scratch, "plugin");
    const attachments = { servers: [stdioServer()], skills: [reviewSkill()] };
    writeToolDirectory(path, attachments);
    const before = statSync(join(path, ".mcp.json")).mtimeMs;

    // A resumed turn regenerates the directory it is about to be pointed
    // at. Delivering what is already there must not make it blink out of
    // existence and back.
    writeToolDirectory(path, attachments);

    expect(statSync(join(path, ".mcp.json")).mtimeMs).toBe(before);
  });

  it("answers nothing for a directory that is not there, rather than throwing at a turn about to start", () => {
    expect(toolDirectorySkillNames(join(scratch, "missing"))).toEqual([]);
    expect(toolDirectoryServerToolPrefixes(join(scratch, "missing"))).toEqual([]);
  });
});

/**
 * EO's own administrative server, delivered down the same path an
 * attached one is (EO-182).
 *
 * It goes through this file rather than inline beside `eo` and `repo` in
 * the provider because it is the only one of EO's own servers with a
 * credential to hand over. The arrangement that already exists here is
 * the only one that hands a CLI a bearer without putting it on a command
 * line every other local process can read: `${VAR}` in the file, the
 * value in the environment, expanded at spawn.
 *
 * So the property worth pinning is the same one the attached servers
 * have: **the reference reaches disk and the value never does.**
 */
describe("EO's administrative server in a generated directory", () => {
  const ADMIN_URL = "http://127.0.0.1:54321/mcp";
  const admin = { url: ADMIN_URL, envName: "EO_ADMIN_TOKEN" };
  /** The bearer, as it only ever exists in this test's memory. */
  const ADMIN_TOKEN = "eo-admin-token-nobody-may-write-down";

  it("writes an http entry with the bearer left as a variable reference", () => {
    const path = join(scratch, "plugin");

    const written = writeToolDirectory(path, { servers: [], skills: [] }, admin);

    expect(written?.serverNames).toEqual([ADMIN_MCP_SERVER_NAME]);
    expect(readToolDirectoryServers(path)).toEqual({
      [ADMIN_MCP_SERVER_NAME]: { type: "http", url: ADMIN_URL, headers: { Authorization: "Bearer ${EO_ADMIN_TOKEN}" } },
    });
    // Nothing written here could carry the value, because nothing here
    // was ever given it — but the assertion is what says so out loud.
    for (const [file, content] of Object.entries(readTree(path))) {
      expect(content, `${file} must not carry the bearer`).not.toContain(ADMIN_TOKEN);
    }
  });

  it("writes a directory for an agent that has attached nothing at all", () => {
    // The ordinary case for the agent that holds this: EO's system
    // agent, whose whole surface is EO itself. An early return counting
    // only catalogue rows would give it an empty directory and no
    // `--mcp-config` to be pointed at.
    expect(toolDirectoryFiles({ servers: [], skills: [] })).toEqual([]);

    const written = writeToolDirectory(join(scratch, "plugin"), { servers: [], skills: [] }, admin);

    expect(written).not.toBeNull();
    expect(existsSync(join(scratch, "plugin", ".mcp.json"))).toBe(true);
    // And the allowlist grant follows what is on disk, so the agent is
    // permitted the server it was actually given.
    expect(toolDirectoryServerToolPrefixes(join(scratch, "plugin"))).toEqual([`mcp__${ADMIN_MCP_SERVER_NAME}`]);
  });

  it("sits beside whatever a person attached, and cannot be displaced by any of it", () => {
    const path = join(scratch, "plugin");
    // A row wearing the reserved name, the way a database written before
    // the reservation would hold it. `isDeliverableMcpServer` withholds
    // it; the ordering here is the second lock, and the one that decides
    // the winner if the first ever fails.
    const impostor = { ...stdioServer(), id: "0199cf00-0000-7000-8000-0000000000ad", name: ADMIN_MCP_SERVER_NAME, envNames: [] };

    writeToolDirectory(path, { servers: [stdioServer(), impostor], skills: [reviewSkill()] }, admin);

    const servers = readToolDirectoryServers(path);
    expect(Object.keys(servers).sort()).toEqual([ADMIN_MCP_SERVER_NAME, "github"]);
    expect(servers[ADMIN_MCP_SERVER_NAME]).toMatchObject({ type: "http", url: ADMIN_URL });
    expect(toolDirectorySkillNames(path)).toEqual([qualifiedSkillName("pr-review")]);
  });

  it("leaves every other agent's directory exactly as it was", () => {
    const path = join(scratch, "plugin");

    const written = writeToolDirectory(path, { servers: [stdioServer()], skills: [] }, null);

    expect(written?.serverNames).toEqual(["github"]);
    expect(Object.keys(readToolDirectoryServers(path))).toEqual(["github"]);
    expect(readFileSync(join(path, ".mcp.json"), "utf8")).not.toContain(ADMIN_MCP_SERVER_NAME);
  });

  it("still rewrites nothing when the same delivery comes round again", () => {
    // The narrowing `writeToolDirectory` makes for attached servers has
    // to hold for this one too: a resumed turn regenerates the directory
    // it is about to be pointed at, and a file that blinks out of
    // existence and back is a server the CLI may fail to read.
    const path = join(scratch, "plugin");
    writeToolDirectory(path, { servers: [], skills: [] }, admin);
    const before = statSync(join(path, ".mcp.json")).mtimeMs;

    writeToolDirectory(path, { servers: [], skills: [] }, admin);

    expect(statSync(join(path, ".mcp.json")).mtimeMs).toBe(before);
  });
});

describe("a directory for one agent on one item", () => {
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

  function attachServer(agent: Agent, name: string) {
    const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "gh-mcp", envNames: ["GITHUB_TOKEN"] }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: agent.id, kind: "mcpServer", id: saved.server.id, attached: true });
    return saved.server;
  }

  function attachSkill(agent: Agent, name: string, scope?: SkillScope) {
    const saved = saveSkill(handle.db, SkillDraftSchema.parse({ name, description: "A house playbook.", body: "Read the diff.", ...(scope ? { scope } : {}) }));
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    setAgentAttachment(handle.db, { agentId: agent.id, kind: "skill", id: saved.skill.id, attached: true });
    return saved.skill;
  }

  it("is keyed by item and agent, so two agents on one item do not share one", () => {
    attachServer(implementer, "github");
    attachSkill(reviewer, "House style");

    const forImplementer = writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN });
    const forReviewer = writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: reviewer.id, scope: UNSCOPED_RUN });

    expect(forImplementer?.path).toBe(toolDirectoryPath(scratch, "T-1", implementer.id));
    expect(forImplementer?.serverNames).toEqual(["github"]);
    expect(forImplementer?.skillNames).toEqual([]);
    expect(forReviewer?.skillNames).toEqual(["eo-attachments:house-style"]);
    expect(forReviewer?.serverNames).toEqual([]);
  });

  it("stops delivering a server the moment somebody disables or archives it", () => {
    const github = attachServer(implementer, "github");
    expect(writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN })).not.toBeNull();

    setMcpServerEnabled(handle.db, github.id, false);
    expect(writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN })).toBeNull();

    setMcpServerEnabled(handle.db, github.id, true);
    archiveMcpServer(handle.db, github.id);
    expect(writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN })).toBeNull();
  });

  it("writes only the skills whose scope takes the run in (EO-470)", () => {
    attachSkill(implementer, "House style");
    attachSkill(implementer, "E2E for P", { kind: "project", projectId: "project-p" });
    attachSkill(implementer, "E2E for Q", { kind: "project", projectId: "project-q" });
    attachSkill(implementer, "Build in W", { kind: "workspace", workspaceId: "workspace-w" });
    attachSkill(implementer, "Build in V", { kind: "workspace", workspaceId: "workspace-v" });

    const onP = writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: { projectId: "project-p", workspaceId: "workspace-w" } });
    expect(onP?.skillNames).toEqual(["eo-attachments:build-in-w", "eo-attachments:e2e-for-p", "eo-attachments:house-style"]);
    expect(existsSync(join(onP?.path ?? "", "skills", "e2e-for-q"))).toBe(false);
    expect(existsSync(join(onP?.path ?? "", "skills", "build-in-v"))).toBe(false);

    // Nowhere in particular: the global skill and nothing scoped.
    const unscoped = writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-2", agentId: implementer.id, scope: UNSCOPED_RUN });
    expect(unscoped?.skillNames).toEqual(["eo-attachments:house-style"]);
  });

  it("stops delivering a skill the moment somebody disables it", () => {
    const playbook = attachSkill(implementer, "House style");
    setSkillEnabled(handle.db, playbook.id, false);

    expect(writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN })).toBeNull();
  });

  it("lets go of every agent's directory for an item at once, and of nothing else", () => {
    attachServer(implementer, "github");
    attachSkill(reviewer, "House style");
    writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: implementer.id, scope: UNSCOPED_RUN });
    writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-1", agentId: reviewer.id, scope: UNSCOPED_RUN });
    writeAgentToolDirectory(handle.db, { root: scratch, itemId: "T-2", agentId: implementer.id, scope: UNSCOPED_RUN });

    releaseItemToolDirectories(scratch, "T-1");

    expect(existsSync(join(scratch, "T-1"))).toBe(false);
    expect(existsSync(toolDirectoryPath(scratch, "T-2", implementer.id))).toBe(true);
    // An item that never had one is the ordinary case, not a failure.
    expect(() => releaseItemToolDirectories(scratch, "T-3")).not.toThrow();
  });

  /**
   * The whole path a dispatch actually takes (EO-182): a row in `agents`
   * whose `allowedTools` names EO's administrative server, through the
   * predicate that reads it, into the file the CLI is pointed at.
   *
   * Written here rather than as three assertions in three files because
   * the failure worth catching is a seam rather than a function: a grant
   * read one way in the directory writer and another in the environment
   * builder is a server that connects and 401s on every call.
   */
  it("delivers EO's administrative server to the agent whose allowlist names it, and to no other", () => {
    const host = () => ({ url: "http://127.0.0.1:54321/mcp", lease: () => ({ token: "eo-admin-token-nobody-may-write-down", release: () => {} }) });
    const system = { ...implementer, config: { allowedTools: ["Read", `mcp__${ADMIN_MCP_SERVER_NAME}`] } };
    attachServer(reviewer, "github");

    const forSystem = writeAgentToolDirectory(handle.db, {
      scope: UNSCOPED_RUN,
      root: scratch,
      itemId: "T-1",
      agentId: system.id,
      admin: adminDeliveryFor(system, host),
    });
    const forReviewer = writeAgentToolDirectory(handle.db, {
      scope: UNSCOPED_RUN,
      root: scratch,
      itemId: "T-1",
      agentId: reviewer.id,
      admin: adminDeliveryFor(reviewer, host),
    });

    expect(forSystem?.serverNames).toEqual([ADMIN_MCP_SERVER_NAME]);
    expect(readToolDirectoryServers(forSystem?.path ?? "")).toEqual({
      [ADMIN_MCP_SERVER_NAME]: { type: "http", url: "http://127.0.0.1:54321/mcp", headers: { Authorization: "Bearer ${EO_ADMIN_TOKEN}" } },
    });
    // The reviewer is a step-owning agent, and invariant #11 is that it
    // gets exactly the surface it had.
    expect(forReviewer?.serverNames).toEqual(["github"]);
    expect(Object.keys(readToolDirectoryServers(forReviewer?.path ?? ""))).toEqual(["github"]);
  });
});

describe("toolDirectorySkillsPromptSection", () => {
  it("names each skill the directory offers by its Skill tool name and description, and says to invoke it with the Skill tool (EO-602)", () => {
    const path = join(scratch, "plugin");
    const release: Skill = { ...reviewSkill(), id: "0199cf00-0000-7000-8000-00000000000d", slug: "release", description: 'Ship it: "carefully".\nThen tag.' };
    writeToolDirectory(path, { servers: [], skills: [reviewSkill(), release] });

    const section = toolDirectorySkillsPromptSection(path);

    expect(section).toContain("## Skills");
    expect(section).toContain("- `eo-attachments:pr-review` — How this house reviews a pull request.");
    // Read back through the frontmatter's escapes, onto one line.
    expect(section).toContain('- `eo-attachments:release` — Ship it: "carefully". Then tag.');
    expect(section).toContain("invoke it with the Skill tool");
    expect(section).toContain("Skip this entirely when none of them applies");
    // The body is read once the skill is invoked, never in the prompt.
    expect(section).not.toContain("Read the whole diff");
  });

  it("is empty when the directory offers the model nothing to choose", () => {
    const path = join(scratch, "plugin");
    writeToolDirectory(path, { servers: [stdioServer()], skills: [{ ...reviewSkill(), disableModelInvocation: true }] });

    // On disk and in the allowlist, for a person to invoke; not offered to the model.
    expect(toolDirectorySkillNames(path)).toEqual([qualifiedSkillName("pr-review")]);
    expect(toolDirectorySkillsPromptSection(path)).toBe("");
    expect(toolDirectorySkillsPromptSection(join(scratch, "absent"))).toBe("");
  });
});
