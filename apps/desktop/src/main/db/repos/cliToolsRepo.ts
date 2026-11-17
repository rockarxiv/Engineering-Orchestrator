import { and, asc, eq } from "drizzle-orm";
import { readCliToolDraft, uuidv7, type AgentCliTools, type CliTool, type CliToolDraft, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { agentCliTools, cliTools } from "../schema.js";
import { getAgent } from "./agentsRepo.js";

/**
 * The command-line tool catalogue and its join to agents (EO-819).
 *
 * The third catalogue beside MCP servers and skills, and the plainest:
 * a row is a name, the command an agent types and what it is for. It
 * grants nothing (invariant 11) and says nothing about whether the
 * program is installed — that is checked on the machine whenever it
 * matters (`agentAttachments/cliTools.ts`), never stored.
 *
 * Only a person writes here. Step agents have no channel to it, and EO's
 * system agent is not served one either: the catalogue tells an agent
 * what to reach for, which is a person's decision (EO-818).
 */

function toCliTool(row: typeof cliTools.$inferSelect): CliTool {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    description: row.description,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Every live CLI, by name and then command; archived ones too when asked. */
export function listCliTools(db: Db, includeArchived = false): CliTool[] {
  const rows = db.select().from(cliTools).orderBy(asc(cliTools.name), asc(cliTools.command)).all().map(toCliTool);
  return includeArchived ? rows : rows.filter((tool) => tool.archivedAt === null);
}

export function getCliTool(db: Db, id: string): CliTool | undefined {
  const row = db.select().from(cliTools).where(eq(cliTools.id, id)).get();
  return row ? toCliTool(row) : undefined;
}

export function getCliToolByCommand(db: Db, command: string): CliTool | undefined {
  const row = db.select().from(cliTools).where(eq(cliTools.command, command)).get();
  return row ? toCliTool(row) : undefined;
}

export type SaveCliToolResult = { ok: true; cliTool: CliTool } | { ok: false; problems: string[] };

/**
 * Creates or edits a CLI. A refusal is a list of sentences, never a
 * throw: everything that can be wrong with one is something a person
 * typed.
 *
 * The command has to be free, archived rows included: two rows for one
 * program would name it twice in a prompt, and an archived one is
 * brought back rather than added again.
 */
export function saveCliTool(db: Db, draft: CliToolDraft, now: number = Date.now()): SaveCliToolResult {
  const read = readCliToolDraft(draft);
  if (!read.ok) return { ok: false, problems: read.problems };

  const existing = draft.id === undefined ? undefined : getCliTool(db, draft.id);
  if (draft.id !== undefined && !existing) return { ok: false, problems: ["That command-line tool no longer exists."] };

  const byCommand = getCliToolByCommand(db, read.command);
  if (byCommand && byCommand.id !== existing?.id) {
    return {
      ok: false,
      problems: [
        byCommand.archivedAt === null
          ? `"${byCommand.name}" already runs \`${read.command}\`.`
          : `An archived command-line tool, "${byCommand.name}", already runs \`${read.command}\`. Restore it instead.`,
      ],
    };
  }

  const values = { name: read.name, command: read.command, description: read.description, updatedAt: now };
  if (existing) {
    db.update(cliTools).set(values).where(eq(cliTools.id, existing.id)).run();
    return { ok: true, cliTool: getCliTool(db, existing.id)! };
  }
  const row = db
    .insert(cliTools)
    .values({ id: uuidv7(), createdAt: now, archivedAt: null, ...values })
    .returning()
    .get();
  return { ok: true, cliTool: toCliTool(row) };
}

/** Archives a CLI. Its attachments stay, and stop being delivered while it is archived. */
export function archiveCliTool(db: Db, id: string, at: number = Date.now()): boolean {
  const existing = getCliTool(db, id);
  if (!existing) return false;
  if (existing.archivedAt !== null) return true;
  db.update(cliTools).set({ archivedAt: at, updatedAt: at }).where(eq(cliTools.id, id)).run();
  return true;
}

/** Brings an archived CLI back, with the attachments it had. */
export function restoreCliTool(db: Db, id: string, at: number = Date.now()): boolean {
  const existing = getCliTool(db, id);
  if (!existing) return false;
  if (existing.archivedAt === null) return true;
  db.update(cliTools).set({ archivedAt: null, updatedAt: at }).where(eq(cliTools.id, id)).run();
  return true;
}

/** What one agent has attached, as ids in catalogue order, archived ones included. */
export function getAgentCliTools(db: Db, agentId: string): AgentCliTools {
  const attached = new Set(
    db.select().from(agentCliTools).where(eq(agentCliTools.agentId, agentId)).all().map((row) => row.cliToolId),
  );
  return { agentId, cliToolIds: listCliTools(db, true).map((tool) => tool.id).filter((id) => attached.has(id)) };
}

/** Every agent that has at least one CLI attached, for the screen asking "which agents have this?". */
export function listAgentCliTools(db: Db): AgentCliTools[] {
  const order = listCliTools(db, true).map((tool) => tool.id);
  const byAgent = new Map<string, Set<string>>();
  for (const row of db.select().from(agentCliTools).all()) {
    const held = byAgent.get(row.agentId) ?? new Set<string>();
    held.add(row.cliToolId);
    byAgent.set(row.agentId, held);
  }
  return [...byAgent.keys()].sort().map((agentId) => ({ agentId, cliToolIds: order.filter((id) => byAgent.get(agentId)?.has(id) ?? false) }));
}

/**
 * The CLIs one agent is given: attached and not archived, in catalogue
 * order. Whether each is installed is not decided here.
 */
export function resolveAgentCliTools(db: Db, agentId: string): CliTool[] {
  const attached = new Set(
    db.select().from(agentCliTools).where(eq(agentCliTools.agentId, agentId)).all().map((row) => row.cliToolId),
  );
  return listCliTools(db).filter((tool) => attached.has(tool.id));
}

export type SetAgentCliToolResult = { ok: true; attachments: AgentCliTools } | { ok: false; problem: string };

/**
 * Ticks one CLI on or off for one agent. Idempotent both ways, and a
 * missing agent or CLI is a sentence: a race with another window, not a
 * programmer error.
 */
export function setAgentCliTool(
  db: Db,
  input: { agentId: string; cliToolId: string; attached: boolean },
  now: number = Date.now(),
): SetAgentCliToolResult {
  const { agentId, cliToolId, attached } = input;
  if (!getAgent(db, agentId as Uuid)) return { ok: false, problem: "That agent no longer exists." };
  if (attached) {
    if (!getCliTool(db, cliToolId)) return { ok: false, problem: "That command-line tool no longer exists." };
    db.insert(agentCliTools).values({ agentId, cliToolId, createdAt: now }).onConflictDoNothing().run();
  } else {
    db.delete(agentCliTools)
      .where(and(eq(agentCliTools.agentId, agentId), eq(agentCliTools.cliToolId, cliToolId)))
      .run();
  }
  return { ok: true, attachments: getAgentCliTools(db, agentId) };
}
