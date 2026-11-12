import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import type { Workspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { buildDispatchContext } from "../../../supervisor/buildDispatchContext.js";
import { commitNamingCheck, implementAppendix, namesKey } from "./commitNaming.js";

/**
 * Commit messages under a Reference (EO-768): the implementer is told to
 * keep EO's and Jira's keys out of them, and the commits its branch adds
 * are checked for them. Neither happens when no Reference names the work.
 */
let handle: DbHandle;
let scratch: string;
let repoPath: string;
let remotePath: string;
let repository: Workspace;

const git = (args: string[], cwd = repoPath) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let counter = 0;
function commit(message: string): string {
  counter += 1;
  writeFileSync(join(repoPath, `file-${counter}.txt`), `${counter}\n`);
  git(["add", "-A"]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "--short", "HEAD"]);
}

function feature(options: { reference?: string | null; jiraKey?: string } = {}): Item {
  return createTestItem(handle.db, {
    type: "feature",
    workspaceId: repository.id,
    title: "Outbox",
    stepId: "todo",
    git: { reference: options.reference ?? null },
    ...(options.jiraKey ? { jiraKey: options.jiraKey } : {}),
  });
}

function story(options: { parent?: Item; reference?: string | null; jiraKey?: string } = {}): Item {
  return createTestItem(handle.db, {
    type: "story",
    workspaceId: repository.id,
    title: "Outbox story",
    stepId: "todo",
    git: { reference: options.reference ?? null },
    ...(options.parent ? { parentId: options.parent.id } : {}),
    ...(options.jiraKey ? { jiraKey: options.jiraKey } : {}),
  });
}

/** The item's branch, cut from main, as the range the implementation check measured. */
function branchFromMain(name = "eo/PROJ-1"): { from: string; to: string } {
  git(["checkout", "-q", "-b", name, "main"]);
  return { from: "main", to: name };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo commit naming "));
  repoPath = join(scratch, "repo");
  remotePath = join(scratch, "remote.git");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "-q", "--bare", remotePath], scratch);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "eo@example.com"]);
  git(["config", "user.name", "EO"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "advice.skippedCherryPicks", "false"]);
  commit("initial");
  git(["remote", "add", "origin", remotePath]);
  git(["push", "-q", "origin", "main"]);

  repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath, baseBranch: "main" });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("what the implementer is told", () => {
  it("names the Reference and the keys to keep out, under the item's own Reference", () => {
    const parent = feature({ jiraKey: "KAN-1" });
    const item = story({ parent, reference: "PROJ-1", jiraKey: "KAN-9" });

    const appendix = implementAppendix(handle.db, item, "implement");

    expect(appendix).toContain("## Commit messages");
    expect(appendix).toContain("filed under PROJ-1");
    for (const key of [item.key, parent.key, "KAN-9", "KAN-1"]) expect(appendix).toContain(key);
    expect(appendix).toContain("any other Jira key");
  });

  it("names a Reference inherited from the feature", () => {
    const item = story({ parent: feature({ reference: "PROJ-2" }) });

    expect(implementAppendix(handle.db, item, "implement")).toContain("filed under PROJ-2");
  });

  it("says nothing when a Jira key or the EO key names the work", () => {
    expect(implementAppendix(handle.db, story(), "implement")).toBeNull();
    expect(implementAppendix(handle.db, story({ parent: feature({ reference: "PROJ-2" }), jiraKey: "KAN-9" }), "implement")).toBeNull();
  });

  it("says nothing on any other action", () => {
    const item = story({ reference: "PROJ-1" });
    for (const action of ["review", "refine", "respond"]) expect(implementAppendix(handle.db, item, action), action).toBeNull();
  });

  it("reaches the implementer through the assembled context, under the task, whatever its prompt says", async () => {
    const context = await buildDispatchContext(handle.db, story({ reference: "PROJ-1" }), "implement");

    expect(context).toContain("filed under PROJ-1: refer to it by that name in commit messages");
    expect(context.indexOf("# Task")).toBeLessThan(context.indexOf("## Commit messages"));
    expect(await buildDispatchContext(handle.db, story(), "implement")).not.toContain("## Commit messages");
  });
});

describe("the check", () => {
  it("passes commits that name only the Reference", async () => {
    const item = story({ reference: "PROJ-1" });
    const range = branchFromMain();
    commit("PROJ-1: add the outbox");

    const check = await commitNamingCheck(handle.db, item, range);

    expect(check).toMatchObject({ key: "commit-naming", passed: true, blocks: true });
  });

  it("fails a commit naming the EO key in its subject, naming the commit and the key", async () => {
    const item = story({ reference: "PROJ-1" });
    const range = branchFromMain();
    commit("PROJ-1: fine");
    const hash = commit(`${item.key}: add the outbox`);

    const check = await commitNamingCheck(handle.db, item, range);

    expect(check).toMatchObject({ key: "commit-naming", passed: false, blocks: true });
    expect(check?.comment).toContain(`- ${hash} ${item.key}: add the outbox — names ${item.key}`);
    expect(check?.comment).not.toContain("fine");
  });

  it("fails a commit naming the EO key only in its body", async () => {
    const item = story({ reference: "PROJ-1" });
    const range = branchFromMain();
    const hash = commit(`PROJ-1: add the outbox\n\nPart of ${item.key}.`);

    const check = await commitNamingCheck(handle.db, item, range);

    expect(check?.passed).toBe(false);
    expect(check?.comment).toContain(`- ${hash} PROJ-1: add the outbox — names ${item.key}`);
  });

  it("fails commits naming the feature's key, the item's Jira key or the feature's", async () => {
    const parent = feature({ jiraKey: "KAN-1" });
    const item = story({ parent, reference: "PROJ-1", jiraKey: "KAN-9" });
    const range = branchFromMain();
    const featureKey = commit(`PROJ-1: part of ${parent.key}`);
    const ownJira = commit("PROJ-1: mirrors KAN-9");
    const featureJira = commit("PROJ-1: under KAN-1");

    const check = await commitNamingCheck(handle.db, item, range);

    expect(check?.passed).toBe(false);
    expect(check?.comment).toContain(`- ${featureKey} PROJ-1: part of ${parent.key} — names ${parent.key}`);
    expect(check?.comment).toContain(`- ${ownJira} PROJ-1: mirrors KAN-9 — names KAN-9`);
    expect(check?.comment).toContain(`- ${featureJira} PROJ-1: under KAN-1 — names KAN-1`);
  });

  it("matches keys whole", async () => {
    const item = story({ reference: "PROJ-1" });
    const range = branchFromMain();
    commit(`PROJ-1: unrelated to ${item.key}3 or X${item.key}`);

    expect((await commitNamingCheck(handle.db, item, range))?.passed).toBe(true);
    expect(namesKey("EO-123", "EO-12")).toBe(false);
    expect(namesKey("see EO-12.", "EO-12")).toBe(true);
    expect(namesKey("eo/PROJ-1-EO-12", "EO-12")).toBe(true);
  });

  it("ignores a stacked dependency's commits, which sit below the range", async () => {
    const item = story({ reference: "PROJ-1" });
    git(["checkout", "-q", "-b", "eo/dependency", "main"]);
    commit(`${item.key}: the dependency happened to name it`);
    git(["checkout", "-q", "-b", "eo/PROJ-1"]);
    commit("PROJ-1: the item's own work");

    expect((await commitNamingCheck(handle.db, item, { from: "eo/dependency", to: "eo/PROJ-1" }))?.passed).toBe(true);
  });

  it("ignores commits already on the remote branch, even once rebased", async () => {
    const item = story({ reference: "PROJ-1" });
    const range = branchFromMain();
    commit(`${item.key}: pushed before anyone said`);
    git(["push", "-q", "origin", "eo/PROJ-1"]);
    commit("PROJ-1: the work since");

    expect((await commitNamingCheck(handle.db, item, range))?.passed).toBe(true);

    // The base moves and the branch is replayed onto it: new hashes, same patches.
    git(["checkout", "-q", "main"]);
    commit("main moves on");
    git(["checkout", "-q", "eo/PROJ-1"]);
    git(["rebase", "-q", "main"]);

    expect((await commitNamingCheck(handle.db, item, range))?.passed).toBe(true);

    const hash = commit(`${item.key}: added after the push`);
    const check = await commitNamingCheck(handle.db, item, range);
    expect(check?.passed).toBe(false);
    expect(check?.comment).toContain(hash);
    expect(check?.comment).not.toContain("pushed before anyone said");
  });

  it("checks nothing when no Reference names the work", async () => {
    const range = branchFromMain();
    const plain = story();
    const mirrored = story({ parent: feature({ reference: "PROJ-2" }), jiraKey: "KAN-9" });
    commit(`${plain.key} ${mirrored.key} KAN-9: names everything`);

    expect(await commitNamingCheck(handle.db, plain, range)).toBeNull();
    expect(await commitNamingCheck(handle.db, mirrored, range)).toBeNull();
  });
});
