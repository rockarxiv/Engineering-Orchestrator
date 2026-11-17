import { readCliToolDraft, type Agent, type AssistCard, type AssistCardDetail, type CliTool, type CliToolDetection, type Uuid } from "@eo/core";
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

export type CliToolCard = Extract<AssistCard, { kind: "cliToolAdd" | "cliToolAttach" }>;
type CliToolAddCard = Extract<AssistCard, { kind: "cliToolAdd" }>;

/** Whether a card is one of the two for command-line tools. */
export function isCliToolCard(card: AssistCard): card is CliToolCard {
  return card.kind === "cliToolAdd" || card.kind === "cliToolAttach";
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
  if (card.kind === "cliToolAdd") {
    const taken = getCliToolByCommand(db, card.command.trim());
    if (taken !== undefined && taken.archivedAt === null) {
      return (
        `No card was offered: "${taken.name}" already runs \`${taken.command}\`, with the id ${taken.id}. ` +
        "To give it to an agent, offer a `cliToolAttach` card naming that id."
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
export function cliToolCardDetail(db: Db, card: CliToolCard, detection: CliToolDetection | null): { detail: AssistCardDetail } | { problem: string } {
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
