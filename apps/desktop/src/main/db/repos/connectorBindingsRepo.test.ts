import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, openMigratedTestDb } from "../testHelpers.js";
import { deleteJiraBinding, getJiraBinding, isJiraConnected, listJiraBindings, projectsUsingJiraConnection, saveJiraBinding } from "./connectorBindingsRepo.js";
import { createJiraConnection, deleteJiraConnection, jiraBaseUrlFor, projectsUsingConnection } from "./jiraConnectionsRepo.js";
import { projectForWorkspace } from "./projectsRepo.js";

/**
 * What a project is bound to outside EO (KAN-130).
 *
 * The eight `jira*` columns a repository carried, as one row on the
 * project. What is worth asserting is the shape that move introduced: a
 * project with no row is a project that mirrors nowhere, a patch does
 * not have to restate what it is not changing, and the connection id is
 * inside JSON where no foreign key can police it.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** A project, by way of a repository on it. */
function project(name: string, prefix: string): Uuid {
  const workspace = attachWorkspace(handle.db, { name, keyPrefix: prefix, repoPath: `/tmp/${name}` });
  return projectForWorkspace(handle.db, workspace.id)!.id;
}

describe("the Jira binding", () => {
  it("is absent until something is saved, which is what 'mirrors nowhere' means", () => {
    const projectId = project("api", "API");

    expect(getJiraBinding(handle.db, projectId)).toBeUndefined();
    expect(isJiraConnected(getJiraBinding(handle.db, projectId))).toBe(false);
  });

  it("needs a site and a project key before anything is connected", () => {
    const projectId = project("api", "API");
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });

    // Either alone mirrors nothing (KAN-22), which is the rule
    // `isJiraConnected` has always enforced — it just reads a binding now
    // rather than a repository.
    saveJiraBinding(handle.db, projectId, { connectionId: site.id });
    expect(isJiraConnected(getJiraBinding(handle.db, projectId))).toBe(false);

    saveJiraBinding(handle.db, projectId, { projectKey: "ACME" });
    expect(isJiraConnected(getJiraBinding(handle.db, projectId))).toBe(true);
  });

  it("lays a patch over what is there rather than replacing it", () => {
    const projectId = project("api", "API");
    saveJiraBinding(handle.db, projectId, { projectKey: "ACME", featureIssueType: "Epic" });

    // The trap a JSON column sets: a caller saving the status map must
    // not have to restate the project key to keep it.
    saveJiraBinding(handle.db, projectId, { statusMap: { review: "In Review" } });

    expect(getJiraBinding(handle.db, projectId)!.config).toMatchObject({
      projectKey: "ACME",
      featureIssueType: "Epic",
      statusMap: { review: "In Review" },
    });
  });

  it("holds one binding per project, however many times it is saved", () => {
    const first = project("api", "API");
    const second = project("web", "WEB");
    saveJiraBinding(handle.db, first, { projectKey: "ACME" });
    saveJiraBinding(handle.db, first, { projectKey: "ACME2" });
    saveJiraBinding(handle.db, second, { projectKey: "WEB" });

    expect(listJiraBindings(handle.db).map((binding) => binding.config.projectKey)).toEqual(["ACME2", "WEB"]);
  });

  it("goes away entirely when the project is unbound", () => {
    const projectId = project("api", "API");
    saveJiraBinding(handle.db, projectId, { projectKey: "ACME" });

    deleteJiraBinding(handle.db, projectId);

    // The row goes rather than being blanked: "bound to nothing" and
    // "never bound" are one state, and storing a payload that asserts
    // silence is what KAN-148 decided against.
    expect(getJiraBinding(handle.db, projectId)).toBeUndefined();
  });
});

describe("a binding and the site it names", () => {
  it("answers which projects would stop mirroring if a site went", () => {
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });
    const first = project("api", "API");
    const second = project("web", "WEB");
    saveJiraBinding(handle.db, first, { connectionId: site.id, projectKey: "ACME" });
    saveJiraBinding(handle.db, second, { connectionId: site.id, projectKey: "WEB" });

    expect(projectsUsingJiraConnection(handle.db, site.id).sort()).toEqual([first, second].sort());
    expect(projectsUsingConnection(handle.db, site.id).map((entry) => entry.keyPrefix).sort()).toEqual(["API", "WEB"]);
  });

  it("clears the site off every binding when the site is deleted", () => {
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });
    const projectId = project("api", "API");
    saveJiraBinding(handle.db, projectId, { connectionId: site.id, projectKey: "ACME" });

    deleteJiraConnection(handle.db, site.id);

    // `repositories.jira_connection_id` was a foreign key and SQLite did
    // this; the id is inside the binding's JSON now, where no constraint
    // can see it, so the sweep is code and this is what proves it runs.
    // The project key survives, which is what a repository that lost its
    // site always looked like.
    expect(getJiraBinding(handle.db, projectId)!.config).toMatchObject({ connectionId: null, projectKey: "ACME" });
    expect(jiraBaseUrlFor(handle.db, projectId)).toBeNull();
  });

  it("builds an issue link from the project's own site", () => {
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });
    const projectId = project("api", "API");
    saveJiraBinding(handle.db, projectId, { connectionId: site.id, projectKey: "ACME" });

    expect(jiraBaseUrlFor(handle.db, projectId)).toBe("https://acme.atlassian.net");
    expect(jiraBaseUrlFor(handle.db, null)).toBeNull();
  });
});
