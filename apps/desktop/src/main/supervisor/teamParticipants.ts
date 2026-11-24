import {
  EVIDENCE_LIST_TOOL_NAME,
  EVIDENCE_READ_MAX_LINES,
  EVIDENCE_READ_TOOL_NAME,
  EVIDENCE_SEARCH_MAX_RESULTS,
  EVIDENCE_SEARCH_TOOL_NAME,
  EvidenceListArgsSchema,
  EvidenceReadArgsSchema,
  EvidenceSearchArgsSchema,
  isTeamEvidenceTool,
  ITEM_CONTEXT_TOOL_NAME,
  ItemContextArgsSchema,
  MEMORY_NOTE_TOOL_NAME,
  REPOSITORY_CHECKOUT_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  reportOnlyRefusal,
  TEAM_EVIDENCE_TOOLS,
  type AgentWriteAnswer,
  type AgentWriteBridgeAddress,
  type AgentWriteRequest,
  type AgentWriteTool,
  type Comment,
  type Item,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { getRun } from "../db/repos/runsRepo.js";
import { getTeamAttempt } from "../db/repos/teamSessionsRepo.js";
import type { AgentWriteBridge } from "../mcp/writeBridge.js";
import { evidencePath, looksLikeText, readCapturedAttachment, type TeamEvidence } from "./teamEvidence.js";

/**
 * A report-only team participant, as EO answers its calls (EO-845).
 *
 * Each participant's attempt is registered here while it runs, with the
 * evidence it was given and where its thread ends. Its turns are handed a
 * credential naming the four evidence tools and its attempt under the
 * bridge's MAC (`reportOnlyCredential`), so a call is answered from that
 * attempt's scope alone — never a sibling's, and never from EO's
 * database the way the ordinary `eo` tools are.
 *
 * **Where a participant's thread ends.** A first-pass participant sees the
 * item's thread up to when its team's evidence was captured: the same
 * context every sibling of that pass was given, and none of the reports
 * they post after it — those reach the person at once, as every comment
 * does, and reach a participant only where a later round exposes them by
 * name (`exposedCommentIds`). `item_context` is the participant's only
 * way into the thread: `item_detail`, `comment_read`, `comment_search` and
 * `thread_read` are refused on its turn by the `eo` server and by the
 * backend's hook, so no other route reads past the boundary.
 */

/** Where a participant's view of the item's thread ends. */
export interface ThreadBoundary {
  /** Comments created at or before this instant, in ms. */
  visibleThrough: number;
  /** Comments after it a later coordination round shows the participant, by id. */
  exposedCommentIds: readonly string[];
  /**
   * Comments before it the participant is not shown, by id (EO-846): its
   * own team's reports, which a retry or a replacement started after its
   * siblings reported must not read any more than the first pass could.
   */
  hiddenCommentIds?: readonly string[];
}

/** The boundary a first pass is given: the instant its evidence was captured, and nothing after it. */
export function firstPassBoundary(evidence: TeamEvidence): ThreadBoundary {
  return { visibleThrough: evidence.ref.capturedAt, exposedCommentIds: [] };
}

export interface TeamParticipantScope {
  attemptId: string;
  itemId: string;
  evidence: TeamEvidence;
  thread: ThreadBoundary;
}

export interface TeamParticipantScopes {
  /** Registers an attempt's scope for as long as its turns run; the answer lets it go. */
  register(scope: TeamParticipantScope): () => void;
  get(attemptId: string): TeamParticipantScope | undefined;
}

export function createTeamParticipantScopes(): TeamParticipantScopes {
  const scopes = new Map<string, TeamParticipantScope>();
  return {
    register(scope) {
      scopes.set(scope.attemptId, scope);
      return () => {
        if (scopes.get(scope.attemptId) === scope) scopes.delete(scope.attemptId);
      };
    },
    get: (attemptId) => scopes.get(attemptId),
  };
}

/**
 * The credential a participant's turns hand their `eo` server (EO-845):
 * the four evidence tools and the attempt, signed, and marked report-only
 * so the server lists those alone and refuses everything else.
 */
export function reportOnlyCredential(bridge: Pick<AgentWriteBridge, "tokenFor">, itemId: string, attemptId: string): AgentWriteBridgeAddress {
  return { ...bridge.tokenFor(itemId, TEAM_EVIDENCE_TOOLS, attemptId), reportOnly: true };
}

/**
 * What an isolated member's credential's scope is prefixed with (EO-867),
 * so the bridge answers its writes for its own run rather than as a
 * report-only participant's evidence calls.
 */
export const MEMBER_SCOPE_PREFIX = "member_";

/** The attempt a member's scope names, or null for a scope that is not a member's. */
export function memberAttemptOf(scope: string | null): string | null {
  return scope !== null && scope.startsWith(MEMBER_SCOPE_PREFIX) ? scope.slice(MEMBER_SCOPE_PREFIX.length) : null;
}

/** The writes an isolated member is served: its agent's own, less posting anything on the item (EO-867). */
export function memberWrites(memoryNote: boolean): AgentWriteTool[] {
  const writes: AgentWriteTool[] = [REPOSITORY_CHECKOUT_TOOL_NAME as AgentWriteTool, SKILL_READ_TOOL_NAME as AgentWriteTool];
  return memoryNote ? [MEMORY_NOTE_TOOL_NAME as AgentWriteTool, ...writes] : writes;
}

/**
 * The credential an isolated member's turn hands its ordinary `eo` server
 * (EO-867): its attempt under the MAC, the writes it is served — never
 * `comment` or `attachment_add`, since it posts nothing on the item — and
 * where its view of the thread ends, so its team's other reports stay
 * out of every thread read.
 */
export function memberCredential(bridge: Pick<AgentWriteBridge, "tokenFor">, itemId: string, attemptId: string, writes: readonly AgentWriteTool[], boundary: ThreadBoundary): AgentWriteBridgeAddress {
  return {
    ...bridge.tokenFor(itemId, writes, `${MEMBER_SCOPE_PREFIX}${attemptId}`),
    teamMember: { itemId, visibleThrough: boundary.visibleThrough, exposed: [...boundary.exposedCommentIds], hidden: [...(boundary.hiddenCommentIds ?? [])] },
  };
}

/**
 * Why an isolated member was not started where EO has no write bridge to
 * sign its credential (EO-870): its team boundary reaches its `eo` server
 * only on that credential, and a server with none serves the whole thread.
 */
export const MEMBER_NO_BRIDGE =
  "EO's agent write bridge is not listening, and a member's view of the thread reaches its `eo` server only on a credential that bridge signs: without one it would be served the whole thread, its team's other reports included.";

/** Whether a comment is within a boundary: the rule `participantThread` applies, as a predicate. */
export function withinBoundary(boundary: ThreadBoundary): (comment: Pick<Comment, "id" | "createdAt">) => boolean {
  const exposed = new Set(boundary.exposedCommentIds);
  const hidden = new Set(boundary.hiddenCommentIds ?? []);
  return (comment) => exposed.has(comment.id) || (comment.createdAt <= boundary.visibleThrough && !hidden.has(comment.id));
}

/**
 * The provider thread a participant's attempt may resume (EO-845): the one
 * its own run recorded, and no other. A retry is a new attempt and starts
 * a thread of its own; two attempts of one agent, side by side or one
 * after the other, never resume each other's — the thread is not keyed on
 * the agent and the item, as an ordinary run's is (`findReusableThread`).
 */
export function participantThreadToResume(db: Db, attemptId: string): string | null {
  const attempt = getTeamAttempt(db, attemptId);
  if (attempt?.runId === null || attempt?.runId === undefined) return null;
  return getRun(db, attempt.runId as Uuid)?.threadId ?? null;
}

/** Why this attempt may not resume this thread, or null where it is its own. */
export function participantResumeProblem(db: Db, attemptId: string, threadId: string): string | null {
  const own = participantThreadToResume(db, attemptId);
  if (own === threadId) return null;
  return own === null
    ? "This participant's attempt has no thread of its own yet, so it is started afresh rather than resuming another's."
    : "That thread is not this participant's attempt's own, so EO does not resume it: a participant never continues another's thread.";
}

/** The comments of an item's thread a participant may see, oldest first. */
export function participantThread(db: Db, itemId: string, boundary: ThreadBoundary): Comment[] {
  return listCommentsForItem(db, itemId as Uuid).filter(withinBoundary(boundary));
}

/**
 * A call a credential made over the bridge, answered as a participant's
 * (EO-845): one of the four evidence tools, from the attempt's own scope;
 * anything else refused with the sentence the backend's hook says.
 */
export async function answerTeamCall(
  db: Db,
  scopes: TeamParticipantScopes | undefined,
  itemId: string,
  request: AgentWriteRequest,
  writes: readonly AgentWriteTool[],
  attemptId: string,
): Promise<AgentWriteAnswer> {
  if (!isTeamEvidenceTool(request.tool) || !writes.includes(request.tool)) return { ok: false, code: "TOOL_NOT_SERVED", problem: reportOnlyRefusal(request.tool) };
  const scope = scopes?.get(attemptId);
  if (scope === undefined || scope.itemId !== itemId) return { ok: false, code: "NO_RUN", problem: "No team participant of this desktop's is running with that credential now, so nothing was read." };
  const item = getItem(db, itemId as Uuid);
  if (item === undefined) return { ok: false, code: "NO_RUN", problem: "EO no longer has the item this participant reports on, so nothing was read." };
  try {
    return await answerTeamTool(db, item, scope, request.tool, request.args);
  } catch (error) {
    return { ok: false, code: "READ_FAILED", problem: `EO could not read it: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const refused = (code: string, problem: string): AgentWriteAnswer => ({ ok: false, code, problem });

async function answerTeamTool(db: Db, item: Item, scope: TeamParticipantScope, tool: string, args: unknown): Promise<AgentWriteAnswer> {
  const { evidence } = scope;
  switch (tool) {
    case EVIDENCE_LIST_TOOL_NAME: {
      const parsed = EvidenceListArgsSchema.safeParse(args);
      if (!parsed.success) return refused("INVALID_ARGUMENT", "evidence_list takes `source`, `path` and `offset`, and nothing else.");
      if (parsed.data.source === "attachments") {
        const attachments = evidence.ref.attachments;
        const lines = attachments.map((attachment) => `- ${attachment.name} — id \`${attachment.id}\`, ${attachment.mimeType}, ${String(attachment.size)} bytes`);
        const text = attachments.length === 0 ? "EO captured no attachments for you." : `The attachments EO captured for you (read one by its id with evidence_read):\n${lines.join("\n")}`;
        return { ok: true, text, data: { attachments: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })) } };
      }
      const path = evidencePath(parsed.data.path);
      if (!path.ok) return refused("PATH_REFUSED", path.problem);
      const listed = await evidence.workspace.list(path.value);
      if (!listed.ok) return refused("NOT_CAPTURED", listed.problem);
      const offset = parsed.data.offset ?? 0;
      const page = listed.value.slice(offset, offset + 500);
      const more = listed.value.length > offset + page.length;
      const where = path.value === "" ? "the work's root" : `\`${path.value}\``;
      const lines = page.map((entry) => `- ${entry.path}${entry.type === "directory" ? "/" : entry.type === "file" ? ` (${String(entry.size)} bytes)` : ` (${entry.type}, not read)`}`);
      const text =
        evidence.workspace.source.kind === "none"
          ? "This item has no disk: EO captured no files for you. Its attachments are under source \"attachments\"."
          : `${where} as EO captured it:\n${lines.join("\n") || "(empty)"}${more ? `\n…and more: ask again with offset ${String(offset + page.length)}.` : ""}`;
      return { ok: true, text, data: { entries: page, more } };
    }
    case EVIDENCE_READ_TOOL_NAME: {
      const parsed = EvidenceReadArgsSchema.safeParse(args);
      if (!parsed.success) return refused("INVALID_ARGUMENT", `evidence_read takes \`source\`, \`path\`, \`startLine\` and \`lineCount\` (at most ${String(EVIDENCE_READ_MAX_LINES)}), and nothing else.`);
      let bytes: Buffer;
      let name: string;
      if (parsed.data.source === "attachments") {
        const read = await readCapturedAttachment(db, item, evidence.ref, parsed.data.path);
        if (!read.ok) return refused("NOT_CAPTURED", read.problem);
        bytes = read.value.bytes;
        name = read.value.attachment.name;
      } else {
        const path = evidencePath(parsed.data.path);
        if (!path.ok) return refused("PATH_REFUSED", path.problem);
        if (path.value === "") return refused("PATH_REFUSED", "Name a file to read; evidence_list lists them.");
        const read = await evidence.workspace.read(path.value);
        if (!read.ok) return refused("NOT_CAPTURED", read.problem);
        bytes = read.value;
        name = path.value;
      }
      if (!looksLikeText(bytes)) return { ok: true, text: `${name} is binary (${String(bytes.length)} bytes), so it is not shown as text.`, data: { path: name, binary: true, size: bytes.length } };
      const all = bytes.toString("utf8").split("\n");
      const start = parsed.data.startLine ?? 1;
      const count = parsed.data.lineCount ?? EVIDENCE_READ_MAX_LINES;
      const window = all.slice(start - 1, start - 1 + count);
      const width = String(start + window.length).length;
      const numbered = window.map((line, index) => `${String(start + index).padStart(width, " ")}\t${line}`).join("\n");
      const end = start + window.length - 1;
      const text = window.length === 0 ? `${name} has ${String(all.length)} lines; there is no line ${String(start)}.` : `${name}, lines ${String(start)}–${String(end)} of ${String(all.length)}:\n${numbered}`;
      return { ok: true, text, data: { path: name, startLine: start, lines: window.length, totalLines: all.length } };
    }
    case EVIDENCE_SEARCH_TOOL_NAME: {
      const parsed = EvidenceSearchArgsSchema.safeParse(args);
      if (!parsed.success) return refused("INVALID_ARGUMENT", "evidence_search takes `text`, `source`, `path`, `ignoreCase` and `maxResults`, and nothing else.");
      const max = parsed.data.maxResults ?? 50;
      const ignoreCase = parsed.data.ignoreCase === true;
      const needle = ignoreCase ? parsed.data.text.toLowerCase() : parsed.data.text;
      if (parsed.data.source === "attachments") {
        const matches: { path: string; line: number; text: string }[] = [];
        for (const attachment of evidence.ref.attachments) {
          const read = await readCapturedAttachment(db, item, evidence.ref, attachment.id);
          if (!read.ok || !looksLikeText(read.value.bytes)) continue;
          for (const [index, line] of read.value.bytes.toString("utf8").split("\n").entries()) {
            if ((ignoreCase ? line.toLowerCase() : line).includes(needle)) matches.push({ path: attachment.id, line: index + 1, text: line.slice(0, 500) });
            if (matches.length >= max) break;
          }
          if (matches.length >= max) break;
        }
        return searchAnswer(matches, max);
      }
      const under = evidencePath(parsed.data.path);
      if (!under.ok) return refused("PATH_REFUSED", under.problem);
      const found = await evidence.workspace.search(parsed.data.text, { ignoreCase, under: under.value, max: Math.min(max, EVIDENCE_SEARCH_MAX_RESULTS) });
      if (!found.ok) return refused("NOT_CAPTURED", found.problem);
      return searchAnswer(found.value, max);
    }
    case ITEM_CONTEXT_TOOL_NAME: {
      if (!ItemContextArgsSchema.safeParse(args).success) return refused("INVALID_ARGUMENT", "item_context takes no arguments.");
      return itemContext(db, item, scope);
    }
  }
  return refused("TOOL_NOT_SERVED", reportOnlyRefusal(tool));
}

function searchAnswer(matches: readonly { path: string; line: number; text: string }[], max: number): AgentWriteAnswer {
  const lines = matches.map((match) => `${match.path}:${String(match.line)}: ${match.text}`);
  const text = matches.length === 0 ? "Nothing EO captured holds that text." : `${String(matches.length)} match${matches.length === 1 ? "" : "es"}${matches.length >= max ? " (the most asked for; there may be more)" : ""}:\n${lines.join("\n")}`;
  return { ok: true, text, data: { matches } };
}

/** The most characters of one comment `item_context` answers with. */
const COMMENT_MAX_CHARS = 8000;

function itemContext(db: Db, item: Item, scope: TeamParticipantScope): AgentWriteAnswer {
  const visible = participantThread(db, item.id, scope.thread);
  const author = (comment: Comment): string => {
    if (comment.authorType === "agent" && comment.authorId !== null) return getAgent(db, comment.authorId)?.name ?? "an agent";
    return comment.authorType === "human" ? "a person" : comment.authorType === "engine" ? "EO" : comment.authorType;
  };
  const comments = visible.map((comment) => {
    const body = comment.body.length > COMMENT_MAX_CHARS ? `${comment.body.slice(0, COMMENT_MAX_CHARS)}…` : comment.body;
    return `### ${author(comment)} — ${comment.kind} — ${new Date(comment.createdAt).toISOString()}\nID: ${comment.id}\n\n${body}`;
  });
  const text = [
    `# ${item.key} — ${item.title}`,
    "",
    `- type: ${item.typeLabel}`,
    "",
    item.body ?? "",
    "",
    "## The thread, as far as you may see it",
    "",
    comments.length === 0 ? "Nothing was said before your assignment began." : comments.join("\n\n"),
  ].join("\n");
  return { ok: true, text, data: { key: item.key, title: item.title, comments: visible.map((comment) => comment.id) } };
}
