// No shebang, deliberately. Nothing ever executes this file directly —
// EO always spawns it as `spawn(execPath, [thisFile])` — so the line bought
// nothing, and Vitest inlines a source `.mjs` rather than letting Node load
// it, which makes a leading `#!` a SyntaxError on Windows.
/* global process, fetch, AbortSignal */

/**
 * EO's provider-neutral MCP service.
 *
 * Both Claude and Codex launch this exact file over stdio. Keeping the
 * protocol implementation here means the advertised schemas, validation and
 * result shapes cannot drift between provider adapters. The service opens the
 * EO database read-only and never returns its path (or an attachment's storage
 * path) to a caller.
 */
import { clearTimeout, setTimeout } from "node:timers";
import { readdirSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const EO_MCP_SERVER_NAME = "eo";
export const EO_MCP_SERVER_VERSION = "1.0.0";

const COMMENT_DESCRIPTION =
  "Post a comment on the ticket you are working on. Mention @user to ask the human something you cannot " +
  "resolve, or @<agent> to ask a teammate. If you mention someone and set blocking, your run ends here " +
  "and resumes when they reply.";

const ITEM_DETAIL_DESCRIPTION =
  "Read one ticket: what it is, its acceptance criteria, what it waits on and what it shipped. Use it on a " +
  "dependency key to find out what that work produced. It does not return the discussion — search that with " +
  "comment_search.";

/**
 * The release after which `ticket_detail` stops resolving (KAN-162).
 *
 * Duplicated from `ALIAS_RETIREMENT_VERSION` in `@eo/core` rather than
 * imported, because this file ships unbundled: Codex spawns it by path
 * with nothing but Node's own builtins resolvable from where it lands,
 * which is why `EO_MCP_SERVER_NAME` is written here too. `eoServer.test.ts`
 * pins the pair against core so the two cannot drift.
 */
const ALIAS_RETIREMENT_VERSION = "0.1";

/**
 * The name every shipped prompt used to say, and some `allowedTools`
 * still do (KAN-162).
 *
 * KAN-145 renamed the entity to `item` everywhere EO owns and left this
 * tool's name alone, because renaming it would have broken every prompt
 * and every allowlist naming `mcp__eo__ticket_detail` at once. So the
 * name is now an alias: `item_detail` is the same tool, over the same
 * handle, answering identically, and this one goes on resolving for one
 * release with the notice in front of its description.
 */
const TICKET_DETAIL_DESCRIPTION = `Deprecated: use item_detail; retired after v${ALIAS_RETIREMENT_VERSION}. ${ITEM_DETAIL_DESCRIPTION}`;

const THREAD_READ_DESCRIPTION =
  "Read one ticket and every comment on it. Unbounded: on a long-running ticket this is the largest answer " +
  "any tool here gives. Use it when the conversation itself is what you are working on.";

const COMMENT_SEARCH_DESCRIPTION =
  "Search one ticket's comments for a regular expression. Answers with the id, author, kind and a short " +
  "excerpt of each match, newest first — not whole comments and not their replies. Open an exchange with " +
  "comment_read once you know which one you want.";

const ATTACHMENT_READ_DESCRIPTION =
  "Read one EO attachment by its stable attachment ID. Returns text, image data, or a binary resource " +
  "using the attachment's stored MIME type. Use only when the file's content is needed.";

const COMMENT_READ_DESCRIPTION =
  "Read one comment and the replies filed under it, by its comment ID. Use it to follow an exchange that " +
  "was collapsed to a pointer, instead of re-reading the whole ticket.";


const ATTACHMENT_ADD_DESCRIPTION =
  "Attach files from the directory you are working in to the ticket you are working on: a screenshot, a test " +
  "log, a report. Each call posts one comment on the ticket carrying the files, with the caption as its text. " +
  "Takes one to eight paths, relative to your working directory. Regular files only, never a symbolic link or a " +
  "path outside that directory, at most 20 MB each and 16 files per run. The caption is plain text: it notifies " +
  "nobody and asks nothing. The answer is EO's own: the files it attached, or which file it refused and why, in " +
  "which case nothing was attached.";

/**
 * The four MCP annotation hints, every one stated (EO-723). A client
 * fills a missing hint with the spec default, and the defaults are the
 * cautious ones — a write with no `destructiveHint` reads as destructive,
 * a tool with no `openWorldHint` as reaching the open world — so "not" is
 * said with `false`, never by leaving a hint out. `eoServer.test.ts`
 * holds every listed tool to all four.
 */

/** A read of EO's own database: changes nothing, the same answer twice, nothing beyond EO. */
const READS_ANNOTATIONS = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

/**
 * A write that adds to what EO holds — a comment, its files, a memory
 * entry — and takes nothing away: a second call adds a second one.
 */
const APPENDS_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });

/**
 * `repository_checkout`: makes or refreshes a checkout on disk, so not
 * read-only, from the repository's remote, so open world. Asking again
 * for the same branch leaves the same checkout, so idempotent.
 */
const CHECKS_OUT_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });

const ATTACHMENT_ADD_TOOL = {
  name: "attachment_add",
  annotations: APPENDS_ANNOTATIONS,
  description: ATTACHMENT_ADD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      // No `minItems` or `maxItems`, on purpose. A client that enforces
      // the schema itself would refuse a ninth path before this service
      // saw the call, in its own words; the count is checked here so the
      // refusal is EO's sentence, naming the path that went over.
      paths: { type: "array", items: { type: "string" }, description: "One to eight files, each relative to your working directory." },
      caption: { type: "string", description: "What these files are, as plain text. Posted as the comment's body." },
    },
    required: ["paths"],
    additionalProperties: false,
  },
};

const COMMENT_TOOL = {
  name: "comment",
  annotations: APPENDS_ANNOTATIONS,
  description: COMMENT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string", description: "The comment, in markdown." },
      mentions: { type: "array", items: { type: "string" }, default: [], description: 'Who to notify: ["user"] or a configured agent name.' },
      kind: { type: "string", enum: ["note", "question", "decision", "approval"], default: "note" },
      options: { type: "array", items: { type: "string" }, description: "Choices to offer the reader, rendered as buttons." },
      blocking: { type: "boolean", default: false, description: "End your run here and wait for a reply." },
    },
    required: ["body"],
    additionalProperties: false,
  },
};

/** What `item_detail` and `ticket_detail` both take. One object, so the two cannot differ. */
const ITEM_DETAIL_INPUT_SCHEMA = {
  type: "object",
  properties: { key: { type: "string", description: 'The ticket key, like "EO-42".' } },
  required: ["key"],
  additionalProperties: false,
};

const ITEM_DETAIL_TOOL = {
  name: "item_detail",
  annotations: READS_ANNOTATIONS,
  description: ITEM_DETAIL_DESCRIPTION,
  inputSchema: ITEM_DETAIL_INPUT_SCHEMA,
};

const TICKET_DETAIL_TOOL = {
  name: "ticket_detail",
  annotations: READS_ANNOTATIONS,
  description: TICKET_DETAIL_DESCRIPTION,
  inputSchema: ITEM_DETAIL_INPUT_SCHEMA,
};

const THREAD_READ_TOOL = {
  name: "thread_read",
  annotations: READS_ANNOTATIONS,
  description: THREAD_READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { key: { type: "string", description: 'The ticket key, like "EO-42".' } },
    required: ["key"],
    additionalProperties: false,
  },
};

const COMMENT_SEARCH_TOOL = {
  name: "comment_search",
  annotations: READS_ANNOTATIONS,
  description: COMMENT_SEARCH_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: 'The ticket whose comments to search, like "EO-42".' },
      pattern: { type: "string", description: "A JavaScript regular expression. Matching is case-insensitive." },
    },
    required: ["key", "pattern"],
    additionalProperties: false,
  },
};

const ATTACHMENT_READ_TOOL = {
  name: "attachment_read",
  annotations: READS_ANNOTATIONS,
  description: ATTACHMENT_READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { attachmentId: { type: "string", description: "The stable attachment ID shown beside its owning comment, or among the item's own files." } },
    required: ["attachmentId"],
    additionalProperties: false,
  },
};

const COMMENT_READ_TOOL = {
  name: "comment_read",
  annotations: READS_ANNOTATIONS,
  description: COMMENT_READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { commentId: { type: "string", description: "The comment ID shown where the exchange was collapsed." } },
    required: ["commentId"],
    additionalProperties: false,
  },
};

// ── Memory (EO-478) ───────────────────────────────────────────

/** `MEMORY_READ_TOOL_NAME` in `@eo/core`, duplicated for the reason `EO_MCP_SERVER_NAME` is and pinned by `eoServer.test.ts`. */
export const MEMORY_READ_TOOL_NAME = "memory_read";

const MEMORY_READ_DESCRIPTION =
  "Read EO's memory of this project, the workspace you are in and the container your item is filed under: what " +
  "earlier runs and people recorded. Your " +
  "prompt carries the entries chosen for this task; this reaches the rest. With no arguments, lists the scopes you " +
  "may read and how many entries each holds. With `scope` (a scope id), lists that scope's entries: each one's id " +
  "and first line. With `entryId`, returns that entry in full. An entry was true when it was written; check it " +
  "against the workspace before you act on it.";

const MEMORY_READ_TOOL = {
  name: MEMORY_READ_TOOL_NAME,
  annotations: READS_ANNOTATIONS,
  description: MEMORY_READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", description: "A scope id, as the Memory section or a call with no arguments shows it." },
      entryId: { type: "string", description: "An entry id, as a scope's listing shows it." },
    },
    required: [],
    additionalProperties: false,
  },
};

/** The longest first line a listing shows of an entry; `entryId` reads the rest. */
const MEMORY_LISTING_LINE = 160;

/**
 * The scopes a turn may read, from the environment the turn started this
 * server with. Anything that is not a list of `{ kind, id, name }` is no
 * scopes at all: a server told nothing it can trust reads nothing.
 */
export function parseMemoryScopes(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (scope) =>
      validObject(scope) &&
      (scope.kind === "project" || scope.kind === "workspace" || scope.kind === "container") &&
      typeof scope.id === "string" &&
      scope.id !== "" &&
      typeof scope.name === "string",
  );
}

function scopeTitle(scope) {
  const kind = scope.kind === "project" ? "Project" : scope.kind === "workspace" ? "Workspace" : "Container";
  return `${kind}: ${scope.name} (scope ${scope.id})`;
}

function memoryWritten(createdAt) {
  return new Date(createdAt).toISOString().slice(0, 10);
}

function renderMemoryScopes(db, scopes) {
  const lines = ["Memory you may read:", ""];
  for (const scope of scopes) {
    const row = queryOne(db, "SELECT count(*) AS count FROM memories WHERE scope_kind = ? AND scope_id = ? AND retired_at IS NULL", scope.kind, scope.id);
    const count = row?.count ?? 0;
    lines.push(`- ${scopeTitle(scope)} — ${count} ${count === 1 ? "entry" : "entries"}`);
  }
  lines.push("", "List one with `scope`, and read an entry with `entryId`.");
  return lines.join("\n");
}

function renderMemoryListing(db, scope) {
  const rows = queryAll(
    db,
    "SELECT id, body, created_at FROM memories WHERE scope_kind = ? AND scope_id = ? AND retired_at IS NULL ORDER BY created_at DESC, id DESC",
    scope.kind,
    scope.id,
  );
  if (rows.length === 0) return `${scopeTitle(scope)}\n\nThis scope holds no entries.`;
  return [
    `${scopeTitle(scope)} — ${rows.length} ${rows.length === 1 ? "entry" : "entries"}, newest first`,
    "",
    ...rows.map((row) => {
      const first = String(row.body).split("\n")[0] ?? "";
      const line = first.length > MEMORY_LISTING_LINE ? `${first.slice(0, MEMORY_LISTING_LINE)}…` : first;
      return `- ${row.id} (written ${memoryWritten(row.created_at)}): ${line}`;
    }),
    "",
    "Read one in full with `entryId`.",
  ].join("\n");
}

function renderMemoryEntry(row, scope) {
  const retired =
    row.retired_at === null || row.retired_at === undefined
      ? []
      : ["", `Retired ${memoryWritten(row.retired_at)} (${row.retired_reason ?? "retired"}): it is not delivered to runs any more.`];
  return [`Memory entry ${row.id} — ${scopeTitle(scope)}, written ${memoryWritten(row.created_at)}`, ...retired, "", String(row.body)].join("\n");
}

/**
 * `memory_read`: read-only, and held to the scopes the turn was given —
 * an entry of any other project or workspace is answered as one that
 * does not exist, because to this turn it does not.
 */
function memoryRead(args, db, memoryScopes) {
  if (memoryScopes.length === 0) return toolError("TOOL_DISABLED", "No memory was delivered to this turn, so there is none to read.");
  if (!validObject(args) || !hasOnlyKeys(args, ["scope", "entryId"])) {
    return toolError("INVALID_ARGUMENT", "memory_read takes `scope`, `entryId`, or neither, and nothing else.");
  }
  const hasScope = args.scope !== undefined;
  const hasEntry = args.entryId !== undefined;
  if ((hasScope && (typeof args.scope !== "string" || args.scope.trim() === "")) || (hasEntry && (typeof args.entryId !== "string" || args.entryId.trim() === ""))) {
    return toolError("INVALID_ARGUMENT", "`scope` and `entryId` are non-empty strings.");
  }
  if (hasScope && hasEntry) return toolError("INVALID_ARGUMENT", "Give `scope` to list a scope, or `entryId` to read an entry — not both.");
  if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's memory store is unavailable.");
  try {
    if (hasEntry) {
      const row = queryOne(db, "SELECT id, scope_kind, scope_id, body, created_at, retired_at, retired_reason FROM memories WHERE id = ?", args.entryId);
      const scope = row ? memoryScopes.find((candidate) => candidate.kind === row.scope_kind && candidate.id === row.scope_id) : undefined;
      if (!row || !scope) return toolError("MEMORY_NOT_FOUND", `No memory entry you may read has the id "${args.entryId}".`);
      return { content: [{ type: "text", text: renderMemoryEntry(row, scope) }] };
    }
    if (hasScope) {
      const scope = memoryScopes.find((candidate) => candidate.id === args.scope);
      if (!scope) return toolError("SCOPE_NOT_FOUND", `"${args.scope}" is not a scope you may read. Call memory_read with no arguments for the ones you may.`);
      return { content: [{ type: "text", text: renderMemoryListing(db, scope) }] };
    }
    return { content: [{ type: "text", text: renderMemoryScopes(db, memoryScopes) }] };
  } catch {
    return toolError("DATABASE_UNAVAILABLE", "EO could not read its memory store.");
  }
}

// ── memory_note (EO-479) ──────────────────────────────────────

/**
 * `MEMORY_NOTE_TOOL_NAME` in `@eo/core`, duplicated for the reason
 * `EO_MCP_SERVER_NAME` is and pinned by `eoServer.test.ts`.
 */
export const MEMORY_NOTE_TOOL_NAME = "memory_note";

const MEMORY_NOTE_DESCRIPTION =
  "Write one entry into EO's memory, which later runs on this project's other items are given. Memory is for what will still be " +
  "true on the next run — how to run the tests, a convention the team enforces, where something lives, a trap you " +
  'fell into — not notes about this run, its progress or this ticket. `scope` is "project" (or the project\'s scope ' +
  "id) for what is true across the whole project, the id of a workspace this run works in for what is true of " +
  "that workspace only, or the id of the container this run's item is filed under for what is only true while the " +
  "work under it is in progress. `text` is the fact itself, at most 1,000 characters. `replaces`, optional, lists the ids of " +
  "entries this note corrects or says again: each must be an active entry an agent wrote, in a scope this run works " +
  "in — never a person's — and EO retires them as superseded when it writes this one. It takes effect at once; a " +
  "person can edit or retire it, and restore what it replaced. The answer is EO's own: noted, with the active " +
  "entries in its scope closest to it, or refused with the reason, in which case nothing was written and nothing " +
  "was retired.";

const MEMORY_NOTE_TOOL = {
  name: MEMORY_NOTE_TOOL_NAME,
  annotations: APPENDS_ANNOTATIONS,
  description: MEMORY_NOTE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      // No `maxLength` on `text`, for the reason `attachment_add` has no
      // `maxItems`: a client that enforced it would refuse the call in its
      // own words, and the refusal is EO's sentence, naming the limit.
      scope: { type: "string", description: '"project" (or the project\'s scope id), or the id of a workspace or container this run works in.' },
      text: { type: "string", description: "The fact to keep, at most 1,000 characters." },
      replaces: {
        type: "array",
        items: { type: "string" },
        description: "The ids of memory entries this note corrects or says again, which EO retires as superseded. Agent-written entries only.",
      },
    },
    required: ["scope", "text"],
    additionalProperties: false,
  },
};

/**
 * `memory_note`: handed to EO, which applies the rules — the scope is
 * one this run works in, the text says something and is short enough,
 * and each entry it `replaces` is an active one an agent wrote in a scope
 * the run works in (EO-594) — against the scopes the item has now, writes
 * the entry with the run as its source (through the organisation's
 * record, where the record holds the project), and answers with what it
 * did (EO-543). This service checks only that the call is the shape the
 * tool advertises.
 */
async function memoryNote(args, memoryScopes, writeBridge) {
  if (memoryScopes.length === 0) return toolError("TOOL_DISABLED", "This run has no memory to write to.");
  if (!validObject(args) || !hasOnlyKeys(args, ["scope", "text", "replaces"])) {
    return toolError("INVALID_ARGUMENT", 'memory_note takes `scope` ("project", or a workspace or container id), `text` and, optionally, `replaces`, and nothing else.');
  }
  if (args.replaces !== undefined && (!Array.isArray(args.replaces) || args.replaces.some((id) => typeof id !== "string"))) {
    return toolError("INVALID_ARGUMENT", "`replaces` is a list of the ids of memory entries this note replaces.");
  }
  return writeThroughEo(writeBridge, MEMORY_NOTE_TOOL_NAME, args);
}

/**
 * `repository_checkout` (EO-633): a read-only checkout of a branch of a
 * repository on the item's project — another repository, or another
 * branch of the item's own. Duplicated from `REPOSITORY_CHECKOUT_TOOL_NAME`
 * in `@eo/core` for the reason `MEMORY_NOTE_TOOL_NAME` is, and pinned to
 * it by `eoServer.test.ts`.
 */
export const REPOSITORY_CHECKOUT_TOOL_NAME = "repository_checkout";

const REPOSITORY_CHECKOUT_DESCRIPTION =
  "Check out a branch of a repository on the ticket's project, to read: another repository, or another branch of the " +
  "one you are working in. `repository` is a name as your prompt lists it; `branch` is the branch's name. EO fetches " +
  "the repository's remote and checks out the remote branch, or the local branch of that name when the remote has " +
  "none, detached, in a checkout made for this ticket and removed when the ticket is finished. Asking again for the " +
  "same branch brings that checkout up to the branch's newest commit. The answer is EO's own: the checkout's path, " +
  "the commit and where that commit came from, or why nothing was checked out. Read it; do not write to it — EO " +
  "checks it before removing it and says on the ticket what was changed.";

const REPOSITORY_CHECKOUT_TOOL = {
  name: REPOSITORY_CHECKOUT_TOOL_NAME,
  annotations: CHECKS_OUT_ANNOTATIONS,
  description: REPOSITORY_CHECKOUT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      repository: { type: "string", description: "A repository on the ticket's project, by the name your prompt lists it under." },
      branch: { type: "string", description: 'The branch to check out, like "main" or "release/2.4".' },
    },
    required: ["repository", "branch"],
    additionalProperties: false,
  },
};

/**
 * `repository_checkout`: handed to EO, which finds the repository on the
 * item's project, fetches and checks the branch out through the
 * workspace kind that lends it (EO-632), and answers with the path, the
 * commit and where it came from — or refuses with the reason, which this
 * service passes on as the tool's error word for word. This service
 * checks only that the call is the shape the tool advertises.
 */
async function repositoryCheckout(args, writeBridge) {
  if (
    !validObject(args) ||
    !hasOnlyKeys(args, ["repository", "branch"]) ||
    typeof args.repository !== "string" ||
    typeof args.branch !== "string" ||
    args.repository.trim() === "" ||
    args.branch.trim() === ""
  ) {
    return toolError("INVALID_ARGUMENT", "repository_checkout takes `repository`, a repository's name as your prompt lists it, and `branch`, and nothing else.");
  }
  return writeThroughEo(writeBridge, REPOSITORY_CHECKOUT_TOOL_NAME, args);
}

// ── skill_read (EO-721) ───────────────────────────────────────

/**
 * `SKILL_READ_TOOL_NAME` in `@eo/core`, duplicated for the reason
 * `MEMORY_NOTE_TOOL_NAME` is and pinned to it by `eoServer.test.ts`.
 */
export const SKILL_READ_TOOL_NAME = "skill_read";

const SKILL_READ_DESCRIPTION =
  "Load one of the skills EO gave this run: answers with the skill's instructions, which you then follow. `slug` is the " +
  "skill's name as your prompt lists it. Where the skill has supporting files, the answer says where in your working " +
  "directory they are. A skill this run was not given is refused, and nothing is loaded.";

const SKILL_READ_TOOL = {
  name: SKILL_READ_TOOL_NAME,
  description: SKILL_READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The skill's name, as your prompt lists it." },
    },
    required: ["slug"],
    additionalProperties: false,
  },
};

/**
 * The skills this turn was given, by slug, from the environment the turn
 * started this server with (EO-721). Which they are is the main process's
 * to hold a call to; here they only decide whether the tool is listed.
 */
export function parseSkillSlugs(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((slug) => typeof slug === "string" && slug !== "") : [];
}

/**
 * `skill_read`: handed to EO, which answers with the skill's instructions
 * when the run was given it — and records the load — or refuses with the
 * reason. This service checks only that the call is the shape the tool
 * advertises.
 */
async function skillRead(args, writeBridge) {
  if (!validObject(args) || !hasOnlyKeys(args, ["slug"]) || typeof args.slug !== "string" || args.slug.trim() === "") {
    return toolError("INVALID_ARGUMENT", "skill_read takes `slug`, a skill's name as your prompt lists it, and nothing else.");
  }
  return writeThroughEo(writeBridge, SKILL_READ_TOOL_NAME, args);
}

// ── Writes (EO-543) ───────────────────────────────────────────

/**
 * How long a write handed to EO may take: a record's round trip for a
 * note, or the copying of sixteen files of twenty megabytes each.
 */
const WRITE_BRIDGE_TIMEOUT_MS = 60_000;

/**
 * Where this turn hands its writes, from the environment the turn started
 * this server with (EO-543). Anything that is not `{ url, token }` is no
 * bridge, and every write is then answered as not made.
 */
export function parseWriteBridge(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validObject(parsed) && typeof parsed.url === "string" && parsed.url !== "" && typeof parsed.token === "string" && parsed.token !== ""
    ? { url: parsed.url, token: parsed.token }
    : null;
}

/**
 * One write, handed to the EO process that started this turn, and the
 * tool's answer made of what it said (EO-543, ARCHITECTURE.md §13.1).
 *
 * This service opens the database read-only and never writes. Nothing
 * else writes for it either: EO does not read a write off the agent's
 * event stream, so the call has to reach EO here, and the agent is told
 * what EO did — `{ ok, text, data }` or `{ ok: false, code, problem }`
 * from `mcp/writeBridge.ts`. Anything else — no address, no answer, an
 * answer this cannot read — is a write nobody can say was made, and is
 * answered as one that was not.
 */
async function writeThroughEo(writeBridge, tool, args) {
  if (!writeBridge) {
    return toolError("EO_UNREACHABLE", "EO gave this run nowhere to send what it writes, so nothing was written.");
  }
  let response;
  try {
    response = await fetch(writeBridge.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${writeBridge.token}` },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(WRITE_BRIDGE_TIMEOUT_MS),
    });
  } catch (error) {
    return toolError("EO_UNREACHABLE", `EO did not answer, so nothing can be said to have been written (${error instanceof Error ? error.message : String(error)}).`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (validObject(body) && body.ok === true && typeof body.text === "string") {
    return { content: [{ type: "text", text: body.text }], structuredContent: validObject(body.data) ? { ...body.data } : {} };
  }
  if (validObject(body) && body.ok === false && typeof body.problem === "string") {
    return toolError(typeof body.code === "string" && body.code !== "" ? body.code : "WRITE_REFUSED", body.problem);
  }
  return toolError("EO_UNREACHABLE", `EO answered in a way that does not say anything was written (HTTP ${String(response.status)}).`);
}

// ── Configuration tools ───────────────────────────────────────
//
// What the pipeline architect reads before it proposes anything. All
// five are read-only, which is not a restriction on them but the whole
// design: the architect produces a *draft* that a person publishes
// through the same `pipeline:save` the configuration screen uses, so
// there is exactly one path that writes a graph.

const PIPELINE_LIST_TOOL = {
  name: "pipeline_list",
  annotations: READS_ANNOTATIONS,
  description:
    "List every pipeline that holds work, with its step count and where work enters it. Use it to see what " +
    "already exists before proposing a new pipeline or a change to one.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const PIPELINE_READ_TOOL = {
  name: "pipeline_read",
  annotations: READS_ANNOTATIONS,
  description:
    "Read one pipeline in full: every step, who owns it, what it runs, and where each declared result routes. " +
    "Read the pipeline you are changing before you change it.",
  inputSchema: {
    type: "object",
    properties: { pipelineId: { type: "string", description: "The pipeline's id, as `pipeline_list` reports it." } },
    required: ["pipelineId"],
    additionalProperties: false,
  },
};

const AGENTS_LIST_TOOL = {
  name: "agents_list",
  annotations: READS_ANNOTATIONS,
  description:
    "List every configured agent: its role, backend, model, whether it is enabled, what it does, and which " +
    "pipeline steps it already owns. Use it to decide whether an agent that exists can own a step before " +
    "proposing a new one.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const AGENT_READ_TOOL = {
  name: "agent_read",
  annotations: READS_ANNOTATIONS,
  description:
    "Read one agent's full instructions. Use it when the one-line summary from `agents_list` is not enough to " +
    "judge whether it can do a job.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "The agent's display name, as `agents_list` reports it." } },
    required: ["name"],
    additionalProperties: false,
  },
};

const RUNTIMES_LIST_TOOL = {
  name: "runtimes_list",
  annotations: READS_ANNOTATIONS,
  description:
    "List the agent runtimes EO can run, and whether each is installed on this machine and enabled. EO ships a " +
    "fixed set; a runtime that is not installed can be installed, but only the person can agree to that.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
};

const CONFIG_TOOLS = [PIPELINE_LIST_TOOL, PIPELINE_READ_TOOL, AGENTS_LIST_TOOL, AGENT_READ_TOOL, RUNTIMES_LIST_TOOL];
const CONFIG_TOOL_NAMES = CONFIG_TOOLS.map((tool) => tool.name);

export function eoToolList({
  enableCommentTool = false,
  enableConfigTools = false,
  enableFullThread = false,
  enableAttachmentAdd = false,
  enableMemoryRead = false,
  enableMemoryNote = false,
  enableRepositoryCheckout = false,
  enableSkillRead = false,
} = {}) {
  return [
    // EO's own name first, because a model reads a tool list in order
    // and the deprecated twin beside it is the one not to reach for.
    ITEM_DETAIL_TOOL,
    TICKET_DETAIL_TOOL,
    ATTACHMENT_READ_TOOL,
    // Beside the read it is the other half of, and only on a turn that
    // has somewhere to attach from (EO-412): a conversation or a
    // workspace with no disk is told nothing about a tool that could
    // only ever refuse.
    ...(enableAttachmentAdd ? [ATTACHMENT_ADD_TOOL] : []),
    COMMENT_READ_TOOL,
    COMMENT_SEARCH_TOOL,
    // Only on a turn with somewhere to hand the call (EO-633): the
    // checkout is made by EO, never by this server, and a turn with no
    // bridge is one on no item, which has no project to check out from.
    ...(enableRepositoryCheckout ? [REPOSITORY_CHECKOUT_TOOL] : []),
    // Only on a turn EO gave skills to through this tool (EO-721) — a
    // Codex turn; Claude loads its skills with the SDK's own `Skill`.
    ...(enableSkillRead ? [SKILL_READ_TOOL] : []),
    // Only on a turn EO delivered memory to (EO-478), which is the turn
    // that told this server which scopes it may read.
    ...(enableMemoryRead ? [MEMORY_READ_TOOL] : []),
    // Beside the read, for an agent whose allowlist grants it, and only on
    // a turn that was told its scopes (EO-479): without them there is
    // nowhere a note could go.
    ...(enableMemoryNote ? [MEMORY_NOTE_TOOL] : []),
    // The unbounded read. Gated for the same reason the seeded context
    // exists: an agent that can pull a whole thread in one call has
    // undone the seed, and the two decisions are made from one predicate
    // (`fullThreadEnabled`) so they cannot disagree.
    ...(enableFullThread ? [THREAD_READ_TOOL] : []),
    ...(enableCommentTool ? [COMMENT_TOOL] : []),
    ...(enableConfigTools ? CONFIG_TOOLS : []),
  ];
}

function toolError(code, message) {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateComment(args) {
  if (!validObject(args) || !hasOnlyKeys(args, ["body", "mentions", "kind", "options", "blocking"]) || typeof args.body !== "string") return false;
  if (args.mentions !== undefined && (!Array.isArray(args.mentions) || args.mentions.some((item) => typeof item !== "string"))) return false;
  if (args.kind !== undefined && !["note", "question", "decision", "approval"].includes(args.kind)) return false;
  if (args.options !== undefined && (!Array.isArray(args.options) || args.options.some((item) => typeof item !== "string"))) return false;
  return args.blocking === undefined || typeof args.blocking === "boolean";
}

/**
 * The most one attached file may be — `MAX_ATTACHMENT_BYTES` in the
 * desktop's attachment store, duplicated because this file ships alone
 * and pinned by `eoServer.test.ts`.
 */
export const MAX_ATTACHMENT_ADD_BYTES = 20 * 1024 * 1024;

/**
 * One path a run asked to attach, checked against the directory it works
 * in (EO-412, EO-414).
 *
 * Answers with where the file is and how big, or with the sentence that
 * refuses it. Not this server's own check any more — `attachment_add`
 * hands its call to EO, which checks with `checkRunFile` in
 * `supervisor/runAttachments.ts` (EO-543) — but the module host's: a
 * module's `ctx.attach` imports it from here, since that host ships
 * alone as this file does and can import nothing else of EO's.
 * `runAttachments.test.ts` runs both over one table so the two cannot
 * come to disagree.
 *
 * **Contained the way `resolveWithin` contains a declared output**: the
 * path is resolved against the directory and must land inside it, which
 * refuses `../` and an absolute path elsewhere by one rule.
 *
 * **A symbolic link is refused, not followed, anywhere along the path.**
 * A link in a workspace can point at a home directory or at `/etc`, and
 * following one would put a file nobody produced there onto a ticket —
 * and, on a mirrored one, off the machine. Every component is asked with
 * `lstat` rather than only the last, because a real file reached through
 * a linked directory is the same escape one level up.
 */
export async function checkAttachmentPath(directory, path) {
  const base = resolve(directory);
  const target = resolve(base, path);
  if (target === base) return { ok: false, reason: `"${path}" is a directory; only regular files can be attached.` };
  if (!target.startsWith(base + sep)) return { ok: false, reason: `"${path}" is outside the directory this run works in.` };

  const parts = target.slice(base.length + 1).split(sep);
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return { ok: false, reason: `"${path}" does not exist.` };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: `"${path}" is a symbolic link, or is reached through one; EO does not follow links.` };
    if (index < parts.length - 1) {
      if (!info.isDirectory()) return { ok: false, reason: `"${path}" does not exist.` };
      continue;
    }
    if (info.isDirectory()) return { ok: false, reason: `"${path}" is a directory; only regular files can be attached.` };
    if (!info.isFile()) return { ok: false, reason: `"${path}" is not a regular file.` };
    if (info.size > MAX_ATTACHMENT_ADD_BYTES) return { ok: false, reason: `"${path}" is larger than the 20 MB attachment limit.` };
    return { ok: true, absolutePath: target, size: info.size };
  }
  return { ok: false, reason: `"${path}" does not exist.` };
}

function validateAttachmentAdd(args) {
  if (!validObject(args) || !hasOnlyKeys(args, ["paths", "caption"])) return false;
  if (!Array.isArray(args.paths) || args.paths.length === 0 || args.paths.some((path) => typeof path !== "string" || path === "")) return false;
  return args.caption === undefined || typeof args.caption === "string";
}

/**
 * `attachment_add`: handed to EO, which checks every path against the
 * directory the run works in — inside it, a regular file, no link on the
 * way, within the limits — copies the bytes into its attachment store
 * and posts the one comment they hang on, or refuses the whole call and
 * attaches nothing (EO-543). The answer is EO's: the comment and the
 * files it now holds, or which file was refused and why.
 */
async function attachmentAdd(args, attach, writeBridge) {
  if (!attach) return toolError("TOOL_DISABLED", "This run has no workspace directory to attach files from.");
  if (!validateAttachmentAdd(args)) {
    return toolError("INVALID_ARGUMENT", "attachment_add takes `paths`, a list of one to eight file paths, and an optional `caption`, and nothing else.");
  }
  return writeThroughEo(writeBridge, "attachment_add", args);
}

function validateSingleString(args, key) {
  return validObject(args) && hasOnlyKeys(args, [key]) && typeof args[key] === "string" && args[key].trim() !== "";
}

function attachmentOrigin(managed) {
  return managed ? "eo" : "legacy";
}

function attachmentMetadata(attachment, indent = "") {
  return `${indent}- ID: ${attachment.id}; name: ${attachment.name}; MIME type: ${attachment.mime_type}; size: ${attachment.size} bytes; origin: ${attachmentOrigin(attachment.managed)}; synchronization state: local`;
}

function queryAll(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function queryOne(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

/** Every comment reader needs the author's name and role, not its id. */
const COMMENT_SELECT = `SELECT c.*, a.name AS author_name, a.role AS author_role
       FROM comments c
       LEFT JOIN agents a ON a.id = c.author_id`;

/**
 * Who wrote a comment, in the words every reader of this service uses.
 *
 * `module` is named explicitly rather than left to fall through (EO-75):
 * a module's comment has no agent row behind it, so the LEFT JOIN leaves
 * `author_name` null and the fallthrough headed every one of them
 * "unknown agent" — an agent named for something no agent said.
 */
function describeAuthor(comment) {
  const author =
    comment.author_type === "human" ? "you" : comment.author_type === "engine" ? "EO" : comment.author_type === "module" ? "a module" : (comment.author_name ?? "unknown agent");
  return `${author}${comment.author_role ? ` (${comment.author_role})` : ""}`;
}

function attachmentsByComment(db, itemId) {
  const byComment = new Map();
  for (const attachment of queryAll(db, "SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at, id", itemId)) {
    const owned = byComment.get(attachment.comment_id) ?? [];
    owned.push(attachment);
    byComment.set(attachment.comment_id, owned);
  }
  return byComment;
}

/**
 * When a comment was written, in UTC, to the second.
 *
 * ISO 8601 because the reader is a program: it is unambiguous about the
 * zone, it sorts lexically, and it needs no locale to be read the same
 * way twice. Milliseconds are dropped — they say nothing about who
 * answered whom, which is the only question a timestamp is here to
 * settle. A stored value that is not a usable instant yields null and
 * the block simply carries no stamp, rather than printing "Invalid
 * Date" or throwing inside a render.
 */
function commentTimestamp(createdAt) {
  const written = typeof createdAt === "bigint" ? Number(createdAt) : createdAt;
  // 8.64e15 ms is the range `Date` can represent; beyond it `toISOString`
  // throws, which a renderer must not do.
  if (typeof written !== "number" || !Number.isFinite(written) || Math.abs(written) > 8.64e15) return null;
  return `${new Date(written).toISOString().slice(0, 19)}Z`;
}

/**
 * One comment, the way this service has always rendered one.
 *
 * Extracted from the item's own thread so `comment_read` cannot drift
 * into a second format for the same thing: an agent that follows a
 * pointer out of a truncated thread must land on something it already
 * knows how to read.
 *
 * `indent` is `"> "` per level of nesting, which is what the assembled
 * context uses to show that a reply answers what it sits under rather
 * than being the next thing anyone happened to say (D-05). At the top
 * level it is empty and every line here is byte-for-byte what
 * `item_detail` emitted before this existed. Blank lines carry the
 * indent trimmed of its trailing space, so a nested block stays one
 * unbroken quote instead of ending at its own first gap.
 *
 * `timestamp` adds when the comment was written to its heading, and is
 * off for `item_detail` and on for `comment_read`. The asymmetry is
 * deliberate rather than incidental: a comment read inside the whole
 * thread arrives in order, with everything before and after it, so the
 * date is inferable; a comment read on its own — which is the entire
 * point of following a pointer out of a collapsed exchange — arrives
 * with no such context, and "when" is what puts it back beside the rest
 * of the run. Adding it to the thread instead would change what every
 * dispatched agent reads, which this story is explicitly not allowed to
 * do; it stays one flag on one renderer so a later change can flip it
 * for both readers in one place.
 */
function commentBlock(comment, owned, indent = "", { timestamp = false } = {}) {
  // `module` is named explicitly rather than left to fall through
  // (EO-75). A module's comment has no agent row behind it — `author_id`
  // is null by construction — so the LEFT JOIN leaves `author_name`
  // null, and the fallthrough headed every one of them "unknown agent":
  // an agent named for something no agent said. Generic here and
  // specific in the body, matching the project view and the conversation
  // view, because the module signs its own name into the body — the only
  // part of a comment Jira receives — and resolving it again for the
  // heading would name the same module twice in a row.
  const pin = comment.pinned ? " [pinned]" : "";
  const written = timestamp ? commentTimestamp(comment.created_at) : null;
  const when = written ? ` — ${written}` : "";
  const blank = indent.trimEnd();
  const body = comment.body || "(attachment only)";
  const lines = [`${indent}### ${describeAuthor(comment)} — ${comment.kind}${pin}${when}`, blank, ...body.split("\n").map((line) => `${indent}${line}`)];
  if (owned.length > 0) lines.push(blank, `${indent}Attachments:`, ...owned.map((attachment) => attachmentMetadata(attachment, indent)));
  return lines;
}

/**
 * An item, and — only for the caller that may have it — its whole thread.
 *
 * The split is the point. `item_detail` answers with the item: what it
 * is, what it must satisfy, what it waits on, what it shipped. That is what
 * an agent working the item needs, and it is bounded no matter how long
 * the argument about the item has been. `thread_read` answers with all of
 * it, for the roles whose work *is* the conversation.
 */
function renderItem(db, requestedKey, { withThread = false } = {}) {
  // The type is a row of its own since KAN-129, so the word this
  // renders comes from a join rather than from a column — an inner one,
  // because every item has a type and an item without one is a broken
  // database rather than an item to render typeless.
  //
  // A LEFT JOIN on the step, because a feature sits above the pipeline and has no
  // step (`a4e498c`): an inner join dropped every feature and told the
  // agent the key did not exist, while the board listing in the same
  // breath showed it. An implementer reading its parent for the why and
  // scope was the caller that hit this most.
  const item = queryOne(
    db,
    `SELECT t.*, it.slug AS type, ws.is_terminal
       FROM items t
       JOIN item_types it ON it.id = t.type_id
       LEFT JOIN pipeline_steps ws ON ws.id = t.step_id
      WHERE t.key = ?`,
    requestedKey.trim(),
  );
  if (!item) return null;

  const active = queryOne(db, "SELECT 1 AS active FROM runs WHERE item_id = ? AND status IN ('queued', 'running') LIMIT 1", item.id);
  const step = item.step_id === null ? "none — sits above the pipeline; its stories carry the steps" : `${item.step_id}${item.is_terminal ? " (terminal)" : ""}`;
  const lines = [`# ${item.key} — ${item.title}`, "", `- type: ${item.type}`, `- step: ${step}`, `- priority: ${item.priority}`];
  if (item.archived_at !== null) lines.push("- archived: yes");
  if (active) lines.push("- **a run is in progress on this ticket** — its content cannot be amended right now");
  if (item.is_terminal) lines.push("- **finished** — propose a follow-up rather than an amendment");
  if (typeof item.body === "string" && item.body.trim() !== "") lines.push("", "## Description", "", item.body);

  let spec = {};
  try {
    spec = typeof item.spec === "string" ? JSON.parse(item.spec) : (item.spec ?? {});
  } catch {
    spec = {};
  }
  const criteria = Array.isArray(spec.acceptance_criteria) ? spec.acceptance_criteria.filter((item) => typeof item === "string") : [];
  if (criteria.length > 0) lines.push("", "## Acceptance criteria", "", ...criteria.map((item) => `- ${item}`));

  // The item's own files (EO-703): the ones no comment owns, part of
  // what the item is beside its description. Metadata only, in the
  // format a comment's files are listed in; `attachment_read` takes the id.
  const files = queryAll(db, "SELECT * FROM attachments WHERE item_id = ? AND comment_id IS NULL ORDER BY created_at, id", item.id);
  if (files.length > 0) {
    lines.push("", "## Files", "", "Part of the item itself. Read one with `attachment_read`.", "", ...files.map((file) => attachmentMetadata(file)));
  }

  if (item.parent_id !== null) {
    const parent = queryOne(db, "SELECT t.key, it.slug AS type, t.step_id, t.title FROM items t JOIN item_types it ON it.id = t.type_id WHERE t.id = ?", item.parent_id);
    if (parent) lines.push("", "## Parent", "", `${parent.key} (${parent.type}, ${parent.step_id}) — ${parent.title}`);
  }

  const children = queryAll(
    db,
    "SELECT t.key, it.slug AS type, t.step_id, t.title FROM items t JOIN item_types it ON it.id = t.type_id WHERE t.parent_id = ? ORDER BY t.created_at, t.id",
    item.id,
  );
  if (children.length > 0) lines.push("", "## Children", "", ...children.map((child) => `- ${child.key} (${child.type}, ${child.step_id}) — ${child.title}`));

  const waitsFor = queryAll(db, "SELECT t.key, t.step_id, t.title FROM item_deps d JOIN items t ON t.id = d.depends_on_id WHERE d.item_id = ?", item.id);
  const blocks = queryAll(db, "SELECT t.key, t.step_id, t.title FROM item_deps d JOIN items t ON t.id = d.item_id WHERE d.depends_on_id = ?", item.id);
  if (waitsFor.length > 0) lines.push("", "## Waits for", "", ...waitsFor.map((item) => `- ${item.key} (${item.step_id}) — ${item.title}`));
  if (blocks.length > 0) lines.push("", "## Blocks", "", ...blocks.map((item) => `- ${item.key} (${item.step_id}) — ${item.title}`));

  // What this item produced, for the caller that arrived here from a
  // dependency key. The same selection `shippedSummary` makes: the newest
  // succeeded run that returned something, dry runs excluded — borrowing a
  // worktree to watch a module work is not what an item shipped (KAN-106).
  const shipped = queryOne(
    db,
    `SELECT result FROM runs
      WHERE item_id = ? AND status = 'succeeded' AND result IS NOT NULL AND dry_run = 0
      ORDER BY ended_at DESC, id DESC
      LIMIT 1`,
    item.id,
  );
  if (shipped) lines.push("", "## What it shipped", "", "```json", shippedResult(shipped.result), "```");

  if (withThread) {
    const comments = queryAll(db, `${COMMENT_SELECT} WHERE c.item_id = ? ORDER BY c.created_at, c.id`, item.id);
    const byComment = attachmentsByComment(db, item.id);

    if (comments.length > 0) {
      lines.push("", "## Comments", "");
      for (const comment of comments) {
        lines.push(...commentBlock(comment, byComment.get(comment.id) ?? []), "");
      }
    }
  } else {
    // Said rather than left to be discovered: an agent that does not know
    // the discussion is reachable assumes it is gone, and either asks for
    // what it already has a tool for or decides without it.
    lines.push("", "The discussion is not here. Search it with `comment_search`, and open an exchange with `comment_read`.");
  }

  return lines.join("\n").trimEnd();
}

/**
 * How many replies one `comment_read` will render.
 *
 * Bounded on purpose. This tool exists so a thread can be collapsed to a
 * pointer without losing what it pointed at, and a pointer that expands
 * to two hundred replies hands back the whole cost the collapse was
 * paying to avoid. Fifty is far more than the exchange this recovers —
 * a question and the answers under it — and what falls outside it is
 * counted and said rather than dropped quietly; the entire thread is
 * still one `item_detail` away, and the line below names the item to
 * ask for.
 */
const MAX_SUBTREE_REPLIES = 50;

/**
 * The most matches one `comment_search` answers with.
 *
 * Newest first, for the reason context truncation drops oldest first:
 * what a dispatch is about is the recent end of the thread. The bound is
 * generous for a search anyone means, and a search that hits it is one
 * whose pattern is too broad to have been useful.
 */
const MAX_SEARCH_MATCHES = 30;

/** How much of a comment a match is quoted with — enough to recognise it, not enough to be the comment. */
const SEARCH_EXCERPT_RADIUS = 120;

/**
 * The longest pattern accepted, and the most of a body matched against.
 *
 * These bound the *input*. They do not bound the work: `(a+)+$` is seven
 * characters and backtracks forever on forty, so a pattern cap is no
 * protection at all — which is why the matching itself runs somewhere it
 * can be killed (see `searchOffsets`).
 */
const MAX_SEARCH_PATTERN = 200;
const MAX_SEARCH_BODY = 20_000;

/**
 * How long the matching may take before it is abandoned.
 *
 * Generous for any pattern anyone means: a linear match over one item's
 * comments is single-digit milliseconds. What this is really for is the
 * pattern nobody meant — an agent's `(\w+\s*)+$` typo would otherwise
 * pin a core until the run's wall-clock guard fires half an hour later,
 * and keep pinning it afterwards, because the service is a grandchild of
 * EO and outlives the CLI that spawned it.
 */
const SEARCH_TIMEOUT_MS = 2_000;

/**
 * Run a pattern over some bodies, and give up if it will not finish.
 *
 * A worker rather than a timer, because a timer cannot interrupt a
 * regular expression: `String.prototype.search` is one uninterruptible
 * call, and the event loop it is blocking is the one a timer would have
 * to fire on. A worker has its own, and `terminate()` stops it dead.
 *
 * The worker is given the pattern as text and compiles it itself. Nothing
 * else crosses: no database handle, no item, just strings in and
 * offsets out.
 */
async function searchOffsets(pattern, bodies) {
  const { Worker } = await import("node:worker_threads");
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const matcher = new RegExp(workerData.pattern, "i");
     parentPort.postMessage(workerData.bodies.map((body) => body.search(matcher)));`,
    { eval: true, workerData: { pattern, bodies } },
  );

  return await new Promise((resolve) => {
    const stop = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, SEARCH_TIMEOUT_MS);
    worker.on("message", (offsets) => {
      clearTimeout(stop);
      resolve(offsets);
    });
    // A worker that dies for any other reason answers the same way a slow
    // one does: no result, and the caller says so rather than pretending
    // nothing matched.
    worker.on("error", () => {
      clearTimeout(stop);
      resolve(null);
    });
    worker.on("exit", () => {
      clearTimeout(stop);
      resolve(null);
    });
  });
}

/**
 * One item's comments that match a pattern.
 *
 * Ids and excerpts, never bodies and never reply trees: a search that
 * answered with whole comments would rebuild the prompt the seed exists
 * to avoid, one call at a time. What it gives back is enough to decide
 * which comment to open with `comment_read`.
 */
/**
 * The validated half of a run's result, never the raw one.
 *
 * `runs.result` persists both (`PersistedRunResult`): `raw` is whatever
 * the agent returned, unvalidated and unbounded — a refine run's is the
 * product owner's entire proposal — and it is kept for forensics (A-02),
 * not for feeding to another agent. `parsedResultOf` makes the same
 * choice on EO's own side of the wall; this is that rule, on this side.
 *
 * Tolerant of a pre-A-02 row that holds the result directly, and of a
 * column that will not parse: an answer of "what it shipped is not
 * readable" is better than a render that throws.
 */
function shippedResult(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  try {
    const persisted = JSON.parse(text);
    if (persisted !== null && typeof persisted === "object" && "parsed" in persisted) return JSON.stringify(persisted.parsed, null, 2);
    return JSON.stringify(persisted, null, 2);
  } catch {
    return "(unreadable)";
  }
}

async function renderCommentSearch(db, requestedKey, pattern) {
  const item = queryOne(db, "SELECT id, key FROM items WHERE key = ?", requestedKey.trim());
  if (!item) return null;

  const comments = queryAll(db, `${COMMENT_SELECT} WHERE c.item_id = ? ORDER BY c.created_at DESC, c.id DESC`, item.id);
  const byComment = attachmentsByComment(db, item.id);

  const bodies = comments.map((comment) => String(comment.body ?? "").slice(0, MAX_SEARCH_BODY));
  // A comment longer than the cap is matched only up to it, and that is
  // said out loud below rather than answered as "no match": this tool is
  // the only route a seeded agent has back to the thread, so a silent
  // false negative is the reachability promise breaking quietly.
  const truncated = comments.filter((comment, index) => String(comment.body ?? "").length > bodies[index].length).length;

  const offsets = await searchOffsets(pattern, bodies);
  if (offsets === null) {
    return `That pattern did not finish within ${SEARCH_TIMEOUT_MS / 1000} seconds on ${item.key} and was abandoned. Patterns with nested repetition — \`(a+)+\`, \`(\\w+\\s*)+\` — can take effectively forever; search for a literal phrase instead.`;
  }

  const matched = [];
  offsets.forEach((at, index) => {
    if (at === -1) return;
    matched.push({ comment: comments[index], excerpt: excerptAround(bodies[index], at) });
  });

  if (matched.length === 0) {
    const caveat = truncated > 0 ? ` ${truncated} comment${truncated === 1 ? " was" : "s were"} long enough to be matched only in part.` : "";
    return `No comment on ${item.key} matches that pattern.${caveat}`;
  }

  const shown = matched.slice(0, MAX_SEARCH_MATCHES);
  const lines = [`# ${matched.length} comment${matched.length === 1 ? "" : "s"} on ${item.key} match that pattern`, ""];

  for (const { comment, excerpt } of shown) {
    const written = commentTimestamp(comment.created_at);
    // `[pinned]` travels with the result: a pinned comment is the one
    // somebody marked as mattering most, which is exactly what a search
    // is looking for.
    lines.push(`### ${describeAuthor(comment)} — ${comment.kind}${comment.pinned ? " [pinned]" : ""}${written ? ` — ${written}` : ""}`);
    lines.push(`ID: ${comment.id}`);
    if (comment.parent_id) lines.push(`A reply — read the exchange with \`comment_read\` on ${comment.parent_id}`);
    lines.push("", excerpt, "");
    const attachments = byComment.get(comment.id) ?? [];
    for (const attachment of attachments) lines.push(attachmentMetadata(attachment, ""));
    if (attachments.length > 0) lines.push("");
  }

  if (matched.length > shown.length) {
    lines.push(`[${matched.length - shown.length} further match${matched.length - shown.length === 1 ? "" : "es"} not shown — narrow the pattern.]`);
  }
  if (truncated > 0) {
    lines.push(`[${truncated} comment${truncated === 1 ? " was" : "s were"} long enough that only the first ${MAX_SEARCH_BODY} characters were searched.]`);
  }

  return lines.join("\n").trimEnd();
}

/** The match and ~120 characters either side, so it is recognisable without being quoted whole. */
function excerptAround(body, at) {
  // Snapped off a surrogate pair. Slicing by code unit can cut an emoji in
  // half, and a lone surrogate travels over JSON-RPC as an unpaired escape
  // that strict parsers turn into a replacement character.
  const from = wholeCharBoundary(body, Math.max(0, at - SEARCH_EXCERPT_RADIUS));
  const to = wholeCharBoundary(body, Math.min(body.length, at + SEARCH_EXCERPT_RADIUS));
  return `${from > 0 ? "…" : ""}${body.slice(from, to).trim()}${to < body.length ? "…" : ""}`;
}

/** Nudges an index off the low half of a surrogate pair. */
function wholeCharBoundary(text, index) {
  const code = text.charCodeAt(index);
  return Number.isNaN(code) || code < 0xdc00 || code > 0xdfff ? index : index + 1;
}

/**
 * One comment and everything filed beneath it.
 *
 * The walk is recursive because the subtree is: threading is one level
 * by design (D-05) and is not one level in practice — a product owner's
 * question hangs off the opening request and the person's answer hangs
 * off the question — and a one-level walk is exactly the bug that hid
 * those answers from agents (KAN-69). Nothing enforces the depth, so
 * nothing here assumes it.
 *
 * Replies are read from the comment's own item in one query and
 * grouped in memory, so depth costs no extra round trips, and `seen`
 * makes a parent cycle terminate instead of recursing forever.
 */
function renderCommentSubtree(db, requestedId) {
  const root = queryOne(db, `${COMMENT_SELECT} WHERE c.id = ?`, requestedId.trim());
  if (!root) return null;

  const item = queryOne(db, "SELECT key FROM items WHERE id = ?", root.item_id);
  const thread = queryAll(db, `${COMMENT_SELECT} WHERE c.item_id = ? ORDER BY c.created_at, c.id`, root.item_id);
  const byComment = attachmentsByComment(db, root.item_id);

  const repliesByParent = new Map();
  for (const comment of thread) {
    if (comment.parent_id === null) continue;
    const siblings = repliesByParent.get(comment.parent_id) ?? [];
    siblings.push(comment);
    repliesByParent.set(comment.parent_id, siblings);
  }

  const ordered = [];
  const seen = new Set([root.id]);
  const walk = (parentId, depth) => {
    for (const reply of repliesByParent.get(parentId) ?? []) {
      if (seen.has(reply.id)) continue;
      seen.add(reply.id);
      ordered.push({ comment: reply, depth });
      walk(reply.id, depth + 1);
    }
  };
  walk(root.id, 1);

  const shown = ordered.slice(0, MAX_SUBTREE_REPLIES);
  const lines = [`# A comment on ${item?.key ?? "an item"} and the replies under it`, ""];
  // Stamped, root and replies alike: a subtree arrives with none of the
  // surrounding thread to date it by.
  lines.push(...commentBlock(root, byComment.get(root.id) ?? [], "", { timestamp: true }), "");
  for (const { comment, depth } of shown) {
    lines.push(...commentBlock(comment, byComment.get(comment.id) ?? [], "> ".repeat(depth), { timestamp: true }), "");
  }

  const omitted = ordered.length - shown.length;
  if (ordered.length === 0) lines.push("It has no replies.");
  else if (omitted > 0) {
    lines.push(
      `[${omitted} further ${omitted === 1 ? "reply" : "replies"} not shown. Read ${item?.key ?? "the item"} with item_detail for the whole thread.]`,
    );
  }

  return lines.join("\n").trimEnd();
}

// ── Rendering the configuration ───────────────────────────────

/**
 * What an agent is for, in one line, from its own instructions.
 *
 * A deliberate copy of `summarizeInstructions` in `packages/core`, which
 * is the canonical one and the one the Agents screen and the dispatch
 * context both use. It is duplicated here rather than imported because
 * this file is shipped unbundled and launched as a bare Node process —
 * it can import `node:*` and nothing else, by design, since Codex needs
 * a real path to spawn.
 *
 * The duplication is made safe by a test rather than by hoping:
 * `eoServer.test.ts` runs both implementations over the same inputs and
 * fails if they ever disagree. Change one and you change both.
 */
export function summarizeInstructions(instructions) {
  for (const raw of String(instructions ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("<!--") || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

/** A pipeline holds work when any step of it is a column. The rest are conversations. */
function holdsWork(db, pipelineId) {
  const steps = queryAll(db, "SELECT off_board FROM pipeline_steps WHERE pipeline_id = ?", pipelineId);
  return steps.length === 0 || steps.some((step) => !step.off_board);
}

function renderPipelineList(db) {
  const pipelines = queryAll(db, "SELECT * FROM pipelines WHERE archived_at IS NULL ORDER BY position, id");
  const listed = pipelines.filter((pipeline) => holdsWork(db, pipeline.id));
  if (listed.length === 0) return "There are no pipelines yet.";

  const lines = ["# Pipelines", ""];
  for (const pipeline of listed) {
    const steps = queryAll(db, "SELECT id FROM pipeline_steps WHERE pipeline_id = ? AND off_board = 0", pipeline.id);
    const entry = pipeline.entry_step_id ?? "nowhere — work cannot enter it";
    lines.push(`- \`${pipeline.id}\` **${pipeline.name}** — ${steps.length} step(s); work enters at ${entry}`);
  }
  return lines.join("\n");
}

function renderPipeline(db, pipelineId) {
  const pipeline = queryOne(db, "SELECT * FROM pipelines WHERE id = ?", pipelineId.trim());
  if (!pipeline) return null;

  const steps = queryAll(
    db,
    "SELECT * FROM pipeline_steps WHERE pipeline_id = ? AND off_board = 0 ORDER BY position, id",
    pipeline.id,
  );
  const routes = queryAll(db, "SELECT * FROM step_routes WHERE pipeline_id = ? ORDER BY from_step_id, position", pipeline.id);
  const counts = new Map(
    queryAll(
      db,
      "SELECT step_id, COUNT(*) AS n FROM items WHERE step_id IS NOT NULL AND archived_at IS NULL GROUP BY step_id",
    ).map((row) => [row.step_id, row.n]),
  );

  const lines = [
    `# ${pipeline.name}`,
    "",
    `- id: ${pipeline.id}`,
    `- work enters at: ${pipeline.entry_step_id ?? "**nowhere — this pipeline cannot receive work**"}`,
    "",
    "## Steps",
    "",
  ];

  if (steps.length === 0) lines.push("It has none.");
  for (const step of steps) {
    const owner =
      step.type === "user"
        ? "waits for the person"
        : step.type === "builtin"
          ? `EO runs \`${step.entry_action ?? "nothing"}\``
          : `\`${step.owner_role ?? "nobody"}\` runs \`${step.entry_action ?? "nothing"}\``;
    const flags = [step.is_terminal ? "terminal" : null, step.plan_mode ? "plans first" : null].filter(Boolean);
    const held = counts.get(step.id) ?? 0;
    lines.push(`- \`${step.id}\` **${step.name}** — ${owner}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`);
    // The count is what makes changing a step consequential rather than
    // merely structural, and removing one that holds work is refused.
    if (held > 0) lines.push(`  - ${held} ticket(s) sitting here right now`);
    if (step.instructions_summary) lines.push(`  - ${step.instructions_summary}`);
  }

  lines.push("", "## Routes", "");
  if (routes.length === 0) lines.push("It declares none, so nothing can move through it.");
  for (const route of routes) {
    lines.push(`- \`${route.from_step_id}\` / \`${route.result_key}\` → \`${route.target}\` (${route.label})`);
  }

  return lines.join("\n");
}

function renderAgents(db) {
  // Live agents only (EO-186). This listing exists to answer "can one of
  // these own the step I am adding", and a retired agent cannot: it
  // staffs no role, and a step owned by its role would park every item
  // that reached it. The row is kept so its runs and comments still
  // resolve, not so it can be given work again.
  const agents = queryAll(db, "SELECT * FROM agents WHERE archived_at IS NULL ORDER BY name");
  if (agents.length === 0) return "There are no agents configured, so no step can be owned by a role.";

  const steps = queryAll(db, "SELECT s.*, p.name AS pipeline_name FROM pipeline_steps s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.off_board = 0");
  const lines = ["# Agents", ""];

  for (const agent of agents) {
    const model = agent.model ? `/${agent.model}` : "";
    const state = agent.enabled ? "" : ", **disabled**";
    lines.push(`## ${agent.name}`, "", `- role: \`${agent.role}\``, `- backend: ${agent.provider}${model}${state}`);
    // The field the whole listing exists for: two agents in the same
    // role can be instructed very differently, and that is what decides
    // whether one of them can own the step being added.
    lines.push(`- what it does: ${summarizeInstructions(agent.instructions) ?? "nothing — it has no instructions yet"}`);

    const owned = steps.filter((step) => step.owner_role === agent.role);
    if (owned.length === 0) lines.push("- owns no steps");
    else {
      lines.push("- owns:");
      for (const step of owned) {
        lines.push(`  - ${step.pipeline_name} / ${step.name}${step.entry_action ? ` (\`${step.entry_action}\`)` : ""}`);
      }
    }
    lines.push("");
  }

  lines.push("Use `agent_read` for an agent's full instructions before deciding it cannot do a job.");
  return lines.join("\n");
}

function renderAgent(db, name) {
  const wanted = name.trim().toLowerCase();
  const agent = queryAll(db, "SELECT * FROM agents").find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!agent) return null;

  return [
    `# ${agent.name}`,
    "",
    `- role: \`${agent.role}\``,
    `- backend: ${agent.provider}${agent.model ? `/${agent.model}` : ""}`,
    `- enabled: ${agent.enabled ? "yes" : "no"}`,
    "",
    "## Instructions",
    "",
    agent.instructions,
  ].join("\n");
}

/**
 * The runtimes EO ships, and whether this machine has them.
 *
 * The catalog is duplicated here in the only way that matters to a
 * reader — the ids — because this process cannot import
 * `runtimes/catalog.ts`. Versions deliberately are not: "installed" is
 * answered by the same `<id>@<version>` directory convention
 * `hasManagedCache` uses, so a version bump needs no change here.
 */
function renderRuntimes(db, runtimeRoot) {
  const known = [
    { id: "claude", label: "Claude Code", prefixes: ["claude@", "@anthropic-ai/claude-agent-sdk@"] },
    { id: "codex", label: "Codex", prefixes: ["codex@"] },
  ];

  let entries = [];
  try {
    entries = runtimeRoot ? readdirSync(runtimeRoot) : [];
  } catch {
    entries = [];
  }

  const lines = ["# Runtimes", "", "EO ships these and no others. Adding another is a change to EO itself, not configuration.", ""];
  for (const runtime of known) {
    const installed = entries.some((entry) => runtime.prefixes.some((prefix) => entry.startsWith(prefix)) && !entry.endsWith(".partial"));
    const setting = queryOne(db, "SELECT value FROM app_settings WHERE key = ?", `runtimes.enabled.${runtime.id}`);
    // Absent means enabled: the preference is only ever written when
    // somebody turns one off.
    const enabled = setting ? JSON.parse(setting.value) !== false : true;
    const state = !runtimeRoot
      ? "cannot tell whether it is installed"
      : installed
        ? enabled
          ? "installed and enabled"
          : "installed but disabled"
        : "not installed";
    lines.push(`- \`${runtime.id}\` **${runtime.label}** — ${state}`);
  }

  lines.push(
    "",
    "Installing one downloads it from npm and grants standing permission to update it, so propose it and let the person agree.",
  );
  return lines.join("\n");
}

export function openServiceDatabase(path) {
  if (!path) return null;
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * One tool call, answered — and every answer's `structuredContent`
 * carrying everything its text does (EO-543).
 *
 * Claude Code hands an agent a tool's `structuredContent` and not its
 * text whenever there is some, so a structured part that says less than
 * the text is a Claude agent told less than a Codex agent about the same
 * call (invariant 12). The rule the MCP host holds its own tools to
 * (EO-202) is held here by construction: whatever a tool answers, the
 * text it answers with goes into the structured part as `text`, beside
 * whatever fields it gave.
 */
export async function callEoTool(options) {
  return withStructuredText(await answerEoTool(options));
}

/** The text blocks of an answer, joined; empty where it has none. */
function textOf(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => validObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function withStructuredText(result) {
  const text = textOf(result);
  const structured = validObject(result.structuredContent) ? result.structuredContent : {};
  if (text === "" && validObject(result.structuredContent)) return result;
  return { ...result, structuredContent: text === "" ? structured : { ...structured, text } };
}

async function answerEoTool({
  name,
  args,
  db,
  enableCommentTool = false,
  enableConfigTools = false,
  enableFullThread = false,
  runtimeRoot = null,
  attach = null,
  memoryScopes = [],
  enableMemoryNote = false,
  enableSkillRead = false,
  writeBridge = null,
}) {
  if (CONFIG_TOOL_NAMES.includes(name)) {
    if (!enableConfigTools) return toolError("TOOL_DISABLED", `The ${name} tool is not enabled for this role.`);
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's configuration store is unavailable.");

    // One try/catch for all five: every one of them is a read against the
    // same handle, and an unreadable store is the same answer whichever
    // asked.
    try {
      if (name === "pipeline_list") {
        if (!validObject(args) || !hasOnlyKeys(args, [])) return toolError("INVALID_ARGUMENT", "pipeline_list takes no arguments.");
        return { content: [{ type: "text", text: renderPipelineList(db) }] };
      }

      if (name === "pipeline_read") {
        if (!validateSingleString(args, "pipelineId")) return toolError("INVALID_ARGUMENT", "pipeline_read requires exactly one non-empty pipeline id.");
        const rendered = renderPipeline(db, args.pipelineId);
        return {
          content: [
            { type: "text", text: rendered ?? `No pipeline with id "${args.pipelineId}". Use pipeline_list for the ids that exist.` },
          ],
        };
      }

      if (name === "agents_list") {
        if (!validObject(args) || !hasOnlyKeys(args, [])) return toolError("INVALID_ARGUMENT", "agents_list takes no arguments.");
        return { content: [{ type: "text", text: renderAgents(db) }] };
      }

      if (name === "agent_read") {
        if (!validateSingleString(args, "name")) return toolError("INVALID_ARGUMENT", "agent_read requires exactly one non-empty agent name.");
        const rendered = renderAgent(db, args.name);
        return {
          content: [{ type: "text", text: rendered ?? `No agent named "${args.name}". Use agents_list for the names that exist.` }],
        };
      }

      if (!validObject(args) || !hasOnlyKeys(args, [])) return toolError("INVALID_ARGUMENT", "runtimes_list takes no arguments.");
      return { content: [{ type: "text", text: renderRuntimes(db, runtimeRoot) }] };
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read its configuration.");
    }
  }

  if (name === "comment") {
    if (!enableCommentTool) return toolError("TOOL_DISABLED", "The comment tool is not enabled for this role.");
    if (!validateComment(args)) return toolError("INVALID_ARGUMENT", "comment requires a body and accepts only the advertised argument types.");
    // Posted by EO, which resolves the mentions, and — for a blocking
    // one — ends this run as it posts (invariant 9). The answer says
    // which happened.
    return writeThroughEo(writeBridge, "comment", args);
  }

  // One handler, two names (KAN-162). The answer does not depend on
  // which was called — an alias that behaved differently would be a
  // second tool wearing the first one's name — and that includes the
  // refusal, which names `item_detail` from either door: EO writes its
  // own name for a tool in every sentence it produces, so a pair cannot
  // differ in the one place it has something to say about itself.
  if (name === "item_detail" || name === "ticket_detail") {
    if (!validateSingleString(args, "key")) return toolError("INVALID_ARGUMENT", "item_detail requires exactly one non-empty ticket key.");
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's ticket store is unavailable.");
    try {
      const rendered = renderItem(db, args.key);
      return { content: [{ type: "text", text: rendered ?? `No ticket with key "${args.key}". Check the board listing for the keys that exist.` }] };
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read the ticket store.");
    }
  }

  if (name === "thread_read") {
    if (!enableFullThread) {
      return toolError("TOOL_DISABLED", "The whole-thread read is not enabled for this role. Use item_detail and comment_search.");
    }
    if (!validateSingleString(args, "key")) return toolError("INVALID_ARGUMENT", "thread_read requires exactly one non-empty ticket key.");
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's ticket store is unavailable.");
    try {
      const rendered = renderItem(db, args.key, { withThread: true });
      return { content: [{ type: "text", text: rendered ?? `No ticket with key "${args.key}". Check the board listing for the keys that exist.` }] };
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read the ticket store.");
    }
  }

  if (name === "comment_search") {
    if (!validObject(args) || !hasOnlyKeys(args, ["key", "pattern"]) || typeof args.key !== "string" || typeof args.pattern !== "string") {
      return toolError("INVALID_ARGUMENT", "comment_search requires a ticket key and a pattern.");
    }
    if (args.key.trim() === "" || args.pattern === "") return toolError("INVALID_ARGUMENT", "comment_search requires a ticket key and a pattern.");
    // A pattern this long is not a search, and length is the only cheap
    // bound available: Node cannot time a regular expression out, so a
    // pathological one runs until the run's wall-clock guard notices.
    if (args.pattern.length > MAX_SEARCH_PATTERN) {
      return toolError("INVALID_ARGUMENT", `A search pattern may be at most ${MAX_SEARCH_PATTERN} characters.`);
    }
    try {
      // Compiled here only to reject a malformed pattern with a clear
      // answer; the matching itself is done by the worker, which compiles
      // it again in the thread that may have to be killed for it.
      new RegExp(args.pattern, "i");
    } catch (error) {
      // Never fall back to a substring search: an agent that asked for a
      // pattern and silently got something else cannot reason about what
      // came back, or about what did not.
      return toolError("INVALID_ARGUMENT", `"${args.pattern}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's comment store is unavailable.");
    try {
      const rendered = await renderCommentSearch(db, args.key, args.pattern);
      return { content: [{ type: "text", text: rendered ?? `No ticket with key "${args.key}". Check the board listing for the keys that exist.` }] };
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read the comment store.");
    }
  }

  // Read-only, and no reach `item_detail` did not already have: the
  // same handle, the same rendering, and a strict subset of one item's
  // thread.
  if (name === "comment_read") {
    if (!validateSingleString(args, "commentId")) return toolError("INVALID_ARGUMENT", "comment_read requires exactly one non-empty comment ID.");
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's comment store is unavailable.");
    let rendered;
    try {
      rendered = renderCommentSubtree(db, args.commentId);
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read the comment store.");
    }
    // A missing id is answered the way `attachment_read` answers one, not
    // with an empty thread that reads like a comment nobody replied to.
    if (rendered === null) return toolError("COMMENT_NOT_FOUND", `No comment exists with ID "${args.commentId}".`);
    return { content: [{ type: "text", text: rendered }] };
  }

  if (name === "attachment_add") return attachmentAdd(args, attach, writeBridge);

  if (name === REPOSITORY_CHECKOUT_TOOL_NAME) {
    if (!writeBridge) return toolError("TOOL_DISABLED", "This run is on no ticket EO can check a repository out for.");
    return repositoryCheckout(args, writeBridge);
  }

  if (name === SKILL_READ_TOOL_NAME) {
    if (!enableSkillRead) return toolError("TOOL_DISABLED", "EO gave this run no skills to load.");
    return skillRead(args, writeBridge);
  }

  if (name === MEMORY_READ_TOOL_NAME) return memoryRead(args, db, memoryScopes);

  if (name === MEMORY_NOTE_TOOL_NAME) {
    if (!enableMemoryNote) return toolError("TOOL_DISABLED", "memory_note is not granted to this agent.");
    return memoryNote(args, memoryScopes, writeBridge);
  }

  if (name === "attachment_read") {
    if (!validateSingleString(args, "attachmentId")) return toolError("INVALID_ARGUMENT", "attachment_read requires exactly one non-empty attachment ID.");
    if (!db) return toolError("DATABASE_UNAVAILABLE", "EO's attachment store is unavailable.");
    let attachment;
    try {
      attachment = queryOne(db, "SELECT id, storage_path, mime_type, size FROM attachments WHERE id = ?", args.attachmentId);
    } catch {
      return toolError("DATABASE_UNAVAILABLE", "EO could not read the attachment store.");
    }
    if (!attachment) return toolError("ATTACHMENT_NOT_FOUND", `No attachment exists with ID "${args.attachmentId}".`);

    let data;
    try {
      data = await readFile(attachment.storage_path);
    } catch {
      return toolError("ATTACHMENT_UNREADABLE", `Attachment "${args.attachmentId}" is not readable from durable storage.`);
    }

    const metadata = { attachmentId: attachment.id, mimeType: attachment.mime_type, size: attachment.size };
    if (attachment.mime_type.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(attachment.mime_type)) {
      return { content: [{ type: "text", text: data.toString("utf8") }], structuredContent: metadata };
    }
    if (attachment.mime_type.startsWith("image/")) {
      return { content: [{ type: "image", data: data.toString("base64"), mimeType: attachment.mime_type }], structuredContent: metadata };
    }
    return {
      content: [{ type: "resource", resource: { uri: `eo-attachment://${attachment.id}`, mimeType: attachment.mime_type, blob: data.toString("base64") } }],
      structuredContent: metadata,
    };
  }

  return toolError("TOOL_NOT_FOUND", `EO has no tool named "${name}".`);
}

export function createEoMcpService({
  dbPath = process.env["EO_MCP_DB_PATH"],
  enableCommentTool = process.env["EO_MCP_COMMENT_ENABLED"] === "1",
  enableConfigTools = process.env["EO_MCP_CONFIG_ENABLED"] === "1",
  enableFullThread = process.env["EO_MCP_FULL_THREAD_ENABLED"] === "1",
  // Where EO caches the CLIs it fetched. Absent is a real answer — the
  // service then says it cannot tell whether a runtime is installed
  // rather than claiming none are.
  runtimeRoot = process.env["EO_MCP_RUNTIME_ROOT"] ?? null,
  // The run this server was started for and the directory it works in
  // (EO-412). Both or neither: without the pair there is nothing to
  // attach from and nothing to check a path against, and the tool is
  // not listed.
  runId = process.env["EO_MCP_RUN_ID"] ?? null,
  runDirectory = process.env["EO_MCP_RUN_DIRECTORY"] ?? null,
  // The memory scopes this turn may read (EO-478), as JSON. Absent or
  // unreadable, `memory_read` is not listed.
  memoryScopes = parseMemoryScopes(process.env["EO_MCP_MEMORY_SCOPES"]),
  // Whether this agent's allowlist grants `memory_note` (EO-479). Listed
  // only with the scopes above, which are where a note may go.
  enableMemoryNote = process.env["EO_MCP_MEMORY_NOTE_ENABLED"] === "1",
  // Where this turn hands what an agent writes (EO-543), as JSON. Absent,
  // the write tools are still listed and answer that nothing could be
  // written: the grant is the agent's, and the bridge being down is a
  // fault to say, not a capability to hide.
  writeBridge = parseWriteBridge(process.env["EO_MCP_WRITE_BRIDGE"]),
  // The skills this turn was given to load with `skill_read` (EO-721), as
  // JSON. Absent or empty, the tool is not listed.
  skillSlugs = parseSkillSlugs(process.env["EO_MCP_SKILLS"]),
} = {}) {
  let db = null;
  try {
    db = openServiceDatabase(dbPath);
  } catch {
    db = null;
  }

  // Which run this is and where it works: what lists `attachment_add`.
  // The directory a path is checked against is EO's to know, not this
  // server's to say — the main process holds it for the turn (EO-543).
  const attach = runId && runDirectory ? { runId, directory: runDirectory } : null;
  const readable = Array.isArray(memoryScopes) ? parseMemoryScopes(JSON.stringify(memoryScopes)) : [];
  const writable = enableMemoryNote === true && readable.length > 0;
  const bridge = validObject(writeBridge) ? writeBridge : null;
  const listed = {
    enableCommentTool,
    enableConfigTools,
    enableFullThread,
    enableAttachmentAdd: attach !== null,
    enableMemoryRead: readable.length > 0,
    enableMemoryNote: writable,
    enableRepositoryCheckout: bridge !== null,
    enableSkillRead: Array.isArray(skillSlugs) && skillSlugs.length > 0,
  };

  return {
    tools: eoToolList(listed),
    async handle(request) {
      if (!validObject(request) || request.jsonrpc !== "2.0") return null;
      if (request.method === "initialize") {
        return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: EO_MCP_SERVER_NAME, version: EO_MCP_SERVER_VERSION } } };
      }
      if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
      if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: eoToolList(listed) } };
      if (request.method === "tools/call") {
        const result = await callEoTool({
          name: request.params?.name,
          args: request.params?.arguments ?? {},
          db,
          enableCommentTool,
          enableConfigTools,
          enableFullThread,
          runtimeRoot,
          attach,
          memoryScopes: readable,
          enableMemoryNote: writable,
          enableSkillRead: listed.enableSkillRead,
          writeBridge: bridge,
        });
        return { jsonrpc: "2.0", id: request.id, result };
      }
      if (request.id === undefined) return null;
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
    },
    close() {
      db?.close();
    },
  };
}

async function serveStdio() {
  const service = createEoMcpService();
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          const response = await service.handle(JSON.parse(line));
          if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
        } catch {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.once("exit", () => service.close());
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await serveStdio();
