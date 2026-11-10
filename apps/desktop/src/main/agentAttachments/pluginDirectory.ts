import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, isDeliverableMcpServer, renderSkillMarkdown, yamlUnquoted, type McpServer, type Skill, type SkillRunScope } from "@eo/core";
import type { Db } from "../db/client.js";
import { resolveAgentAttachmentsForRun, type ResolvedAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";
import type { AdminMcpDelivery } from "./adminDelivery.js";
import { skillsPromptSection, type OfferedSkill } from "./skillsPrompt.js";

/**
 * The directory an agent's attached servers and skills are delivered in
 * (EO-107).
 *
 * **This layout is a contract with a binary, not with a type.** The
 * Claude Agent SDK's `plugins: [{type:"local", path}]` becomes
 * `--plugin-dir <path>` on the CLI's command line, and everything the
 * CLI then does with that path — which files it opens, what it calls
 * what it finds — is in no `.d.ts` EO can compile against. So it was
 * established by running the binary EO downloads, and the fixture in
 * `pluginDirectory.test.ts` is what keeps this file honest about it.
 *
 * What the run showed, and each line of it decides something here:
 *
 * - `.claude-plugin/plugin.json` at the root is the manifest; `.mcp.json`
 *   at the root carries `mcpServers`; `skills/<slug>/SKILL.md` is a
 *   skill. Nothing is nested under a further directory.
 * - A server delivered this way is registered as
 *   **`plugin:<plugin>:<server>`**, and its tools as
 *   `mcp__plugin_<plugin>_<server>__<tool>` — colons become underscores
 *   in a tool name. Neither is the name a person typed, which is why
 *   `qualifiedServerName` exists and why nothing compares raw names.
 * - A skill is offered as **`<plugin>:<slug>`**, and that is the spelling
 *   the SDK's `skills` allowlist has to be given.
 * - `${VAR}` in the generated `.mcp.json` is expanded from the
 *   environment of the CLI process, and the expanded value reaches the
 *   server subprocess. Verified end to end: a server started this way
 *   read a value EO never wrote to disk.
 *
 * And the one that decides how the servers in here reach the agent:
 * `--strict-mcp-config` — which the ambient-configuration decision
 * requires — makes the CLI ignore a plugin's own `.mcp.json` outright,
 * so the servers cannot be left for the plugin loader to find. They are
 * named instead: `--mcp-config` takes "JSON files or strings", and EO
 * gives it **this file's path**. The plugin is still loaded, with
 * `skipMcpDiscovery` so exactly one party owns each connection, and it
 * still carries the skills and the manifest.
 *
 * What that preserves is the thing the whole arrangement is for: the
 * command line holds two paths and nothing else, and the engine reads
 * the servers, the skills and the manifest off disk. A server named this
 * way is registered under the plain name a person typed, and its tools
 * as `mcp__<server>__<tool>` — which is what `schemas/mcpServers.ts`
 * says a catalogue name is for.
 *
 * `providers/claude.ts` carries the measurements. This file stays the
 * one place that knows the layout, which is why the adapter asks it
 * where the file is rather than building the path itself.
 */

/**
 * The plugin's name, and therefore half of every qualified name above.
 *
 * Not `eo`. That is EO's own MCP server, injected separately and by
 * hand, and a plugin sharing the word would put `plugin:eo:github`
 * beside `eo` in the same list for a reader to tell apart.
 */
export const TOOL_PLUGIN_NAME = "eo-attachments";

/**
 * What the backend would call a server it discovered in this directory
 * itself.
 *
 * Not what happens today: `skipMcpDiscovery` means the adapter hands the
 * servers over and they keep their plain names. Kept because it is a
 * real spelling this build produces — it is what `claude mcp list`
 * reports for a plugin directory, and what the CLI would register if the
 * strict flag were ever dropped — and because the one place that
 * compares a reported name against EO's own has to accept both rather
 * than be wrong about which arrangement is live.
 */
export function qualifiedServerName(serverName: string): string {
  return `plugin:${TOOL_PLUGIN_NAME}:${serverName}`;
}

/** How the backend offers a skill this directory delivered. */
export function qualifiedSkillName(slug: string): string {
  return `${TOOL_PLUGIN_NAME}:${slug}`;
}

/**
 * What is actually delivered, out of what is attached.
 *
 * EO-106 attached rows and deliberately left this decision here: both
 * switches travel in the attachment fingerprint, so a change of mind
 * about either invalidates the cached provider and refuses a thread
 * reuse, whichever way this function reads them.
 *
 * Disabled means "not now" and archived means "I am done with this", and
 * neither is a thing to hand a running agent. An archived row still
 * resolves — that is why archiving exists — so an old attachment keeps
 * pointing at something a person can read on the screen; it just stops
 * being written into a directory.
 *
 * `isDeliverable` is the rule itself, exported because the answer to
 * "what will this agent actually be dispatched with?" is now asked
 * somewhere that has rows but does not build a directory: the MCP host
 * tells a client what a tick did (EO-114), and a client told that a
 * disabled server is attached would reasonably read that as delivered.
 * One predicate rather than two spellings of it — a second copy is a
 * copy that gets to disagree with what is actually written to disk.
 *
 * **A server is held to one rule more than a skill is** (EO-151), and
 * the extra rule is `packages/core`'s rather than this file's: a name EO
 * has reserved cannot reach a dispatch, however it got into the
 * catalogue. That check is *not* applied to skills, because a skill
 * named `repo` shadows nothing — it is not a key under `mcpServers`.
 *
 * It has to be here rather than only in the provider that already had
 * it. Codex filtered reserved names on its own merge into `mcp_servers`
 * and this path did not, so a row named `repo` written before the name
 * was reserved was still being written into the generated `.mcp.json`
 * and named to the CLI with `--mcp-config` — configured beside the
 * inline query server EO had just injected under the same name.
 */
export function isDeliverable(row: { enabled: boolean; archivedAt: number | null }): boolean {
  return row.enabled && row.archivedAt === null;
}

export function deliverableAttachments(resolved: ResolvedAgentAttachments): ResolvedAgentAttachments {
  return { servers: resolved.servers.filter(isDeliverableMcpServer), skills: resolved.skills.filter(isDeliverable) };
}

/** One generated file: a path relative to the directory's root, and its whole content. */
export interface PluginFile {
  path: string;
  content: string;
}

/**
 * A path EO is willing to write under a directory it owns.
 *
 * Both a slug and a supporting file's path are held to a shape when they
 * are saved (`SKILL_SLUG_PATTERN`, `readSkillDraft`), so this is the
 * second lock rather than the first. It is here because this is the
 * function that turns a database column into a filesystem write, and the
 * cost of the row having come from somewhere else — an older migration,
 * a hand-edited database — is a file written outside the directory.
 */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[/\\]/);
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * What one server looks like in `.mcp.json`.
 *
 * **Names, never values.** A declared environment variable is written as
 * `${NAME}`, and the value arrives in the CLI's own environment at
 * spawn — the pinned decision "secrets never enter a generated file",
 * and the reason a generated directory is safe to leave lying under
 * `userData` between runs.
 *
 * A remote server gets no `env` block, because there is nothing for one
 * to do: its secret is referenced from a header the person wrote
 * (`Authorization: Bearer ${TOKEN}`) and expanded from the same
 * environment. Its `envNames` still matter — they are what tells the
 * provider which values to put there — they just leave no trace here.
 */
export type GeneratedMcpServer =
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

function serverEntry(server: McpServer): GeneratedMcpServer {
  const config = server.config;
  if (config.transport === "stdio") {
    const env = Object.fromEntries(server.envNames.map((name) => [name, `\${${name}}`]));
    return {
      type: "stdio",
      command: config.command,
      args: config.args,
      ...(server.envNames.length > 0 ? { env } : {}),
    };
  }
  return { type: config.transport, url: config.url, headers: config.headers };
}

/**
 * EO's own administrative server, for the one agent that holds it
 * (EO-182).
 *
 * Delivered through this file rather than inline beside `eo` and `repo`
 * in `providers/claude.ts`, and the reason is the bearer. Those two are
 * stdio commands with nothing to authenticate; this one is an HTTP
 * server on a loopback port, and the only way to hand a CLI a
 * credential without putting it on a command line every other process
 * can read is the arrangement already built here — `${VAR}` in the file,
 * the value in the environment, expanded by the CLI at spawn. It also
 * lands under `--strict-mcp-config` the way an attached server does,
 * which is what stops the plugin loader finding it a second time.
 *
 * The fact being written — a loopback URL and the name of the variable
 * the bearer arrives in — is `AdminMcpDelivery`, and it lives in
 * `adminDelivery.ts` rather than here since Codex grew a delivery of its
 * own (EO-203). What stays in this file is this file's spelling of it:
 * `${VAR}` inside a `.mcp.json`, which is a contract with one CLI and
 * with nothing else.
 */
function adminServerEntry(admin: AdminMcpDelivery): GeneratedMcpServer {
  return { type: "http", url: admin.url, headers: { Authorization: `Bearer \${${admin.envName}}` } };
}

/**
 * One entry read back off disk, or null if it is not one.
 *
 * Narrowed rather than cast. The file was written by this module a
 * moment earlier, so in practice every entry passes — but it is a file
 * under `userData` that a person can open and edit, and the alternative
 * to checking is handing a half-formed object to the SDK, where the
 * failure is a subprocess that will not start and a run that cannot say
 * why.
 */
function readServerEntry(value: unknown): GeneratedMcpServer | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (entry["type"] === "stdio") {
    if (typeof entry["command"] !== "string") return null;
    const args = Array.isArray(entry["args"]) ? entry["args"].filter((arg): arg is string => typeof arg === "string") : [];
    const env = entry["env"];
    return {
      type: "stdio",
      command: entry["command"],
      args,
      ...(typeof env === "object" && env !== null ? { env: env as Record<string, string> } : {}),
    };
  }
  if (entry["type"] === "http" || entry["type"] === "sse") {
    if (typeof entry["url"] !== "string") return null;
    const headers = entry["headers"];
    return {
      type: entry["type"],
      url: entry["url"],
      headers: typeof headers === "object" && headers !== null ? (headers as Record<string, string>) : {},
    };
  }
  return null;
}

/**
 * One skill as files: its `SKILL.md`, and whatever it says to read next.
 *
 * Exported since EO-207, which delivers the same files to a second
 * place — `.agent/skills` inside the worktree, for a Codex agent that
 * has no plugin loader to point at a generated directory. The paths it
 * returns are relative to whichever root the caller is writing under,
 * and both roots want the same `skills/<slug>/…` shape, so the two
 * deliveries share this rather than agreeing about a layout twice.
 */
export function skillFiles(skill: Skill): PluginFile[] {
  if (!isSafeRelativePath(skill.slug) || skill.slug.includes("/")) return [];
  const directory = `skills/${skill.slug}`;
  const files: PluginFile[] = [
    {
      path: `${directory}/SKILL.md`,
      // The frontmatter's `name` is the slug and not the display name —
      // `skillFrontmatter` carries the reasoning, and it is the line that
      // decides whether the skill can be invoked at all.
      content: renderSkillMarkdown(skill),
    },
  ];
  for (const file of skill.files) {
    if (!isSafeRelativePath(file.path)) continue;
    files.push({ path: `${directory}/${file.path}`, content: file.content });
  }
  return files;
}

/**
 * Every file the directory holds, as content rather than as writes.
 *
 * Split from `writeToolDirectory` so the shape can be asserted against a
 * fixture without a temporary directory in the loop, and so the one
 * function that touches the disk has nothing in it to get wrong but the
 * order of its `mkdir`s.
 *
 * Sorted by path, and every collection inside it ordered by the
 * identifier a person cannot duplicate. Two runs of the same attachment
 * set produce the same bytes, which is what makes a fixture worth
 * pinning and what keeps a rewritten directory from looking like a
 * change.
 */
export function toolDirectoryFiles(resolved: ResolvedAgentAttachments, admin?: AdminMcpDelivery | null): PluginFile[] {
  const { servers, skills } = deliverableAttachments(resolved);
  // The administrative server counts as something to deliver. An agent
  // that holds it and has attached nothing at all is the ordinary case —
  // EO's system agent, whose whole surface is EO itself — and an early
  // return that only counted rows would give it an empty directory and
  // no `--mcp-config` to be pointed at.
  if (servers.length === 0 && skills.length === 0 && !admin) return [];

  const files: PluginFile[] = [
    {
      path: ".claude-plugin/plugin.json",
      content: `${JSON.stringify(
        {
          name: TOOL_PLUGIN_NAME,
          description: "The MCP servers and skills EO gave this agent.",
          // Inert, and fixed on purpose. The directory is regenerated
          // from the catalogue on every dispatch, so there is no version
          // of it to be at — but the manifest this was established
          // against carried the field, and a contract with a binary is
          // not the place to find out which parts were load-bearing.
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    },
  ];

  if (servers.length > 0 || admin) {
    const mcpServers: Record<string, unknown> = {};
    for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
      mcpServers[server.name] = serverEntry(server);
    }
    // Written last, out of the sorted order the rows are in, and that is
    // a guarantee rather than an oversight — the same one
    // `providers/claude.ts` makes by putting `eo` last in its inline
    // object. `ADMIN_MCP_SERVER_NAME` is reserved, so no catalogue row
    // can be called this; if one ever arrives from a database written
    // before the reservation, it loses to EO's own server rather than
    // taking its name. Determinism is unaffected: the same attachments
    // still produce the same bytes.
    if (admin) mcpServers[ADMIN_MCP_SERVER_NAME] = adminServerEntry(admin);
    files.push({ path: ".mcp.json", content: `${JSON.stringify({ mcpServers }, null, 2)}\n` });
  }

  for (const skill of [...skills].sort((a, b) => a.slug.localeCompare(b.slug))) {
    files.push(...skillFiles(skill));
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The skills a generated directory holds, in the spelling the backend's
 * own allowlist takes.
 *
 * Read back off disk rather than carried beside the path, so that
 * `AgentProviderStartOptions` stays one string and this file remains the
 * only one that knows what the layout is. The provider adapter is the
 * caller: it has to name the skills explicitly, because omitting the
 * option does not mean "no skills" — the CLI's own defaults still apply.
 *
 * An unreadable or absent directory is no skills rather than a throw.
 * The one caller is about to spawn a turn, and a directory that has been
 * removed underneath it is a reason to run with nothing attached, not a
 * reason for the run to fail.
 */
export function toolDirectorySkillNames(path: string): string[] {
  try {
    return readdirSync(join(path, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => qualifiedSkillName(entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The Skills section a Claude turn that opens a thread starts with
 * (EO-602), or an empty string when the directory offers the model
 * nothing to choose.
 *
 * Read off the same folders `toolDirectorySkillNames` lists, so the
 * prompt cannot name a skill the allowlist does not offer — and, on an
 * agent that inherits the person's own setup, names only the skills EO
 * put here and never theirs. A skill written with
 * `disable-model-invocation` is left out, as Codex leaves it out, and so
 * is a folder whose `SKILL.md` cannot be read back: a bullet with no
 * description is not a choice.
 */
export function toolDirectorySkillsPromptSection(path: string): string {
  const offered: OfferedSkill[] = [];
  for (const name of toolDirectorySkillNames(path)) {
    const slug = name.slice(TOOL_PLUGIN_NAME.length + 1);
    let markdown: string;
    try {
      markdown = readFileSync(join(path, "skills", slug, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    // `skillFrontmatter` writes one key per line, every value quoted onto it.
    const frontmatter = markdown.split("\n---\n")[0]?.split("\n") ?? [];
    if (frontmatter.includes("disable-model-invocation: true")) continue;
    const description = yamlUnquoted(frontmatter.find((line) => line.startsWith("description: "))?.slice("description: ".length) ?? "");
    if (description !== null) offered.push({ name, description });
  }
  return skillsPromptSection(offered, "When one of them fits what you are doing, invoke it with the Skill tool by the name shown and follow it;");
}

/**
 * The servers this directory delivers, by name.
 *
 * Read from the directory rather than resolved from the rows a second
 * time, for the reason `toolDirectorySkillNames` is: the directory is
 * what this turn was actually built with, and a second source for the
 * same answer is a second thing to go stale — including on a resumed
 * turn, where the rows may have moved on and the thread's directory has
 * not.
 *
 * Nobody delivers servers *through* this function: the CLI is given the
 * file's path and parses it itself. This is for the two questions EO has
 * to answer about what it delivered — which tool prefixes an allowlisted
 * agent needs, and which servers a startup report should have mentioned.
 *
 * An absent or malformed file is no servers rather than a throw. Its
 * callers are about to spawn a turn, or are reading a report from one.
 */
export function readToolDirectoryServers(path: string): Record<string, GeneratedMcpServer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(path, ".mcp.json"), "utf8"));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== "object" || servers === null) return {};

  const read: Record<string, GeneratedMcpServer> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    const entry = readServerEntry(value);
    if (entry) read[name] = entry;
  }
  return read;
}

/**
 * The file `--mcp-config` is pointed at, or null when this directory
 * delivers no servers.
 *
 * A path, which is the whole point: the servers' commands, arguments and
 * URLs stay on disk instead of being serialised onto the command line,
 * where every other local process on the machine can read them out of
 * `/proc/<pid>/cmdline` for as long as the run lasts.
 *
 * Existence is checked rather than assumed, because a directory with
 * only skills in it has no such file and pointing the CLI at a missing
 * one is a startup error rather than an empty list.
 */
export function toolDirectoryMcpConfigPath(path: string): string | null {
  const file = join(path, ".mcp.json");
  return existsSync(file) ? file : null;
}

/**
 * The tool-id prefix each delivered server's tools carry, for an agent
 * whose config carries an `allowedTools` allowlist.
 *
 * A server named this way advertises `mcp__github__create_issue`, and a
 * bare `mcp__<server>` is Claude Code's grant of that whole server —
 * which is the same spelling `schemas/mcpServers.ts` says a catalogue
 * name exists to produce.
 */
export function toolDirectoryServerToolPrefixes(path: string): string[] {
  return Object.keys(readToolDirectoryServers(path))
    .map((name) => `mcp__${name}`)
    .sort();
}

/** What a written directory turned out to hold, in the names the backend will use. */
export interface WrittenToolDirectory {
  path: string;
  /**
   * Each delivered server, under the name the session will report it by.
   *
   * The plain catalogue name: the CLI is given this directory's
   * `.mcp.json` by path rather than left to discover it, because
   * `--strict-mcp-config` would ignore a plugin's own copy.
   * `qualifiedServerName` is what they would be called under the other
   * arrangement, and the supervisor accepts either.
   *
   * Travels out of here rather than being re-read later because it is
   * the snapshot a turn's startup report is judged against: by the time
   * the backend says what came up, the catalogue may have moved on.
   */
  serverNames: string[];
  /** `<plugin>:<slug>` for each delivered skill — what the `skills` allowlist takes. */
  skillNames: string[];
}

/**
 * Is what is on disk already exactly this?
 *
 * Both directions: every intended file present with the same bytes, and
 * nothing there that is not intended. A skill somebody detached has to
 * stop being on disk, so "all my files are there" is only half the
 * question.
 */
function alreadyWritten(path: string, files: PluginFile[]): boolean {
  const found = new Set<string>();
  const walk = (directory: string, prefix: string): boolean => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!walk(join(directory, entry.name), relative)) return false;
        continue;
      }
      const intended = files.find((file) => file.path === relative);
      if (!intended) return false;
      try {
        if (readFileSync(join(directory, entry.name), "utf8") !== intended.content) return false;
      } catch {
        return false;
      }
      found.add(relative);
    }
    return true;
  };
  return walk(path, "") && found.size === files.length;
}

/**
 * Writes the directory, or removes it and answers null when there is
 * nothing to deliver.
 *
 * Rewritten from scratch rather than merged into: a skill somebody
 * detached has to stop being on disk, and a directory that only ever
 * gains files would go on offering it for as long as the item lived.
 * The write is cheap — a handful of small files — and doing it on every
 * dispatch is also what heals a directory somebody deleted between runs.
 *
 * **Unless nothing has changed, in which case nothing is touched.** The
 * rewrite is `rm -rf` followed by a write, and every dispatch that
 * resumes a thread calls this again: a directory a backend is about to
 * be pointed at should not blink out of existence and back for a run
 * that is delivering exactly what was already there. The comparison is
 * a handful of small file reads, which is cheaper than the writes it
 * replaces.
 *
 * That is a narrowing rather than a guarantee: what stops a *changed*
 * surface being rewritten under a live thread is `resumeBlockedReason`,
 * which refuses to resume a thread whose attachments have moved at all.
 */
export function writeToolDirectory(
  path: string,
  resolved: ResolvedAgentAttachments,
  admin?: AdminMcpDelivery | null,
): WrittenToolDirectory | null {
  const files = toolDirectoryFiles(resolved, admin);
  if (files.length === 0) {
    rmSync(path, { recursive: true, force: true });
    return null;
  }

  if (!alreadyWritten(path, files)) {
    rmSync(path, { recursive: true, force: true });
    for (const file of files) {
      const target = join(path, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
  }

  const { servers, skills } = deliverableAttachments(resolved);
  return {
    path,
    // The administrative server is named here with the rest, because
    // this list is what a turn's startup report is judged against: if it
    // does not come up, the agent that most needs it is the one running
    // without it, and invariant #8 says that cannot pass in silence.
    serverNames: [...servers.map((server) => server.name), ...(admin ? [ADMIN_MCP_SERVER_NAME] : [])].sort(),
    skillNames: skills.map((skill) => qualifiedSkillName(skill.slug)).sort(),
  };
}

/**
 * Where one agent's directory for one item lives.
 *
 * **Never inside the item's worktree**, and that is the whole reason
 * this takes a root at all. `verify.ts` fails a run whose `git status
 * --porcelain` is not empty, and an untracked directory counts — so a
 * generated directory in the checkout would fail the `clean` step of
 * every run that had anything attached.
 *
 * EO-207 has since excluded two directories EO *does* write into a
 * checkout (`workspace/excludes.ts`), so "git would see it" is no longer
 * the whole of the argument — but this directory still does not move,
 * and the reason is `.mcp.json`. It carries `Authorization: Bearer
 * ${EO_ADMIN_TOKEN}` and the admin listener's URL: a credential in a
 * checkout, one `git add -A` from a commit, and an exclusion is not a
 * defence against a command a person types. Skill markdown is inert and
 * went to `.agent/skills`; the MCP configuration stays here.
 *
 * Keyed by item and agent rather than by run, because a *thread* is
 * keyed that way: `findReusableThread` looks up an agent's last run on an
 * item, and a parked run's conversation outlives the run row that
 * opened it. A directory keyed by run would be removed while the thread
 * it belongs to was still resumable.
 */
export function toolDirectoryPath(root: string, itemId: string, agentId: string): string {
  return join(root, itemId, agentId);
}

/**
 * The directory for this dispatch, from what the agent has attached
 * right now.
 *
 * Read from the database on every dispatch rather than remembered: this
 * is the thing that has to notice an edit, and an answer of its own that
 * went stale would defeat the story it belongs to.
 */
export function writeAgentToolDirectory(
  db: Db,
  options: {
    root: string;
    itemId: string;
    agentId: string;
    /**
     * Where the run works (EO-470): only the attached skills whose scope
     * takes it in are written, so a project's or a workspace's skill is
     * not in a directory generated for a run elsewhere. The same rule the
     * Codex adapter applies to `.agent/skills` (`skillsForRun`).
     */
    scope: SkillRunScope;
    admin?: AdminMcpDelivery | null;
  },
): WrittenToolDirectory | null {
  return writeToolDirectory(
    toolDirectoryPath(options.root, options.itemId, options.agentId),
    resolveAgentAttachmentsForRun(db, options.agentId, options.scope),
    // Decided by the caller, which is the only place that can: whether
    // this agent holds the grant is a question about `allowedTools`, and
    // whether there is a host to point at is a question about a socket.
    // Neither is something a directory writer should be reaching for.
    options.admin ?? null,
  );
}

/**
 * Lets go of every directory generated for one item.
 *
 * Called when the item settles, beside the worktree being released
 * (G-03), because that is the moment no thread on it will be resumed
 * again. Not when a run ends: a run that parks at `awaiting_input` ends
 * while its conversation is still waiting for a person, and taking the
 * directory away then would resume that conversation with its servers
 * and skills gone.
 *
 * `force` because an item that never had anything attached has no
 * directory, and that is the ordinary case rather than a failure.
 */
export function releaseItemToolDirectories(root: string, itemId: string): void {
  rmSync(join(root, itemId), { recursive: true, force: true });
}
