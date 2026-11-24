import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { listAgents } from "../../db/repos/agentsRepo.js";
import { postComment, updateWorkspace } from "../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../db/testHelpers.js";
import { syncRolePrompts } from "../../roles/prompts.js";
import { buildTurnContext } from "../../supervisor/buildDispatchContext.js";
import { developerSectionRenderers } from "./sections.js";

/**
 * What a member of a team on Review is sent of the item (EO-888), beside
 * what the step's own reviewer is sent: the item, its criteria, its
 * thread and its output, and none of what only the agent answering the
 * step acts on — the task and its answer instructions ("If you approve"),
 * and where to put files for the ticket, which a member never posts.
 *
 * On a Git workspace that opens pull requests, so the step's reviewer is
 * asked for a pull request body; through the context the member's turn is
 * built from (`buildTurnContext`, as the supervisor's isolated member turn
 * calls it), with the developer pack's own sections.
 */

/** Every section heading of a prompt, in order. */
const headingsOf = (text: string): string[] => text.split("\n").filter((line) => /^#{1,2} /.test(line));

let handle: DbHandle;
let scratch: string;
let item: Item;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  syncRolePrompts(handle.db);
  scratch = mkdtempSync(join(tmpdir(), "eo-member-context-"));
  // Nothing is read from the repository: with no remote to read a template from, the reviewer is asked for a body of its own.
  const repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "API", repoPath: join(scratch, "repo"), baseBranch: "main" });
  updateWorkspace(handle.db, repository.id, { config: { forgeOpenPr: true, forgeKind: "github" } });
  item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "review", workspaceId: repository.id, spec: REVIEWABLE_SPEC, git: { branch: "eo/API-1" } });
  postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "output", body: "diff --git a/src/limit.ts b/src/limit.ts\n+export const limit = 100;" });
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: "Per key, not per account.", pinned: true });
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: "Keep the 429 body short." });
  reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a team member's context on Review (EO-888)", () => {
  it("has the item, its criteria, its output and its thread, and leaves out the step's task, how to answer it and where to put files", async () => {
    const step = await buildTurnContext(handle.db, item, reviewer, "review", null, developerSectionRenderers);
    const member = await buildTurnContext(handle.db, item, reviewer, "review", null, developerSectionRenderers, undefined, undefined, "member");

    // The step's own reviewer: what it has always been sent.
    expect(await buildTurnContext(handle.db, item, reviewer, "review", null, developerSectionRenderers, undefined, undefined, "step")).toBe(step);
    expect(headingsOf(step)).toEqual([
      "# Task",
      "## If you approve",
      `# ${item.key}: Rate limiting`,
      "## The current output",
      "## Acceptance Criteria",
      "## Files for the ticket, not the branch",
      "## Dependencies",
      "## Pinned",
      "## What the person said",
      "## What each step said",
      "## What is not here",
    ]);

    // A member: the same, without what only the step's own agent acts on.
    expect(headingsOf(member)).toEqual([
      `# ${item.key}: Rate limiting`,
      "## The current output",
      "## Acceptance Criteria",
      "## Dependencies",
      "## Pinned",
      "## What the person said",
      "## What each step said",
      "## What is not here",
    ]);
    for (const kept of ["+export const limit = 100;", ...REVIEWABLE_SPEC.acceptance_criteria, "Per key, not per account.", "Keep the 429 body short."]) expect(member, kept).toContain(kept);
    for (const left of ['perform the "review" action', "pull_request_body", "Approving this opens a pull request", ".eo-attachments"]) {
      expect(member, left).not.toContain(left);
      expect(step, left).toContain(left);
    }
  });
});
