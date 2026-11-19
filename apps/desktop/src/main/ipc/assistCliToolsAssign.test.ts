import { rmSync } from "node:fs";
import { AssistOutputSchema, pageDescriptorFor, type Agent, type AssistCard, type IpcChannel, type IpcResponse, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  archiveCliTool,
  createRun,
  deleteAgent,
  getAgentCliTools,
  getItem,
  listAgents,
  listCliTools,
  listCommentsForItem,
  saveCliTool,
  setAgentCliTool,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { assistCardBody } from "../roles/assistCards.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * One card that adds command-line tools and gives them to several agents,
 * or takes them away (EO-859).
 *
 * Returning the card changes nothing. The person's press applies the
 * rows they left ticked through `agentCliTools:assign`, in one
 * transaction: a refused row leaves nothing written, and the card stays
 * to press again. Every test drives the app's own handlers on an
 * in-memory database and asserts against the rows.
 */

let handle: DbHandle;
let userData: string;

/** Commands no machine running these tests has. */
const DEPLOY = "eo-859-deploy";
const LINT = "eo-859-lint";

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  userData = platform.userDataPath;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

async function chat(body = "Set up the CLIs."): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run returning `card`, and what it posted. */
function turn(conversation: Item, card: AssistCard): { cardId: Uuid | undefined; rejections: string[] } {
  const output = { message: "That is yours to press.", card };
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardId: posted.find((comment) => comment.kind === PROPOSAL_KIND)?.id,
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

type Unticked = { adds: string[]; rows: { agentId: string; cli: string }[] };
const press = (conversation: Item, messageId: string, unticked?: Unticked) =>
  call("assist:applyCard", { conversationId: conversation.id, messageId, ...(unticked === undefined ? {} : { unticked }) });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });

function agentOf(role: string): Agent {
  const agent = listAgents(handle.db).find((candidate) => candidate.role === role);
  if (agent === undefined) throw new Error(`no ${role} agent is seeded`);
  return agent;
}

function catalogue(name: string, command: string): string {
  const saved = saveCliTool(handle.db, { name, command, description: "" });
  if (!saved.ok) throw new Error(saved.problems.join(" "));
  return saved.cliTool.id;
}

const cliIds = (agent: Agent) => getAgentCliTools(handle.db, agent.id).cliToolIds;

/** The card the story's own example names: two new CLIs, two agents, three gives and a take. */
function story() {
  const implementer = agentOf("implementer");
  const reviewer = agentOf("reviewer");
  const gh = catalogue("GitHub CLI", "gh");
  setAgentCliTool(handle.db, { agentId: reviewer.id, cliToolId: gh, attached: true });
  const card: AssistCard = {
    kind: "cliToolsAssign",
    add: [
      { name: "Deployer", command: DEPLOY, description: "Deploys to staging." },
      { name: "Linter", command: LINT, description: "" },
    ],
    agents: [
      { agentId: implementer.id, give: [DEPLOY, LINT], take: [] },
      { agentId: reviewer.id, give: [DEPLOY], take: [gh] },
    ],
  };
  return { implementer, reviewer, gh, card };
}

describe("the card's offer", () => {
  it("is drawn for a card that would change something, and changes nothing until pressed", async () => {
    const { card, implementer, reviewer, gh } = story();
    const { cardId, rejections } = turn(await chat(), card);
    expect(rejections).toEqual([]);
    expect(cardId).toBeDefined();
    expect(listCliTools(handle.db)).toHaveLength(1);
    expect(cliIds(implementer)).toEqual([]);
    expect(cliIds(reviewer)).toEqual([gh]);
  });

  it("is refused for an agent that is not here", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const absent = "019a0000-0000-7000-8000-000000000859";
    const { cardId, rejections } = turn(await chat(), { kind: "cliToolsAssign", add: [], agents: [{ agentId: absent, give: [gh], take: [] }] });
    expect(cardId).toBeUndefined();
    expect(rejections).toEqual([
      `No card was offered: there is no agent with the ID "${absent}". Read the agents with \`agents_list\` and name one by the ID it gives.`,
    ]);
  });

  it("is refused for an agent that has been deleted", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const reviewer = agentOf("reviewer");
    deleteAgent(handle.db, reviewer.id as Uuid);
    const { rejections } = turn(await chat(), { kind: "cliToolsAssign", add: [], agents: [{ agentId: reviewer.id, give: [gh], take: [] }] });
    expect(rejections).toEqual([`No card was offered: there is no agent with the ID "${reviewer.id}". Read the agents with \`agents_list\` and name one by the ID it gives.`]);
  });

  it("is refused for a catalogue id that is not in the catalogue", async () => {
    const implementer = agentOf("implementer");
    const absent = "019a0000-0000-7000-8000-000000000860";
    const { rejections } = turn(await chat(), { kind: "cliToolsAssign", add: [], agents: [{ agentId: implementer.id, give: [absent], take: [] }] });
    expect(rejections).toEqual([
      `No card was offered: there is no command-line tool with the ID "${absent}". Read the catalogue with \`cli_tools_list\` and name one by the ID it gives, ` +
        "or add the program in `add` and name it by its command.",
    ]);
  });

  it("is refused for a reference that is neither a catalogue id nor one of the card's own add commands", async () => {
    const implementer = agentOf("implementer");
    const { rejections } = turn(await chat(), {
      kind: "cliToolsAssign",
      add: [{ name: "Deployer", command: DEPLOY, description: "" }],
      agents: [{ agentId: implementer.id, give: ["kubectl"], take: [] }],
    });
    expect(rejections).toEqual([
      'No card was offered: "kubectl" is neither the ID of a catalogued command-line tool nor the command of one of this card\'s `add` entries. ' +
        "Name a CLI by the ID `cli_tools_list` gives, or add it in `add` and name it by its command.",
    ]);
  });

  it("is refused for an add whose command the catalogue already has, naming that row's id", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const implementer = agentOf("implementer");
    const { rejections } = turn(await chat(), {
      kind: "cliToolsAssign",
      add: [{ name: "GH", command: "gh", description: "" }],
      agents: [{ agentId: implementer.id, give: ["gh"], take: [] }],
    });
    expect(rejections).toEqual([`No card was offered: "GitHub CLI" already runs \`gh\`, with the id ${gh}. Leave it out of \`add\` and name that id in \`give\` instead.`]);
  });

  it("is refused for an add whose command an archived catalogue row already has, naming that row's id", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    archiveCliTool(handle.db, gh);
    const implementer = agentOf("implementer");
    const { cardId, rejections } = turn(await chat(), {
      kind: "cliToolsAssign",
      add: [{ name: "GH", command: "gh", description: "" }],
      agents: [{ agentId: implementer.id, give: ["gh"], take: [] }],
    });
    expect(cardId).toBeUndefined();
    expect(rejections).toEqual([
      `No card was offered: an archived command-line tool, "GitHub CLI", already runs \`gh\`, with the id ${gh}. ` +
        "A person restores it on the Agent tools screen; then leave it out of `add` and name that id in `give`.",
    ]);
  });

  it("is refused for giving an archived CLI", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    archiveCliTool(handle.db, gh);
    const implementer = agentOf("implementer");
    const { rejections } = turn(await chat(), { kind: "cliToolsAssign", add: [], agents: [{ agentId: implementer.id, give: [gh], take: [] }] });
    expect(rejections).toEqual([
      `No card was offered: "GitHub CLI" is archived, so ${implementer.name} would be told nothing about it. A person restores it on the Agent tools screen first.`,
    ]);
  });

  it("is refused for a card on which every row is already in place", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const jira = catalogue("Jira CLI", "jira");
    const implementer = agentOf("implementer");
    setAgentCliTool(handle.db, { agentId: implementer.id, cliToolId: gh, attached: true });
    const { rejections } = turn(await chat(), { kind: "cliToolsAssign", add: [], agents: [{ agentId: implementer.id, give: [gh], take: [jira] }] });
    expect(rejections).toEqual([
      `No card was offered: every row is already in place (${implementer.name} already has “GitHub CLI”; ${implementer.name} does not have “Jira CLI”), so there is nothing to change.`,
    ]);
  });
});

describe("what the card shows", () => {
  it("reads each add with its install detection, and one row per agent × CLI with its current state", async () => {
    const { card, implementer, reviewer, gh } = story();
    const conversation = await chat();
    const { cardId } = turn(conversation, card);
    const shown = (await read(conversation, cardId!)).card;
    expect(shown).toEqual({
      kind: "cliToolsAssign",
      adds: [
        { name: "Deployer", command: DEPLOY, description: "Deploys to staging.", detection: { found: false }, problem: null },
        { name: "Linter", command: LINT, description: "", detection: { found: false }, problem: null },
      ],
      rows: [
        { agentId: implementer.id, agentName: implementer.name, cli: DEPLOY, cliToolId: null, add: DEPLOY, cliToolName: "Deployer", command: DEPLOY, give: true, current: false, inPlace: false, problem: null },
        { agentId: implementer.id, agentName: implementer.name, cli: LINT, cliToolId: null, add: LINT, cliToolName: "Linter", command: LINT, give: true, current: false, inPlace: false, problem: null },
        { agentId: reviewer.id, agentName: reviewer.name, cli: DEPLOY, cliToolId: null, add: DEPLOY, cliToolName: "Deployer", command: DEPLOY, give: true, current: false, inPlace: false, problem: null },
        { agentId: reviewer.id, agentName: reviewer.name, cli: gh, cliToolId: gh, add: null, cliToolName: "GitHub CLI", command: "gh", give: false, current: true, inPlace: false, problem: null },
      ],
    });
  });
});

describe("pressing it", () => {
  it("applies only the ticked rows: 2 adds, and 3 of 4 changes with one give unticked", async () => {
    const { card, implementer, reviewer } = story();
    const conversation = await chat();
    const { cardId } = turn(conversation, card);

    const pressed = await press(conversation, cardId!, { adds: [], rows: [{ agentId: reviewer.id, cli: DEPLOY }] });
    expect(pressed.applied).toBe(true);

    const deploy = listCliTools(handle.db).find((tool) => tool.command === DEPLOY)!;
    const lint = listCliTools(handle.db).find((tool) => tool.command === LINT)!;
    // gh, plus exactly the two new rows.
    expect(listCliTools(handle.db).map((tool) => tool.command).sort()).toEqual([DEPLOY, LINT, "gh"].sort());
    // A new CLI named only by its command ends up attached by its new row's id.
    expect(new Set(cliIds(implementer))).toEqual(new Set([deploy.id, lint.id]));
    // The reviewer's unticked give is not done; its take is.
    expect(cliIds(reviewer)).toEqual([]);

    expect(pressed.said).toContain(`Added the command-line tool “Deployer” (\`${DEPLOY}\`, id: ${deploy.id}) to the catalogue.`);
    expect(pressed.said).toContain(`Gave ${implementer.name} “Deployer” and “Linter”.`);
    expect(pressed.said).toContain(`Took “GitHub CLI” away from ${reviewer.name}.`);
    expect(pressed.said).toContain(`Unticked, so not done: giving ${reviewer.name} “Deployer”.`);

    // Spent: it cannot be pressed twice.
    expect((await press(conversation, cardId!)).problem).toBe("That card has already been pressed.");
  });

  it("leaves out every give of a new CLI whose add was unticked", async () => {
    const { card, implementer, reviewer, gh } = story();
    const conversation = await chat();
    const { cardId } = turn(conversation, card);

    const pressed = await press(conversation, cardId!, { adds: [DEPLOY], rows: [] });
    expect(pressed.applied).toBe(true);
    expect(listCliTools(handle.db).map((tool) => tool.command).sort()).toEqual([LINT, "gh"].sort());
    expect(cliIds(implementer)).toEqual([listCliTools(handle.db).find((tool) => tool.command === LINT)!.id]);
    expect(cliIds(reviewer)).not.toContain(gh);
    expect(pressed.said).toContain(`Unticked, so not done: adding “Deployer” (\`${DEPLOY}\`); giving ${implementer.name} “Deployer”; giving ${reviewer.name} “Deployer”.`);
  });

  it("writes nothing when a ticked row would be refused at press time, names that row, and can be pressed again", async () => {
    const { card, implementer, reviewer, gh } = story();
    const conversation = await chat();
    const { cardId } = turn(conversation, card);
    // Catalogued since the card was drawn.
    catalogue("Someone's linter", LINT);

    const refused = await press(conversation, cardId!);
    expect(refused.applied).toBe(false);
    expect(refused.said).toBeNull();
    expect(refused.problem).toBe(
      `Nothing was changed. Adding “Linter” (\`${LINT}\`) was refused: "Someone's linter" already runs \`${LINT}\`. Untick that row and press again, or say what should change.`,
    );
    // Not even the other rows: no Deployer, and every tick as it was.
    expect(listCliTools(handle.db).map((tool) => tool.command).sort()).toEqual([LINT, "gh"].sort());
    expect(cliIds(implementer)).toEqual([]);
    expect(cliIds(reviewer)).toEqual([gh]);
    // The card shows the refusal on that add.
    const shown = (await read(conversation, cardId!)).card;
    expect(shown?.kind === "cliToolsAssign" ? shown.adds[1]!.problem : null).toContain("already runs");

    // Unticked, the rest goes through.
    const again = await press(conversation, cardId!, { adds: [LINT], rows: [] });
    expect(again.applied).toBe(true);
    const deploy = listCliTools(handle.db).find((tool) => tool.command === DEPLOY)!;
    expect(cliIds(implementer)).toEqual([deploy.id]);
    expect(new Set(cliIds(reviewer))).toEqual(new Set([deploy.id]));
  });

  it("writes nothing when a ticked take's agent was deleted after the card was drawn", async () => {
    const { card, implementer, reviewer } = story();
    const conversation = await chat();
    const { cardId } = turn(conversation, card);
    deleteAgent(handle.db, reviewer.id as Uuid);

    // The reviewer's take now looks like nothing to do; it is still a row the press must refuse.
    const shown = (await read(conversation, cardId!)).card;
    const take = shown?.kind === "cliToolsAssign" ? shown.rows.find((row) => row.agentId === reviewer.id && !row.give) : undefined;
    expect(take).toMatchObject({ inPlace: false, problem: "That agent no longer exists." });

    const refused = await press(conversation, cardId!, { adds: [], rows: [{ agentId: reviewer.id, cli: DEPLOY }] });
    expect(refused).toMatchObject({ applied: false, said: null });
    expect(refused.problem).toContain("away from");
    expect(refused.problem).toContain("was refused: that agent no longer exists.");
    // Not even the adds or the implementer's gives.
    expect(listCliTools(handle.db).map((tool) => tool.command)).toEqual(["gh"]);
    expect(cliIds(implementer)).toEqual([]);
  });

  it("refuses a press with nothing ticked, filing nothing", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const implementer = agentOf("implementer");
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "cliToolsAssign", add: [], agents: [{ agentId: implementer.id, give: [gh], take: [] }] });
    const pressed = await press(conversation, cardId!, { adds: [], rows: [{ agentId: implementer.id, cli: gh }] });
    expect(pressed).toMatchObject({ applied: false, said: null });
    expect(cliIds(implementer)).toEqual([]);
    // Still to press.
    expect((await press(conversation, cardId!)).applied).toBe(true);
    expect(cliIds(implementer)).toEqual([gh]);
  });
});

describe("agentCliTools:assign", () => {
  it("rolls back the adds when a later tick is refused", async () => {
    const implementer = agentOf("implementer");
    const answer = await call("agentCliTools:assign", {
      add: [{ name: "Deployer", command: DEPLOY, description: "" }],
      agents: [{ agentId: implementer.id, give: [DEPLOY, "019a0000-0000-7000-8000-000000000861"], take: [] }],
    });
    expect(answer).toEqual({
      applied: false,
      problem: `Giving ${implementer.name} “019a0000-0000-7000-8000-000000000861” was refused: that command-line tool no longer exists.`,
      added: [],
      ticks: [],
    });
    expect(listCliTools(handle.db, true)).toEqual([]);
    expect(cliIds(implementer)).toEqual([]);
  });
});

describe("what a later turn reads", () => {
  it("states each add and each agent's gives and takes", () => {
    const { card, implementer, reviewer } = story();
    const body = assistCardBody(handle.db, card);
    expect(body).toContain("**Add** the command-line tool “Deployer” (`eo-859-deploy`) to the catalogue — “Deploys to staging.”.");
    expect(body).toContain("**Add** the command-line tool “Linter” (`eo-859-lint`) to the catalogue.");
    expect(body).toContain(`**${implementer.name}** is given “Deployer” and “Linter”.`);
    expect(body).toContain(`**${reviewer.name}** is given “Deployer”, and loses “GitHub CLI”.`);
    expect(body).toContain("from its next dispatch, when EO finds the program installed");
    expect(body).toContain("nothing changes until the button on the card is pressed.");
  });
});

describe("a card that only adds CLIs, several at once (EO-860)", () => {
  const KUBE = "eo-860-kube";
  const ADD_ONLY: AssistCard = {
    kind: "cliToolsAssign",
    add: [
      { name: "Deployer", command: DEPLOY, description: "Deploys to staging." },
      { name: "Linter", command: LINT, description: "" },
      { name: "Kube", command: KUBE, description: "" },
    ],
    agents: [],
  };
  /** Every agent's CLI ticks, to show a press left them alone. */
  const everyTick = () => listAgents(handle.db).map((agent) => [agent.id, cliIds(agent)]);

  it("is drawn, shows its adds with install detection and no agent rows, and changes nothing until pressed", async () => {
    const conversation = await chat("Add three CLIs.");
    const { cardId, rejections } = turn(conversation, ADD_ONLY);
    expect(rejections).toEqual([]);
    expect(cardId).toBeDefined();
    expect(listCliTools(handle.db)).toEqual([]);

    const shown = (await read(conversation, cardId!)).card;
    expect(shown).toMatchObject({ kind: "cliToolsAssign", rows: [] });
    expect(shown?.kind === "cliToolsAssign" ? shown.adds.map((add) => [add.command, add.detection]) : null).toEqual([
      [DEPLOY, { found: false }],
      [LINT, { found: false }],
      [KUBE, { found: false }],
    ]);
  });

  it("creates exactly the ticked catalogue rows, and touches no agent's attachments", async () => {
    const gh = catalogue("GitHub CLI", "gh");
    const implementer = agentOf("implementer");
    setAgentCliTool(handle.db, { agentId: implementer.id, cliToolId: gh, attached: true });
    const before = everyTick();
    const conversation = await chat();
    const { cardId } = turn(conversation, ADD_ONLY);

    const pressed = await press(conversation, cardId!);
    expect(pressed.applied).toBe(true);
    expect(listCliTools(handle.db).map((tool) => tool.command).sort()).toEqual([DEPLOY, KUBE, LINT, "gh"].sort());
    expect(everyTick()).toEqual(before);
    expect(pressed.said).toContain("No agent is told about what was added until one is given it.");
  });

  it("with one add unticked, creates only the other two", async () => {
    const before = everyTick();
    const conversation = await chat();
    const { cardId } = turn(conversation, ADD_ONLY);

    const pressed = await press(conversation, cardId!, { adds: [LINT], rows: [] });
    expect(pressed.applied).toBe(true);
    expect(listCliTools(handle.db).map((tool) => tool.command).sort()).toEqual([DEPLOY, KUBE].sort());
    expect(everyTick()).toEqual(before);
    expect(pressed.said).toContain(`Unticked, so not done: adding “Linter” (\`${LINT}\`).`);
  });

  it("is not drawn for an add whose command the catalogue already has, and says which entry", async () => {
    const lint = catalogue("Someone's linter", LINT);
    const { cardId, rejections } = turn(await chat(), ADD_ONLY);
    expect(cardId).toBeUndefined();
    expect(rejections).toEqual([`No card was offered: "Someone's linter" already runs \`${LINT}\`, with the id ${lint}. Leave it out of \`add\` and name that id in \`give\` instead.`]);
    expect(listCliTools(handle.db)).toHaveLength(1);
  });

  it("is not drawn for an add whose command an archived row already has", async () => {
    const kube = catalogue("Old kube", KUBE);
    archiveCliTool(handle.db, kube);
    const { cardId, rejections } = turn(await chat(), ADD_ONLY);
    expect(cardId).toBeUndefined();
    expect(rejections).toEqual([
      `No card was offered: an archived command-line tool, "Old kube", already runs \`${KUBE}\`, with the id ${kube}. ` +
        "A person restores it on the Agent tools screen; then leave it out of `add` and name that id in `give`.",
    ]);
  });

  it("is not drawn for an add with an invalid command or name, and names the entry and why", async () => {
    const command = turn(await chat(), { kind: "cliToolsAssign", add: [ADD_ONLY.add[0]!, { name: "PRs", command: "gh pr", description: "" }], agents: [] });
    expect(command.cardId).toBeUndefined();
    expect(command.rejections).toEqual([
      'No card was offered: `add` entry 2 (“PRs”, `gh pr`) would be refused: "gh pr" has a space in it: enter only the program, like `gh`, not its arguments. Fix that entry or leave it out.',
    ]);

    const name = turn(await chat(), { kind: "cliToolsAssign", add: [{ name: "   ", command: DEPLOY, description: "" }], agents: [] });
    expect(name.cardId).toBeUndefined();
    expect(name.rejections).toEqual([`No card was offered: \`add\` entry 1 (\`${DEPLOY}\`) would be refused: A command-line tool needs a name. Fix that entry or leave it out.`]);
    expect(listCliTools(handle.db)).toEqual([]);
  });

  it("reads to a later turn as the tools it adds, with no agent lines", () => {
    const body = assistCardBody(handle.db, ADD_ONLY);
    expect(body).toContain("**Add** these 3 command-line tools to the catalogue:");
    expect(body).toContain(`- “Deployer” (\`${DEPLOY}\`) — “Deploys to staging.”\n- “Linter” (\`${LINT}\`)\n- “Kube” (\`${KUBE}\`)`);
    expect(body).toContain("no agent is told about a CLI added here until one is given it.");
    expect(body).not.toMatch(/\*\* is given|loses/);
    for (const agent of listAgents(handle.db)) expect(body).not.toContain(agent.name);
  });
});
