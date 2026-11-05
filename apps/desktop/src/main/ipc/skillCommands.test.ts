import { SkillDraftSchema, ipcContract, renderSkillMarkdown, type SkillDraft } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { archiveSkillCommand, listSkillsCommand, saveSkillCommand, setSkillEnabledCommand } from "./skillCommands.js";

/**
 * The skill catalogue over IPC (EO-105).
 *
 * Against the real migrations, because what this boundary is for is the
 * round trip: a skill goes in as a draft and has to come back out as the
 * same skill, body and supporting files included.
 */
function draft(overrides: Partial<SkillDraft> & { name: string }): SkillDraft {
  return SkillDraftSchema.parse({ description: "Reviews a pull request.", body: "Read the whole diff.", ...overrides });
}

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("the catalogue over IPC", () => {
  it("creates, reads, updates, disables, enables and archives a skill", () => {
    const created = saveSkillCommand(handle.db, draft({ name: "PR review" }));
    expect(created.saved).toBe(true);
    const id = created.skill?.id ?? "";

    expect(listSkillsCommand(handle.db, {}).skills.map((skill) => skill.slug)).toEqual(["pr-review"]);

    const edited = saveSkillCommand(handle.db, draft({ id, name: "PR review", body: "Read it twice." }));
    expect(edited.skill?.body).toBe("Read it twice.");

    expect(setSkillEnabledCommand(handle.db, { id, enabled: false }).skill?.enabled).toBe(false);
    expect(setSkillEnabledCommand(handle.db, { id, enabled: true }).skill?.enabled).toBe(true);

    expect(archiveSkillCommand(handle.db, { id })).toEqual({ archived: true, problem: null });
    expect(listSkillsCommand(handle.db, {}).skills).toEqual([]);
    expect(listSkillsCommand(handle.db, { includeArchived: true }).skills).toHaveLength(1);
  });

  it("survives a round trip with a body and supporting files", () => {
    const files = [
      { path: "checklist.md", content: "- [ ] read the whole diff\n\n- [ ] check the tests\t" },
      { path: "snippets/query.sql", content: 'select "id" from t; -- a colon: here\n' },
    ];
    const body = '# How to review\n\nSee `checklist.md`. Mind the "quotes": they are content.\n';

    const saved = saveSkillCommand(handle.db, draft({ name: "PR review", body, files }));
    expect(saved.saved).toBe(true);

    const listed = listSkillsCommand(handle.db, {}).skills[0];
    expect(listed?.body).toBe(body);
    expect(listed?.files).toEqual(files);
  });

  it("answers with what the contract says it answers with", () => {
    // The schemas in `packages/core` are not a parallel description of
    // the skill shape: `handleRequest` parses every payload against the
    // channel's request schema and every answer against its response
    // one, so a command that drifted from them fails at the boundary.
    const created = saveSkillCommand(handle.db, draft({ name: "PR review", files: [{ path: "checklist.md", content: "- read it" }] }));

    expect(ipcContract["skills:save"].response.safeParse(created).success).toBe(true);
    expect(ipcContract["skills:list"].response.safeParse(listSkillsCommand(handle.db, {})).success).toBe(true);
    const id = created.skill?.id ?? "";
    expect(ipcContract["skills:setEnabled"].response.safeParse(setSkillEnabledCommand(handle.db, { id, enabled: false })).success).toBe(true);
    expect(ipcContract["skills:archive"].response.safeParse(archiveSkillCommand(handle.db, { id })).success).toBe(true);
  });

  it("stores and reports a skill marked disable-model-invocation", () => {
    const created = saveSkillCommand(handle.db, draft({ name: "Release notes", disableModelInvocation: true }));
    const skill = created.skill;
    expect(skill).not.toBeNull();
    if (skill === null) return;

    expect(skill.disableModelInvocation).toBe(true);
    expect(listSkillsCommand(handle.db, {}).skills[0]?.disableModelInvocation).toBe(true);
    // And what the frontmatter written from it says, since that is the
    // half the model actually sees: on disk, and not offered.
    expect(renderSkillMarkdown(skill)).toContain("disable-model-invocation: true");
  });

  /**
   * A typed refusal, and nothing on the path throws.
   *
   * Throwing would reach the renderer as `Internal error` — the envelope
   * `handleIpcRequest` builds for a handler that broke its own contract
   * — which is the one answer a person cannot act on.
   */
  it("refuses a malformed skill with a sentence, not an exception", () => {
    const cases: SkillDraft[] = [
      draft({ name: "  " }),
      draft({ name: "PR review", description: "" }),
      draft({ name: "PR review", body: "   " }),
      draft({ name: "PR review", slug: "PR Review" }),
      draft({ name: "PR review", files: [{ path: "../escape.md", content: "" }] }),
      draft({ name: "PR review", files: [{ path: "SKILL.md", content: "" }] }),
    ];

    for (const malformed of cases) {
      expect(() => saveSkillCommand(handle.db, malformed)).not.toThrow();
      const refused = saveSkillCommand(handle.db, malformed);
      expect(refused.saved).toBe(false);
      expect(refused.skill).toBeNull();
      expect(refused.problem).toEqual(expect.any(String));
    }
    expect(listSkillsCommand(handle.db, {}).skills).toEqual([]);
  });

  it("says so rather than throwing when the skill is gone", () => {
    expect(setSkillEnabledCommand(handle.db, { id: "019fb8c6-0000-7000-8000-00000000beef", enabled: false })).toEqual({
      skill: null,
      problem: "That skill no longer exists.",
    });
    expect(archiveSkillCommand(handle.db, { id: "019fb8c6-0000-7000-8000-00000000beef" })).toEqual({
      archived: false,
      problem: "That skill no longer exists.",
    });
  });
});

describe("scopes over IPC (EO-470)", () => {
  it("saves a skill scoped to a project or a workspace that exists, and moves it between scopes", () => {
    const workspace = attachWorkspace(handle.db, { keyPrefix: "P", name: "app", repoPath: "/tmp/eo/app" });
    const projectId = workspace.projectId ?? "";

    const created = saveSkillCommand(handle.db, draft({ name: "E2E", scope: { kind: "project", projectId } }));
    expect(created.skill?.scope).toEqual({ kind: "project", projectId });

    const moved = saveSkillCommand(handle.db, draft({ id: created.skill?.id ?? "", name: "E2E", scope: { kind: "workspace", workspaceId: workspace.id } }));
    expect(moved.skill?.scope).toEqual({ kind: "workspace", workspaceId: workspace.id });
  });

  it("refuses a scope whose project or workspace is gone, with a sentence", () => {
    expect(saveSkillCommand(handle.db, draft({ name: "E2E", scope: { kind: "project", projectId: "no-such-project" } }))).toEqual({
      saved: false,
      skill: null,
      problem: "That project no longer exists — pick another scope for this skill.",
    });
    expect(saveSkillCommand(handle.db, draft({ name: "E2E", scope: { kind: "workspace", workspaceId: "no-such-workspace" } })).problem).toBe(
      "That workspace no longer exists — pick another scope for this skill.",
    );
  });

  it("carries a scope through the contract, and reads a skill without one as global", () => {
    expect(ipcContract["skills:save"].request.parse({ name: "a", description: "b", body: "c", scope: { kind: "project", projectId: "p" } }).scope).toEqual({ kind: "project", projectId: "p" });
    expect(saveSkillCommand(handle.db, draft({ name: "Plain" })).skill?.scope).toEqual({ kind: "global" });
  });
});
