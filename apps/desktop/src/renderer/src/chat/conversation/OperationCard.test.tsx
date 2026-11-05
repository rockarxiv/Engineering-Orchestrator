import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WEBHOOK_UNATTENDED_LABEL, WEBHOOK_UNATTENDED_MANAGED, WEBHOOK_UNATTENDED_RISK, type AssistCardDetail, type AssistCardView, type DiscussionMessage, type ImportPreflightView, type ItemTypeCardShape } from "@eo/core";
import { ipcStub, renderSection, sent, type Answers } from "../views/settings/org/testing";
import { OperationCard } from "./OperationCard";

/**
 * The cards for what only a person may do (EO-521), as the conversation
 * draws them: what the card read about its pipeline or file, one button,
 * and — once pressed — what came of it in the button's place.
 *
 * The button is `assist:applyCard` and nothing else. The channels it is
 * carried out through (`pipelines:delete` and the rest) are the main
 * process's to call, so a card that called one itself would be a second
 * way of doing it that skipped "newest wins" and left nothing filed.
 */

function message(card: AssistCardView, overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "card-1",
    authorType: "agent",
    authorName: "Assistant",
    body: "**Delete** Delivery.",
    attachments: [],
    kind: "decision",
    parentId: null,
    runId: "run-1",
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: card.outcome === null,
    approves: card.outcome === null ? "card" : null,
    moduleSlug: null,
    card,
    proposedType: null,
    status: null,
    ...overrides,
  };
}

function preflight(overrides: Partial<ImportPreflightView> = {}): ImportPreflightView {
  return {
    pipelineName: "Shipping",
    missingBinaries: [{ name: "flyctl", wantedBy: ["Deploy"] }],
    missingSecrets: [],
    wantsNetwork: [],
    readsItems: [],
    postsComments: [],
    attachesFiles: [],
    createsItems: [],
    collisions: [
      { slug: "deploy", localName: "Deploy", incomingName: "Deploy (theirs)" },
      { slug: "notify", localName: "Notify", incomingName: "Notify" },
    ],
    roleSlots: [],
    connectors: [],
    capabilities: [],
    refusal: null,
    itemTypes: [],
    oldNames: [],
    machineSpecific: [],
    moduleCount: 2,
    ...overrides,
  };
}

function draw(card: DiscussionMessage, detail: AssistCardDetail | null, answers: Answers = {}) {
  const stub = ipcStub({ "assist:card": { card: detail, problem: null }, ...answers });
  window.eo.ipc.invoke = stub.invoke as never;
  const onDone = vi.fn();
  renderSection(<OperationCard message={card} conversationId="conv-1" onDone={onDone} />);
  return { calls: stub.calls, onDone };
}

const DELETE = { kind: "pipelineDelete", pipelineId: "delivery", pipelineName: "Delivery", itemCount: 3 } as const;
const PRESSED = { applied: true, problem: null, said: "Deleted Delivery. It is in the Archive, with the 3 items that were on it.", conversation: {} };

describe("a card for deleting a pipeline", () => {
  it("says how many items it holds and that it goes to the Archive, and Delete goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "pipelineDelete", outcome: null }), DELETE, { "assist:applyCard": PRESSED });

    const card = screen.getByRole("region", { name: "Delete a pipeline" });
    expect(await within(card).findByText(/Delivery holds 3/)).toHaveTextContent("Deleting it moves it to the Archive");

    fireEvent.click(within(card).getByRole("button", { name: "Delete pipeline" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "pipelines:delete")).toEqual([]);
    expect(sent(calls, "assist:approve")).toEqual([]);
  });

  it("shows what came of it once pressed, with no button left to press", async () => {
    draw(message({ kind: "pipelineDelete", outcome: { done: true, said: PRESSED.said } }), DELETE);

    expect(await screen.findByText("Deleted")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(PRESSED.said);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a refusal on the card", async () => {
    const said = "Delivery was not deleted: a run is working on one of its items. Let it finish, or stop it, and ask again.";
    draw(message({ kind: "pipelineDelete", outcome: { done: false, said } }), DELETE);

    expect(await screen.findByText("Not deleted")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(said);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers nothing once a newer card replaced it", async () => {
    draw(message({ kind: "pipelineDelete", outcome: null }, { canApprove: false, approves: null }), DELETE);

    expect(await screen.findByText(/A newer reply replaced this card/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why under the card when nothing was filed for a press", async () => {
    draw(message({ kind: "pipelineDelete", outcome: null }), DELETE, {
      "assist:applyCard": { applied: false, problem: "That card has already been pressed.", said: null, conversation: {} },
    });

    // Held until the card has read what it is about, then pressed.
    expect(screen.getByRole("button", { name: "Delete pipeline" })).toBeDisabled();
    await screen.findByText(/Delivery holds 3/);
    fireEvent.click(screen.getByRole("button", { name: "Delete pipeline" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That card has already been pressed.");
  });
});

describe("a card for importing an attached pipeline file", () => {
  const IMPORT = { kind: "pipelineImport", attachmentName: "shipping.eo-pipeline.json", preflight: preflight() } as const;

  it("shows what the import would create and need, and asks about each module it shares a name with", async () => {
    draw(message({ kind: "pipelineImport", outcome: null }), IMPORT);

    expect(await screen.findByText(/From shipping\.eo-pipeline\.json: a new pipeline, Shipping, and 2 modules/)).toBeInTheDocument();
    // ImportPreflight's own lines, drawn by the component the editor shares.
    expect(screen.getByText(/is not on your PATH/)).toHaveTextContent("flyctl");
    const deploy = screen.getByRole("radiogroup", { name: "What to do about deploy" });
    // Keep mine until the person says otherwise.
    expect(within(deploy).getByRole("radio", { name: "Keep mine" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radiogroup", { name: "What to do about notify" })).toBeInTheDocument();
  });

  it("imports with the person's choice for each, through assist:applyCard", async () => {
    const { calls, onDone } = draw(message({ kind: "pipelineImport", outcome: null }), IMPORT, {
      "assist:applyCard": { applied: true, problem: null, said: "Imported Shipping.", conversation: {} },
    });

    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "What to do about deploy" })).getByRole("radio", { name: "Import theirs" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: { deploy: "import", notify: "reuse" } }]);
    expect(sent(calls, "pipelines:import")).toEqual([]);
  });

  it("holds Import for a file EO refuses outright", async () => {
    draw(message({ kind: "pipelineImport", outcome: null }), { ...IMPORT, preflight: preflight({ refusal: "This pack asks for EO's admin tools, which no pack may have." }) });

    expect(await screen.findByText(/admin tools/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });
});

describe("a card for exporting, and one for discarding edits", () => {
  it("offers Export for the pipeline it names", async () => {
    const { calls } = draw(message({ kind: "pipelineExport", outcome: null }), { kind: "pipelineExport", pipelineId: "delivery", pipelineName: "Delivery" }, {
      "assist:applyCard": { applied: true, problem: null, said: "Exported Delivery to /tmp/Delivery.eo-pipeline.json.", conversation: {} },
    });

    expect(await screen.findByText(/Saves Delivery as a pipeline file/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));

    await waitFor(() => expect(sent(calls, "assist:applyCard")).toHaveLength(1));
    expect(sent(calls, "pipelines:export")).toEqual([]);
  });

  it("offers Discard my edits, saying the organisation's updates resume", async () => {
    draw(message({ kind: "pipelineDiscardEdits", outcome: null }), {
      kind: "pipelineDiscardEdits",
      pipelineId: "delivery",
      pipelineName: "Delivery",
      line: "Edited locally · based on v6",
      version: 6,
    });

    expect(await screen.findByText(/puts back the version your organisation published, v6/)).toHaveTextContent("Your organisation's updates resume.");
    expect(screen.getByText("Edited locally · based on v6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard my edits" })).toBeEnabled();
  });
});

/**
 * The settings that are deliberately a person's (EO-522): webhook items
 * sent on unread, and a step's own secret or variable.
 */
describe("a card for letting webhook items through unread", () => {
  const WEBHOOK = { kind: "pipelineWebhookUnattended", pipelineId: "support", pipelineName: "Support", unattended: true, current: false, entry: true, managed: false } as const;

  it("states the risk in webhookUnattended.ts's words, and its button goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "pipelineWebhookUnattended", outcome: null }), WEBHOOK, {
      "assist:applyCard": { applied: true, problem: null, said: "Support now sends webhook items on without a person reading them first.", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "Webhook items" });
    expect(await within(card).findByText(WEBHOOK_UNATTENDED_RISK)).toBeInTheDocument();
    expect(within(card).getByText(WEBHOOK_UNATTENDED_LABEL)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Send on unread" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "pipelines:setWebhookUnattended")).toEqual([]);
  });

  it("offers Stop for a card asking to turn it off", async () => {
    draw(message({ kind: "pipelineWebhookUnattended", outcome: null }), { ...WEBHOOK, unattended: false, current: true });

    expect(await screen.findByRole("button", { name: "Stop sending on unread" })).toBeEnabled();
  });

  it("holds the button where the organisation manages the pipeline, and says so", async () => {
    draw(message({ kind: "pipelineWebhookUnattended", outcome: null }), { ...WEBHOOK, managed: true });

    expect(await screen.findByText(WEBHOOK_UNATTENDED_MANAGED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send on unread" })).toBeDisabled();
  });
});

describe("a card for a step's own secret or variable", () => {
  const SECRET = { kind: "stepSecret", pipelineId: "delivery", pipelineName: "Delivery", stepId: "deploy", stepName: "Deploy", name: "DEPLOY_TOKEN", action: "set", set: true, setAsOther: false, shared: null, organisation: false } as const;

  it("names the step and the variable, says a value is set without saying it, and takes the value typed into it", async () => {
    const { calls, onDone } = draw(message({ kind: "stepSecret", outcome: null }, { body: "**Set** the secret DEPLOY_TOKEN." }), SECRET, {
      "assist:applyCard": { applied: true, problem: null, said: "The secret DEPLOY_TOKEN was set on the Deploy step of Delivery.", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "A step's own secret" });
    expect(await within(card).findByText("DEPLOY_TOKEN · Deploy")).toBeInTheDocument();
    expect(within(card).getByText(/already has its own value for DEPLOY_TOKEN/)).toBeInTheDocument();
    const field = within(card).getByLabelText("Value for DEPLOY_TOKEN");
    expect(field).toHaveAttribute("type", "password");
    const button = within(card).getByRole("button", { name: "Set secret" });
    expect(button).toBeDisabled();

    fireEvent.change(field, { target: { value: "typed-on-the-card" } });
    fireEvent.click(button);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // The value goes in the press and nowhere else: not to the store's
    // channel from here, and not left in the field once pressed.
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {}, value: "typed-on-the-card" }]);
    expect(sent(calls, "moduleSecrets:set")).toEqual([]);
    expect(within(card).getByLabelText("Value for DEPLOY_TOKEN")).toHaveValue("");
  });

  it("offers Clear with no field, and nothing to press where the step has no value of its own", async () => {
    draw(message({ kind: "stepVariable", outcome: null }), { ...SECRET, kind: "stepVariable", name: "REGION", action: "clear", set: false, shared: "variable" });

    expect(await screen.findByText(/There is nothing to clear/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Value for REGION")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear variable" })).toBeDisabled();
  });

  // A run is given a name across both lists (environmentFor): without its
  // own secret, a step falls back to a shared *variable* of that name, and
  // the other way round. The card says which, never that nothing is left.
  it("says a cleared secret falls back to a shared variable, and a cleared variable to a shared secret", async () => {
    draw(message({ kind: "stepSecret", outcome: null }), { ...SECRET, action: "clear", shared: "variable" });
    expect(await screen.findByText(/Clearing removes it, and the step falls back to the shared environment variable\./)).toBeInTheDocument();
    expect(screen.queryByText(/is left with no value/)).not.toBeInTheDocument();
  });

  it("says a cleared variable falls back to a shared secret", async () => {
    draw(message({ kind: "stepVariable", outcome: null }), { ...SECRET, kind: "stepVariable", name: "REGION", action: "clear", shared: "secret" });
    expect(await screen.findByText(/Clearing removes it, and the step falls back to the shared secret\./)).toBeInTheDocument();
  });

  it("says only where nothing stands behind it that the step is left with no value", async () => {
    draw(message({ kind: "stepSecret", outcome: null }), { ...SECRET, action: "clear", shared: null });
    expect(await screen.findByText(/is left with no value for it/)).toBeInTheDocument();
  });

  it("says the organisation's value is what a run is given, whatever is set on the step", async () => {
    draw(message({ kind: "stepSecret", outcome: null }), { ...SECRET, organisation: true });
    expect(await screen.findByText(/Your organisation sets DEPLOY_TOKEN, so its value is what a run of this step is given/)).toBeInTheDocument();
  });

  it("holds Set where the step already has the name as the other kind", async () => {
    draw(message({ kind: "stepSecret", outcome: null }), { ...SECRET, set: false, setAsOther: true });
    expect(await screen.findByText(/already has DEPLOY_TOKEN as its own environment variable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set secret" })).toBeDisabled();
    expect(screen.queryByLabelText("Value for DEPLOY_TOKEN")).not.toBeInTheDocument();
  });
});


describe("a card for a project's item type (EO-523)", () => {
  const CASE: ItemTypeCardShape = {
    label: "Case",
    plural: "Cases",
    slug: "case",
    container: false,
    fields: [
      { name: "customer_name", kind: "string", required: true },
      { name: "priority", kind: "number", required: false },
    ],
  };
  const CREATE: AssistCardDetail = { kind: "itemTypeCreate", projectId: "shop", projectName: "Shop", type: CASE, problem: null };

  it("shows the type as it would be, and Add type goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "itemTypeCreate", outcome: null }), CREATE, {
      "assist:applyCard": { applied: true, problem: null, said: "Added the item type “Case” to Shop.", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "Add an item type" });
    expect(await within(card).findByText("A new item type on Shop.")).toBeInTheDocument();
    const shown = within(card).getByLabelText("The item type");
    expect(shown).toHaveTextContent("NameCase");
    expect(shown).toHaveTextContent("PluralCases");
    expect(shown).toHaveTextContent("Filed ascase");
    expect(shown).toHaveTextContent("HoldsIs the work");
    expect(within(shown).getByLabelText("Fields")).toHaveTextContent("customer_nameTextrequired");
    expect(within(shown).getByLabelText("Fields")).toHaveTextContent("priorityNumber");

    fireEvent.click(within(card).getByRole("button", { name: "Add type" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "itemTypes:create")).toEqual([]);
  });

  it("marks what a change moves, and says a pack's type can only be renamed", async () => {
    const story = { label: "Story", plural: "Stories", slug: "story", container: false, fields: [] };
    draw(message({ kind: "itemTypeUpdate", outcome: null }), {
      kind: "itemTypeUpdate",
      itemTypeId: "t-story",
      projectName: "Shop",
      packSlug: "developer",
      itemCount: 4,
      problem: null,
      before: story,
      after: { ...story, label: "Request", plural: "Requests" },
    });

    const card = screen.getByRole("region", { name: "Change an item type" });
    expect(await within(card).findByText("Story → Request")).toBeInTheDocument();
    expect(within(card).getByText("Story", { selector: ".line-through" })).toBeInTheDocument();
    expect(within(card).getByText(/The developer pack ships this type\. It can be renamed/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Save type" })).toBeEnabled();
  });

  it("shows what the channel would refuse as the refusal, and offers no press", async () => {
    const refusal = "“Story” comes from the developer pack. You can rename it; its fields and whether it holds other items are the pack's.";
    const story = { label: "Story", plural: "Stories", slug: "story", container: false, fields: [] };
    draw(message({ kind: "itemTypeUpdate", outcome: null }), {
      kind: "itemTypeUpdate",
      itemTypeId: "t-story",
      projectName: "Shop",
      packSlug: "developer",
      itemCount: 4,
      problem: refusal,
      before: story,
      after: { ...story, container: true },
    });

    const card = screen.getByRole("region", { name: "Change an item type" });
    expect(await within(card).findByRole("note", { name: "Refused" })).toHaveTextContent(refusal);
    expect(within(card).getByRole("button", { name: "Save type" })).toBeDisabled();
  });

  it("says how many items a type to delete holds, and shows a refusal filed for a press", async () => {
    const refused = "“Case” was not deleted: “Case” has 1 item of it. Change its type or delete it before removing the type.";
    draw(message({ kind: "itemTypeDelete", outcome: { done: false, said: refused } }), {
      kind: "itemTypeDelete",
      itemTypeId: "t-case",
      projectName: "Shop",
      packSlug: "local",
      itemCount: 1,
      problem: "“Case” has 1 item of it. Change its type or delete it before removing the type.",
      type: CASE,
    });

    const card = screen.getByRole("region", { name: "Delete an item type" });
    expect(await within(card).findByText("Not deleted")).toBeInTheDocument();
    expect(within(card).getByRole("status")).toHaveTextContent(refused);
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("offers Delete type for a type nothing is filed under", async () => {
    draw(message({ kind: "itemTypeDelete", outcome: null }), {
      kind: "itemTypeDelete",
      itemTypeId: "t-case",
      projectName: "Shop",
      packSlug: "local",
      itemCount: 0,
      problem: null,
      type: CASE,
    });

    const card = screen.getByRole("region", { name: "Delete an item type" });
    expect(await within(card).findByText(/Removes the item type “Case” from Shop\. No items are of it\./)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Delete type" })).toBeEnabled();
  });
});

/** Keeping one's own pipeline and skipping a held template update (EO-534). */
describe("a card for keeping my pipeline", () => {
  const KEEP = {
    kind: "pipelineKeepMine",
    pipelineId: "default",
    pipelineName: "Delivery",
    held: { templateTitle: "Software feature to merge", fromVersion: "1.0", toVersion: "1.1" },
  } as const;

  it("says the pipeline stays as it is and which update it skips, and Keep my pipeline goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "pipelineKeepMine", outcome: null }), KEEP, {
      "assist:applyCard": { applied: true, problem: null, said: "Kept Delivery as it is and skipped the template update to 1.1.", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "Keep my pipeline" });
    expect(await within(card).findByText(/Keeps Delivery exactly as it is and skips the Software feature to merge template's update from 1.0 to 1.1/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Keep my pipeline" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "pipeline:keepOwnVersion")).toEqual([]);
  });

  it("cannot be pressed once the update is no longer held", async () => {
    draw(message({ kind: "pipelineKeepMine", outcome: null }), { ...KEEP, held: null });

    expect(await screen.findByText("Delivery has no template update waiting any more, so there is nothing to skip.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep my pipeline" })).toBeDisabled();
  });

  it("shows what came of it once pressed", async () => {
    draw(message({ kind: "pipelineKeepMine", outcome: { done: true, said: "Kept Delivery as it is and skipped the template update to 1.1." } }), KEEP);

    expect(await screen.findByText("Kept Delivery as it is and skipped the template update to 1.1.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep my pipeline" })).toBeNull();
  });
});
