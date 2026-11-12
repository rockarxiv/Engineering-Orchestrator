import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, type Message, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createStep,
  getPipelineOrigin,
  getMessage,
  listPeople,
  listUpdateConflicts,
  openUpdateConflict,
  recordUpdateConflict,
  resolveUpdateConflict,
} from "../db/repos/index.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createTestItem, messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { listInbox } from "../ipc/domainQueries.js";
import type { TemplateHistory, TemplateVersion } from "./history.js";
import { templateHistoryUpTo } from "./historyTestHelpers.js";
import { backfillPipelineOrigins } from "./origins.js";
import { applyTemplateUpdates, conflictNoticeOptions, FIX_WITH_ASSISTANT, updateConflictBrief } from "./templateUpdates.js";

/**
 * The conflict notice (EO-533, EO-727): a held template update is told to
 * the person as a message about each project it concerns, in their inbox,
 * with one button — Fix with assistant — and resolved when the conflict
 * is. Never a comment on a project thread.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";

let handle: DbHandle;
let history: TemplateHistory;

beforeEach(() => {
  handle = openMigratedTestDb();
  // As it stood at 1.3: what a notice says is the same for any version,
  // and the conflict below reads as the 1.1 to 1.3 graphs drew it.
  history = templateHistoryUpTo(GALLERY_DIRECTORY, SOFTWARE, "1.3");
});

afterEach(() => {
  handle.close();
});

/**
 * EO's own Delivery as it was before EO-461, with Merge Request's
 * `opened` re-pointed at a Merge pipeline's `merge_pr`: the one conflict
 * the 1.1 template raises against it, and so 1.2 (EO-571) and 1.3 (EO-664).
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

/** The conflict notices sent about a project, open or handled, oldest first. */
function noticesOn(projectId: Uuid): Message[] {
  return messagesFrom(handle.db, "template_conflict").filter((message) => message.projectId === projectId);
}

/** Nothing was posted as a comment anywhere: what EO says here is a message. */
function expectNoComment(): void {
  expect(handle.db.all(sql`select id from comments`)).toEqual([]);
}

function withVersion(version: string, notes: string): TemplateHistory {
  const current = history.get(SOFTWARE)!.at(-1)!;
  const next: TemplateVersion = { ...current, version, notes, document: { ...current.document, template: { ...current.document.template, version } } };
  return new Map([...history, [SOFTWARE, [...history.get(SOFTWARE)!, next]]]);
}

describe("recording an update conflict", () => {
  it("sends one message about the owning project to the person, naming the pipeline, template, versions and conflict, and posts on no thread", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    const notices = noticesOn(projectId);
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.recipientId).toBe(LOCAL_PERSON_ID);
    expect(notice.handledAt).toBeNull();
    expect(notice.body).toContain("**Delivery**");
    expect(notice.body).toContain("*Software feature to merge*");
    expect(notice.body).toContain("from 1.0 to 1.3");
    // The conflicting key in plain words, each value in step names.
    expect(notice.body).toContain(
      "**Merge Request**'s 'opened' route: it went to **Done**; you have it going to **Merge PR**; the template sends it to **Watching pull request**.",
    );
    expect(notice.body).toContain("Nothing from it was applied");

    // Exactly one option, and it is an action rather than an answer.
    const conflict = openUpdateConflict(handle.db, "default")!;
    expect(notice.options).toEqual([{ kind: "open", label: FIX_WITH_ASSISTANT, opens: { type: "updateConflictChat", conflictId: conflict.id } }]);
    expect(notice.options).toEqual(conflictNoticeOptions(conflict.id));
    expect(conflict.noticeIds).toEqual([notice.id]);

    // In the person's inbox, as a message.
    expect(listInbox(handle.db, projectId).messages.map((message) => message.id)).toEqual([notice.id]);
    expectNoComment();
  });

  it("sends one about each project with items on a pipeline no project has adopted", () => {
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
    expect(conflict.noticeIds).toHaveLength(2);
    expectNoComment();
  });

  it("sends it to each of the organisation's admins on the record", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
    const ben = createPerson(handle.db, { name: "Ben", email: "ben@example.com", isAdmin: true });
    const carl = createPerson(handle.db, { name: "Carl", email: "carl@example.com", isAdmin: false });

    applyTemplateUpdates(handle.db, history, { isTheRecord: true });

    const recipients = noticesOn(projectId).map((message) => message.recipientId);
    const admins = listPeople(handle.db).filter((person) => person.isAdmin).map((person) => person.id);
    expect(recipients.sort()).toEqual([...admins].sort());
    expect(recipients).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(recipients).not.toContain(carl.id);
    expect(openUpdateConflict(handle.db, "default")?.noticeIds.sort()).toEqual(noticesOn(projectId).map((message) => message.id).sort());
    expectNoComment();
  });

  it("is held and told at once while the project is moving, rather than deferred", () => {
    customisedDelivery();
    const projectId = adoptedBy("Moving", "MOVE");
    handle.db.run(sql`UPDATE projects SET adopting_at = 123 WHERE id = ${projectId}`);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "conflict" })]);
    expect(noticesOn(projectId)).toHaveLength(1);
    expectNoComment();
  });
});

describe("when the conflict resolves", () => {
  it("marks the notice resolved, whatever resolved it", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const notice = noticesOn(projectId)[0]!;
    const conflict = openUpdateConflict(handle.db, "default")!;

    resolveUpdateConflict(handle.db, conflict.id, "published", 500);

    expect(getMessage(handle.db, notice.id)).toMatchObject({ handledHow: "resolved", handledAt: 500 });
    expect(listInbox(handle.db, projectId).messages).toEqual([]);
  });

  it("leaves a notice the person dismissed as they left it", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const notice = noticesOn(projectId)[0]!;
    handle.db.run(sql`UPDATE messages SET handled_at = 10, handled_how = 'dismissed' WHERE id = ${notice.id}`);

    resolveUpdateConflict(handle.db, openUpdateConflict(handle.db, "default")!.id, "published", 500);

    expect(getMessage(handle.db, notice.id)).toMatchObject({ handledHow: "dismissed", handledAt: 10 });
  });

  it("never notifies the same template version twice, however many launches and resolutions", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");

    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    expect(noticesOn(projectId)).toHaveLength(1);

    // Resolved without the base moving — a path that should never leave
    // the base behind, and the guard that holds even if one does: the
    // next launch compares 1.3 again, holds it again, and says nothing.
    resolveUpdateConflict(handle.db, openUpdateConflict(handle.db, "default")!.id, "kept");
    expect(getPipelineOrigin(handle.db, "default")?.version).toBe("1.0");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });

    expect(listUpdateConflicts(handle.db, "default")).toHaveLength(2);
    expect(openUpdateConflict(handle.db, "default")?.noticeIds).toEqual([]);
    expect(noticesOn(projectId)).toHaveLength(1);
  });

  it("resolves the old notice and sends a new one when a newer version supersedes it", () => {
    customisedDelivery();
    const projectId = adoptedBy("Shop", "SHOP");
    applyTemplateUpdates(handle.db, history, { isTheRecord: false });
    const first = noticesOn(projectId)[0]!;

    applyTemplateUpdates(handle.db, withVersion("1.4", "A later version."), { isTheRecord: false });

    const notices = noticesOn(projectId);
    expect(notices).toHaveLength(2);
    expect(getMessage(handle.db, first.id)?.handledHow).toBe("resolved");
    const second = notices.find((message) => message.id !== first.id)!;
    expect(second.body).toContain("from 1.0 to 1.4");
    expect(second.handledAt).toBeNull();
    expectNoComment();
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
    expect(brief).toContain(`Template: Software feature to merge (${SOFTWARE}), from version 1.0 (the pipeline's base) to version 1.3`);
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
      toVersion: "1.3",
      baseId: origin.baseId,
      templateId: origin.baseId,
      notes: "1.1: Adds Watching pull request.\n1.2: Watching pull request no longer gives up.\n1.3: First run ends in the assistant.",
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
    expect(notices[0]!.body).toContain("from 1.0 to 1.3");
    expect(notices[0]!.body).toContain("**Merge Request**'s 'opened' route: it went to **Done**; you have it going to **Merge PR**; the template sends it to **Watching pull request**.");
    expect(notices[0]!.options).toEqual(conflictNoticeOptions(held.id));
    expect(notices[0]!.handledAt).toBeNull();
    // The same row, now announced; nothing compared or held again.
    expect(listUpdateConflicts(handle.db, "default").map((conflict) => conflict.id)).toEqual([held.id]);
    expect(openUpdateConflict(handle.db, "default")?.noticeIds).toEqual([notices[0]!.id]);

    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([]);
    expect(noticesOn(projectId)).toHaveLength(1);
    expectNoComment();
  });

  it("is announced once work arrives on a pipeline that had no project and no work when it was held", () => {
    customisedDelivery();
    expect(applyTemplateUpdates(handle.db, history, { isTheRecord: false })).toEqual([expect.objectContaining({ outcome: "conflict" })]);
    const held = openUpdateConflict(handle.db, "default")!;
    expect(held.noticeIds).toEqual([]);
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
    expectNoComment();
  });
});

