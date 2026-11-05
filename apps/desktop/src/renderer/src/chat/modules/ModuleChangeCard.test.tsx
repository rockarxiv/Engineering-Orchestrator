import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DiscussionMessage, ModuleView } from "@eo/core";
import { ipcStub, renderSection, sent, type Answers } from "../views/settings/org/testing";
import { ModuleChangeCard } from "./ModuleChangeCard";

/**
 * A change to a module that exists, as the help chat shows it (EO-418):
 * the diff EO drew, Apply while nothing is saved, and Approve once it
 * has been.
 *
 * Which button the card offers is decided in `useModuleChangeCard`; the
 * card draws what it decided.
 */

const BODY = "**Proposed change to Deploy** (`deploy`)\n\nStops asking for two variables.\n\n**Manifest**\n\n```diff\n-      \"AWS_PROFILE\",\n```\n\nNothing is saved until you apply it.";

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-1",
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the release.",
    code: "export default async () => ({ ok: true, result: 'deployed' });",
    manifest: {
      name: "Deploy",
      description: "Deploys the release.",
      inputs: {},
      needs: { bin: ["aws"], env: ["DEPLOY_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
      results: ["deployed"],
    },
    originalScript: null,
    source: "user",
    approvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    usedByStepCount: 1,
    portability: [],
    machineSpecific: [],
    testRun: null,
    testsStale: false,
    testCount: 1,
    ...overrides,
  };
}

function message(overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "card-1",
    authorType: "agent",
    authorName: "Assistant",
    body: BODY,
    attachments: [],
    kind: "decision",
    parentId: null,
    runId: "run-1",
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: true,
    approves: "moduleChange",
    moduleSlug: null,
    moduleChange: { moduleId: "mod-1", applied: false, describesSaved: false },
    proposedType: null,
    status: null,
    ...overrides,
  };
}

const APPLIED = message({ canApprove: false, approves: null, moduleChange: { moduleId: "mod-1", applied: true, describesSaved: true } });

type Card = (props: { message: DiscussionMessage; conversationId: string; onDone: () => void }) => ReactElement;

function draw(Card: Card, card: DiscussionMessage, modules: ModuleView[], answers: Answers = {}) {
  const catalog = { modules };
  const stub = ipcStub({ "modules:list": () => ({ modules: catalog.modules }), ...answers });
  window.eo.ipc.invoke = stub.invoke as never;
  const onDone = vi.fn();
  renderSection(<Card message={card} conversationId="conv-1" onDone={onDone} />);
  return { calls: stub.calls, catalog, onDone };
}

describe.each([
  ["the chat layout", ModuleChangeCard as Card],
])("a proposed change to an existing module, in %s", (_layout, Card) => {
  it("shows the diff and offers Apply, which goes through assist:applyChange and nothing else", async () => {
    const { calls, onDone } = draw(Card, message(), [module({ approvedAt: 5 })], {
      "assist:applyChange": { applied: true, problem: null, conversation: {} },
    });

    expect(screen.getByRole("region", { name: "Proposed module change" })).toBeInTheDocument();
    expect(screen.getByText(/Stops asking for two variables/)).toBeInTheDocument();
    expect(screen.getByText(/"AWS_PROFILE"/)).toBeInTheDocument();
    // Nothing is approved from a card that has not been applied.
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(calls, "assist:applyChange")).toEqual([{ conversationId: "conv-1", messageId: "card-1" }]);
    expect(sent(calls, "assist:approve")).toEqual([]);
    expect(sent(calls, "modules:approve")).toEqual([]);
  });

  it("says why under the card when Apply is refused", async () => {
    draw(Card, message(), [module()], {
      "assist:applyChange": { applied: false, problem: "Deploy's code has changed since this was proposed, so applying it would overwrite that edit.", conversation: {} },
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Deploy's code has changed since this was proposed");
  });

  it("offers Approve once applied, through the approval Settings → Modules uses", async () => {
    const { calls, catalog } = draw(Card, APPLIED, [module()], {
      "modules:approve": () => {
        catalog.modules = [module({ approvedAt: 9 })];
        return { approved: true, problem: null, lineCoverage: 90, coverageAcknowledgementNeeded: false };
      },
    });

    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByRole("button", { name: "Apply change" })).not.toBeInTheDocument();
    expect(screen.getByText(/Approving runs its tests/)).toBeInTheDocument();

    fireEvent.click(approve);

    await waitFor(() => expect(sent(calls, "modules:approve")).toEqual([{ id: "mod-1", acknowledgeLowCoverage: false }]));
    // Read back from the catalog: approved, and nothing left to press.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
  });

  // EO-449: what the applied change saved, named where it is, beside Approve rather than in its way.
  it("shows the saved module's machine-specific values once applied, and still offers Approve", async () => {
    const machineSpecific = [{ where: { in: "code" as const, line: 4 }, text: "/Users/dev/deploy", kind: "machine_path" as const, instead: "use ctx.cwd for the step's working directory, or take the path as a step input" }];
    draw(Card, APPLIED, [module({ machineSpecific })]);

    expect(await screen.findByRole("note", { name: "Machine-specific values" })).toHaveTextContent("code line 4: /Users/dev/deploy — use ctx.cwd");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("says nothing about the saved module's values before the change is applied", async () => {
    const machineSpecific = [{ where: { in: "code" as const, line: 4 }, text: "/Users/dev/deploy", kind: "machine_path" as const, instead: "use ctx.cwd" }];
    draw(Card, message(), [module({ machineSpecific })]);

    expect(await screen.findByRole("button", { name: "Apply change" })).toBeInTheDocument();
    expect(screen.queryByRole("note", { name: "Machine-specific values" })).not.toBeInTheDocument();
  });

  it("names each failing case when the approval is refused, and stays unapproved", async () => {
    draw(Card, APPLIED, [module()], {
      "modules:approve": {
        approved: false,
        problem: '"Deploy" was not approved: 1 of 2 test cases failed.\n- retries a failed deploy: expected a failed deploy to be retried',
        lineCoverage: 70,
        coverageAcknowledgementNeeded: false,
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 of 2 test cases failed");
    expect(alert).toHaveTextContent("- retries a failed deploy: expected a failed deploy to be retried");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("offers no Approve over a module that has been approved since", async () => {
    const approved = draw(Card, APPLIED, [module({ approvedAt: 9 })]);
    await waitFor(() => expect(sent(approved.calls, "modules:list")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/approved/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says the module has moved on when it was changed again after this was applied", async () => {
    draw(Card, message({ canApprove: false, approves: null, moduleChange: { moduleId: "mod-1", applied: true, describesSaved: false } }), [module()]);

    expect(await screen.findByText(/has been changed again since, so this card no longer describes it/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says so when the module has been deleted since", async () => {
    draw(Card, APPLIED, [module({ archivedAt: 12 })]);

    expect(await screen.findByText(/the module has been deleted since/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("keeps the diff and offers nothing once a newer card has taken its place unapplied", async () => {
    const { calls } = draw(Card, message({ canApprove: false, approves: null }), [module()]);

    await waitFor(() => expect(sent(calls, "modules:list")).toHaveLength(1));
    expect(screen.getByText(/Stops asking for two variables/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply change" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
