import { pageDescriptorFor, type Agent, type AgentEvent, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem } from "../db/repos/index.js";
import { archivePipeline, createPipeline, createStep, setEntryStep } from "../db/repos/pipelineStepsRepo.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { sendToAssist } from "../ipc/assistCommands.js";
import { clearPublishedView } from "../ipc/currentView.js";
import { postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { describeProposal, proposalOfComment } from "../roles/discussion.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A proposal naming a pipeline its project does not have is sent back to
 * the agent while its turn is open (EO-440).
 *
 * The rule lives in `proposedPipelineProblem`; this is the proof the
 * supervisor holds `assist` results to it where every
 * result is validated. Before, such a proposal was posted as an
 * approvable card and refused only when a person pressed Create, after
 * the agent's turn had ended — so the person had to ask for the
 * correction themselves.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** Each start or resume answers with the next scripted result; what the supervisor sent back is recorded. */
function providerYielding(results: unknown[]) {
  let index = 0;
  const promptsSeen: string[] = [];
  async function* emit(): AsyncIterable<AgentEvent> {
    const data = results[Math.min(index, results.length - 1)];
    index += 1;
    yield { type: "result", data };
  }
  return {
    promptsSeen,
    provider: {
      async *start(): AsyncIterable<AgentEvent> {
        yield { type: "thread_started", threadId: "t1" };
        yield* emit();
      },
      async *resume(_threadId: string, message: string): AsyncIterable<AgentEvent> {
        promptsSeen.push(message);
        yield* emit();
      },
    },
  };
}

let handle: DbHandle;
let hotfix: { id: string };

beforeEach(() => {
  handle = openMigratedTestDb();
  // A second placeable pipeline, so the correction has more than one to list.
  const pipeline = createPipeline(handle.db, { name: "Hotfix", projectId: null });
  const step = createStep(handle.db, { id: "hx_build", pipelineId: pipeline.id, position: 0, name: "Build", ownerRole: "implementer", entryAction: "implement" });
  setEntryStep(handle.db, pipeline.id, step.id);
  hotfix = pipeline;
});

/**
 * A supervisor that posts a conversation turn's reply the way the
 * developer pack's wiring does, by the same two calls, without reaching
 * into the pack for them.
 */
function supervisor(provider: ReturnType<typeof providerYielding>["provider"]) {
  return createRunSupervisor({
    db: handle.db,
    provider,
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
    },
  });
}

afterEach(() => {
  clearPublishedView();
  handle.close();
});

function reply(pipeline: string) {
  return {
    message: "Here is the fix.",
    proposals: [
      {
        action: "new_story",
        title: "Count each request once",
        body: "The limiter counts retries twice.",
        acceptance_criteria: ["A retried request is counted once."],
        pipeline,
      },
    ],
  };
}

/** What the agent posted in the conversation — the person's own message excluded. */
function agentComments(conversation: Item) {
  return listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.authorType === "agent");
}

describe("an assist turn proposing work on a pipeline the project does not have", () => {
  async function ask() {
    const { conversation } = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "File the limiter bug.", attachmentIds: [], interrupt: false });
    return getItem(handle.db, conversation.id as Uuid)!;
  }

  it("is sent back naming the proposal, the value and every pipeline, and the corrected reply posts its card", async () => {
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([reply("Shipping"), reply("default")]);

    await supervisor(provider).runOnce();

    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain('"Count each request once" names the pipeline "Shipping"');
    expect(promptsSeen[0]).toContain("Delivery (id: default)");
    expect(promptsSeen[0]).toContain(`Hotfix (id: ${hotfix.id})`);

    // One run, succeeded on the corrected reply: nobody typed again.
    const runs = listRunsForItem(handle.db, conversation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(JSON.stringify(runs[0]?.result)).not.toContain("Shipping");

    // Posted exactly as a reply valid the first time would be: its
    // message and its card, and no rejection for the attempt that was
    // sent back.
    const posted = agentComments(conversation);
    expect(posted.filter((comment) => comment.kind === "rejection")).toEqual([]);
    expect(posted.filter((comment) => comment.body.includes("Here is the fix."))).toHaveLength(1);
    const cards = posted.filter((comment) => comment.kind === PROPOSAL_KIND);
    expect(cards).toHaveLength(1);

    // And the card names the pipeline the id meant.
    const proposal = proposalOfComment(handle.db, conversation, cards[0]!.id);
    expect(proposal).toMatchObject({ title: "Count each request once", pipeline: "default" });
    expect(describeProposal(handle.db, conversation, proposal!).landsOn?.pipelineName).toBe("Delivery");
  });

  it("posts nothing at all when the agent never corrects it", async () => {
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([reply("Shipping")]);

    await supervisor(provider).runOnce();

    expect(promptsSeen.length).toBeGreaterThan(0);
    const [run] = listRunsForItem(handle.db, conversation.id);
    expect(run?.status).not.toBe("succeeded");
    expect(run?.error).toContain("still failed validation");
    expect(run?.error).toContain('names the pipeline "Shipping"');

    const posted = agentComments(conversation);
    expect(posted.filter((comment) => comment.kind === PROPOSAL_KIND || comment.kind === "rejection")).toEqual([]);
    expect(posted.some((comment) => comment.body.includes("Here is the fix."))).toBe(false);
  });

  it("is not sent back when the pipeline is named by name", async () => {
    const conversation = await ask();
    const named = reply("Delivery");
    const { provider, promptsSeen } = providerYielding([{ ...named, proposals: [...named.proposals, { ...named.proposals[0]!, title: "Hotfix one", pipeline: "hotfix" }] }]);

    await supervisor(provider).runOnce();

    expect(promptsSeen).toEqual([]);
    expect(listRunsForItem(handle.db, conversation.id)[0]?.status).toBe("succeeded");
    expect(agentComments(conversation).filter((comment) => comment.kind === PROPOSAL_KIND)).toHaveLength(2);
  });
});

/**
 * A proposal naming no pipeline, on a project with more than one, is sent
 * back the same way (EO-441): approval would only ask which, and nothing
 * in a chat asks the person. With one pipeline there is nothing to ask.
 */
describe("an assist turn proposing work with no pipeline", () => {
  async function ask() {
    const { conversation } = await sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId: null, body: "File the limiter bug.", attachmentIds: [], interrupt: false });
    return getItem(handle.db, conversation.id as Uuid)!;
  }

  function unnamed() {
    const named = reply("unused");
    return { ...named, proposals: named.proposals.map(({ pipeline: _pipeline, ...rest }) => rest) };
  }

  it("is sent back on a project with two pipelines, and the corrected reply posts its card", async () => {
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([unnamed(), reply("Hotfix")]);

    await supervisor(provider).runOnce();

    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain('The proposal "Count each request once" names no pipeline, and this project has more than one.');
    expect(promptsSeen[0]).toContain("Delivery (id: default)");
    expect(promptsSeen[0]).toContain(`Hotfix (id: ${hotfix.id})`);

    const runs = listRunsForItem(handle.db, conversation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");

    const posted = agentComments(conversation);
    expect(posted.filter((comment) => comment.kind === "rejection")).toEqual([]);
    expect(posted.filter((comment) => comment.body.includes("Here is the fix."))).toHaveLength(1);
    const cards = posted.filter((comment) => comment.kind === PROPOSAL_KIND);
    expect(cards).toHaveLength(1);
    const proposal = proposalOfComment(handle.db, conversation, cards[0]!.id);
    expect(describeProposal(handle.db, conversation, proposal!).landsOn?.pipelineName).toBe("Hotfix");
  });

  it("posts with no re-prompt on a project with one pipeline, naming that pipeline on its card", async () => {
    archivePipeline(handle.db, hotfix.id);
    const conversation = await ask();
    const { provider, promptsSeen } = providerYielding([unnamed()]);

    await supervisor(provider).runOnce();

    expect(promptsSeen).toEqual([]);
    expect(listRunsForItem(handle.db, conversation.id)[0]?.status).toBe("succeeded");
    const cards = agentComments(conversation).filter((comment) => comment.kind === PROPOSAL_KIND);
    expect(cards).toHaveLength(1);
    const proposal = proposalOfComment(handle.db, conversation, cards[0]!.id);
    expect(proposal?.action === "new_story" && proposal.pipeline).toBeFalsy();
    expect(describeProposal(handle.db, conversation, proposal!).landsOn?.pipelineName).toBe("Delivery");
  });
});
