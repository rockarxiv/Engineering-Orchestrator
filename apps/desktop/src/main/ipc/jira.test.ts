import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { getJiraBinding, listJiraConnections, projectForWorkspace, type ConnectorBinding, type Workspace } from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { hasToken } from "../packs/developer/jira/credentials.js";
import type { FetchLike } from "../packs/developer/jira/client.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import type { SecretStore } from "../secrets/store.js";
import { connectJira, disconnectJira, jiraConfigView, jiraFields, saveJiraConfig, saveJiraConnection, testJira } from "./jiraCommands.js";
import { listRepositoriesCommand } from "./repositoryCommands.js";

let handle: DbHandle;
let directory: string;
let repository: Workspace;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

/** A Jira that answers everything the connection check asks. */
function healthyJira(): FetchLike {
  return async (url) => {
    const body = url.includes("/myself")
      ? { accountId: "acc-1", displayName: "Dev" }
      : url.includes("/project/")
        ? { id: "1", key: "ACME", name: "Acme API" }
        : url.endsWith("/issuetypes")
          ? { issueTypes: [{ id: "10", name: "Epic" }] }
          : { fields: [{ fieldId: "customfield_1", name: "Team", required: true, schema: { type: "option" }, allowedValues: [] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function failingJira(status: number, body: unknown): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

const SITE = {
  baseUrl: "https://acme.atlassian.net",
  flavour: "cloud" as const,
  email: "dev@acme.com",
  token: "secret-token",
  name: "",
};

const CONNECT = { projectKey: "ACME", featureIssueType: "Epic", storyIssueType: "Story" };

/**
 * Adds the site, then points a repository at it — the two halves the
 * settings screen now has, since a connection stopped being part of a
 * repository (KAN-22).
 */
async function connectVia(fetchImpl: FetchLike, repositoryId: string, overrides: Partial<typeof CONNECT> = {}) {
  const saved = await saveJiraConnection(handle.db, context(fetchImpl), { ...SITE, ...(siteId ? { id: siteId } : {}) });
  if (saved.ok && saved.connection) siteId = saved.connection.id;
  return connectJira(handle.db, context(fetchImpl), { ...CONNECT, ...overrides, repositoryId, connectionId: siteId! });
}

let siteId: string | undefined;

/**
 * The Jira configuration behind a repository.
 *
 * A binding on its *project* since KAN-130, so the hop the settings
 * channels make internally is made here too: the screen names a
 * repository, the row lives one step away, and undefined is what a
 * project that has never been connected has.
 */
function bindingOf(workspaceId: Uuid): ConnectorBinding | undefined {
  return getJiraBinding(handle.db, projectForWorkspace(handle.db, workspaceId)!.id);
}

beforeEach(() => {
  siteId = undefined;
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo jira ipc "));
  repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: "/tmp/acme", baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("connecting", () => {
  it("stores the configuration and the token", async () => {
    const result = await connectVia(healthyJira(), repository.id);

    expect(result).toEqual({ ok: true, problem: null });

    // The site is its own record now and the binding points at it
    // (KAN-22). The binding keeps only what belongs to *this* Jira
    // project — the key and the issue types.
    const saved = bindingOf(repository.id)!;
    expect(saved.config.projectKey).toBe("ACME");
    expect(listJiraConnections(handle.db)).toMatchObject([{ baseUrl: SITE.baseUrl, flavour: "cloud" }]);
    expect(saved.config.connectionId).toBe(listJiraConnections(handle.db)[0]!.id);

    expect(jiraConfigView(handle.db, saved, { directory, store }).credentialsConfigured).toBe(true);
  });

  it("reuses a site a second repository is already connected to, rather than storing the token twice", async () => {
    // The whole point of KAN-22. Two repositories on one Jira used to mean
    // two encrypted copies of one credential, entered twice and rotated
    // twice.
    const second = attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/other" });

    await connectVia(healthyJira(), repository.id);
    await connectVia(healthyJira(), second.id, { projectKey: "OTHER" });

    expect(listJiraConnections(handle.db)).toHaveLength(1);
    expect(bindingOf(second.id)?.config.connectionId).toBe(bindingOf(repository.id)?.config.connectionId);
  });

  it("does not take a shared token away when one repository disconnects", async () => {
    // The bug this refactor could most easily introduce: the credential
    // is shared, so clearing it on disconnect would silently break
    // every other repository on that site.
    const second = attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/other" });
    await connectVia(healthyJira(), repository.id);
    await connectVia(healthyJira(), second.id, { projectKey: "OTHER" });

    disconnectJira(handle.db, context(healthyJira()), { repositoryId: second.id });

    expect(jiraConfigView(handle.db, bindingOf(repository.id), { directory, store }).credentialsConfigured).toBe(true);
    expect(bindingOf(second.id)).toBeUndefined();
  });

  it("does take the token away when the last repository on a site disconnects", async () => {
    await connectVia(healthyJira(), repository.id);

    disconnectJira(handle.db, context(healthyJira()), { repositoryId: repository.id });

    expect(hasToken({ directory, store }, listJiraConnections(handle.db)[0]!.id)).toBe(false);
  });

  it("keeps the token out of what the renderer is given", async () => {
    // ARCHITECTURE.md, "Secrets": secrets go in the OS keychain. The renderer is
    // told a token exists, never what it is.
    await connectVia(healthyJira(), repository.id);

    const listed = JSON.stringify(listRepositoriesCommand(handle.db, { directory, store }));

    expect(listed).not.toContain("secret-token");
    expect(listed).toContain('"credentialsConfigured":true');
  });

  it("proves the credentials before storing them", async () => {
    // A stored token that has never worked reports a puzzling failure
    // later instead of an obvious one now. The proving moved to the
    // connection with the credential (KAN-22).
    const result = await saveJiraConnection(handle.db, context(failingJira(401, { errorMessages: ["Client must be authenticated"] })), SITE);

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("rejected the credentials");
    expect(listJiraConnections(handle.db), "nothing is stored for a site that never authenticated").toEqual([]);
  });

  it("says which part of the path failed", async () => {
    // Credentials, project key and fields fail for different reasons,
    // and "connection failed" would send someone to check the wrong one.
    // The site is fine here; the project key is not.
    const site = await saveJiraConnection(handle.db, context(healthyJira()), SITE);
    siteId = site.connection!.id;

    const result = await connectJira(
      handle.db,
      context(async (url) =>
        url.includes("/myself")
          ? new Response(JSON.stringify({ accountId: "a", displayName: "Dev" }), { status: 200 })
          : new Response(JSON.stringify({ errorMessages: ["No repository could be found with key 'ACME'."] }), { status: 404 }),
      ),
      { ...CONNECT, repositoryId: repository.id, connectionId: siteId! },
    );

    expect(result.problem).toContain("Repository");
    expect(result.problem).toContain("No repository could be found");
  });
});

describe("testing a connection", () => {
  it("reports each step it tried", async () => {
    await connectVia(healthyJira(), repository.id);

    const result = await testJira(handle.db, context(healthyJira()), { repositoryId: repository.id });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual(["Credentials", "Repository", "Fields"]);
    expect(result.steps[0]?.detail).toContain("Dev");
  });

  it("says a repository isn't connected rather than pretending it failed", async () => {
    const result = await testJira(handle.db, context(healthyJira()), { repositoryId: repository.id });

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain("not connected");
  });

  it("says so when the configuration is there but the token is gone", async () => {
    // Another machine, or a keychain reset. Different from "not
    // connected", and different from "wrong token".
    await connectVia(healthyJira(), repository.id);
    rmSync(directory, { recursive: true, force: true });

    const result = await testJira(handle.db, context(healthyJira()), { repositoryId: repository.id });

    expect(result.steps[0]?.detail).toContain("no stored token");
  });
});

describe("the fields Jira requires", () => {
  it("counts only the ones a person has to fill in", async () => {
    // A real Atlassian repository answered "4 required fields" — repository,
    // issuetype, reporter, summary, every one of them sent from the
    // item already — directly above a panel saying it needed nothing.
    // Both were true and together they were nonsense.
    const alwaysSent: FetchLike = async (url) =>
      new Response(
        JSON.stringify(
          url.includes("/myself")
            ? { accountId: "a", displayName: "Dev" }
            : url.includes("/project/")
              ? { id: "1", key: "ACME", name: "Acme" }
              : url.endsWith("/issuetypes")
                ? { issueTypes: [{ id: "10", name: "Epic" }] }
                : {
                    fields: ["project", "issuetype", "summary", "reporter"].map((id) => ({
                      fieldId: id,
                      name: id,
                      required: true,
                      schema: { type: "string" },
                      allowedValues: [],
                    })),
                  },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await connectVia(alwaysSent, repository.id);
    const result = await testJira(handle.db, context(alwaysSent), { repositoryId: repository.id });

    expect(result.steps[2]?.detail).toBe('"Epic" needs nothing beyond what EO already sends');
  });

  it("names the ones it does need, so they can be filled in before an issue fails", async () => {
    await connectVia(healthyJira(), repository.id);

    const result = await testJira(handle.db, context(healthyJira()), { repositoryId: repository.id });

    expect(result.steps[2]?.detail).toContain("Team");
  });


  it("lists them for the configured issue type", async () => {
    await connectVia(healthyJira(), repository.id);

    const result = await jiraFields(handle.db, context(healthyJira()), { repositoryId: repository.id, issueType: "Epic" });

    expect(result.problem).toBeNull();
    expect(result.fields).toEqual([{ id: "customfield_1", name: "Team", required: true, schemaType: "option", allowedValues: [] }]);
  });

  it("saves the values that will be sent on every create", async () => {
    await connectVia(healthyJira(), repository.id);

    saveJiraConfig(handle.db, {
      repositoryId: repository.id,
      fields: { customfield_1: { id: "5" } },
      createByDefault: false,
      featureIssueType: "Epic",
      storyIssueType: "Task",
    });

    expect(bindingOf(repository.id)?.config).toMatchObject({
      fields: { customfield_1: { id: "5" } },
      createByDefault: false,
      storyIssueType: "Task",
    });
  });
});

describe("disconnecting", () => {
  it("forgets the configuration and the credential", async () => {
    await connectVia(healthyJira(), repository.id);

    expect(disconnectJira(handle.db, context(healthyJira()), { repositoryId: repository.id })).toEqual({ ok: true });

    // The row goes rather than being blanked: "bound to nothing" and
    // "never bound" are one state.
    const saved = bindingOf(repository.id);
    expect(saved).toBeUndefined();
    expect(jiraConfigView(handle.db, saved, { directory, store }).credentialsConfigured).toBe(false);
  });
});

describe("with no repository connected", () => {
  it("says so, and leaves the create-by-default ready for when it is", () => {
    const view = jiraConfigView(handle.db, bindingOf(repository.id), { directory, store });

    expect(view).toMatchObject({ baseUrl: null, projectKey: null, credentialsConfigured: false });
    // J-03's checkbox reads this, and is only shown when connected.
    expect(view.createByDefault).toBe(true);
  });
});
