import { rmSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { AssistOutputSchema, pageDescriptorFor, WEBHOOK_UNATTENDED_LABEL, WEBHOOK_UNATTENDED_RISK, type AssistReply, type IpcChannel, type IpcResponse, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import { createRun, getItem, getPipeline, listCommentsForItem, listStepsForPipeline, publishSection, setWebhookUnattended, updateRun } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { TOOLS } from "../mcpHost/catalog.js";
import { answerToolCall } from "../mcpHost/server.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createJob } from "../jobs/jobs.js";
import { mintWebhookSecret } from "../jobs/webhookSignature.js";
import { environmentFor } from "../modules/secrets.js";
import { readOrganisationSecretEntry, storeOrganisationSecret } from "../policy/organisationSecrets.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Letting a webhook pipeline's items reach a sending step unread, and a
 * step's own secrets and variables, through the assistant's cards
 * (EO-522).
 *
 * Both are settings that are deliberately a person's. The claim is the
 * one EO-521 made for its cards — the assistant names the thing and the
 * person's press does it, through the channel the editor called — plus
 * one more for the step's values: what the person types reaches the
 * store and nothing else. Not the agent's prompt, not the run's
 * transcript, not the chat, not anything filed about the card. Every test
 * drives the app's own handlers and asserts against the rows and the
 * store, not against what a card says.
 */

let handle: DbHandle;
let userData: string;

// A keychain that is there, so a secret can be stored at all — written in
// the clear on disk, which is no part of what is swept below.
const keychain = { isEncryptionAvailable: () => true, encryptString: (plainText: string) => Buffer.from(plainText), decryptString: (encrypted: Buffer) => encrypted.toString() };

/** The stores the app's handlers write, where handlers.ts puts them under userData. */
const stores = () => ({
  secrets: { directory: join(userData, "module-secrets"), store: keychain },
  organisation: { directory: join(userData, "organisation-secrets"), store: keychain },
});

/** What a run of the step would be given for `name`, resolved the way a dispatch resolves it (`environmentFor`). */
function givenToARun(stepId: string, name: string): string | undefined {
  const { secrets, organisation } = stores();
  return environmentFor(secrets, [name], stepId, (asked) => readOrganisationSecretEntry(organisation, asked)).env[name];
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform({ keychain });
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

async function chat(body = "Can you do that?"): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run carrying `output`, and what it posted. */
function turn(conversation: Item, output: AssistReply): { cardIds: Uuid[]; rejections: string[]; runId: Uuid } {
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
    cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
    runId: run.id,
  };
}

async function messageOf(conversation: Item, id: string) {
  const view = await call("assist:open", undefined);
  return view.conversation.messages.find((message) => message.id === id)!;
}

const press = (conversation: Item, messageId: string, value?: string) =>
  call("assist:applyCard", { conversationId: conversation.id, messageId, ...(value === undefined ? {} : { value }) });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });

function webhookJobOnto(pipelineId = "default"): void {
  const created = createJob(handle.db, {
    projectId: null,
    name: "Support",
    trigger: { kind: "webhook", path: "support", secret: mintWebhookSecret(), mapping: { title: null, body: null, eventKey: null, spec: {} } },
    pipelineId,
    template: { type: "developer:story", title: "A case", body: "" },
  });
  if (!created.ok) throw new Error(created.problem);
}

/** A step of the default pipeline that is part of its current version. */
function aStep(): { id: string; name: string } {
  const step = listStepsForPipeline(handle.db, "default")[0]!;
  return { id: step.id, name: step.name };
}

const unattended = () => getPipeline(handle.db, "default")?.webhookUnattended;

describe("webhook items sent on unread", () => {
  it("is a card stating the risk in webhookUnattended.ts's words, and nothing changes until it is pressed", async () => {
    webhookJobOnto();
    const conversation = await chat("Let the support webhook's items through without anybody reading them.");

    const { cardIds, rejections } = turn(conversation, { message: "That is yours to accept.", card: { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: true } });

    expect(rejections).toEqual([]);
    const card = await messageOf(conversation, cardIds[0]!);
    expect(card).toMatchObject({ canApprove: true, approves: "card", card: { kind: "pipelineWebhookUnattended", outcome: null } });
    expect(card.body).toContain(WEBHOOK_UNATTENDED_LABEL);
    expect(card.body).toContain(WEBHOOK_UNATTENDED_RISK);
    expect((await read(conversation, cardIds[0]!)).card).toEqual({
      kind: "pipelineWebhookUnattended",
      pipelineId: "default",
      pipelineName: getPipeline(handle.db, "default")!.name,
      unattended: true,
      current: false,
      entry: true,
      managed: false,
    });
    expect(unattended()).toBe(false);

    const pressed = await press(conversation, cardIds[0]!);

    expect(pressed.applied).toBe(true);
    expect(unattended()).toBe(true);
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: false, card: { outcome: { done: true } } });
    // Spent: a second press cannot apply it twice.
    expect((await press(conversation, cardIds[0]!)).problem).toContain("already been pressed");
  });

  it("turns it off from a card asking to stop", async () => {
    webhookJobOnto();
    setWebhookUnattended(handle.db, "default", true);
    const conversation = await chat("Stop sending them on unread.");
    const { cardIds } = turn(conversation, { message: "Press it.", card: { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: false } });

    expect((await press(conversation, cardIds[0]!)).applied).toBe(true);

    expect(unattended()).toBe(false);
  });

  it("is not offered for a pipeline no webhook job files onto, nor for a setting already as asked", async () => {
    const conversation = await chat();

    const noJob = turn(conversation, { message: "x", card: { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: true } });
    expect(noJob.cardIds).toEqual([]);
    expect(noJob.rejections[0]).toContain("no webhook job files onto");

    webhookJobOnto();
    const already = turn(conversation, { message: "x", card: { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: false } });
    expect(already.cardIds).toEqual([]);
    expect(already.rejections[0]).toContain("nothing to change");
  });

  it("says the organisation manages it before the press, and files the lock's refusal when pressed", async () => {
    webhookJobOnto();
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "x", card: { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: true } });
    publishSection(handle.db, { section: "pipelines", subjectId: "default", versionId: "a-version", versionNumber: 1, publishedAt: Date.now(), publishedBy: "dana-id", publishedByName: "Dana" });
    const stopBeingAReplica = markReplica(handle.db, () => true);
    try {
      expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ managed: true });

      const pressed = await press(conversation, cardIds[0]!);

      expect(pressed.applied).toBe(false);
      expect(pressed.said).toContain("was not changed");
      expect(unattended()).toBe(false);
    } finally {
      stopBeingAReplica();
    }
  });

  it("is still refused to pipeline_save, and no eo_admin tool reaches the setting or the card", async () => {
    const reached = TOOLS.flatMap((tool) => tool.channels);
    expect(reached).not.toContain("pipelines:setWebhookUnattended");
    expect(reached).not.toContain("assist:applyCard");
  });
});

describe("a step's own secret or variable", () => {
  it("is a card naming the step and the variable, saying whether a value is set and never what it is", async () => {
    const step = aStep();
    await call("moduleSecrets:set", { name: "DEPLOY_TOKEN", value: "the-old-token-value", stepId: step.id });
    const conversation = await chat("Give the first step its own deploy token.");

    const { cardIds, rejections } = turn(conversation, { message: "Type it on the card.", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });

    expect(rejections).toEqual([]);
    const card = await messageOf(conversation, cardIds[0]!);
    expect(card).toMatchObject({ canApprove: true, approves: "card", card: { kind: "stepSecret", outcome: null } });
    expect(card.body).toContain("DEPLOY_TOKEN");
    expect(card.body).toContain(step.name);
    const detail = await read(conversation, cardIds[0]!);
    expect(detail.card).toMatchObject({ kind: "stepSecret", stepId: step.id, stepName: step.name, name: "DEPLOY_TOKEN", action: "set", set: true, setAsOther: false, shared: null, organisation: false });
    expect(JSON.stringify(detail)).not.toContain("the-old-token-value");
  });

  it("sets the secret to what the person typed, through moduleSecrets:set, for that step alone", async () => {
    const step = aStep();
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "x", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });

    const pressed = await press(conversation, cardIds[0]!, "typed-on-the-card");

    expect(pressed.applied).toBe(true);
    expect(pressed.said).toContain("DEPLOY_TOKEN");
    expect(await call("moduleSecrets:list", { stepId: step.id })).toMatchObject({ names: [], overrides: ["DEPLOY_TOKEN"] });
    expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ set: true });
  });

  it("sets and clears a step's own variable", async () => {
    const step = aStep();
    const conversation = await chat();
    const set = turn(conversation, { message: "x", card: { kind: "stepVariable", stepId: step.id, name: "REGION", action: "set" } });
    expect((await press(conversation, set.cardIds[0]!, "eu-west-1")).applied).toBe(true);
    expect((await call("environmentVariables:list", { stepId: step.id })).variables).toEqual([{ name: "REGION", value: "eu-west-1", scope: "step" }]);

    await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: conversation.id, body: "Now remove it.", attachmentIds: [], interrupt: false });
    const clear = turn(conversation, { message: "x", card: { kind: "stepVariable", stepId: step.id, name: "REGION", action: "clear" } });
    expect((await read(conversation, clear.cardIds[0]!)).card).toMatchObject({ set: true, action: "clear" });
    expect((await press(conversation, clear.cardIds[0]!)).applied).toBe(true);

    expect((await call("environmentVariables:list", { stepId: step.id })).variables).toEqual([]);
  });

  it("files nothing for a Set pressed with nothing typed, so the card stays to fill in", async () => {
    const step = aStep();
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "x", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });

    const pressed = await press(conversation, cardIds[0]!);

    expect(pressed).toMatchObject({ applied: false, said: null });
    expect(pressed.problem).toContain("Type the value");
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ canApprove: true, card: { outcome: null } });
  });

  it("files the channel's refusal under the card", async () => {
    const step = aStep();
    const conversation = await chat();
    await call("environmentVariables:set", { name: "DEPLOY_TOKEN", value: "plain", stepId: step.id });
    const { cardIds } = turn(conversation, { message: "x", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });

    const pressed = await press(conversation, cardIds[0]!, "a-secret");

    expect(pressed.applied).toBe(false);
    expect(pressed.said).toContain("never both");
    expect(await messageOf(conversation, cardIds[0]!)).toMatchObject({ card: { outcome: { done: false } } });
  });

  it("is not offered for a step that is not there or a name that is not a variable's", async () => {
    const conversation = await chat();

    const noStep = turn(conversation, { message: "x", card: { kind: "stepSecret", stepId: "no-such-step", name: "DEPLOY_TOKEN", action: "set" } });
    expect(noStep.cardIds).toEqual([]);
    expect(noStep.rejections[0]).toContain("no step with the ID");

    const badName = turn(conversation, { message: "x", card: { kind: "stepVariable", stepId: aStep().id, name: "not a name", action: "set" } });
    expect(badName.cardIds).toEqual([]);
    expect(badName.rejections[0]).toContain("is not an environment-variable name");
  });
});

/**
 * Where a name stands for a step, as a run is given it (`environmentFor`):
 * the organisation's value first, then the step's own entry of either
 * kind, then the shared one of either kind. The card's word for what a
 * step falls back to is checked here against that resolution, not
 * against itself.
 */
describe("what a card says the step is left with", () => {
  async function pressed(card: { kind: "stepSecret" | "stepVariable"; stepId: string; name: string; action: "set" | "clear" }, value?: string) {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "x", card });
    const detail = (await read(conversation, cardIds[0]!)).card;
    return { detail, said: (await press(conversation, cardIds[0]!, value)).said };
  }

  it("says a cleared secret falls back to a shared variable of the same name, which is what a run then gets", async () => {
    const step = aStep();
    await call("environmentVariables:set", { name: "DEPLOY_TOKEN", value: "shared-plain-value" });
    await call("moduleSecrets:set", { name: "DEPLOY_TOKEN", value: "the-steps-own", stepId: step.id });

    const { detail, said } = await pressed({ kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "clear" });

    expect(detail).toMatchObject({ set: true, shared: "variable", organisation: false });
    expect(said).toContain("The step now uses the shared environment variable DEPLOY_TOKEN.");
    expect(givenToARun(step.id, "DEPLOY_TOKEN")).toBe("shared-plain-value");
  });

  it("says a cleared variable falls back to a shared secret of the same name, which is what a run then gets", async () => {
    const step = aStep();
    await call("moduleSecrets:set", { name: "REGION", value: "shared-secret-value" });
    await call("environmentVariables:set", { name: "REGION", value: "eu-west-1", stepId: step.id });

    const { detail, said } = await pressed({ kind: "stepVariable", stepId: step.id, name: "REGION", action: "clear" });

    expect(detail).toMatchObject({ set: true, shared: "secret", organisation: false });
    expect(said).toContain("The step now uses the shared secret REGION.");
    expect(givenToARun(step.id, "REGION")).toBe("shared-secret-value");
  });

  it("says the step has no value only where nothing of either kind stands behind it", async () => {
    const step = aStep();
    await call("environmentVariables:set", { name: "REGION", value: "eu-west-1", stepId: step.id });

    const { detail, said } = await pressed({ kind: "stepVariable", stepId: step.id, name: "REGION", action: "clear" });

    expect(detail).toMatchObject({ set: true, shared: null });
    expect(said).toContain("The step now has no value for REGION.");
    expect(givenToARun(step.id, "REGION")).toBeUndefined();
  });

  it("says the organisation's value is what a run is given, before and after the press", async () => {
    const step = aStep();
    expect(storeOrganisationSecret(stores().organisation, "DEPLOY_TOKEN", "the-organisations").ok).toBe(true);

    const { detail, said } = await pressed({ kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" }, "typed-on-the-card");

    expect(detail).toMatchObject({ set: false, organisation: true });
    expect(said).toContain("Your organisation sets DEPLOY_TOKEN, so its value is still what a run of this step is given.");
    expect(givenToARun(step.id, "DEPLOY_TOKEN")).toBe("the-organisations");
  });

  it("says the step already holds the name as the other kind", async () => {
    const step = aStep();
    await call("environmentVariables:set", { name: "DEPLOY_TOKEN", value: "plain", stepId: step.id });
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "x", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });

    expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ set: false, setAsOther: true });
  });
});

/**
 * The story's own criterion: "The value never appears in the agent's
 * prompt, its transcript, the chat thread or the card's stored message."
 *
 * Swept rather than spot-checked. After a secret and a variable are set
 * from their cards, every row of every table in the database is read —
 * comments, runs and their results, run events, mentions, items, settings,
 * whatever a later story adds — along with the conversation as the chat
 * draws it, what each card reads, and the context the assistant's next
 * turn would be dispatched with. The values are in the store, where they
 * were sent, and in none of those.
 */
describe("the value a person types on the card", () => {
  it("appears nowhere but the store: not in the prompt, the transcript, the thread or the card", async () => {
    const SECRET = "typed-secret-eo522-a1b2c3";
    const VARIABLE = "typed-variable-eo522-d4e5f6";
    const step = aStep();
    const conversation = await chat("Give the first step its own token and region.");
    const secret = turn(conversation, { message: "Type it on the card.", card: { kind: "stepSecret", stepId: step.id, name: "DEPLOY_TOKEN", action: "set" } });
    expect((await press(conversation, secret.cardIds[0]!, SECRET)).problem).toBeNull();
    await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: conversation.id, body: "And the region.", attachmentIds: [], interrupt: false });
    const variable = turn(conversation, { message: "Type it on the card.", card: { kind: "stepVariable", stepId: step.id, name: "REGION", action: "set" } });
    expect((await press(conversation, variable.cardIds[0]!, VARIABLE)).problem).toBeNull();
    // The person says something after, so a next turn is due.
    await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: conversation.id, body: "Done?", attachmentIds: [], interrupt: false });

    // Where it went: the store, for that step.
    expect((await call("moduleSecrets:list", { stepId: step.id })).overrides).toContain("DEPLOY_TOKEN");
    expect((await call("environmentVariables:list", { stepId: step.id })).variables).toContainEqual({ name: "REGION", value: VARIABLE, scope: "step" });

    const nowhere = (where: string, text: string) => {
      expect(text, where).not.toContain(SECRET);
      expect(text, where).not.toContain(VARIABLE);
    };

    // The agent's prompt: the context its next turn is dispatched with.
    nowhere("the next turn's context", await buildDispatchContext(handle.db, getItem(handle.db, conversation.id)!, ASSIST_ACTION));

    // What an agent reads back through eo_admin: the tool that lists
    // environment variables, asked about that very step, after the press.
    // Neither its structured answer nor its text carries the value; it
    // says the step sets the name.
    const listTool = TOOLS.find((candidate) => candidate.name === "environment_variables_list")!;
    const listed = await listTool.run(dispatchIpc, { stepId: step.id });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    nowhere("environment_variables_list's structured answer", JSON.stringify(listed.data));
    nowhere("environment_variables_list's text", listed.text);
    expect(listed.text).toContain("REGION (this step) — set");
    expect(listed.data).toEqual({ variables: [{ name: "REGION", value: null, scope: "step" }] });
    // And through the host's own door, narrowed (EO-538): a client may ask
    // for the list's fields, filter it, or ask for a value outright. The
    // host narrows what the tool gave, which never had the value.
    for (const narrowing of [
      {},
      { fields: ["variables.name", "variables.value"] },
      { where: [{ path: "name", op: "eq", value: "REGION" }], fields: ["variables.value"] },
      { where: [{ path: "value", op: "contains", value: "eo522" }] },
      { sort: { path: "value", direction: "asc" }, limit: 5 },
    ]) {
      const answered = await answerToolCall({ name: "environment_variables_list", arguments: { stepId: step.id, ...narrowing } }, "admin", true);
      nowhere(`environment_variables_list through the host, narrowed by ${JSON.stringify(narrowing)}`, JSON.stringify(answered));
    }

    // Nor can a filter on the value be used to probe for it: guessing
    // right and guessing wrong answer the same, and an exact match on the
    // typed value matches nothing — the host filters what the tool gave,
    // where a step's own value is null.
    const probe = (op: "eq" | "contains", guess: string) =>
      answerToolCall({ name: "environment_variables_list", arguments: { stepId: step.id, where: [{ path: "value", op, value: guess }] } }, "admin", true);
    for (const op of ["eq", "contains"] as const) {
      const right = await probe(op, op === "eq" ? VARIABLE : VARIABLE.slice(0, 12));
      const wrong = await probe(op, op === "eq" ? "a-wrong-guess-for-the-value" : "a-wrong-guess");
      expect(right.isError, `${op} probe`).toBe(false);
      expect(JSON.stringify(right), `${op} probe with the right value`).toBe(JSON.stringify(wrong).replaceAll(op === "eq" ? "a-wrong-guess-for-the-value" : "a-wrong-guess", op === "eq" ? VARIABLE : VARIABLE.slice(0, 12)));
      expect(right.structuredContent, `${op} probe`).toMatchObject({ total: 0, returned: 0 });
    }

    // And the secrets' list, which never carried a value.
    const secretsTool = TOOLS.find((candidate) => candidate.name === "module_secrets_list")!;
    const secretsListed = await secretsTool.run(dispatchIpc, { stepId: step.id });
    expect(secretsListed.ok).toBe(true);
    if (secretsListed.ok) {
      nowhere("module_secrets_list's structured answer", JSON.stringify(secretsListed.data));
      nowhere("module_secrets_list's text", secretsListed.text);
    }

    // The chat thread, as the chat draws it, and each card as it reads itself.
    const view = await call("assist:open", undefined);
    nowhere("the conversation", JSON.stringify(view));
    for (const id of [...secret.cardIds, ...variable.cardIds]) nowhere(`card ${id}`, JSON.stringify(await read(conversation, id)));

    // Every row of every table: comments (the card's stored message and
    // what was filed under it), runs and their results, run events (the
    // transcript), and anything else.
    const tables = handle.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(["comments", "runs", "run_events"]));
    for (const { name } of tables) {
      const rows = handle.db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${name}"`));
      const cells = rows.flatMap((row) => Object.values(row).map((cell) => (cell instanceof Uint8Array ? Buffer.from(cell).toString("utf8") : cell)));
      nowhere(`table ${name}`, JSON.stringify(cells));
    }
  });
});
