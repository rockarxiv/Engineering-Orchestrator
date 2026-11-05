import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { updateWorkspace, type Workspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { buildDispatchContext } from "../../../supervisor/buildDispatchContext.js";
import { reviewAppendix } from "./reviewAppendix.js";

/**
 * Asking the reviewer for the pull request description (F-06).
 *
 * It travels in the dispatch context rather than in `reviewer.md`,
 * because `syncRolePrompts` never touches a prompt someone has
 * customised (U-06) — a change made there would silently skip exactly
 * the people who have used EO longest.
 */
let handle: DbHandle;
let scratch: string;
let repoPath: string;
let repository: Workspace;

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

function story(): Item {
  return createTestItem(handle.db, { type: "story", workspaceId: repository.id, title: "Outbox", stepId: "review", git: { branch: "eo/API-4" } });
}

function commitTemplate(path: string, body: string): void {
  mkdirSync(join(repoPath, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
  writeFileSync(join(repoPath, path), body);
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "template"], repoPath);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo appendix "));
  repoPath = join(scratch, "repo");
  mkdirSync(repoPath, { recursive: true });
  git(["init", "-b", "main"], repoPath);
  git(["config", "user.email", "eo@example.com"], repoPath);
  git(["config", "user.name", "EO"], repoPath);
  git(["config", "commit.gpgsign", "false"], repoPath);
  git(["config", "tag.gpgsign", "false"], repoPath);
  writeFileSync(join(repoPath, "README.md"), "# repo\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "initial"], repoPath);

  repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath, baseBranch: "main" });
  updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: true, forgeKind: "github" } });
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("when it asks", () => {
  it("asks the reviewer for a description", async () => {
    expect(await reviewAppendix(handle.db, story(), "review")).toContain("pull_request_body");
  });

  it("hands over the repository's template, headings and all", async () => {
    commitTemplate(".github/pull_request_template.md", "## Why is this needed?\n\n## How was it tested?\n");

    const appendix = await reviewAppendix(handle.db, story(), "review");

    expect(appendix).toContain("## Why is this needed?");
    expect(appendix).toContain("keep every heading exactly as written");
  });

  it("asks for free prose when the repository has no template", async () => {
    const appendix = await reviewAppendix(handle.db, story(), "review");

    expect(appendix).toContain("two or three paragraphs");
    expect(appendix).not.toContain("keep every heading");
  });

  it("says to leave it out on a rejection, so a rejected review does not write one", async () => {
    expect(await reviewAppendix(handle.db, story(), "review")).toContain("Leave it out if you are rejecting");
  });
});

describe("under a Reference (EO-638)", () => {
  function feature(reference: string | null): Item {
    return createTestItem(handle.db, { type: "feature", workspaceId: repository.id, title: "Outbox", stepId: "review", git: { reference } });
  }

  const KEEP_OUT = "Do not mention";

  for (const withTemplate of [false, true]) {
    describe(withTemplate ? "with a repository template" : "without a template", () => {
      beforeEach(() => {
        if (withTemplate) commitTemplate(".github/pull_request_template.md", "## Why is this needed?\n");
      });

      it("names the item's own Reference and asks it to leave EO and Jira keys out", async () => {
        const parent = feature(null);
        const item = createTestItem(handle.db, { type: "story", parentId: parent.id, workspaceId: repository.id, title: "Outbox", stepId: "review", jiraKey: "KAN-9", git: { reference: "PROJ-123" } });

        const appendix = await reviewAppendix(handle.db, item, "review");

        expect(appendix).toContain("filed under PROJ-123");
        expect(appendix).toContain(`${KEEP_OUT} ${item.key}, its feature's key or any Jira key`);
        expect(appendix).toContain(withTemplate ? "## Why is this needed?" : "two or three paragraphs");
      });

      it("names a Reference inherited from the feature", async () => {
        const parent = feature("PROJ-123");
        const item = createTestItem(handle.db, { type: "story", parentId: parent.id, workspaceId: repository.id, title: "Outbox", stepId: "review" });

        const appendix = await reviewAppendix(handle.db, item, "review");

        expect(appendix).toContain("filed under PROJ-123");
        expect(appendix).toContain(KEEP_OUT);
      });

      it("is unchanged when no Reference names the work, including a story whose own Jira key outranks its feature's Reference", async () => {
        const plain = await reviewAppendix(handle.db, story(), "review");
        const parent = feature("PROJ-123");
        const mirrored = createTestItem(handle.db, { type: "story", parentId: parent.id, workspaceId: repository.id, title: "Outbox", stepId: "review", jiraKey: "KAN-9" });

        expect(plain).not.toContain("filed under");
        expect(plain).not.toContain(KEEP_OUT);
        expect(await reviewAppendix(handle.db, mirrored, "review")).toBe(plain);
      });
    });
  }
});

describe("when it does not", () => {
  it("says nothing on any other action", async () => {
    for (const action of ["implement", "refine", "intake"]) {
      expect(await reviewAppendix(handle.db, story(), action), action).toBeNull();
    }
  });

  it("says nothing when the repository does not open pull requests", async () => {
    updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: false } });

    expect(await reviewAppendix(handle.db, story(), "review")).toBeNull();
  });

  it("says nothing for an item with no repository", async () => {
    const orphan = createTestItem(handle.db, { type: "story", title: "No repository", stepId: "review" });

    expect(await reviewAppendix(handle.db, orphan, "review")).toBeNull();
  });
});

describe("in the assembled context", () => {
  it("reaches the reviewer under the task, where truncation cannot drop it", async () => {
    // Context truncation only ever removes comments, so an instruction
    // in the task section survives however long the thread gets.
    commitTemplate(".github/pull_request_template.md", "## Why is this needed?\n");

    const context = await buildDispatchContext(handle.db, story(), "review");

    expect(context).toContain("## Why is this needed?");
    expect(context.indexOf("# Task")).toBeLessThan(context.indexOf("## Why is this needed?"));
  });

  it("leaves an implementer's context exactly as it was", async () => {
    commitTemplate(".github/pull_request_template.md", "## Why is this needed?\n");

    const context = await buildDispatchContext(handle.db, story(), "implement");

    expect(context).not.toContain("pull_request_body");
  });
});
