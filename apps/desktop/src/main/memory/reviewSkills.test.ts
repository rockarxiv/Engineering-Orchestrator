import { SKILL_CREATE_TOOL_NAME, SKILL_PATCH_TOOL_NAME, SKILL_VIEW_TOOL_NAME, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getAgentAttachments } from "../db/repos/agentAttachmentsRepo.js";
import { createProject, getSkill, getSkillBySlug, listAgents, saveSkill, setAgentAttachment } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { answerReviewSkillTool, commitHeldSkillWrites, reviewableSkills, reviewSkillState } from "./reviewSkills.js";

/**
 * A quiet chat's review holds its skill writes until it ends (EO-788):
 * read back to it as written, saved only by `commitHeldSkillWrites`.
 */
describe("a review that holds its skill writes", () => {
  let handle: DbHandle;
  let projectId: string;
  let agentId: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    projectId = createProject(handle.db, { name: "Payments", keyPrefix: "PAY" }).id;
    agentId = listAgents(handle.db).find((agent) => agent.role === "system")!.id;
  });

  afterEach(() => handle.close());

  const held = () => reviewSkillState({ runId: "run-1", agentId, scope: { projectId, workspaceId: null }, hold: true });

  it("changes nothing until it is committed, reads back what it wrote, and saves each skill once as the run", () => {
    const saved = saveSkill(handle.db, { slug: "watch-jobs", name: "watch-jobs", description: "Use when adding a watch job.", body: "Keep the schedule.", files: [] });
    if (!saved.ok) throw new Error(saved.problems.join(" "));
    setAgentAttachment(handle.db, { agentId: agentId as Uuid, kind: "skill", id: saved.skill.id, attached: true });
    const state = held();

    expect(answerReviewSkillTool(handle.db, state, SKILL_VIEW_TOOL_NAME, { slug: "watch-jobs" })).toEqual(expect.objectContaining({ ok: true }));
    expect(answerReviewSkillTool(handle.db, state, SKILL_PATCH_TOOL_NAME, { slug: "watch-jobs", old_text: "Keep the schedule.", new_text: "Keep the schedule, in UTC." })).toEqual(expect.objectContaining({ ok: true }));
    expect(answerReviewSkillTool(handle.db, state, SKILL_PATCH_TOOL_NAME, { slug: "watch-jobs", old_text: "in UTC.", new_text: "in UTC, as the job's own." })).toEqual(expect.objectContaining({ ok: true }));
    expect(answerReviewSkillTool(handle.db, state, SKILL_CREATE_TOOL_NAME, { slug: "nightly-jobs", description: "Use when naming a nightly job.", body: "Name it nightly." })).toEqual(expect.objectContaining({ ok: true }));
    expect(answerReviewSkillTool(handle.db, state, SKILL_PATCH_TOOL_NAME, { slug: "nightly-jobs", old_text: "nightly.", new_text: "nightly-<name>." })).toEqual(expect.objectContaining({ ok: true }));
    // A slug it created is taken, as one saved would be.
    expect(answerReviewSkillTool(handle.db, state, SKILL_CREATE_TOOL_NAME, { slug: "nightly-jobs", description: "Again.", body: "Again." })).toEqual(expect.objectContaining({ ok: false, code: "SKILL_EXISTS" }));

    // Held: the database is as it was, and the review reads its own writes.
    expect(getSkill(handle.db, saved.skill.id)?.body).toBe("Keep the schedule.");
    expect(getSkillBySlug(handle.db, "nightly-jobs")).toBeUndefined();
    expect(reviewableSkills(handle.db, state).map((skill) => [skill.slug, skill.body])).toEqual([
      ["watch-jobs", "Keep the schedule, in UTC, as the job's own."],
      ["nightly-jobs", "Name it nightly-<name>."],
    ]);
    expect(state.written).toEqual([]);

    const committed = commitHeldSkillWrites(handle.db, state);

    expect(committed.problems).toEqual([]);
    expect(getSkill(handle.db, saved.skill.id)?.body).toBe("Keep the schedule, in UTC, as the job's own.");
    const created = getSkillBySlug(handle.db, "nightly-jobs")!;
    expect(created).toEqual(expect.objectContaining({ body: "Name it nightly-<name>.", createdBy: "agent", scope: { kind: "project", projectId } }));
    expect(getAgentAttachments(handle.db, agentId as Uuid).skillIds).toContain(created.id);
    expect(committed.written.sort()).toEqual([saved.skill.id, created.id].sort());
  });

  it("does not save an edit over a skill a person changed after the review first changed it, and saves the rest", () => {
    const write = (slug: string) => {
      const saved = saveSkill(handle.db, { slug, name: slug, description: `Use when ${slug}.`, body: "Keep the schedule.", files: [{ path: "notes.md", content: "First." }] });
      if (!saved.ok) throw new Error(saved.problems.join(" "));
      setAgentAttachment(handle.db, { agentId: agentId as Uuid, kind: "skill", id: saved.skill.id, attached: true });
      return saved.skill;
    };
    const edited = write("watch-jobs");
    const untouched = write("nightly-jobs");
    const state = held();
    for (const slug of ["watch-jobs", "nightly-jobs"]) {
      expect(answerReviewSkillTool(handle.db, state, SKILL_VIEW_TOOL_NAME, { slug })).toEqual(expect.objectContaining({ ok: true }));
      expect(answerReviewSkillTool(handle.db, state, SKILL_PATCH_TOOL_NAME, { slug, old_text: "Keep the schedule.", new_text: "Keep the schedule, in UTC." })).toEqual(expect.objectContaining({ ok: true }));
    }

    // A person changes a supporting file of one, which the review's edit
    // left alone, while it holds that edit.
    const person = saveSkill(handle.db, { id: edited.id, slug: null, name: edited.name, description: edited.description, body: edited.body, files: [{ path: "notes.md", content: "A person's." }] });
    if (!person.ok) throw new Error(person.problems.join(" "));

    const committed = commitHeldSkillWrites(handle.db, state);

    expect(committed.problems).toEqual([expect.stringContaining("`watch-jobs` was not changed: it was changed by somebody else after this review read it")]);
    expect(getSkill(handle.db, edited.id)).toEqual(expect.objectContaining({ body: "Keep the schedule.", files: [{ path: "notes.md", content: "A person's." }] }));
    expect(getSkill(handle.db, untouched.id)?.body).toBe("Keep the schedule, in UTC.");
    expect(committed.written).toEqual([untouched.id]);
  });
});
