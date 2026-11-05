import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_ADD_TOOL_NAME, FOLDER_KIND, SCRATCH_KIND, eoToolName, uuidv7, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { createRun, createWorkspace, listAgents, updateRun, updateStep } from "../../db/repos/index.js";
import { createDefaultProject } from "../../db/repos/projectsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { buildDispatchContext, buildFollowUpContext, buildSeedContext } from "../../supervisor/buildDispatchContext.js";
import { developerSectionRenderers } from "./sections.js";
import { TICKET_FILES_DIRECTORY } from "./workspace/ticketFiles.js";

/**
 * Which dispatches are told about the ticket's directory (EO-413).
 *
 * `sections.test.ts` holds the renderer to its words given a kind. What
 * that cannot hold is where the kind *comes from*: the section reads a
 * slug off the item view, and the item view is built from the database
 * by the same resolution the dispatch makes. So these go through the
 * real rows — a repository, a folder, a scratch workspace and none —
 * and read the prompt an agent would actually be sent.
 */
let handle: DbHandle;
let drive: string;
let implementer: Agent;

const TOOL = eoToolName(ATTACHMENT_ADD_TOOL_NAME);
const DIRECTORY = `\`${TICKET_FILES_DIRECTORY}/\``;
const count = (text: string, needle: string): number => text.split(needle).length - 1;

beforeEach(() => {
  handle = openMigratedTestDb();
  drive = mkdtempSync(join(tmpdir(), "eo ticket files "));
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
  rmSync(drive, { recursive: true, force: true });
});

function storyOnRepository(): Item {
  const repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath: drive, baseBranch: "main" });
  return createTestItem(handle.db, { type: "story", title: "Fix the login screen", stepId: "todo", workspaceId: repository.id });
}

function storyOn(kind: typeof FOLDER_KIND | typeof SCRATCH_KIND, keyPrefix: string): Item {
  const workspace = kind === FOLDER_KIND ? createWorkspace(handle.db, { kind, config: { path: drive } }) : createWorkspace(handle.db, { kind });
  createDefaultProject(handle.db, workspace, keyPrefix);
  return createTestItem(handle.db, { type: "story", title: "Draft the report", stepId: "todo", workspaceId: workspace.id });
}

describe("the context a run is dispatched with", () => {
  it("names the directory and the tool once on a git workspace, seeded or in full", async () => {
    const item = storyOnRepository();

    for (const text of [
      await buildSeedContext(handle.db, item, implementer, "implement", developerSectionRenderers),
      await buildDispatchContext(handle.db, item, "implement", developerSectionRenderers),
    ]) {
      expect(count(text, DIRECTORY)).toBe(1);
      expect(count(text, TOOL)).toBe(1);
    }
  });

  it("names them for a step that only reads the repository, which is a git workspace all the same", async () => {
    const item = storyOnRepository();
    updateStep(handle.db, "todo", { workspaceMode: "read" });

    const text = await buildSeedContext(handle.db, item, implementer, "implement", developerSectionRenderers);

    expect(count(text, DIRECTORY)).toBe(1);
    expect(count(text, TOOL)).toBe(1);
  });

  it("does not repeat them on a resumed thread", () => {
    const item = storyOnRepository();
    const prior = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", stepId: "todo", threadId: uuidv7() });
    updateRun(handle.db, prior.id, { status: "succeeded", endedAt: Date.now() });

    const text = buildFollowUpContext(handle.db, item, implementer, "implement", prior, { sectionRenderers: developerSectionRenderers }).fullText;

    expect(text).not.toContain(TICKET_FILES_DIRECTORY);
  });

  it.each([
    ["a folder", () => storyOn(FOLDER_KIND, "FO")],
    ["a scratch", () => storyOn(SCRATCH_KIND, "SC")],
    ["no", () => createTestItem(handle.db, { type: "story", title: "Answer the email", stepId: "todo" })],
  ])("says neither on %s workspace", async (_name, make) => {
    const item = make();

    for (const text of [
      await buildSeedContext(handle.db, item, implementer, "implement", developerSectionRenderers),
      await buildDispatchContext(handle.db, item, "implement", developerSectionRenderers),
    ]) {
      expect(text).not.toContain(TICKET_FILES_DIRECTORY);
      expect(text).not.toContain(TOOL);
    }
  });
});
