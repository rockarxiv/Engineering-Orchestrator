import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createStep,
  getPipelineOrigin,
  listCommentsForItem,
  listMentionsForComment,
  listPeople,
  listUpdateConflicts,
  needsAttention,
  openMentionsForHuman,
  openUpdateConflict,
  postComment,
  recordUpdateConflict,
  resolveUpdateConflict,
} from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import { findProjectThread } from "../projects/projectThread.js";
import { loadTemplateHistory, type TemplateHistory, type TemplateVersion } from "./history.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates, conflictNoticeOptions, FIX_WITH_ASSISTANT, updateConflictBrief } from "./templateUpdates.js";

/**
 * The conflict notice (EO-533): a held template update is told to the
 * person as one comment on the project thread, in their inbox, with one
 * button — Fix with assistant — and it closes when the conflict does.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

let handle: DbHandle;
let history: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  history = loadTemplateHistory(GALLERY_DIRECTORY);
});

afterEach(() => {
  handle.close();
});

/**
 * EO's own Delivery as it was before EO-461, with Merge Request's
 * `opened` re-pointed at a Merge pipeline's `merge_pr`: the one conflict
 * the 1.1 template raises against it, and so 1.2 (EO-571).
 */
function customisedDelivery(): void {
  const merge = createPipeline(handle.db, { projectId: null, name: "Merge" });
  createStep(handle.db, { id: "merge_pr", pipelineId: merge.id as Uuid, position: 0, name: "Merge PR", type: "user" });
  createStep(handle.db, { pipelineId: merge.id as Uuid, position: 1, name: "Merged", type: "user", isTerminal: true });
  handle.db.run(sql`DELETE FROM step_routes WHERE from_step_id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE pipeline_steps SET retired_version = 1 WHERE id = 'pull_request_watch'`);
  handle.db.run(sql`UPDATE step_routes SET target = 'merge_pr' WHERE from_step_id = 'merge_request' AND result_key = 'opened'`);
  backfillPipelineOrigins(handle.db, history);
}

/** Delivery adopted by a project of its own. */
function adoptedBy(name: string, keyPrefix: string): Uuid {
  const project = createProject(handle.db, { name, keyPrefix });
  handle.db.run(sql`UPDATE pipelines SET project_id = ${project.id} WHERE id = 'default'`);
  return project.id as Uuid;
}

function noticesOn(projectId: Uuid) {
  const thread = findProjectThread(handle.db, projectId);
  return thread === undefined ? [] : listCommentsForItem(handle.db, thread.id as Uuid);
}

function withVersion(version: string, notes: string): TemplateHistory {
  const current = history.get(SOFTWARE)!.at(-1)!;
  const next: TemplateVersion = { ...current, version, notes, document: { ...current.document, template: { ...current.document.template, version } } };
  return new Map([...history, [SOFTWARE, [...history.get(SOFTWARE)!, next]]]);
}

describe("recording an update conflict", () => {
  it("posts one comment on the owning project's thread that mentions the person and names the pipeline, template, versions and conflict", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    const comments = noticesOn(projectId);
    expect(comments).toHaveLength(1);
    const notice = comments[0]!;
    expect(notice.authorType).toBe("engine");
    expect(notice.body).toContain("**Delivery**");
    expect(notice.body).toContain("*Software feature to merge*");
    expect(notice.body).toContain("from 1.0 to 1.2");
    // The conflicting key in plain words, each value in step names.
    expect(notice.body).toContain(
      "**Merge Request**'s 'opened' route: it went to **Done**; you have it going to **Merge PR**; the template sends it to **Watching pull request**.",
    );
    expect(notice.body).toContain("Nothing from it was applied");

    // Exactly one option, and it is an action rather than an answer.
    const conflict = openUpdateConflict(handle.db, "default")!;
    expect(notice.options).toEqual([{ kind: "open", label: FIX_WITH_ASSISTANT, opens: { type: "updateConflictChat", conflictId: conflict.id } }]);
    expect(notice.options).toEqual(conflictNoticeOptions(conflict.id));
    expect(conflict.noticeCommentIds).toEqual([notice.id]);

    // In the person's inbox, and raising `!` on the thread.
    expect(listMentionsForComment(handle.db, notice.id as Uuid)).toEqual([expect.objectContaining({ targetType: "human", targetId: LOCAL_PERSON_ID, status: "open" })]);
    expect(openMentionsForHuman(handle.db).map((open) => open.comment.id)).toContain(notice.id);
    const inbox = listInbox(handle.db, projectId);
    const row = inbox.items.find((item) => item.commentId === notice.id);
    expect(row).toBeDefined();
    expect(row?.options).toEqual(notice.options);
    expect(needsAttention(handle.db, notice.itemId)).toBe(true);
  });

  it("posts on the thread of each project with items on a pipeline no project has adopted", () => {
    customisedDelivery();
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const blog = createProject(handle.db, { name: "Blog", keyPrefix: "BLOG" });
    const idle = createProject(handle.db, { name: "Idle", keyPrefix: "IDLE" });
    createTestItem(handle.db, { type: "story", title: "On Shop", stepId: "todo", projectId: shop.id as Uuid });
    createTestItem(handle.db, { type: "story", title: "On Blog", stepId: "review", projectId: blog.id as Uuid });

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(noticesOn(shop.id as Uuid)).toHaveLength(1);
    expect(noticesOn(blog.id as Uuid)).toHaveLength(1);
    expect(noticesOn(idle.id as Uuid)).toHaveLength(0);
    const conflict = openUpdateConflict(handle.db, "default")!;
    expect(conflict.noticeCommentIds).toHaveLength(2);
  });

  it("mentions the organisation's admins on the record", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
    const ben = createPerson(handle.db, { name: "Ben", email: "ben@example.com", isAdmin: true });
    const carl = createPerson(handle.db, { name: "Carl", email: "carl@example.com", isAdmin: false });

    applyTemplateUpdates(handle.db, history, { isTheRecord: true });

    const notice = noticesOn(projectId)[0]!;
    const targets = listMentionsForComment(handle.db, notice.id as Uuid).map((mention) => mention.targetId);
    const admins = listPeople(handle.db).filter((person) => person.isAdmin).map((person) => person.id);
    expect(targets.sort()).toEqual([...admins].sort());
    expect(targets).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(targets).not.toContain(carl.id);
  });

  it("is deferred, recording nothing, while the thread cannot be opened, and notified once it can", () => {
    customisedDelivery();
    const projectId = adoptedBy("Moving", "MOVE");
    handle.db.run(sql`UPDATE projects SET adopting_at = 123 WHERE id = ${projectId}`);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "deferred" })]);
    expect(listUpdateConflicts(handle.db, "default")).toEqual([]);

    handle.db.run(sql`UPDATE projects SET adopting_at = NULL WHERE id = ${projectId}`);
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "conflict" })]);
    expect(noticesOn(projectId)).toHaveLength(1);
  });
});

describe("when the conflict resolves", () => {
  it("closes the notice's mention, whatever resolved it", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const notice = noticesOn(projectId)[0]!;
    const conflict = openUpdateConflict(handle.db, "default")!;

    resolveUpdateConflict(handle.db, conflict.id, "published");

    expect(listMentionsForComment(handle.db, notice.id as Uuid).map((mention) => mention.status)).toEqual(["dismissed"]);
    expect(openMentionsForHuman(handle.db).map((open) => open.comment.id)).not.toContain(notice.id);
    expect(listInbox(handle.db, projectId).items.map((item) => item.commentId)).not.toContain(notice.id);
    expect(needsAttention(handle.db, notice.itemId)).toBe(false);
  });

  it("never notifies the same template version twice, however many launches and resolutions", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(noticesOn(projectId)).toHaveLength(1);

    // Resolved without the base moving — a path that should never leave
    // the base behind, and the guard that holds even if one does: the
    // next launch compares 1.2 again, holds it again, and says nothing.
    resolveUpdateConflict(handle.db, openUpdateConflict(handle.db, "default")!.id, "kept");
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(listUpdateConflicts(handle.db, "default")).toHaveLength(2);
    expect(openUpdateConflict(handle.db, "default")?.noticeCommentIds).toEqual([]);
    expect(noticesOn(projectId)).toHaveLength(1);
  });

  it("closes the old notice and posts a new one when a newer version supersedes it", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const first = noticesOn(projectId)[0]!;

    applyTemplateUpdates(handle.db, withVersion("1.3", "A later version."), { isTheRecord: false });

    const notices = noticesOn(projectId);
    expect(notices).toHaveLength(2);
    expect(listMentionsForComment(handle.db, first.id as Uuid).map((mention) => mention.status)).toEqual(["dismissed"]);
    const second = notices.find((comment) => comment.id !== first.id)!;
    expect(second.body).toContain("from 1.0 to 1.3");
    expect(listMentionsForComment(handle.db, second.id as Uuid).map((mention) => mention.status)).toEqual(["open"]);
  });
});

describe("EO's brief", () => {
  it("carries the pipeline's name and id, the template and both versions, the release notes and the conflicting keys, and asks for drafts", () => {
    customisedDelivery();
    adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const conflict = openUpdateConflict(handle.db, "default")!;

    const brief = updateConflictBrief(handle.db, conflict);

    expect(brief).toContain("Pipeline: Delivery (id: default)");
    expect(brief).toContain(`Template: Software feature to merge (${SOFTWARE}), from version 1.0 (the pipeline's base) to version 1.2`);
    expect(brief).toContain("CI failures, merge conflicts and review comments send the work back to the implementer");
    expect(brief).toContain(
      "**Merge Request**'s 'opened' route: it went to **Done**; the person has it going to **Merge PR**; the template sends it to **Watching pull request**.",
    );
    expect(brief).toContain("pipeline_update_conflict tool for pipeline id default");
    expect(brief).toContain("up to three alternative drafts");
    expect(brief).toContain("Never apply anything");
    // No backend's spelling of the tool (invariant 12).
    expect(brief).not.toMatch(/mcp__|eo_admin\//);
  });
});

describe("a held update nobody was told about", () => {
  it("is announced on a later launch when it was held before notices existed, and only once", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    // What EO-532 left behind: an open conflict with no notice, as
    // migration 0136 gives every row it finds — at the newest version, so
    // the launch announces it rather than superseding it.
    const origin = getPipelineOrigin(handle.db, "default")!;
    const held = recordUpdateConflict(handle.db, {
      pipelineId: "default",
      templateSlug: SOFTWARE,
      fromVersion: "1.0",
      toVersion: "1.2",
      baseId: origin.baseId,
      templateId: origin.baseId,
      notes: "1.1: Adds Watching pull request.\n1.2: Watching pull request no longer gives up.",
      conflicts: [
        {
          key: { kind: "route", fromStepId: "merge_request", resultKey: "opened" },
          outcome: "conflict",
          base: { target: "ready_to_merge" },
          current: { target: "merge_pr" },
          template: { target: "pull_request_watch" },
        },
      ],
      problems: [],
    });
    expect(noticesOn(projectId)).toEqual([]);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "conflict", conflictId: held.id })]);

    const notices = noticesOn(projectId);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("from 1.0 to 1.2");
    expect(notices[0]!.body).toContain("**Merge Request**'s 'opened' route: it went to **Done**; you have it going to **Merge PR**; the template sends it to **Watching pull request**.");
    expect(notices[0]!.options).toEqual(conflictNoticeOptions(held.id));
    expect(listMentionsForComment(handle.db, notices[0]!.id as Uuid).map((mention) => mention.status)).toEqual(["open"]);
    // The same row, now announced; nothing compared or held again.
    expect(listUpdateConflicts(handle.db, "default").map((conflict) => conflict.id)).toEqual([held.id]);
    expect(openUpdateConflict(handle.db, "default")?.noticeCommentIds).toEqual([notices[0]!.id]);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(noticesOn(projectId)).toHaveLength(1);
  });

  it("is announced once work arrives on a pipeline that had no project and no work when it was held", () => {
    customisedDelivery();
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "conflict" })]);
    const held = openUpdateConflict(handle.db, "default")!;
    expect(held.noticeCommentIds).toEqual([]);
    // Nobody to tell yet, so nothing on the next launch either.
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);

    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    createTestItem(handle.db, { type: "story", title: "On Shop", stepId: "todo", projectId: shop.id as Uuid });
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    const notices = noticesOn(shop.id as Uuid);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.options).toEqual(conflictNoticeOptions(held.id));
    expect(listUpdateConflicts(handle.db, "default")).toHaveLength(1);

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(noticesOn(shop.id as Uuid)).toHaveLength(1);
  });
});

describe("an ordinary remark on the project thread", () => {
  it("leaves an unresolved conflict's notice open — a remark beside it, or a reply under it — until the conflict resolves", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const notice = noticesOn(projectId)[0]!;
    // And a plain question beside it, which a remark does answer.
    const question = postComment(handle.db, { itemId: notice.itemId, author: { type: "engine" }, kind: "question", body: "Which repository?", mentions: [{ type: "human" }] });

    postComment(handle.db, { itemId: notice.itemId, author: { type: "human" }, body: "Unrelated: the CI is slow today." });
    postComment(handle.db, { itemId: notice.itemId, author: { type: "human" }, parentId: notice.id, body: "I'll look at this later." });

    expect(listMentionsForComment(handle.db, question.id as Uuid).map((mention) => mention.status)).toEqual(["addressed"]);
    expect(listMentionsForComment(handle.db, notice.id as Uuid).map((mention) => mention.status)).toEqual(["open"]);
    expect(listInbox(handle.db, projectId).items.map((item) => item.commentId)).toContain(notice.id);
    expect(needsAttention(handle.db, notice.itemId)).toBe(true);

    resolveUpdateConflict(handle.db, openUpdateConflict(handle.db, "default")!.id, "published");
    expect(listMentionsForComment(handle.db, notice.id as Uuid).map((mention) => mention.status)).toEqual(["dismissed"]);
    expect(needsAttention(handle.db, notice.itemId)).toBe(false);
  });
});
