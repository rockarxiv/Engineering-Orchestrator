import { createHash } from "node:crypto";
import type { CliTool, McpServer, Skill, SkillRunScope, SkillScope } from "@eo/core";
import type { Db } from "../db/client.js";
import { resolveAgentAttachments, resolveAgentAttachmentsForRun, type ResolvedAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";

/**
 * What an agent's attachments amount to, as one string (EO-106).
 *
 * Two things go stale the moment attachments exist, and this is the
 * answer both of them need:
 *
 * - the provider cache in `engine.ts`, which is keyed on
 *   `JSON.stringify(agent.config)` and never cleared, so anything held
 *   outside that bag would be invisible until the app restarted;
 * - thread reuse in `supervisor/threadReuse.ts`, which refuses to resume
 *   when the instructions changed and has to refuse for the same reason
 *   when the servers or CLIs did, on backends that re-send neither — and
 *   which since EO-919 asks that of `fingerprintToolSurface` below, which
 *   leaves the skills out.
 *
 * Three properties, and each of them is load-bearing:
 *
 * **It fingerprints the resolved content, not the set of ids.** A
 * renamed command, an edited skill body, a header that grew a variable:
 * none of those move an id, and all of them change what the agent can
 * do. A fingerprint over ids would say nothing had happened.
 *
 * **It carries no secret.** Not by care taken here but by construction:
 * the rows themselves hold only environment-variable *names* (EO-104's
 * whole point), the values live in the OS keychain, and the provider
 * reads them lazily at spawn — `providers/claude.ts` does exactly that
 * with the API key. On top of which this is a sha256 digest, so even a
 * row that somehow held one would not put it in a Map key that outlives
 * the run. `engine.ts` records why that matters.
 *
 * **It is stable under things that are not changes.** `createdAt` and
 * `updatedAt` are excluded deliberately: a save that rewrote a body byte
 * for byte would otherwise mint a new fingerprint, discard a warm
 * provider and cost an in-flight item its thread, for nothing. Order
 * is imposed rather than inherited, so the same set attached in a
 * different order fingerprints the same.
 */

/**
 * One entry's content, as a shape whose key order is fixed by this
 * source rather than by a row, a JSON column or an insertion order.
 *
 * Written out field by field on purpose. A spread of the row would make
 * this quietly depend on every column the catalogues ever grow — the
 * next timestamp added to `mcp_servers` would start invalidating every
 * provider on every save, and nothing here would say why.
 */
function serverContent(server: McpServer): unknown {
  const config = server.config;
  return {
    name: server.name,
    transport: config.transport,
    command: config.transport === "stdio" ? config.command : null,
    args: config.transport === "stdio" ? config.args : [],
    // Sorted: a `Record` reconstituted from a JSON column keeps whatever
    // order it was written in, and two identical header sets must not
    // fingerprint differently because one was typed in another order.
    // Values are `${VAR}` references, never secrets — the pinned
    // decision "secrets never enter a generated file" is upstream of
    // this being safe to hash at all.
    headers: config.transport === "stdio" ? [] : Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b)),
    url: config.transport === "stdio" ? null : config.url,
    // Names only. Which names a server declares is part of its surface —
    // adding one changes what the spawned process is handed.
    envNames: [...server.envNames].sort(),
    // Both switches are in, because both decide whether this entry is
    // delivered, and EO-107/EO-108 are where that is decided. A change
    // of mind there must not need a change here to take effect.
    enabled: server.enabled,
    archived: server.archivedAt !== null,
  };
}

/**
 * A skill's scope, for the one fingerprint that carries it.
 *
 * Only the provider cache's key (`agentSurfaceKey`) asks for it. The
 * one-run hash is taken over the skills one run is given, already
 * narrowed by scope, so what matters there is which skills arrived and
 * what they say — moving a skill between two scopes that both take a run
 * in changes nothing that run can do (EO-470).
 */
function scopeContent(scope: SkillScope): unknown {
  switch (scope.kind) {
    case "global":
      return ["global"];
    case "project":
      return ["project", scope.projectId];
    case "workspace":
      return ["workspace", scope.workspaceId];
  }
}

function skillContent(skill: Skill, withScope: boolean): unknown {
  return {
    ...(withScope ? { scope: scopeContent(skill.scope) } : {}),
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    // By path, for the reason headers are sorted: the same directory
    // written in another order is the same directory.
    files: [...skill.files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => [file.path, file.content]),
    disableModelInvocation: skill.disableModelInvocation,
    enabled: skill.enabled,
    archived: skill.archivedAt !== null,
  };
}

/**
 * A CLI's content (EO-819): what the prompt tells an agent about it.
 *
 * The command and the description, and not the display name, which the
 * prompt section does not show — renaming "GitHub CLI" to "GitHub" must
 * not cost an in-flight item its thread. Archived CLIs never reach here
 * (`resolveAgentAttachments` leaves them out), so there is no flag.
 */
function cliToolContent(tool: CliTool): unknown {
  return { command: tool.command, description: tool.description };
}

/**
 * The canonical form the hash is taken over.
 *
 * Exported so a test can read what actually went in — a digest that is
 * wrong is indistinguishable from a digest that is right, and the one
 * assertion worth making about this file is which fields reached it.
 */
export function canonicalAttachments(resolved: ResolvedAgentAttachments, options: { withScopes?: boolean } = {}): string {
  const withScope = options.withScopes === true;
  return JSON.stringify({
    // Sorted by the identifier a person cannot duplicate: `name` is
    // unique on `mcp_servers` and `slug` on `skills`, so this is a total
    // order and does not depend on how the join table happens to read.
    servers: [...resolved.servers].sort((a, b) => a.name.localeCompare(b.name)).map(serverContent),
    skills: [...resolved.skills].sort((a, b) => a.slug.localeCompare(b.slug)).map((skill) => skillContent(skill, withScope)),
    // Only when there are any (EO-819), so an agent with no CLIs hashes
    // exactly as it did before CLIs existed and no thread opened before
    // this build is refused a resume for a change that did not happen.
    // Sorted by command, which is unique in the catalogue.
    ...(resolved.cliTools.length > 0 ? { cliTools: [...resolved.cliTools].sort((a, b) => a.command.localeCompare(b.command)).map(cliToolContent) } : {}),
  });
}

/** The digest of the above. `promptHash`'s sibling, and deliberately the same shape of answer. */
export function fingerprintAttachments(resolved: ResolvedAgentAttachments, options: { withScopes?: boolean } = {}): string {
  return createHash("sha256").update(canonicalAttachments(resolved, options)).digest("hex");
}

/**
 * The tool surface one agent has right now, for one run (EO-106, EO-470).
 *
 * Taken over the skills that run is actually given — those whose scope
 * takes in its project or its step's workspace — and not over everything
 * attached. A run given only global skills hashes exactly as it did
 * before scopes existed. The key a warm backend is adopted by; what a
 * run row records, and thread reuse compares, is the part of it without
 * the skills (`agentToolSurfaceHash`, EO-919).
 *
 * Read from the database on every dispatch rather than cached: this is
 * the thing that has to notice an edit, so an answer of its own that
 * went stale would defeat the entire story.
 */
export function agentAttachmentsHash(db: Db, agentId: string, scope: SkillRunScope): string {
  return fingerprintAttachments(resolveAgentAttachmentsForRun(db, agentId, scope));
}

/**
 * Everything attached to one agent, scopes included — the provider
 * cache's key (EO-470).
 *
 * Not the thread-reuse hash, which is one run's. A cached Codex provider
 * holds every attached skill and narrows them per turn by the turn's
 * scope, so a skill whose scope moved must discard it even though no
 * body changed — otherwise the provider would go on narrowing by the old
 * scope.
 */
export function agentSurfaceKey(db: Db, agentId: string): string {
  return fingerprintAttachments(resolveAgentAttachments(db, agentId), { withScopes: true });
}

/**
 * What a session is fixed to when it opens (EO-919): the MCP servers and
 * the command-line tools, and not the skills.
 *
 * Both backends take servers and CLIs at the moment a session opens — on
 * Claude they are arguments to the process that started it, on Codex the
 * config its opening invocation carried, and a CLI is named only in the
 * prompt that opens the thread — so a change to either refuses a resume.
 * A skill's body is not: both read it when the agent loads it, from the
 * generated plugin directory on Claude and through `skill_read` and the
 * worktree's files on Codex, and EO writes both again before every
 * resumed turn. Only the list in the opening prompt goes stale, and the
 * resumed turn is told what changed instead (`agentAttachments/skillChanges.ts`).
 *
 * Taken over the same canonical form as the whole surface with the skills
 * left empty, so an agent with no skills hashes exactly as it did when
 * the run row recorded the whole surface. Prefixed, so a row written
 * before this split — which holds the whole surface's hash — can be told
 * from one written after it (`toolSurfaceVerdict`).
 */
export const TOOL_SURFACE_PREFIX = "tools:";

export function fingerprintToolSurface(resolved: ResolvedAgentAttachments): string {
  return `${TOOL_SURFACE_PREFIX}${fingerprintAttachments({ servers: resolved.servers, skills: [], cliTools: resolved.cliTools })}`;
}

/**
 * Whether the tool surface a thread was born with (the run row's
 * `agentAttachmentsHash`) is the one this run would open with:
 *
 * - `same` — the servers and CLIs match; skills are not asked about.
 * - `changed` — they do not.
 * - `changed-unsplit` — the row predates EO-919 and recorded servers,
 *   CLIs and skills as one hash, which no longer matches. Which of the
 *   three moved cannot be told, so the thread is refused as it was before
 *   and the refusal says all three.
 *
 * Null reads as a thread born with nothing attached, as it always has:
 * nothing could be attached before migration 0052.
 */
export type ToolSurfaceVerdict = "same" | "changed" | "changed-unsplit";

export function toolSurfaceVerdict(recorded: string | null, resolved: ResolvedAgentAttachments): ToolSurfaceVerdict {
  const tools = fingerprintToolSurface(resolved);
  if (recorded === null) return tools === EMPTY_TOOL_SURFACE_HASH ? "same" : "changed";
  if (recorded.startsWith(TOOL_SURFACE_PREFIX)) return recorded === tools ? "same" : "changed";
  return recorded === fingerprintAttachments(resolved) ? "same" : "changed-unsplit";
}

/** `toolSurfaceVerdict` for one agent's run, read from the database. */
export function agentToolSurfaceVerdict(db: Db, recorded: string | null, agentId: string, scope: SkillRunScope): ToolSurfaceVerdict {
  return toolSurfaceVerdict(recorded, resolveAgentAttachmentsForRun(db, agentId, scope));
}

/** The tool surface one agent's run opens with, as the run row records it (EO-919). */
export function agentToolSurfaceHash(db: Db, agentId: string, scope: SkillRunScope): string {
  return fingerprintToolSurface(resolveAgentAttachmentsForRun(db, agentId, scope));
}

/**
 * The surface of an agent with nothing attached.
 *
 * Not a constant string but a computed one, so it cannot drift from what
 * `canonicalAttachments` produces for an empty pair. What a run row
 * recorded for an agent with nothing attached before EO-919, when the
 * row held the whole surface; a null on a row is read as
 * `EMPTY_TOOL_SURFACE_HASH` now (`toolSurfaceVerdict`).
 */
export const EMPTY_ATTACHMENTS_HASH = fingerprintAttachments({ servers: [], skills: [], cliTools: [] });

/** A tool surface with no server and no CLI, prefixed as the run row records it. */
export const EMPTY_TOOL_SURFACE_HASH = fingerprintToolSurface({ servers: [], skills: [], cliTools: [] });
