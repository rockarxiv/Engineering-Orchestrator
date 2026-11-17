import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
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

  it("marks what a change moves, and says what of a pack's type may change", async () => {
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
    const refusal = "“Story” comes from the developer pack, so whether it holds other items is the pack's. You can rename it and add optional fields of your own.";
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

/** Jobs (EO-786): made, changed and deleted on a card, and a webhook job's two buttons. */
describe("a card for a job", () => {
  const LINES = [
    { label: "Name", value: "Monday report" },
    { label: "Trigger", value: "Mondays at 08:00, Europe/Berlin — a missed time is still run within 180 minutes" },
    { label: "Pipeline", value: "Delivery" },
    { label: "Template type", value: "developer:story" },
    { label: "Title", value: "Report for {{date}}" },
    { label: "Budget per run", value: "$1.50" },
    { label: "Runs on", value: "This machine" },
  ];
  const CREATE: AssistCardDetail = { kind: "jobCreate", projectName: "Shop", name: "Monday report", lines: LINES, created: null };

  it("shows the job as it would be, and Create job goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "jobCreate", outcome: null }), CREATE, {
      "assist:applyCard": { applied: true, problem: null, said: "Created the job “Monday report” (job j-1).", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "Create a job" });
    expect(await within(card).findByText("A new job on Shop, as it would be.")).toBeInTheDocument();
    const shown = within(card).getByLabelText("The job");
    expect(shown).toHaveTextContent("TriggerMondays at 08:00, Europe/Berlin");
    expect(shown).toHaveTextContent("Template typedeveloper:story");
    expect(shown).toHaveTextContent("Budget per run$1.50");
    expect(shown).toHaveTextContent("Runs onThis machine");

    fireEvent.click(within(card).getByRole("button", { name: "Create job" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "jobs:create")).toEqual([]);
  });

  it("links the job it made once pressed, with what was said, and offers no button", async () => {
    const said = "Created the job “Monday report” (job j-1). Entry rules are checked when it fires.";
    draw(message({ kind: "jobCreate", outcome: { done: true, said } }), { ...CREATE, created: { jobId: "j-1", name: "Monday report" } });

    expect(await screen.findByRole("link", { name: "Open Monday report" })).toHaveAttribute("href", "/jobs/j-1");
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create job" })).toBeNull();
  });

  it("shows a refusal once pressed, and no link", async () => {
    draw(message({ kind: "jobCreate", outcome: { done: false, said: "“Monday report” was not created: That pipeline no longer exists." } }), CREATE);

    expect(await screen.findByText("“Monday report” was not created: That pipeline no longer exists.")).toBeInTheDocument();
    expect(screen.getByText("Not created")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists each change as old → new, and Save job goes through assist:applyCard", async () => {
    const { calls, onDone } = draw(
      message({ kind: "jobUpdate", outcome: null }),
      { kind: "jobUpdate", jobId: "j-1", jobName: "Nightly", changes: [{ label: "Budget per run", before: "$2.00", after: "None" }] },
      { "assist:applyCard": { applied: true, problem: null, said: "Saved the job “Nightly”.", conversation: {} } },
    );

    const changes = await screen.findByLabelText("What changes");
    expect(changes).toHaveTextContent("Budget per run$2.00→None");
    expect(within(changes).getByText("$2.00")).toHaveClass("line-through");

    fireEvent.click(screen.getByRole("button", { name: "Save job" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
  });

  it("asks whether to keep or archive the job's items, and Delete job sends that choice", async () => {
    const { calls, onDone } = draw(
      message({ kind: "jobDelete", outcome: null }),
      { kind: "jobDelete", jobId: "j-1", jobName: "Nightly", lines: LINES, itemCount: 3 },
      { "assist:applyCard": { applied: true, problem: null, said: "Deleted the job “Nightly”.", conversation: {} } },
    );

    const choice = await screen.findByRole("radiogroup", { name: "What happens to the job's items" });
    fireEvent.click(within(choice).getByRole("radio", { name: "Archive them" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete job" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {}, archiveItems: true }]);
  });

  it("keeps the items unless the person says otherwise", async () => {
    const { calls, onDone } = draw(
      message({ kind: "jobDelete", outcome: null }),
      { kind: "jobDelete", jobId: "j-1", jobName: "Nightly", lines: LINES, itemCount: 3 },
      { "assist:applyCard": { applied: true, problem: null, said: "Deleted the job “Nightly”.", conversation: {} } },
    );

    expect(await screen.findByRole("radiogroup", { name: "What happens to the job's items" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete job" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {}, archiveItems: false }]);
  });

  it("says a new secret stops the old one working the moment it is pressed", async () => {
    draw(message({ kind: "jobWebhook", outcome: null }), { kind: "jobWebhook", jobId: "j-2", jobName: "Helpdesk", action: "regenerateSecret", address: "/webhooks/helpdesk", filed: null });

    expect(await screen.findByText("The old secret stops working the moment the button is pressed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate secret" })).toBeEnabled();
  });

  it("shows a test event's outcome and links the item it filed", async () => {
    const said = "Sent a test event to “Helpdesk”: it was accepted and filed an item. It filed SUP-7 (item i-7).";
    draw(message({ kind: "jobWebhook", outcome: { done: true, said } }), {
      kind: "jobWebhook",
      jobId: "j-2",
      jobName: "Helpdesk",
      action: "testEvent",
      address: "/webhooks/helpdesk",
      filed: { itemId: "i-7", itemKey: "SUP-7" },
    });

    expect(await screen.findByRole("link", { name: "SUP-7" })).toHaveAttribute("href", "/items/i-7");
    expect(screen.getByText(said)).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });
});

describe("a card for a command-line tool (EO-822)", () => {
  const ADD: AssistCardDetail = {
    kind: "cliToolAdd",
    name: "GitHub CLI",
    command: "gh",
    description: "Pull requests and issues on GitHub.",
    detection: { found: true, path: "/usr/bin/gh", version: "gh version 2.63.0" },
    problem: null,
  };
  const ATTACH: AssistCardDetail = {
    kind: "cliToolAttach",
    agentId: "a-1",
    agentName: "Implementer",
    cliToolId: "c-1",
    cliToolName: "GitHub CLI",
    command: "gh",
    attached: true,
    current: false,
    archived: false,
  };

  it("shows the CLI and whether this machine has it, and Add CLI goes through assist:applyCard alone", async () => {
    const { calls, onDone } = draw(message({ kind: "cliToolAdd", outcome: null }), ADD, {
      "assist:applyCard": { applied: true, problem: null, said: "Added the command-line tool “GitHub CLI” (`gh`, id: c-1) to the catalogue.", conversation: {} },
    });

    const card = screen.getByRole("region", { name: "Add a command-line tool" });
    const shown = await within(card).findByLabelText("The command-line tool");
    expect(shown).toHaveTextContent("Commandgh");
    expect(shown).toHaveTextContent("DescriptionPull requests and issues on GitHub.");
    expect(shown).toHaveTextContent("On this machineFound at /usr/bin/gh · gh version 2.63.0");

    fireEvent.click(within(card).getByRole("button", { name: "Add CLI" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "cliTools:save")).toEqual([]);
  });

  it("re-reads the Agent tools screen's catalogue after Add CLI, and its ticks after Give CLI", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    try {
      const added = draw(message({ kind: "cliToolAdd", outcome: null }), ADD, { "assist:applyCard": { applied: true, problem: null, said: "Added.", conversation: {} } });
      await screen.findByLabelText("The command-line tool");
      fireEvent.click(screen.getByRole("button", { name: "Add CLI" }));
      await waitFor(() => expect(added.onDone).toHaveBeenCalled());
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cliTools"] });
      cleanup();

      const given = draw(message({ kind: "cliToolAttach", outcome: null }), ATTACH, { "assist:applyCard": { applied: true, problem: null, said: "Gave.", conversation: {} } });
      await screen.findByText("GitHub CLI · Implementer");
      fireEvent.click(screen.getByRole("button", { name: "Give CLI" }));
      await waitFor(() => expect(given.onDone).toHaveBeenCalled());
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agentCliTools"] });
    } finally {
      invalidate.mockRestore();
    }
  });

  it("says a command not found here, and shows a refusal the save would meet with the button off", async () => {
    draw(message({ kind: "cliToolAdd", outcome: null }), { ...ADD, detection: { found: false }, problem: '"GitHub CLI" already runs `gh` (id: c-1).' });

    expect(await screen.findByText("Not found")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "Refused" })).toHaveTextContent('"GitHub CLI" already runs `gh`');
    expect(screen.getByRole("button", { name: "Add CLI" })).toBeDisabled();
  });

  it("gives an agent a CLI through assist:applyCard, never agentCliTools:set", async () => {
    const { calls, onDone } = draw(message({ kind: "cliToolAttach", outcome: null }), ATTACH, {
      "assist:applyCard": { applied: true, problem: null, said: "Gave Implementer “GitHub CLI”.", conversation: {} },
    });

    expect(await screen.findByText("GitHub CLI · Implementer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Give CLI" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyCard")).toEqual([{ conversationId: "conv-1", messageId: "card-1", choices: {} }]);
    expect(sent(calls, "agentCliTools:set")).toEqual([]);
  });

  it("turns the button off when the agent already is as the card asks", async () => {
    draw(message({ kind: "cliToolAttach", outcome: null }), { ...ATTACH, attached: false, current: false });

    expect(await screen.findByText("Implementer does not have it, so there is nothing to change.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take CLI away" })).toBeDisabled();
  });
});
