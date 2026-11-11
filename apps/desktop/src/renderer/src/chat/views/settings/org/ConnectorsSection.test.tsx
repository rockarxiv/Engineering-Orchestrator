import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { RepositoryView } from "@eo/core";
import { SECTION_LOCK_TEXT } from "@eo/core";
import { describe, expect, it } from "vitest";
import { ConnectorsSection } from "../sections/ConnectorsSection";
import { renderSection, sent, ipcStub, type Answers } from "./testing";

/** The shared stub, installed where only a test may put it. */
function stubIpc(answers?: Answers) {
  const stub = ipcStub(answers);
  window.eo.ipc.invoke = stub.invoke as never;
  return stub.calls;
}

/**
 * Settings → Connectors in the chat layout (EO-315, KAN-22, J-01, J-04,
 * J-05): the connector list with the lock line and no fence, the Jira
 * sites, the repository's mirror and its status map, transition fields
 * only once Jira has asked, and the pull interval.
 */

const KEYCHAIN = { available: true, backend: "gnome_libsecret", weak: false, warning: null };

const SLACK = {
  serverId: "019fb8c6-0000-7000-8000-0000000000a1",
  serverName: "slack",
  label: "Slack",
  capability: "reads and posts in your Slack channels",
  setup: "token",
  secretNames: ["SLACK_BOT_TOKEN"],
  secretsSet: [],
  connected: false,
  problem: "Slack is not connected yet — EO still needs SLACK_BOT_TOKEN.",
  deliverable: true,
};

const SITE = { id: "c1", name: "acme", baseUrl: "https://acme.atlassian.net", flavour: "cloud", email: "me@acme.com", credentialsConfigured: true, projectCount: 1 };

function repository(jira: Partial<RepositoryView["jira"]> = {}, id = "p1", name = "acme-api") {
  return {
    id,
    name,
    keyPrefix: "ACME",
    repoPath: "/tmp/acme",
    baseBranch: "main",
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    itemCount: 0,
    forge: { openPr: false, kind: null, remote: "origin", draft: false, templatePath: null, reviewers: [] },
    jira: {
      baseUrl: "https://acme.atlassian.net",
      flavour: "cloud",
      projectKey: "ACME",
      email: null,
      featureIssueType: "Epic",
      storyIssueType: "Story",
      fields: null,
      createByDefault: true,
      credentialsConfigured: true,
      statusMap: { ready_to_merge: "Done" },
      transitionFields: null,
      ...jira,
    },
  };
}

interface Fixture {
  repositories?: unknown[];
  repositoryIds?: string[];
  pipelines?: unknown[];
  stepsByPipeline?: Record<string, unknown[]>;
  answers?: Record<string, unknown>;
}

function mockIpc(fixture: Fixture = {}) {
  const repositories = fixture.repositories ?? [repository()];
  return stubIpc({
    "connectors:list": { connectors: [SLACK], keychain: KEYCHAIN },
    "jiraConnections:list": { connections: [SITE] },
    "projects:list": {
      projects: [{ id: "b1", name: "repo", keyPrefix: "EO", jiraProjectId: "p1", repositoryIds: fixture.repositoryIds ?? ["p1"], itemCount: 0 }],
      activeProjectId: "b1",
    },
    "repositories:list": { repositories },
    "pipelines:list": {
      pipelines: fixture.pipelines ?? [{ id: "default", projectId: null, name: "Delivery", icon: null, entryStepId: "ready_to_merge", position: 0, archivedAt: null }],
    },
    "pipelineSteps:list": (payload: unknown) => {
      const pipelineId = (payload as { pipelineId: string }).pipelineId;
      const steps = fixture.stepsByPipeline?.[pipelineId] ?? [
        { id: "ready_to_merge", pipelineId, position: 5, name: "Done", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
      ];
      return { steps, routes: [], entryStepId: null };
    },
    "jira:fields": { fields: [], problem: null },
    "jira:statuses": { statuses: ["To Do", "Done"], problem: null },
    "jira:outbox": { pending: 0, failing: 0 },
    "jira:saveTransitionFields": { ok: true, problem: null },
    "jira:saveStatusMap": { ok: true, problem: null },
    "settings:get": { doNotDisturb: false, archiveAfterDays: 14, jiraPullMinutes: 5, branchPrefix: "eo" },
    ...fixture.answers,
  });
}

const draw = () => renderSection(<ConnectorsSection />);

describe("the connector list", () => {
  it("lists every connector the installation has, red with why, and asks for no role", async () => {
    const calls = mockIpc();
    draw();

    expect(await screen.findByText(/reads and posts in your Slack channels/)).toHaveClass("text-danger");
    expect(sent(calls, "connectors:list")[0]).toEqual({ role: null });
  });

  it("says the catalogue is managed and leaves signing in to it the person's", async () => {
    mockIpc({
      answers: {
        "sections:list": {
          published: [{ section: "connectors", subjectId: "", versionId: null, versionNumber: null, publishedAt: 1, publishedBy: "dana", publishedByName: "Dana", document: null }],
          locked: ["connectors"],
          lockText: SECTION_LOCK_TEXT,
        },
      },
    });
    draw();

    expect(await screen.findByTestId("managed-lock-connectors")).toHaveTextContent("Published by Dana.");
    // The line and not a fence.
    expect(await screen.findByRole("button", { name: "Connect" })).toBeEnabled();
  });
});

describe("Jira connections", () => {
  it("lists a site with whether a token is stored, never the token", async () => {
    mockIpc();
    draw();

    const list = within(await screen.findByRole("list", { name: "Jira connections" }));
    expect(list.getByText("acme")).toBeInTheDocument();
    expect(list.getByText("token stored")).toBeInTheDocument();
    expect(list.getByText(/1 repository$/)).toBeInTheDocument();
  });

  it("adds a cloud site with its email and token, and needs a token for a new one", async () => {
    const calls = mockIpc({ answers: { "jiraConnections:save": { ok: true, problem: null } } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Add a Jira connection" }));
    const form = within(screen.getByRole("region", { name: "Add Jira connection" }));
    fireEvent.change(form.getByLabelText("Jira URL"), { target: { value: "https://new.atlassian.net" } });
    fireEvent.change(form.getByLabelText("Email"), { target: { value: "me@new.com" } });
    expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(form.getByLabelText(/^API token/), { target: { value: " secret " } });
    fireEvent.click(form.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(sent(calls, "jiraConnections:save")).toEqual([{ name: "", baseUrl: "https://new.atlassian.net", flavour: "cloud", email: "me@new.com", token: "secret" }]),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Add Jira connection" })).not.toBeInTheDocument());
  });

  it("edits a site without asking for the token again, and sends no email for Data Center", async () => {
    const calls = mockIpc({ answers: { "jiraConnections:save": { ok: true, problem: null } } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const form = within(screen.getByRole("region", { name: "Edit acme" }));
    fireEvent.change(form.getByLabelText("Kind"), { target: { value: "datacenter" } });
    expect(form.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(form.getByLabelText(/^Personal access token/)).toHaveAttribute("placeholder", "leave blank to keep the stored one");
    fireEvent.click(form.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent(calls, "jiraConnections:save")).toEqual([{ id: "c1", name: "acme", baseUrl: "https://acme.atlassian.net", flavour: "datacenter", email: null }]));
  });

  it("says why a site could not be removed", async () => {
    mockIpc({ answers: { "jiraConnections:remove": { ok: false, problem: "Two repositories still use acme." } } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Two repositories still use acme.")).toBeInTheDocument();
  });
});

describe("a repository's Jira mirror", () => {
  it("connects a repository to a site that has a token", async () => {
    const calls = mockIpc({
      repositories: [repository({ credentialsConfigured: false, baseUrl: null })],
      answers: { "jira:connect": { ok: false, problem: "Jira has no project ACME." } },
    });
    draw();

    const form = within(await screen.findByRole("region", { name: "Connect to Jira" }));
    expect(form.getByRole("button", { name: "Connect" })).toBeDisabled();
    fireEvent.change(form.getByLabelText("Project key"), { target: { value: "acme" } });
    expect(form.getByLabelText("Project key")).toHaveValue("ACME");
    fireEvent.click(form.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(sent(calls, "jira:connect")).toEqual([{ projectKey: "ACME", featureIssueType: "Epic", storyIssueType: "Story", repositoryId: "p1", connectionId: "c1" }]),
    );
    expect(await form.findByText("Jira has no project ACME.")).toBeInTheDocument();
  });

  it("says to add a connection first when no site has a token", async () => {
    mockIpc({ repositories: [repository({ credentialsConfigured: false, baseUrl: null })], answers: { "jiraConnections:list": { connections: [] } } });
    draw();

    expect(await screen.findByText(/Add a Jira connection first/)).toBeInTheDocument();
  });

  it("names the repository it configures when the project spans more than one", async () => {
    mockIpc({ repositories: [repository(), repository({}, "p2", "acme-web")], repositoryIds: ["p1", "p2"] });
    draw();

    const picker = await screen.findByLabelText("Repository");
    expect(within(picker).getByRole("option", { name: "acme-web" })).toBeInTheDocument();
    expect(picker).toHaveValue("p1");
  });

  it("tests the connection and lists each check", async () => {
    mockIpc({ answers: { "jira:test": { steps: [{ name: "Reach the site", ok: true, detail: "200" }, { name: "Read ACME", ok: false, detail: "403 Forbidden" }] } } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    const check = within(await screen.findByRole("list", { name: "Connection check" }));
    expect(check.getByText("403 Forbidden")).toHaveClass("text-danger");
    expect(check.getByText("Reach the site")).toBeInTheDocument();
  });

  it("saves the required fields and whether features are created by default", async () => {
    const calls = mockIpc({
      answers: {
        "jira:fields": { fields: [{ id: "customfield_1", name: "Team", required: true, schemaType: "option", allowedValues: [{ id: "t1", value: "Platform" }] }], problem: null },
        "jira:saveConfig": { ok: true, problem: null },
      },
    });
    draw();

    fireEvent.change(await screen.findByLabelText("Team"), { target: { value: "t1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Create features in Jira by default" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Jira connection" })).getAllByRole("button", { name: "Save" })[0]!);

    await waitFor(() =>
      expect(sent(calls, "jira:saveConfig")).toEqual([
        { repositoryId: "p1", fields: { customfield_1: { id: "t1" } }, createByDefault: false, featureIssueType: "Epic", storyIssueType: "Story" },
      ]),
    );
  });

  it("disconnects the repository", async () => {
    const calls = mockIpc({ answers: { "jira:disconnect": { ok: true } } });
    draw();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(sent(calls, "jira:disconnect")).toEqual([{ repositoryId: "p1" }]));
  });
});

describe("the status map and transition fields (J-04, J-05)", () => {
  const RESOLUTION = {
    Done: {
      requires: [{ id: "resolution", name: "Resolution", schemaType: "resolution", allowedValues: [{ id: "10000", value: "Done" }] }],
      values: {},
    },
  };

  it("shows no transition fields until Jira has actually asked for something", async () => {
    mockIpc();
    draw();

    await screen.findByRole("group", { name: "Jira status map" });
    expect(screen.queryByRole("group", { name: "Jira transition fields" })).not.toBeInTheDocument();
  });

  it("offers the options Jira gave, says how many are unfilled, and saves against the status", async () => {
    const calls = mockIpc({ repositories: [repository({ transitionFields: RESOLUTION })] });
    draw();

    const fields = within(await screen.findByRole("group", { name: "Jira transition fields" }));
    expect(fields.getByText("Moving to Done")).toBeInTheDocument();
    expect(fields.getByText("1 to fill")).toBeInTheDocument();
    expect(fields.getByRole("option", { name: "Done" })).toBeInTheDocument();
    fireEvent.change(fields.getByLabelText("Resolution"), { target: { value: "10000" } });
    fireEvent.click(fields.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent(calls, "jira:saveTransitionFields")).toEqual([{ repositoryId: "p1", status: "Done", values: { resolution: { id: "10000" } } }]));
  });

  it("offers every pipeline's steps, grouped by pipeline, and saves the map", async () => {
    const calls = mockIpc({
      pipelines: [
        { id: "default", projectId: null, name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null },
        { id: "hotfix", projectId: null, name: "Hotfix", icon: null, entryStepId: "hx_build", position: 1, archivedAt: null },
      ],
      stepsByPipeline: {
        default: [{ id: "todo", pipelineId: "default", position: 0, name: "Build it", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false }],
        hotfix: [{ id: "hx_build", pipelineId: "hotfix", position: 0, name: "Ship it", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false }],
      },
    });
    draw();

    const map = within(await screen.findByRole("group", { name: "Jira status map" }));
    expect(await map.findByText("Hotfix")).toBeInTheDocument();
    fireEvent.change(await map.findByLabelText("Ship it"), { target: { value: "Done" } });
    expect(map.getByLabelText("Build it")).toHaveValue("");
    expect(map.getByText("Nothing waiting to send.")).toBeInTheDocument();
    fireEvent.click(map.getByRole("button", { name: "Save status map" }));

    await waitFor(() => expect(sent(calls, "jira:saveStatusMap")).toEqual([{ repositoryId: "p1", statusMap: { ready_to_merge: "Done", hx_build: "Done" } }]));
  });

  it("says a stuck queue is stuck", async () => {
    mockIpc({ answers: { "jira:outbox": { pending: 3, failing: 1 } } });
    draw();
    expect(await screen.findByText("3 waiting to send, 1 retrying")).toBeInTheDocument();
  });
});

describe("Jira sync", () => {
  it("saves the pull interval, and blank as never", async () => {
    const calls = mockIpc({ answers: { "settings:set": {} } });
    draw();

    const box = await screen.findByRole("spinbutton", { name: /Check every/ });
    expect(box).toHaveValue(5);
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(sent(calls, "settings:set")).toEqual([{ jiraPullMinutes: null }]));
  });
});
