import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscussionMessage, ModuleReadinessCheck, ModuleView } from "@eo/core";
import { setBridge } from "../../ipc/bridge";
import { ipcStub, renderSection, sent, type Answers, type Call } from "../views/settings/org/testing";
import { DraftModuleRow } from "./DraftModuleRow";
import { ModuleChangeCard } from "./ModuleChangeCard";
import { ModuleProposal } from "./ModuleProposal";

/**
 * A module's readiness on this device, on the cards it is proposed,
 * changed and drafted on (EO-817): every declared CLI and variable at
 * once, beside approval and never part of it, with the secure editors to
 * set what is missing, Recheck, install guidance, and "unknown" where the
 * device or the scope cannot be inspected.
 */

const SECRET = "tok-9f2e-typed-into-the-box";

function module(overrides: Partial<ModuleView> = {}): ModuleView {
  return {
    id: "mod-1",
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the release.",
    code: "export default async (ctx) => { await ctx.exec('aws', ['deploy']); return { ok: true, result: 'deployed' }; };",
    manifest: {
      name: "Deploy",
      description: "Deploys the release.",
      inputs: {},
      needs: { bin: ["aws", "gh"], env: ["DEPLOY_TOKEN", "AWS_REGION"], network: true, item: false, comment: false, attach: false, create: false },
      results: ["deployed"],
    },
    originalScript: null,
    source: "architect",
    approvedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    usedByStepCount: 0,
    portability: [],
    machineSpecific: [],
    testRun: null,
    testsStale: false,
    testCount: 1,
    ...overrides,
  };
}

function check(overrides: Partial<ModuleReadinessCheck> = {}): ModuleReadinessCheck {
  return {
    device: "anna-laptop",
    platform: "darwin",
    scope: { kind: "shared" },
    readiness: {
      ready: false,
      bin: [
        { name: "aws", status: "missing" },
        { name: "gh", status: "found" },
      ],
      env: [
        { name: "DEPLOY_TOKEN", status: "unset" },
        { name: "AWS_REGION", status: "unset" },
      ],
    },
    unknownBins: [],
    introduced: { bin: [], env: [] },
    searched: ["/opt/homebrew/bin", "/usr/bin"],
    steps: [],
    ...overrides,
  };
}

const READY = check({
  readiness: {
    ready: true,
    bin: [
      { name: "aws", status: "found" },
      { name: "gh", status: "found" },
    ],
    env: [
      { name: "DEPLOY_TOKEN", status: "set" },
      { name: "AWS_REGION", status: "set" },
    ],
  },
});

/** Read channels the card may call; anything else would be the card doing something. */
const READS = new Set(["modules:list", "moduleTests:list", "modules:readiness", "moduleSecrets:list", "environmentVariables:list"]);

function install(answers: Answers) {
  const stub = ipcStub({ "moduleTests:list": { tests: [], problem: null }, "moduleSecrets:list": { names: [], overrides: [], organisation: [], references: [], stored: { shared: [], step: [] } }, "environmentVariables:list": { variables: [] }, ...answers });
  window.eo.ipc.invoke = stub.invoke as never;
  return stub;
}

function channels(calls: Call[]): string[] {
  return [...new Set(calls.map((call) => call.channel))];
}

afterEach(() => setBridge(undefined));

describe("a new module's card", () => {
  it("lists every declared CLI and variable, with all the missing ones together, on the named device and scope", async () => {
    const { calls } = install({ "modules:list": { modules: [module()] }, "modules:readiness": { check: check(), problem: null } });
    renderSection(<ModuleProposal slug="deploy" />);

    const list = await screen.findByRole("list", { name: "What Deploy needs on this device" });
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringMatching(/CLI\s*aws.*Not installed/),
      expect.stringMatching(/CLI\s*gh.*Installed/),
      expect.stringMatching(/Variable\s*DEPLOY_TOKEN.*Not set/),
      expect.stringMatching(/Variable\s*AWS_REGION.*Not set/),
    ]);
    expect(screen.getByText("Not ready on this device")).toBeInTheDocument();
    expect(screen.getByText("anna-laptop")).toBeInTheDocument();
    expect(screen.getByText(/the shared values every step falls back to/)).toBeInTheDocument();
    expect(sent(calls, "modules:readiness")).toEqual([{ moduleId: "mod-1", stepId: null, change: null }]);
  });

  it("can be Approved and Not ready at once, and an unready module can still be approved", async () => {
    const { calls } = install({
      "modules:list": { modules: [module()] },
      "modules:readiness": { check: check(), problem: null },
      "modules:approve": { approved: true, problem: null, lineCoverage: 90, coverageAcknowledgementNeeded: false, machineSpecific: [] },
    });
    renderSection(<ModuleProposal slug="deploy" />);

    await screen.findByText("Not ready on this device");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(calls, "modules:approve")).toEqual([{ id: "mod-1", acknowledgeLowCoverage: false }]));
  });

  it("shows Approved beside Not ready on this device", async () => {
    install({ "modules:list": { modules: [module({ approvedAt: 5 })] }, "modules:readiness": { check: check(), problem: null } });
    renderSection(<ModuleProposal slug="deploy" />);

    expect(await screen.findByText("Not ready on this device")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("gives install guidance for a missing CLI, and checking it calls nothing but reads", async () => {
    const { calls } = install({ "modules:list": { modules: [module()] }, "modules:readiness": { check: check(), problem: null } });
    renderSection(<ModuleProposal slug="deploy" />);

    const guidance = await screen.findByLabelText("How to install the missing CLIs");
    expect(guidance).toHaveTextContent("EO never installs software. Install aws yourself");
    expect(guidance).toHaveTextContent("Homebrew");
    expect(guidance).toHaveTextContent("/opt/homebrew/bin");
    expect(channels(calls).every((channel) => READS.has(channel))).toBe(true);
  });

  it("sets a missing value through the secure editor in the named scope, never anywhere else, and asks again", async () => {
    const readiness = { answer: check() };
    const { calls } = install({
      "modules:list": { modules: [module()] },
      "modules:readiness": () => ({ check: readiness.answer, problem: null }),
      "moduleSecrets:set": () => {
        readiness.answer = check({ readiness: { ...check().readiness, env: [{ name: "DEPLOY_TOKEN", status: "set" }, { name: "AWS_REGION", status: "unset" }] } });
        return { saved: true, problem: null, replaced: null };
      },
    });
    renderSection(<ModuleProposal slug="deploy" />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up the 2 missing values" }));
    const setup = screen.getByRole("region", { name: "Set up Deploy" });
    expect(setup).toHaveTextContent("Setting the shared values on anna-laptop");
    expect(setup).toHaveTextContent("never into this conversation");
    const box = within(setup).getByLabelText("Value for DEPLOY_TOKEN");
    expect(box).toHaveAttribute("type", "password");
    fireEvent.change(box, { target: { value: SECRET } });
    fireEvent.click(within(setup).getByRole("button", { name: "Save DEPLOY_TOKEN" }));

    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "DEPLOY_TOKEN", value: SECRET, stepId: null }]));
    // Saving made the checklist ask again, and it follows the answer.
    await waitFor(() => expect(sent(calls, "modules:readiness").length).toBeGreaterThan(1));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "What Deploy needs on this device" })).getAllByRole("listitem")[2]).toHaveTextContent(/DEPLOY_TOKEN.*Set/));
    // The value went to one channel and nowhere else.
    expect(calls.filter((call) => JSON.stringify(call.payload ?? null).includes(SECRET)).map((call) => call.channel)).toEqual(["moduleSecrets:set"]);
  });

  it("offers the plain-variable editor too, in the same scope", async () => {
    const { calls } = install({
      "modules:list": { modules: [module()] },
      "modules:readiness": { check: check(), problem: null },
      "environmentVariables:set": { saved: true, problem: null },
    });
    renderSection(<ModuleProposal slug="deploy" />);

    fireEvent.click(await screen.findByRole("button", { name: "Set up the 2 missing values" }));
    fireEvent.click(screen.getByRole("radio", { name: "As a plain variable" }));
    const setup = screen.getByRole("region", { name: "Set up Deploy" });
    fireEvent.change(await within(setup).findByLabelText("Value of variable AWS_REGION"), { target: { value: "eu-west-1" } });
    fireEvent.click(within(setup).getByRole("button", { name: "Save variable AWS_REGION" }));

    await waitFor(() => expect(sent(calls, "environmentVariables:set")).toEqual([{ name: "AWS_REGION", value: "eu-west-1", stepId: null }]));
  });

  it("checks and sets up one published step's own values when that scope is picked", async () => {
    const steps = [{ stepId: "step-1", name: "Staging", pipelineName: "Ship" }];
    const { calls } = install({
      "modules:list": { modules: [module()] },
      "modules:readiness": (payload: unknown) => {
        const stepId = (payload as { stepId: string | null }).stepId;
        return { check: check({ steps, ...(stepId === null ? {} : { scope: { kind: "step", step: steps[0]! } }) }), problem: null };
      },
      "moduleSecrets:set": { saved: true, problem: null, replaced: null },
    });
    renderSection(<ModuleProposal slug="deploy" />);

    fireEvent.change(await screen.findByLabelText("Scope to check Deploy in"), { target: { value: "step-1" } });
    expect(await screen.findByText(/Ship › Staging, its own values over the shared ones/)).toBeInTheDocument();
    expect(sent(calls, "modules:readiness")).toContainEqual({ moduleId: "mod-1", stepId: "step-1", change: null });

    fireEvent.click(screen.getByRole("button", { name: "Set up the 2 missing values" }));
    const setup = screen.getByRole("region", { name: "Set up Deploy" });
    expect(setup).toHaveTextContent("Setting Staging's own values on anna-laptop");
    fireEvent.change(within(setup).getByLabelText("Value for DEPLOY_TOKEN"), { target: { value: SECRET } });
    fireEvent.click(within(setup).getByRole("button", { name: "Save DEPLOY_TOKEN" }));
    await waitFor(() => expect(sent(calls, "moduleSecrets:set")).toEqual([{ name: "DEPLOY_TOKEN", value: SECRET, stepId: "step-1" }]));
  });

  it("Recheck asks again and shows a CLI installed since, without saving or approving anything", async () => {
    const readiness = { answer: check() };
    const { calls } = install({ "modules:list": { modules: [module({ approvedAt: 5 })] }, "modules:readiness": () => ({ check: readiness.answer, problem: null }) });
    renderSection(<ModuleProposal slug="deploy" />);

    await screen.findByText("Not ready on this device");
    readiness.answer = READY;
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));

    expect(await screen.findByText("Ready on this device")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(sent(calls, "modules:readiness")).toHaveLength(2);
    expect(channels(calls).every((channel) => READS.has(channel))).toBe(true);
  });

  it("says a CLI found from a run's directory is unknown rather than ready", async () => {
    install({
      "modules:list": { modules: [module()] },
      "modules:readiness": { check: check({ readiness: { ready: false, bin: [], env: [] }, unknownBins: ["./tools/deploy"] }), problem: null },
    });
    renderSection(<ModuleProposal slug="deploy" />);

    expect(await screen.findByText(/Unknown — a relative path/)).toBeInTheDocument();
    expect(screen.getByText("Readiness unknown")).toBeInTheDocument();
    expect(screen.queryByText("Ready on this device")).not.toBeInTheDocument();
  });

  it("says it cannot tell in a browser served by the organisation's server, and does not ask", async () => {
    const stub = ipcStub({ "modules:list": { modules: [module()] }, "moduleTests:list": { tests: [], problem: null } });
    setBridge({ invoke: stub.invoke as never, machineAvailable: false, subscribe: () => () => {}, subscribeRefetch: () => () => {} });
    renderSection(<ModuleProposal slug="deploy" />);

    expect(await screen.findByText("Readiness unknown")).toBeInTheDocument();
    expect(screen.getByText(/served by the organisation's server/)).toBeInTheDocument();
    expect(screen.queryByText("Ready on this device")).not.toBeInTheDocument();
    expect(sent(stub.calls, "modules:readiness")).toEqual([]);
  });
});

describe("a change card", () => {
  function message(overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
    return {
      id: "card-1",
      authorType: "agent",
      authorName: "Assistant",
      body: "**Proposed change to Deploy** (`deploy`)",
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

  it("shows what the update adds, and its readiness, before Apply", async () => {
    const proposed = check({
      readiness: { ready: false, bin: [...check().readiness.bin, { name: "jq", status: "missing" }], env: [...check().readiness.env, { name: "SLACK_WEBHOOK", status: "unset" }] },
      introduced: { bin: ["jq"], env: ["SLACK_WEBHOOK"] },
    });
    const { calls } = install({ "modules:list": { modules: [module({ approvedAt: 5 })] }, "modules:readiness": { check: proposed, problem: null } });
    renderSection(<ModuleChangeCard message={message()} conversationId="conv-1" onDone={vi.fn()} />);

    const list = await screen.findByRole("list", { name: "What Deploy needs on this device" });
    expect(screen.getByText("On this device, if applied")).toBeInTheDocument();
    expect(sent(calls, "modules:readiness")).toEqual([{ moduleId: "mod-1", stepId: null, change: { conversationId: "conv-1", messageId: "card-1" } }]);
    const rows = within(list).getAllByRole("listitem");
    expect(rows.find((row) => row.textContent?.includes("jq"))).toHaveTextContent("New in this change");
    expect(rows.find((row) => row.textContent?.includes("SLACK_WEBHOOK"))).toHaveTextContent(/New in this change.*Not set/);
    expect(screen.getByLabelText("How to install the missing CLIs")).toHaveTextContent("Install aws, jq yourself");
    expect(screen.getByRole("button", { name: "Apply change" })).toBeEnabled();
  });

  it("follows the saved version once applied", async () => {
    const { calls } = install({ "modules:list": { modules: [module()] }, "modules:readiness": { check: check(), problem: null } });
    renderSection(
      <ModuleChangeCard
        message={message({ canApprove: false, approves: null, moduleChange: { moduleId: "mod-1", applied: true, describesSaved: true } })}
        conversationId="conv-1"
        onDone={vi.fn()}
      />,
    );

    await screen.findByRole("list", { name: "What Deploy needs on this device" });
    expect(screen.getByText("On this device")).toBeInTheDocument();
    expect(screen.getByText("Applied · not approved")).toBeInTheDocument();
    expect(sent(calls, "modules:readiness")).toEqual([{ moduleId: "mod-1", stepId: null, change: null }]);
  });
});

describe("a module on a pipeline draft", () => {
  it("checks the shared values and says the draft's own step values are unknown until it is published", async () => {
    install({ "modules:list": { modules: [module()] }, "modules:readiness": { check: check(), problem: null } });
    renderSection(<DraftModuleRow slug="deploy" />);

    expect(await screen.findByText("Not ready on this device")).toBeInTheDocument();
    expect(screen.getByText(/This draft's steps are not published yet, so whether one of them will set a value of its own is unknown/)).toBeInTheDocument();
  });
});
