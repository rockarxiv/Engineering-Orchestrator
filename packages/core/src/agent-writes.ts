import { z } from "zod";
import { ATTACHMENT_ADD_TOOL_NAME } from "./attachment-tool.js";
import { COMMENT_TOOL_NAME } from "./comment-tool.js";
import { MEMORY_NOTE_TOOL_NAME } from "./memory.js";
import { MODULE_CHANGE_TOOLS } from "./module-change-tools.js";
import { REPOSITORY_CHECKOUT_TOOL_NAME } from "./repository-checkout-tool.js";
import { SKILL_READ_TOOL_NAME } from "./skill-read-tool.js";
import { SKILL_WRITE_TOOLS } from "./skill-write-tools.js";
import { TEAM_EVIDENCE_TOOLS } from "./team-evidence.js";

/**
 * How an agent's write reaches EO (EO-543, ARCHITECTURE.md §13.1).
 *
 * The `eo` server an agent calls opens EO's database read-only, and three
 * of its tools are writes: `comment`, `attachment_add` and `memory_note`.
 * A fourth, `repository_checkout` (EO-633), writes nothing EO keeps but
 * needs what only the main process has — the git kind that makes a
 * reference checkout — and goes the same way, as does `skill_read`
 * (EO-721), which writes nothing but is answered from which skills the
 * run was given, which only the main process knows. So do the learning
 * review's skill tools (EO-718, `skill-write-tools.ts`), which only a
 * review's credential is served. And the module-change tools (EO-813,
 * `module-change-tools.ts`), which stage and freeze a change to a module
 * for an assistant or scenario turn: only the main process knows which
 * run is asking and where its staging area is.
 * Each is handed, as it is called, to the main process over the agent
 * write bridge (`mcp/writeBridge.ts`); the main process applies the
 * rules, writes, and answers with what happened. The tool's answer *is*
 * that answer — written, or refused with the reason.
 *
 * **EO never infers a write from an agent's event stream.** The supervisor
 * once posted a comment from a `tool_call`'s arguments and wrote a note
 * or an attachment when a `tool_result`'s text began with the right
 * words. Claude Code hands the tool's `structuredContent` back rather
 * than its text, so on Claude the words never matched: the tool said yes
 * and nothing was written. A write the stream implies is a write that
 * depends on how a backend reports a tool, and that is the backend's
 * business, not EO's.
 */

/** The `eo` server's tools that write, or act, through the bridge. */
export const AGENT_WRITE_TOOLS = [COMMENT_TOOL_NAME, ATTACHMENT_ADD_TOOL_NAME, MEMORY_NOTE_TOOL_NAME, REPOSITORY_CHECKOUT_TOOL_NAME, SKILL_READ_TOOL_NAME, ...SKILL_WRITE_TOOLS, ...MODULE_CHANGE_TOOLS, ...TEAM_EVIDENCE_TOOLS] as const;
export type AgentWriteTool = (typeof AGENT_WRITE_TOOLS)[number];

/**
 * Where one turn's `eo` server hands a write, and the bearer it presents.
 *
 * Per item: minted by the running supervisor from a secret it never
 * writes down, so a credential outlives neither the process that minted
 * it nor its reach into one item.
 */
export const AgentWriteBridgeAddressSchema = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  /**
   * The only writes this address takes (EO-717), where a turn is served
   * fewer than its agent's grant — the learning review, served
   * `memory_note` and the skill tools (EO-718), which no other turn is. The `eo` server lists no other write tool and
   * refuses a call to one, and the bridge refuses any other write made
   * with this credential, which carries the same list under its MAC.
   * Absent, the agent's grant decides, as it always has.
   */
  writes: z.array(z.enum(AGENT_WRITE_TOOLS)).optional(),
  /**
   * Whether the `eo` server lists the module-change tools (EO-813): set
   * on an assistant or scenario chat's turns. A listing hint only, and
   * not signed — the main process decides every call from the run it
   * comes from — but it keeps the tools off every other turn's list.
   */
  moduleChanges: z.boolean().optional(),
  /**
   * Whether the turn is a report-only team participant's (EO-845): the
   * `eo` server then lists the evidence tools alone and refuses every
   * other call it is asked, whatever the agent's grant, and fails closed
   * on an address it cannot read. The credential beside it names those
   * tools and the participant's attempt under its MAC, which is what the
   * main process answers from; this is what makes the server refuse the
   * reads it would otherwise answer itself from EO's database.
   */
  reportOnly: z.boolean().optional(),
  /**
   * Where an isolated team member's view of the item's thread ends
   * (EO-867): the `eo` server's thread reads — `comment_read`,
   * `comment_search`, `thread_read` and what `item_detail` says the item
   * shipped — show a comment only where it is `exposed`, or was written
   * at or before `visibleThrough` and is not `hidden`, the rule a
   * report-only participant's `item_context` applies. So a member never
   * reads its team's other reports. Set with a credential scoped to the
   * member's attempt, whose writes leave out posting on the item. Not
   * signed: the server fails closed on an address that names it and
   * cannot be read.
   */
  teamMember: z
    .object({
      visibleThrough: z.number(),
      exposed: z.array(z.string()),
      hidden: z.array(z.string()),
    })
    .optional(),
});
export type AgentWriteBridgeAddress = z.infer<typeof AgentWriteBridgeAddressSchema>;

/** What the `eo` server sends: which tool, and the arguments the agent gave it, untouched. */
export const AgentWriteRequestSchema = z.object({
  tool: z.enum(AGENT_WRITE_TOOLS),
  args: z.unknown(),
});
export type AgentWriteRequest = z.infer<typeof AgentWriteRequestSchema>;

/**
 * What the main process answers, and what the tool answers the agent.
 *
 * `text` is the sentence the agent reads; `data` is what the write
 * produced, for the tool's `structuredContent` (which carries `text`
 * too, since Claude shows an agent nothing else). A refusal names its
 * `code` and the `problem`, in a sentence the agent can act on. Every
 * refusal means nothing was written.
 */
export const AgentWriteAnswerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string(), data: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ ok: z.literal(false), code: z.string().default("WRITE_REFUSED"), problem: z.string() }),
]);
export type AgentWriteAnswer = { ok: true; text: string; data: Record<string, unknown> } | { ok: false; code: string; problem: string };
