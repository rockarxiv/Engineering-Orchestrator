import {
  readCliToolDraft,
  type Agent,
  type AssistCard,
  type AssistCardDetail,
  type CliTool,
  type CliToolDetection,
  type CliToolsAssignCard,
  type IpcPayload,
  type IpcResponse,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent, getAgentCliTools, getCliTool, getCliToolByCommand } from "../db/repos/index.js";

/**
 * The assistant's cards for command-line tools (EO-822): adding one to
 * the catalogue, and giving one to an agent or taking it away.
 *
 * Which programs agents are told to reach for is a person's decision
 * (EO-818). So EO's system agent has no tool that writes the catalogue or
 * ticks a CLI onto an agent: it names the row or the tick, and the person
 * presses the card's button, which calls `cliTools:save` or
 * `agentCliTools:set` — the channels the Agent tools screen calls, with
 * the same refusals.
 *
 * What the card shows is EO's read, never the agent's word: whether the
 * command is installed on this machine, what `cliTools:save` would refuse
 * now, the agent and the CLI by their names, and whether the agent
 * already has it.
 */

export type CliToolCard = Extract<AssistCard, { kind: "cliToolAdd" | "cliToolAttach" | "cliToolsAssign" }>;
type CliToolAddCard = Pick<Extract<AssistCard, { kind: "cliToolAdd" }>, "name" | "command" | "description">;

/** Whether a card is one of the three for command-line tools. */
export function isCliToolCard(card: AssistCard): card is CliToolCard {
  return card.kind === "cliToolAdd" || card.kind === "cliToolAttach" || card.kind === "cliToolsAssign";
}

/**
 * What `cliTools:save` would refuse an add card with now, in its own
 * words, or null when it would save it: the draft's own problems, then a
 * command another row already runs, archived rows included.
 */
export function cliToolAddProblem(db: Db, card: CliToolAddCard): string | null {
  const read = readCliToolDraft(card);
  if (!read.ok) return read.problems.join(" ");
  const taken = getCliToolByCommand(db, read.command);
  if (taken === undefined) return null;
  return taken.archivedAt === null
    ? `"${taken.name}" already runs \`${read.command}\` (id: ${taken.id}).`
    : `An archived command-line tool, "${taken.name}", already runs \`${read.command}\`. Restore it instead.`;
}

/** An agent a card may name: one that has not been deleted. */
function liveAgent(db: Db, agentId: string): Agent | null {
  const agent = getAgent(db, agentId as Uuid);
  return agent === undefined || agent.deletedAt !== null ? null : agent;
}

/** Whether the agent has the CLI attached now. */
function attachedNow(db: Db, agentId: string, cliToolId: string): boolean {
  return getAgentCliTools(db, agentId).cliToolIds.includes(cliToolId);
}

/**
 * Why a card for a CLI cannot be offered at all, or null when it can —
 * said to the next turn rather than drawn as a button that could only be
 * refused (invariant #8).
 */
export function cliToolCardRefusal(db: Db, card: CliToolCard): string | null {
  if (card.kind === "cliToolsAssign") return cliToolsAssignRefusal(db, card);
  if (card.kind === "cliToolAdd") {
    const taken = getCliToolByCommand(db, card.command.trim());
    if (taken !== undefined && taken.archivedAt === null) {
      return (
        `No card was offered: "${taken.name}" already runs \`${taken.command}\`, with the id ${taken.id}. ` +
        "To give it to an agent, offer a `cliToolsAssign` card naming that id in `give`."
      );
    }
    const problem = cliToolAddProblem(db, card);
    return problem === null ? null : `No card was offered: ${problem}`;
  }

  const agent = liveAgent(db, card.agentId);
  if (agent === null) {
    return `No card was offered: there is no agent with the ID "${card.agentId}". Read the agents with \`agents_list\` and name one by the ID it gives.`;
  }
  const tool = getCliTool(db, card.cliToolId);
  if (tool === undefined) {
    return (
      `No card was offered: there is no command-line tool with the ID "${card.cliToolId}". Read the catalogue with \`cli_tools_list\`, ` +
      "or offer a `cliToolAdd` card first when the program is not in it."
    );
  }
  if (card.attached && tool.archivedAt !== null) {
    return `No card was offered: "${tool.name}" is archived, so an agent given it would be told nothing. A person restores it on the Agent tools screen first.`;
  }
  if (attachedNow(db, agent.id, tool.id) === card.attached) {
    return `No card was offered: ${agent.name} ${card.attached ? "already has" : "does not have"} "${tool.name}", so there is nothing to change.`;
  }
  return null;
}

/**
 * What a CLI card shows, read now — `assist:card`. `detection` is whether
 * an add card's command is installed on this machine, asked by the
 * caller through `cliTools:detect`, or null where it could not be.
 */
export function cliToolCardDetail(
  db: Db,
  card: Exclude<CliToolCard, CliToolsAssignCard>,
  detection: CliToolDetection | null,
): { detail: AssistCardDetail } | { problem: string } {
  if (card.kind === "cliToolAdd") {
    const read = readCliToolDraft(card);
    return {
      detail: {
        kind: "cliToolAdd",
        name: read.ok ? read.name : card.name.trim(),
        command: read.ok ? read.command : card.command.trim(),
        description: read.ok ? read.description : card.description.trim(),
        detection,
        problem: cliToolAddProblem(db, card),
      },
    };
  }

  const agent = liveAgent(db, card.agentId);
  if (agent === null) return { problem: "The agent this card was about no longer exists." };
  const tool = getCliTool(db, card.cliToolId);
  if (tool === undefined) return { problem: "The command-line tool this card was about no longer exists." };
  return {
    detail: {
      kind: "cliToolAttach",
      agentId: agent.id,
      agentName: agent.name,
      cliToolId: tool.id,
      cliToolName: tool.name,
      command: tool.command,
      attached: card.attached,
      current: attachedNow(db, agent.id, tool.id),
      archived: tool.archivedAt !== null,
    },
  };
}

/** What a CLI card says in prose — what a later turn reads back. */
export function cliToolCardBody(db: Db, card: CliToolCard): string {
  if (card.kind === "cliToolsAssign") return cliToolsAssignBody(db, card);
  if (card.kind === "cliToolAdd") {
    const description = card.description.trim() === "" ? "" : ` — “${card.description.trim()}”`;
    return (
      `**Add** the command-line tool “${card.name.trim()}” (\`${card.command.trim()}\`) to the catalogue${description}. ` +
      "The card shows whether it is installed on this machine. Nothing is saved until Add is pressed, and no agent is told about it until one is given it."
    );
  }
  const agent = getAgent(db, card.agentId as Uuid)?.name ?? "the agent";
  const tool: CliTool | undefined = getCliTool(db, card.cliToolId);
  const name = tool === undefined ? "the command-line tool" : `the command-line tool “${tool.name}” (\`${tool.command}\`)`;
  return card.attached
    ? `**Give** ${agent} ${name}. It is told about it from its next dispatch, when EO finds the program installed; nothing changes until the button on the card is pressed.`
    : `**Take** ${name} away from ${agent}. Nothing changes until the button on the card is pressed.`;
}

// ── Several CLIs for several agents, in one press (EO-859) ─────────────

type AssignAdd = CliToolsAssignCard["add"][number];

/** One agent × CLI a `cliToolsAssign` card names, resolved against the database now. */
interface AssignRow {
  agentId: string;
  /** Null for an agent that is not here or has been deleted. */
  agent: Agent | null;
  /** The CLI as the card names it. */
  cli: string;
  give: boolean;
  /** The catalogued CLI the row names by id. */
  tool: CliTool | undefined;
  /** The card's own `add` entry the row names by command, where it is not a catalogue id. */
  add: AssignAdd | undefined;
  /** Whether the agent has it now; never, for a CLI this card adds. */
  current: boolean;
}

/** A catalogue id is a UUID; anything else the card names is a command or a mistake. */
const LOOKS_LIKE_AN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every row a `cliToolsAssign` card names, in its order: per agent, its gives and then its takes. */
function assignRows(db: Db, card: CliToolsAssignCard): AssignRow[] {
  const addOf = (cli: string) => card.add.find((entry) => entry.command.trim() === cli.trim());
  return card.agents.flatMap((entry) => {
    const agent = liveAgent(db, entry.agentId);
    const attached = agent === null ? [] : getAgentCliTools(db, agent.id).cliToolIds;
    const row = (cli: string, give: boolean): AssignRow => {
      const tool = getCliTool(db, cli);
      return { agentId: entry.agentId, agent, cli, give, tool, add: tool === undefined ? addOf(cli) : undefined, current: tool !== undefined && attached.includes(tool.id) };
    };
    return [...entry.give.map((cli) => row(cli, true)), ...entry.take.map((cli) => row(cli, false))];
  });
}

/**
 * Whether the row is already as the card asks: nothing to tick. A row
 * whose agent or CLI is gone is never in place, so it stays in the
 * request and the press refuses it, rather than being dropped as a no-op
 * while the rest is written.
 */
const inPlace = (row: AssignRow): boolean =>
  row.agent !== null && (row.tool !== undefined || row.add !== undefined) && row.current === row.give;

/** The CLI's name as a person reads it in a sentence. */
function cliWords(row: AssignRow): string {
  if (row.tool !== undefined) return `“${row.tool.name}”`;
  if (row.add !== undefined) return `“${row.add.name.trim()}”`;
  return `“${row.cli}”`;
}

/** The agent's name, or its id where it is not here. */
const agentWords = (row: AssignRow): string => row.agent?.name ?? `the agent ${row.agentId}`;

/** The row as a phrase — "giving Implementer “GitHub CLI”". */
function rowWords(row: AssignRow): string {
  return row.give ? `giving ${agentWords(row)} ${cliWords(row)}` : `taking ${cliWords(row)} away from ${agentWords(row)}`;
}

/** What a press would refuse this row with now, or null — the reasons `agentCliTools:assign` gives. */
function assignRowProblem(row: AssignRow): string | null {
  if (row.agent === null) return "That agent no longer exists.";
  if (row.tool === undefined && row.add === undefined) return "That command-line tool no longer exists.";
  if (row.give && row.tool !== undefined && row.tool.archivedAt !== null) return `“${row.tool.name}” is archived. Restore it on the Agent tools screen first.`;
  return null;
}

/**
 * Why a `cliToolsAssign` card cannot be offered, or null when it can:
 * each sentence names what is wrong and the fix (invariant #8).
 */
function cliToolsAssignRefusal(db: Db, card: CliToolsAssignCard): string | null {
  for (const entry of card.add) {
    const command = entry.command.trim();
    const taken = getCliToolByCommand(db, command);
    if (taken !== undefined && taken.archivedAt === null) {
      return (
        `No card was offered: "${taken.name}" already runs \`${taken.command}\`, with the id ${taken.id}. ` +
        "Leave it out of `add` and name that id in `give` instead."
      );
    }
    if (taken !== undefined) {
      return (
        `No card was offered: an archived command-line tool, "${taken.name}", already runs \`${taken.command}\`, with the id ${taken.id}. ` +
        "A person restores it on the Agent tools screen; then leave it out of `add` and name that id in `give`."
      );
    }
    const problem = cliToolAddProblem(db, entry);
    if (problem !== null) return `No card was offered: adding “${entry.name.trim()}” would be refused: ${problem}`;
  }

  for (const entry of card.agents) {
    const agent = liveAgent(db, entry.agentId);
    if (agent === null) {
      return `No card was offered: there is no agent with the ID "${entry.agentId}". Read the agents with \`agents_list\` and name one by the ID it gives.`;
    }
  }

  const rows = assignRows(db, card);
  for (const row of rows) {
    if (row.tool === undefined && row.add === undefined) {
      const byCommand = getCliToolByCommand(db, row.cli.trim());
      if (byCommand !== undefined) {
        return (
          `No card was offered: "${row.cli}" is a command, not an id. The catalogue has it as "${byCommand.name}", with the id ${byCommand.id}: ` +
          "name that id instead. A command names only a CLI this card adds in `add`."
        );
      }
      if (LOOKS_LIKE_AN_ID.test(row.cli)) {
        return (
          `No card was offered: there is no command-line tool with the ID "${row.cli}". Read the catalogue with \`cli_tools_list\` and name one by the ID it gives, ` +
          "or add the program in `add` and name it by its command."
        );
      }
      return (
        `No card was offered: "${row.cli}" is neither the ID of a catalogued command-line tool nor the command of one of this card's \`add\` entries. ` +
        "Name a CLI by the ID `cli_tools_list` gives, or add it in `add` and name it by its command."
      );
    }
    if (row.give && row.tool !== undefined && row.tool.archivedAt !== null) {
      return `No card was offered: "${row.tool.name}" is archived, so ${agentWords(row)} would be told nothing about it. A person restores it on the Agent tools screen first.`;
    }
  }

  if (card.add.length === 0 && rows.every(inPlace)) {
    const already = rows.map((row) => `${agentWords(row)} ${row.current ? "already has" : "does not have"} ${cliWords(row)}`).join("; ");
    return `No card was offered: every row is already in place (${already}), so there is nothing to change.`;
  }
  return null;
}

/**
 * What a `cliToolsAssign` card shows, read now — `assist:card`.
 * `detections` are its `add` entries' installs on this machine, in order,
 * each null where it could not be checked.
 */
export function cliToolsAssignDetail(db: Db, card: CliToolsAssignCard, detections: readonly (CliToolDetection | null)[]): Extract<AssistCardDetail, { kind: "cliToolsAssign" }> {
  return {
    kind: "cliToolsAssign",
    adds: card.add.map((entry, index) => {
      const read = readCliToolDraft(entry);
      return {
        name: read.ok ? read.name : entry.name.trim(),
        command: entry.command.trim(),
        description: read.ok ? read.description : entry.description.trim(),
        detection: detections[index] ?? null,
        problem: cliToolAddProblem(db, entry),
      };
    }),
    rows: assignRows(db, card).map((row) => ({
      agentId: row.agentId,
      agentName: agentWords(row),
      cli: row.cli,
      cliToolId: row.tool?.id ?? null,
      add: row.add === undefined ? null : row.add.command.trim(),
      cliToolName: row.tool?.name ?? row.add?.name.trim() ?? row.cli,
      command: row.tool?.command ?? row.add?.command.trim() ?? row.cli,
      give: row.give,
      current: row.current,
      inPlace: inPlace(row),
      problem: assignRowProblem(row),
    })),
  };
}

/** One sentence per agent: what it is given and what it loses. */
function agentSentences(rows: readonly AssignRow[]): string[] {
  const agents = [...new Set(rows.map((row) => row.agentId))];
  return agents.map((agentId) => {
    const own = rows.filter((row) => row.agentId === agentId);
    const name = agentWords(own[0]!);
    const named = (row: AssignRow) => `${cliWords(row)}${inPlace(row) ? (row.give ? " (it already has it)" : " (it does not have it)") : ""}`;
    const gives = own.filter((row) => row.give).map(named);
    const takes = own.filter((row) => !row.give).map(named);
    const parts = [gives.length > 0 ? `is given ${listed(gives)}` : null, takes.length > 0 ? `loses ${listed(takes)}` : null].filter((part) => part !== null);
    return `**${name}** ${parts.join(", and ")}.`;
  });
}

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What a `cliToolsAssign` card says in prose — what a later turn reads back. */
function cliToolsAssignBody(db: Db, card: CliToolsAssignCard): string {
  const adds = card.add.map((entry) => {
    const description = entry.description.trim() === "" ? "" : ` — “${entry.description.trim()}”`;
    return `**Add** the command-line tool “${entry.name.trim()}” (\`${entry.command.trim()}\`) to the catalogue${description}.`;
  });
  return [
    ...adds,
    ...agentSentences(assignRows(db, card)),
    "Each agent is told about a CLI it is given from its next dispatch, when EO finds the program installed. " +
      "Every row starts ticked and the person may untick any; nothing changes until the button on the card is pressed.",
  ].join("\n\n");
}

/** What a press left out: the person's unticked rows, by `assist:applyCard`'s `unticked`. */
export type CliToolsUnticked = NonNullable<IpcPayload<"assist:applyCard">["unticked"]>;

/** What pressing a `cliToolsAssign` card sends, and what it leaves out, in words. */
export interface CliToolsAssignPress {
  /** `agentCliTools:assign`'s request: the ticked adds and rows that change something. */
  request: IpcPayload<"agentCliTools:assign">;
  /** The rows and adds the person unticked, in words, for the sentence filed afterwards. */
  unticked: string[];
  /** Rows already as asked when pressed, in words. */
  already: string[];
  /** Whether anything at all is ticked that would change something. */
  empty: boolean;
}

/**
 * What a press of a `cliToolsAssign` card does, read now: the ticked adds,
 * and each agent's ticked rows that are not already in place. An unticked
 * add takes every give of its new CLI with it, as the card shows.
 */
export function cliToolsAssignPress(db: Db, card: CliToolsAssignCard, unticked: CliToolsUnticked | undefined): CliToolsAssignPress {
  const untickedAdds = new Set((unticked?.adds ?? []).map((command) => command.trim()));
  const untickedRow = (row: AssignRow) =>
    (row.add !== undefined && untickedAdds.has(row.add.command.trim())) ||
    (unticked?.rows ?? []).some((left) => left.agentId === row.agentId && left.cli === row.cli);

  const adds = card.add.filter((entry) => !untickedAdds.has(entry.command.trim()));
  const rows = assignRows(db, card);
  const ticked = rows.filter((row) => !untickedRow(row) && !inPlace(row));
  const agents = card.agents
    .map((entry) => ({
      agentId: entry.agentId,
      give: ticked.filter((row) => row.agentId === entry.agentId && row.give).map((row) => row.add?.command.trim() ?? row.cli),
      take: ticked.filter((row) => row.agentId === entry.agentId && !row.give).map((row) => row.cli),
    }))
    .filter((entry) => entry.give.length > 0 || entry.take.length > 0);

  return {
    request: { add: adds.map((entry) => ({ name: entry.name, command: entry.command, description: entry.description })), agents },
    unticked: [
      ...card.add.filter((entry) => untickedAdds.has(entry.command.trim())).map((entry) => `adding “${entry.name.trim()}” (\`${entry.command.trim()}\`)`),
      ...rows.filter((row) => untickedRow(row) && !inPlace(row)).map(rowWords),
    ],
    already: rows.filter(inPlace).map((row) => `${agentWords(row)} ${row.current ? "already had" : "did not have"} ${cliWords(row)}`),
    empty: adds.length === 0 && agents.length === 0,
  };
}

/** The sentence filed under a `cliToolsAssign` card once its press was applied: what changed, and what was left out. */
export function cliToolsAssignedSaid(db: Db, press: CliToolsAssignPress, applied: IpcResponse<"agentCliTools:assign">): string {
  const sentences = applied.added.map((tool) => `Added the command-line tool “${tool.name}” (\`${tool.command}\`, id: ${tool.id}) to the catalogue.`);
  const agents = [...new Set(applied.ticks.map((tick) => tick.agentId))];
  for (const agentId of agents) {
    const name = getAgent(db, agentId as Uuid)?.name ?? "The agent";
    const named = (attached: boolean) =>
      applied.ticks.filter((tick) => tick.agentId === agentId && tick.attached === attached).map((tick) => `“${getCliTool(db, tick.cliToolId)?.name ?? tick.cliToolId}”`);
    const given = named(true);
    const taken = named(false);
    if (given.length > 0) sentences.push(`Gave ${name} ${listed(given)}.`);
    if (taken.length > 0) sentences.push(`Took ${listed(taken)} away from ${name}.`);
  }
  if (press.unticked.length > 0) sentences.push(`Unticked, so not done: ${press.unticked.join("; ")}.`);
  if (press.already.length > 0) sentences.push(`Already in place: ${press.already.join("; ")}.`);
  if (applied.ticks.some((tick) => tick.attached)) {
    sentences.push("An agent is told about a CLI it was given from its next dispatch, when EO finds the program installed on the machine it runs on.");
  } else if (applied.added.length > 0 && applied.ticks.length === 0) {
    sentences.push("No agent is told about what was added until one is given it.");
  }
  return sentences.join(" ");
}
