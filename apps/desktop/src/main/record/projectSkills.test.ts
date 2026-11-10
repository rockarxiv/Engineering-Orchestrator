import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, LOCAL_PERSON_ID, ipcContract, SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT, McpServerDraftSchema, SkillDraftSchema, type IpcPayload, type SkillScope, type Uuid } from "@eo/core";
import { buildTickInput } from "../supervisor/buildTickInput.js";
import type { DbHandle } from "../db/client.js";
import { messagesFrom, openMigratedTestDb } from "../db/testHelpers.js";
import { createAgent } from "../db/repos/agentsRepo.js";
import { getAgentAttachments, setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { addWorkspaceToProject, createProject, getProject } from "../db/repos/projectsRepo.js";
import { createWorkspace } from "../db/repos/workspacesRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { issueDevice } from "../db/repos/devicesRepo.js";
import { getSkill, getSkillBySlug, listHeldSkillCopies, listSkills, listSkillVersions, readProjectSkills, saveSkill, setSkillLocked, upsertReplicaSkill } from "../db/repos/skillsRepo.js";
import { saveMcpServer } from "../db/repos/mcpServersRepo.js";
import { setSetting } from "../db/repos/settingsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { countProjectRows, readProjectAgents, writeAdoptedPage, writeAdoptedProject } from "../db/repos/projectMoveRepo.js";
import { findProjectThread } from "../projects/projectThread.js";
import { MANAGED_PERSON_ID_KEY } from "../identity/viewer.js";
import { createLocalRecord, type LocalItemRecord } from "./localRecord.js";
import { createDeviceRecord, type DeviceRecord } from "./deviceRecord.js";
import { moveProjectToRecord } from "./adopt.js";
import { serveAdopt, serveApply, serveChanges, serveMessages, serveProjectThread, serveSendMessage, type ServeRecordContext } from "./serveRecord.js";
import { archiveReachOf, archiveUnusedSkills } from "../skills/archival.js";
import { skillUsageById, usageOfSkill } from "../db/repos/skillUsageRepo.js";
import { createRun } from "../db/repos/runsRepo.js";
import { appendRunEvent } from "../db/repos/index.js";
import { createTestItem } from "../db/testHelpers.js";
import type { RecordTransport } from "./syncStatus.js";

/**
 * A project's own skills travel with the project (EO-513,
 * ARCHITECTURE.md, "Skills", "The record").
 *
 * The three databases `projectAgents.test.ts` has — the organisation's
 * record, Anna's desktop that holds the project, and her laptop, a
 * replica that has never seen it — with the requests going through the
 * same `serve*` functions the server puts behind its door.
 */

let recordDb: DbHandle;
let annaDb: DbHandle;
let laptopDb: DbHandle;
let theRecord: LocalItemRecord;
let serving: ServeRecordContext;
let anna: Desktop;
let laptop: Desktop;
let annaPersonId: Uuid;
let root: string;

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

interface Desktop {
  handle: DbHandle;
  record: DeviceRecord;
  deviceId: string;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eo project skills "));
  recordDb = openMigratedTestDb();
  annaDb = openMigratedTestDb();
  laptopDb = openMigratedTestDb();
  theRecord = createLocalRecord(recordDb.db);
  serving = {
    db: recordDb.db,
    record: theRecord,
    offerWork: (deviceId, capacity) => theRecord.offerWork({ deviceId, capacity, tickInput: buildTickInput(recordDb.db, LIMITS, false) }),
  };
  // An admin: whom the record's messages about a project go to (EO-727).
  const person = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com", isAdmin: true });
  annaPersonId = person.id;
  anna = desktop(annaDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-desk", tokenHash: "h1", secretsKeyHash: null }).id);
  laptop = desktop(laptopDb, issueDevice(recordDb.db, { personId: person.id, name: "anna-laptop", tokenHash: "h2", secretsKeyHash: null }).id);
  setSetting(annaDb.db, MANAGED_PERSON_ID_KEY, annaPersonId);
  setSetting(laptopDb.db, MANAGED_PERSON_ID_KEY, annaPersonId);
});

afterEach(() => {
  anna.record.stop();
  laptop.record.stop();
  recordDb.close();
  annaDb.close();
  laptopDb.close();
  rmSync(root, { recursive: true, force: true });
});

function desktop(handle: DbHandle, deviceId: string): Desktop {
  const transport: RecordTransport = {
    async request(channel, payload) {
      const answer =
        channel === "record:changes"
          ? serveChanges(serving, payload as IpcPayload<"record:changes">)
          : channel === "record:apply"
            ? await serveApply(serving, payload as IpcPayload<"record:apply">)
            : channel === "record:projectThread"
              ? await serveProjectThread(serving, payload as IpcPayload<"record:projectThread">)
              : channel === "record:messages"
                ? serveMessages(serving, { ...(payload as IpcPayload<"record:messages">), deviceId })
                : channel === "record:sendMessage"
                  ? serveSendMessage(serving, { ...(payload as IpcPayload<"record:sendMessage">), deviceId })
                  : null;
      return answer === null ? { ok: false, error: { message: `EO has no channel called "${channel}".` } } : { ok: true, data: answer as never };
    },
  };
  return { handle, deviceId, record: createDeviceRecord({ db: handle.db, deviceId: () => deviceId, transport: () => transport }) };
}

/** The move, as the IPC command performs it: pages over the contract's own schema, into the record. */
async function move(projectId: Uuid): Promise<{ problem?: string }> {
  const outcome = await moveProjectToRecord({
    db: annaDb.db,
    projectId,
    personId: annaPersonId,
    personName: "Anna",
    send: async (request) => {
      const parsed = ipcContract["record:adopt"].request.safeParse({ deviceId: anna.deviceId, ...request });
      if (!parsed.success) return { ok: false, problem: `the record refused the request: ${parsed.error.message}` };
      // A request the record fails part way through is an error answer at
      // the server's door, never a rejection the move cannot read.
      let served: Awaited<ReturnType<typeof serveAdopt>>;
      try {
        served = await serveAdopt(serving, parsed.data);
      } catch (error) {
        return { ok: false, problem: error instanceof Error ? error.message : String(error) };
      }
      if (served.problem !== null) return { ok: false, problem: served.problem };
      return { ok: true, accepted: served.accepted };
    },
  });
  return outcome.ok ? {} : { problem: outcome.problem };
}

function skill(db: DbHandle["db"], name: string, scope: SkillScope): string {
  const saved = saveSkill(db, SkillDraftSchema.parse({ name, description: `When ${name.toLowerCase()} applies.`, body: `Do ${name.toLowerCase()}.`, scope }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.skill.id;
}

function attach(agentId: string, skillId: string): void {
  expect(setAgentAttachment(annaDb.db, { agentId, kind: "skill", id: skillId, attached: true }).ok).toBe(true);
}

/**
 * Anna's Support project with a workspace, and an agent of the project's
 * own attached to a skill of the project's, one of the workspace's, and
 * one of hers that is global.
 */
function supportWithItsOwnSkills() {
  const workspace = createWorkspace(annaDb.db, { kind: FOLDER_KIND, config: { path: root } });
  const support = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false, workspaceIds: [workspace.id] });
  const own = createAgent(annaDb.db, { name: "Support implementer", role: "implementer", provider: "fake", instructions: "Implement.", projectId: support.id });
  const projectSkill = skill(annaDb.db, "Refund policy", { kind: "project", projectId: support.id });
  const workspaceSkill = skill(annaDb.db, "Fixture layout", { kind: "workspace", workspaceId: workspace.id });
  const globalSkill = skill(annaDb.db, "House style", { kind: "global" });
  for (const id of [projectSkill, workspaceSkill, globalSkill]) attach(own.id, id);
  return { support, workspace, own, projectSkill, workspaceSkill, globalSkill };
}

describe("handing a project to the record carries its own skills (EO-513)", () => {
  it("carries the project's skills and its workspaces', and the moved agent keeps them on the record", async () => {
    const { support, workspace, own, projectSkill, workspaceSkill, globalSkill } = supportWithItsOwnSkills();
    // The record already holds the global one — published to it, say —
    // so the agent's whole surface can be attached there.
    upsertReplicaSkill(recordDb.db, getSkill(annaDb.db, globalSkill)!);

    expect(await move(support.id)).toEqual({});

    expect(getSkill(recordDb.db, projectSkill)).toMatchObject({ name: "Refund policy", body: "Do refund policy.", scope: { kind: "project", projectId: support.id } });
    // A workspace never travels, but its skill does — still scoped to the
    // workspace, and known on the record as the project's.
    expect(getSkill(recordDb.db, workspaceSkill)).toMatchObject({ name: "Fixture layout", scope: { kind: "workspace", workspaceId: workspace.id } });
    expect(readProjectSkills(recordDb.db, support.id).map((one) => one.id).sort()).toEqual([projectSkill, workspaceSkill].sort());
    expect(getAgentAttachments(recordDb.db, own.id).skillIds.sort()).toEqual([projectSkill, workspaceSkill, globalSkill].sort());
    // …and the count comparison holds for them as for every other table.
    expect(countProjectRows(recordDb.db, support.id).skills).toBe(2);
    expect(countProjectRows(recordDb.db, support.id)).toEqual(countProjectRows(annaDb.db, support.id));
    // Nothing missing, so nothing to say.
    const thread = findProjectThread(recordDb.db, support.id);
    expect(thread === undefined ? [] : listCommentsForItem(recordDb.db, thread.id as Uuid)).toEqual([]);
  });

  it("does not copy a global skill", async () => {
    const { support, globalSkill } = supportWithItsOwnSkills();

    expect(await move(support.id)).toEqual({});

    expect(getSkill(recordDb.db, globalSkill)).toBeUndefined();
    expect(getSkillBySlug(recordDb.db, getSkill(annaDb.db, globalSkill)!.slug)).toBeUndefined();
  });

  it("puts the skills on a replica that pulls the project, with the moved agent attached to them", async () => {
    const { support, workspace, own, projectSkill, workspaceSkill, globalSkill } = supportWithItsOwnSkills();
    upsertReplicaSkill(recordDb.db, getSkill(annaDb.db, globalSkill)!);
    upsertReplicaSkill(laptopDb.db, getSkill(annaDb.db, globalSkill)!);
    await move(support.id);

    await laptop.record.sync();

    expect(getProject(laptopDb.db, support.id)).toBeDefined();
    expect(getSkill(laptopDb.db, projectSkill)).toMatchObject({ name: "Refund policy", scope: { kind: "project", projectId: support.id } });
    expect(getSkill(laptopDb.db, workspaceSkill)).toMatchObject({ name: "Fixture layout", scope: { kind: "workspace", workspaceId: workspace.id } });
    expect(readProjectSkills(laptopDb.db, support.id).map((one) => one.id).sort()).toEqual([projectSkill, workspaceSkill].sort());
    expect(getAgentAttachments(laptopDb.db, own.id).skillIds.sort()).toEqual([projectSkill, workspaceSkill, globalSkill].sort());
    // The desktop that moved it keeps its own copy, attachments and all.
    expect(getAgentAttachments(annaDb.db, own.id).skillIds.sort()).toEqual([projectSkill, workspaceSkill, globalSkill].sort());
  });

  it("carries a skill created from a consolidation proposal like any other of the project's", async () => {
    // Applying a proposal creates the skill in the proposal's scope and
    // attaches it to the agents whose runs wrote the evidence (EO-483);
    // what reaches the move is that row and that attachment.
    const support = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false });
    const own = createAgent(annaDb.db, { name: "Support implementer", role: "implementer", provider: "fake", instructions: "Implement.", projectId: support.id });
    const proposed = skill(annaDb.db, "Reproduce before fixing", { kind: "project", projectId: support.id });
    attach(own.id, proposed);

    expect(await move(support.id)).toEqual({});
    await laptop.record.sync();

    expect(getAgentAttachments(recordDb.db, own.id).skillIds).toEqual([proposed]);
    expect(getAgentAttachments(laptopDb.db, own.id).skillIds).toEqual([proposed]);
  });
});

describe("an attachment that cannot be carried over (EO-513)", () => {
  it("is one message to the organisation's admins about the project, naming the agent and the skill, and on no thread", async () => {
    const { support, own, projectSkill, globalSkill } = supportWithItsOwnSkills();
    // A skill of another project's, and a server the record has no row for.
    const other = createProject(annaDb.db, { name: "Billing", keyPrefix: "BIL", managed: false });
    const elsewhere = skill(annaDb.db, "Invoice format", { kind: "project", projectId: other.id });
    attach(own.id, elsewhere);
    const server = saveMcpServer(annaDb.db, McpServerDraftSchema.parse({ name: "help-desk", transport: "stdio", command: "help-desk" }));
    if (!server.ok) throw new Error(server.problems.join("\n"));
    expect(setAgentAttachment(annaDb.db, { agentId: own.id, kind: "mcpServer", id: server.server.id, attached: true }).ok).toBe(true);

    expect(await move(support.id)).toEqual({});

    // What travelled is attached; what did not is not on the record.
    expect(getAgentAttachments(recordDb.db, own.id).skillIds).toContain(projectSkill);
    expect(getSkill(recordDb.db, globalSkill)).toBeUndefined();
    expect(getSkill(recordDb.db, elsewhere)).toBeUndefined();

    expect(findProjectThread(recordDb.db, support.id)).toBeUndefined();
    const said = messagesFrom(recordDb.db, "uncarried_tools");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ recipientId: annaPersonId, projectId: support.id, handledAt: null });
    expect(said[0]!.body).toContain("Support implementer");
    expect(said[0]!.body).toContain('the skill "House style"');
    expect(said[0]!.body).toContain('the skill "Invoice format"');
    expect(said[0]!.body).toContain('the MCP server "help-desk"');
    expect(said[0]!.body).not.toContain("Refund policy");

    // …and the admin's other desktop pulls the same message, with no thread.
    await laptop.record.sync();
    expect(messagesFrom(laptopDb.db, "uncarried_tools").map((message) => message.id)).toEqual([said[0]!.id]);
    expect(findProjectThread(laptopDb.db, support.id)).toBeUndefined();
  });

  it("is said once, however many times the last page is sent", async () => {
    const { support } = supportWithItsOwnSkills();
    expect(await move(support.id)).toEqual({});

    // The commit's answer lost and the request sent again.
    const again = await serveAdopt(serving, ipcContract["record:adopt"].request.parse({
      deviceId: anna.deviceId,
      project: wireProject(support.id),
      keyNextValue: 0,
      final: true,
      abandon: false,
      page: {},
    }));
    expect(again.problem).toBeNull();

    expect(messagesFrom(recordDb.db, "uncarried_tools")).toHaveLength(1);
  });

  it("attaches a skill that arrives on a later page than the agent, and says nothing about it", () => {
    const { support, own, projectSkill } = supportWithItsOwnSkills();
    const wire = wireProject(support.id);
    const rows = moveRows(support.id);
    const [agent] = rows.agents;
    expect(agent?.id).toBe(own.id);

    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 1).ok).toBe(true);
    writeAdoptedPage(recordDb.db, wire, emptyPage({ agents: [agent!] }), anna.deviceId);
    expect(getAgentAttachments(recordDb.db, own.id).skillIds).toEqual([]);
    writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: rows.skills }), anna.deviceId);

    expect(getAgentAttachments(recordDb.db, own.id).skillIds).toContain(projectSkill);
  });
});

describe("the windows a move has to hold through (EO-513, review)", () => {
  it("keeps an edit the last sweep carries after finalising, rather than the copy finalising stamped", () => {
    const { support, projectSkill } = supportWithItsOwnSkills();
    const wire = wireProject(support.id);
    const sent = readProjectSkills(annaDb.db, support.id).find((one) => one.id === projectSkill)!;

    // The first pass carries the body as it was at 10…
    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 5).ok).toBe(true);
    writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: [{ ...sent, body: "First.", updatedAt: 10 }] }), anna.deviceId);
    // …the commit makes the project live at 30…
    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 30, true).ok).toBe(true);
    // …and the sweep after it carries the edit made at 20, during the commit's round trip.
    const late = writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: [{ ...sent, body: "Edited during the commit.", updatedAt: 20 }] }), anna.deviceId);

    expect(late.skipped).toEqual([]);
    expect(late.skills).toBe(1);
    expect(getSkill(recordDb.db, projectSkill)).toMatchObject({ body: "Edited during the commit.", updatedAt: 20 });
    // …and that is what a replica is offered.
    const offered = serveChanges(serving, ipcContract["record:changes"].request.parse({ within: support.id }));
    expect(offered.skills.find((one) => one.id === projectSkill)?.body).toBe("Edited during the commit.");
  });

  it("does not let a project still arriving hold the skills feed behind it", () => {
    // A move left unfinished: its skills are on the record and hidden.
    const { support } = supportWithItsOwnSkills();
    const wire = wireProject(support.id);
    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 5).ok).toBe(true);
    writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: readProjectSkills(annaDb.db, support.id) }), anna.deviceId);
    // A live project's skill, written on the record after them.
    const live = createProject(recordDb.db, { name: "Live", keyPrefix: "LIV", managed: true });
    const theirs = skill(recordDb.db, "Live procedure", { kind: "project", projectId: live.id });
    recordDb.db.run(sql`UPDATE skills SET local_changed_at = 100 WHERE project_id = ${support.id}`);
    recordDb.db.run(sql`UPDATE skills SET local_changed_at = 200 WHERE id = ${theirs}`);

    // A page of one, which the hidden rows would fill.
    const first = serveChanges(serving, ipcContract["record:changes"].request.parse({ limit: 1 }));

    expect(first.skills.map((one) => one.id)).toEqual([theirs]);
    expect(first.cursors.skills).toEqual({ ts: 200, id: theirs });
    // …and once the move finishes, the hidden ones are offered after it.
    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 300, true).ok).toBe(true);
    const next = serveChanges(serving, ipcContract["record:changes"].request.parse({ cursors: { ...first.cursors }, limit: 10 }));
    expect(next.skills.map((one) => one.projectId)).toEqual([support.id, support.id]);
  });

  it("keeps the warning when its message cannot be written, and says it when the request is sent again", async () => {
    const { support } = supportWithItsOwnSkills();
    // The record refuses the warning's message, once.
    recordDb.db.run(sql`CREATE TRIGGER refuse_warning BEFORE INSERT ON messages WHEN NEW.body LIKE '%did not move%' BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`);

    const failed = await move(support.id);

    expect(failed.problem).toContain("the disk is full");
    expect(messagesFrom(recordDb.db, "uncarried_tools")).toEqual([]);

    // The last request, sent again once the record can write.
    recordDb.db.run(sql`DROP TRIGGER refuse_warning`);
    const again = await serveAdopt(serving, ipcContract["record:adopt"].request.parse({ deviceId: anna.deviceId, project: wireProject(support.id), keyNextValue: 0, final: true, abandon: false, page: {} }));
    expect(again.problem).toBeNull();

    const said = messagesFrom(recordDb.db, "uncarried_tools");
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toContain("Support implementer");
    expect(said[0]!.body).toContain('the skill "House style"');
    expect(findProjectThread(recordDb.db, support.id)).toBeUndefined();
  });
});

describe("a skill the record cannot take (EO-513)", () => {
  it("ends the move by name where the record already has a skill answering to the slug", async () => {
    const { support, projectSkill } = supportWithItsOwnSkills();
    const slug = getSkill(annaDb.db, projectSkill)!.slug;
    // The organisation's own skill of that name.
    const theirs = saveSkill(recordDb.db, SkillDraftSchema.parse({ name: "Refund policy", slug, description: "The organisation's.", body: "Theirs." }));
    expect(theirs.ok).toBe(true);

    const outcome = await move(support.id);

    expect(outcome.problem).toContain(`already has a skill called "${slug}"`);
    // The organisation's skill is untouched, and the project stays here.
    expect(getSkillBySlug(recordDb.db, slug)).toMatchObject({ body: "Theirs.", archivedAt: null });
    expect(getProject(annaDb.db, support.id)?.managedAt).toBeNull();
  });
});

/**
 * A person's lock against the record's copies (EO-714): the record is not
 * a person, so a lock refuses what it writes, says so, and holds nothing
 * back for good.
 */
describe("a skill a person locked, against the record's copies (EO-714)", () => {
  it("ends a move's page by name where a person locked the skill on the record", () => {
    const { support, projectSkill } = supportWithItsOwnSkills();
    const wire = wireProject(support.id);
    const sent = readProjectSkills(annaDb.db, support.id).find((one) => one.id === projectSkill)!;
    expect(writeAdoptedProject(recordDb.db, wire, annaPersonId, 5).ok).toBe(true);
    writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: [{ ...sent, body: "First.", updatedAt: 10 }] }), anna.deviceId);
    expect(setSkillLocked(recordDb.db, projectSkill, true, 11).ok).toBe(true);
    const before = getSkill(recordDb.db, projectSkill);
    const history = listSkillVersions(recordDb.db, projectSkill);

    const again = writeAdoptedPage(recordDb.db, wire, emptyPage({ skills: [{ ...sent, body: "Second.", updatedAt: 20 }] }), anna.deviceId);

    expect(again.skipped).toEqual([expect.stringContaining(`a person locked the skill "${sent.slug}"`)]);
    expect(getSkill(recordDb.db, projectSkill)).toEqual(before);
    expect(listSkillVersions(recordDb.db, projectSkill)).toEqual(history);
  });

  it("holds the record's newer copy off a replica's locked skill, tells the person in one message, and writes it once unlocked", async () => {
    const { support, projectSkill } = supportWithItsOwnSkills();
    await move(support.id);
    await laptop.record.sync();
    expect(setSkillLocked(laptopDb.db, projectSkill, true).ok).toBe(true);
    const mine = getSkill(laptopDb.db, projectSkill);
    const history = listSkillVersions(laptopDb.db, projectSkill);

    // The record's newer copy, written by somebody on another machine.
    const edited = saveSkill(recordDb.db, { ...getSkill(recordDb.db, projectSkill)!, slug: null, body: "Edited on the record." }, Date.now() + 1_000);
    expect(edited.ok).toBe(true);
    await laptop.record.sync();

    expect(getSkill(laptopDb.db, projectSkill)).toEqual(mine);
    expect(listSkillVersions(laptopDb.db, projectSkill)).toEqual(history);
    expect(listHeldSkillCopies(laptopDb.db).map((held) => held.skill.body)).toEqual(["Edited on the record."]);
    const said = messagesFrom(laptopDb.db, "held_skill_copy");
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toContain("a person locked it here");
    // Kept on this machine, whose lock it is: about no project, since the record holds this one.
    expect(said[0]).toMatchObject({ recipientId: LOCAL_PERSON_ID, projectId: null, handledAt: null });
    expect(findProjectThread(laptopDb.db, support.id)).toBeUndefined();

    // Unlocked, it arrives — and the person is not told twice.
    expect(setSkillLocked(laptopDb.db, projectSkill, false).ok).toBe(true);
    await laptop.record.sync();
    expect(getSkill(laptopDb.db, projectSkill)?.body).toBe("Edited on the record.");
    expect(listHeldSkillCopies(laptopDb.db)).toEqual([]);
    expect(messagesFrom(laptopDb.db, "held_skill_copy")).toHaveLength(1);
  });
});

describe("a workspace's skills when the workspace changes project (EO-513)", () => {
  it("go with the workspace, so handing over the project it is in now carries them", () => {
    const workspace = createWorkspace(annaDb.db, { kind: FOLDER_KIND, config: { path: root } });
    const first = createProject(annaDb.db, { name: "First", keyPrefix: "FIR", workspaceIds: [workspace.id] });
    const id = skill(annaDb.db, "Fixture layout", { kind: "workspace", workspaceId: workspace.id });
    expect(readProjectSkills(annaDb.db, first.id).map((one) => one.id)).toEqual([id]);

    const second = createProject(annaDb.db, { name: "Second", keyPrefix: "SEC" });
    addWorkspaceToProject(annaDb.db, second.id, workspace.id);

    expect(readProjectSkills(annaDb.db, first.id)).toEqual([]);
    expect(readProjectSkills(annaDb.db, second.id).map((one) => one.id)).toEqual([id]);
  });
});

/** The rows a move sends, read as the move reads them and as the record's door parses them. */
function moveRows(projectId: Uuid): Pick<IpcPayload<"record:adopt">["page"], "agents" | "skills"> {
  const page = emptyPage({});
  const parsed = ipcContract["record:adopt"].request.parse({
    deviceId: anna.deviceId,
    project: wireProject(projectId),
    keyNextValue: 0,
    page: { ...page, agents: readProjectAgents(annaDb.db, projectId), skills: readProjectSkills(annaDb.db, projectId) },
  }).page;
  return { agents: parsed.agents, skills: parsed.skills };
}

function wireProject(projectId: Uuid): IpcPayload<"record:adopt">["project"] {
  return { id: projectId, name: "Support", keyPrefix: "SUP", ownerId: annaPersonId, managedAt: 1, createdAt: 1, updatedAt: 1 };
}

function emptyPage(part: Partial<IpcPayload<"record:adopt">["page"]>): IpcPayload<"record:adopt">["page"] {
  return { ...ipcContract["record:adopt"].request.parse({ deviceId: "d", project: wireProject("p" as Uuid), keyNextValue: 0, page: {} }).page, ...part };
}

describe("an agent's skill nobody loads, on a project the record holds (EO-720)", () => {
  /** Support, moved to the record, with an agent-written skill of its own. */
  async function movedWithAnAgentSkill() {
    const support = createProject(annaDb.db, { name: "Support", keyPrefix: "SUP", managed: false });
    const saved = saveSkill(
      annaDb.db,
      SkillDraftSchema.parse({ name: "Refund policy", description: "When refunds apply.", body: "Do refunds.", scope: { kind: "project", projectId: support.id } }),
      Date.now(),
      { kind: "consolidation", consolidationId: "c-1" },
    );
    if (!saved.ok) throw new Error(saved.problems.join("\n"));
    expect(await move(support.id)).toEqual({});
    return { support, skillId: saved.skill.id };
  }

  /** A clock a millisecond on with every line, so no delivery shares its time with the load before it. */
  let clock = Date.now() - 1_000_000;

  /** One page of a run's transcript reaching the record, with the run row as the device has it then. */
  function page(runId: Uuid, itemId: Uuid, from: number, types: string[], skillId: string) {
    const payloadOf = (type: string) =>
      type === SKILLS_DELIVERED_EVENT
        ? { type, skillIds: [skillId], slugs: ["refund-policy"] }
        : type === SKILL_LOADED_EVENT
          ? { type, skillId, slug: "refund-policy" }
          : { type };
    return serveApply(serving, {
      deviceId: anna.deviceId,
      commands: [{ kind: "runEvents", id: `${runId}:events:${String(from)}`, runId, itemId, events: types.map((type, index) => ({ seq: from + index, ts: (clock += 1), type, payload: payloadOf(type) })) }],
    });
  }

  it("archives on the record only once a run's transcript has settled, and never a skill a run still arriving may have loaded", async () => {
    const { support, skillId } = await movedWithAnAgentSkill();
    serving.skillAgeing = () => ({ staleAfterRuns: 1, archiveAfterRuns: 2 });
    const item = createTestItem(recordDb.db, { type: "story", title: "A refund", stepId: "todo", projectId: support.id });
    const newRun = (status: "running" | "succeeded") => createRun(recordDb.db, { itemId: item.id, agentId: null, action: "implement", status }).id;
    const archived = () => getSkill(recordDb.db, skillId)!.archivedAt !== null;

    // One run, finished and settled, that never loaded it.
    const first = newRun("succeeded");
    await page(first, item.id, 1, [SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(archived()).toBe(false);

    // A second, still running: its delivery arrives on one page…
    const going = newRun("running");
    await page(going, item.id, 1, [SKILLS_DELIVERED_EVENT], skillId);
    expect(archived()).toBe(false);
    // …a third run settles meanwhile, which would be the second without a load — but the one going may yet load it…
    const third = newRun("succeeded");
    await page(third, item.id, 1, [SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(archived()).toBe(false);
    // …and does, on a later page.
    recordDb.db.run(sql`update runs set status = 'succeeded', ended_at = ${Date.now()} where id = ${going}`);
    await page(going, item.id, 2, [SKILL_LOADED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(archived()).toBe(false);
    expect(usageOfSkill(skillUsageById(recordDb.db), skillId).deliveriesSinceLoad).toBe(0);

    // A finished run whose transcript arrives in two pages, its load on the
    // second — while two settled runs without a load bring the count to the line.
    const before = newRun("succeeded");
    await page(before, item.id, 1, [SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    // Ended days ago — a desktop reconnecting after a long time away — and no less incomplete for it.
    const split = newRun("succeeded");
    recordDb.db.run(sql`update runs set ended_at = ${Date.now() - 3 * 24 * 60 * 60 * 1000} where id = ${split}`);
    await page(split, item.id, 1, [SKILLS_DELIVERED_EVENT], skillId);
    const after = newRun("succeeded");
    await page(after, item.id, 1, [SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(usageOfSkill(skillUsageById(recordDb.db), skillId).deliveriesSinceLoad).toBe(2);
    expect(archived()).toBe(false);
    await page(split, item.id, 2, [SKILL_LOADED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(archived()).toBe(false);
    expect(usageOfSkill(skillUsageById(recordDb.db), skillId).deliveriesSinceLoad).toBe(0);

    // Two settled runs in a row with nothing still arriving: archived, once.
    for (const run of [newRun("succeeded"), newRun("succeeded")]) await page(run, item.id, 1, [SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT], skillId);
    expect(archived()).toBe(true);
    expect(listSkillVersions(recordDb.db, skillId)[0]).toMatchObject({ action: "archive", author: { kind: "eo" } });
    const notes = listCommentsForItem(recordDb.db, findProjectThread(recordDb.db, support.id)!.id as Uuid);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain("`refund-policy`");

    // The archived copy reaches a replica, and stays archived there.
    await laptop.record.sync();
    expect(getSkill(laptopDb.db, skillId)!.archivedAt).not.toBeNull();
    expect(listSkills(laptopDb.db).map((one) => one.id)).not.toContain(skillId);
    await laptop.record.sync();
    expect(getSkill(laptopDb.db, skillId)!.archivedAt).not.toBeNull();
  });

  it("leaves a moved project's skills to the record, but archives the desktop's own global skill, with the note on the project's one thread", async () => {
    const { support, skillId } = await movedWithAnAgentSkill();
    const global = saveSkill(annaDb.db, SkillDraftSchema.parse({ name: "House style", description: "How this house writes.", body: "Write plainly." }), Date.now(), { kind: "consolidation", consolidationId: "c-2" });
    if (!global.ok) throw new Error(global.problems.join("\n"));
    const globalId = global.skill.id;
    // Global skills are not carried: the record has no copy to archive.
    expect(getSkill(recordDb.db, globalId)).toBeUndefined();

    // Anna's runs on the moved project, here on her desktop, each given both and loading neither.
    const item = createTestItem(annaDb.db, { type: "story", title: "A refund", stepId: "todo", projectId: support.id });
    for (let index = 0; index < 3; index++) {
      const runId = createRun(annaDb.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" }).id;
      appendRunEvent(annaDb.db, runId, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [skillId, globalId], slugs: ["refund-policy", "house-style"] });
      appendRunEvent(annaDb.db, runId, SKILLS_SETTLED_EVENT, { type: SKILLS_SETTLED_EVENT });
    }

    const reach = archiveReachOf(annaDb.db, support.id, false);
    expect(reach).toBe("global");
    expect(archiveReachOf(recordDb.db, support.id, true)).toBe("all");
    const result = await archiveUnusedSkills({
      db: annaDb.db,
      projectId: support.id,
      reach,
      ageing: { staleAfterRuns: 1, archiveAfterRuns: 3 },
      projectThread: (id) => anna.record.projectThread(id),
      postComment: (comment) => anna.record.postComment(comment),
    });

    expect(result.archived.map((one) => one.id)).toEqual([globalId]);
    expect(getSkill(annaDb.db, skillId)!.archivedAt).toBeNull();
    expect(listSkillVersions(annaDb.db, globalId)[0]).toMatchObject({ action: "archive", author: { kind: "eo" } });
    // The note is on the project's thread, which is the record's: it reaches the record.
    await anna.record.sync();
    const notes = listCommentsForItem(recordDb.db, findProjectThread(recordDb.db, support.id)!.id as Uuid);
    expect(notes.map((one) => one.body).filter((body) => body.includes("`house-style`"))).toHaveLength(1);
    expect(notes.some((one) => one.body.includes("`refund-policy`"))).toBe(false);
  });
});
