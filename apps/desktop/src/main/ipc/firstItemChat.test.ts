import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { getItem, getPipeline, listCommentsForItem, listMentionsForComment, updateAgent } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { firstItemBrief } from "../gallery/firstItemBrief.js";
import { forgetListed } from "../gallery/session.js";
import { bundledTemplates } from "../gallery/templates.js";
import { assistAgent, assistBoards, listAssistThreads, shownAssistConversation } from "../roles/assist.js";
import { ASSIST_STEP } from "../roles/conversationSteps.js";
import type { EngineHandle } from "./domainCommands.js";
import { openFirstItemChatCommand, useGalleryCommand } from "./galleryCommands.js";

/**
 * The end of first run for a template with no job (EO-664): the needs
 * check, all green, opens a new assistant chat whose first message is
 * EO's brief for the first item — posted by EO, mentioning the
 * assistant so its first turn dispatches with nobody typing, naming the
 * project and the pipeline, and asking the template's own question. The
 * pipeline is pinned to the brief.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-gallery-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};
const CONTENT = "content-draft-and-approve";

let handle: DbHandle;
let folder: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  folder = mkdtempSync(join(tmpdir(), "eo drafts "));
  forgetListed();
});

afterEach(() => {
  handle.close();
  rmSync(folder, { recursive: true, force: true });
});

function context() {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] as string[] };
}

function engineStub(): EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> } {
  return { notifyStateChange: vi.fn() } as unknown as EngineHandle & { notifyStateChange: ReturnType<typeof vi.fn> };
}

/** Use this on Content draft and approve, as first run does. */
async function useContent(): Promise<{ projectId: string; pipelineId: string }> {
  const used = await useGalleryCommand(handle.db, context(), { slug: CONTENT, answers: { folder, keyPrefix: "DOC" }, roleSlots: {}, projectName: "Blog" });
  expect(used.problem).toBeNull();
  expect(used.jobId).toBeNull();
  return { projectId: used.projectId!, pipelineId: used.pipelineId! };
}

describe("pressing the needs check's way on, for a template with no job", () => {
  it("opens a new chat whose first message is EO's brief, asking the assistant, and wakes the engine at once", async () => {
    const { projectId, pipelineId } = await useContent();
    const engine = engineStub();

    const opened = await openFirstItemChatCommand(handle.db, context(), engine, { projectId, slug: CONTENT, pipelineId });

    expect(opened.problem).toBeNull();
    const chat = getItem(handle.db, opened.conversation!.id as Uuid)!;
    expect(chat.stepId).toBe(ASSIST_STEP);
    expect(chat.projectId).toBe(projectId);
    expect(shownAssistConversation(handle.db)?.id).toBe(chat.id);

    const comments = listCommentsForItem(handle.db, chat.id);
    expect(comments).toHaveLength(1);
    const brief = comments[0]!;
    expect(brief.authorType).toBe("engine");
    expect(opened.conversation!.messages.map((message) => message.id)).toEqual([brief.id]);
    // The mention is what dispatches the first turn, with nobody typing.
    expect(listMentionsForComment(handle.db, brief.id as Uuid)).toEqual([expect.objectContaining({ targetType: "agent", targetId: assistAgent(handle.db)!.id, status: "open" })]);
    expect(engine.notifyStateChange).toHaveBeenCalledWith({ promptly: true });

    // The project, the pipeline, and the template's own question.
    const pipeline = getPipeline(handle.db, pipelineId)!;
    const question = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === CONTENT)!.document.template!.openingQuestion!;
    expect(question).toContain("first piece you want drafted");
    expect(brief.body).toContain(`- Project: Blog (id: ${projectId})`);
    expect(brief.body).toContain(`- Pipeline: ${pipeline.name} (id: ${pipelineId})`);
    expect(brief.body).toContain(`> ${question}`);
    expect(brief.body).toContain(`\`pipeline\` set to "${pipeline.name}"`);

    // Pinned: what the assistant raises in answer lands on this pipeline.
    expect(assistBoards(chat)).toEqual([{ from: brief.id, pipelineId }]);
    // Listed by what it is about before anybody has said anything.
    expect(listAssistThreads(handle.db).find((thread) => thread.conversation.id === chat.id)?.title).toBe("Help the person file the first piece of work for Blog.");
  });

  it("finds the project's own pipeline when the needs check had none to name", async () => {
    const { projectId, pipelineId } = await useContent();

    const opened = await openFirstItemChatCommand(handle.db, context(), engineStub(), { projectId, slug: CONTENT, pipelineId: null });

    expect(assistBoards(getItem(handle.db, opened.conversation!.id as Uuid)!)).toEqual([expect.objectContaining({ pipelineId })]);
  });

  it("is refused, writing nothing, where there is no assistant to talk to", async () => {
    const { projectId, pipelineId } = await useContent();
    updateAgent(handle.db, assistAgent(handle.db)!.id, { enabled: false });
    const engine = engineStub();
    const before = listAssistThreads(handle.db).length;

    const opened = await openFirstItemChatCommand(handle.db, context(), engine, { projectId, slug: CONTENT, pipelineId });

    expect(opened).toEqual({ conversation: null, problem: "There is no enabled system agent to talk to." });
    expect(listAssistThreads(handle.db)).toHaveLength(before);
    expect(engine.notifyStateChange).not.toHaveBeenCalled();
  });

  it("is refused for a project that is gone", async () => {
    const opened = await openFirstItemChatCommand(handle.db, context(), engineStub(), { projectId: "no-such-project", slug: CONTENT, pipelineId: null });
    expect(opened).toEqual({ conversation: null, problem: "That project no longer exists." });
  });
});

describe("the brief, for a template that brings no question of its own", () => {
  it("asks about the template in its own title and description", () => {
    const body = firstItemBrief({
      template: { title: "Grant applications", description: "A call for proposals becomes a draft application you sign off." },
      project: { id: "p1", name: "Lab" },
      pipeline: { id: "pl1", name: "Applications" },
    });

    expect(body).toContain("- Project: Lab (id: p1)");
    expect(body).toContain('- Pipeline: Applications (id: pl1), set up just now from the template "Grant applications"');
    expect(body).toContain("> Grant applications: A call for proposals becomes a draft application you sign off. What is the first piece of work you want it to take on?");
  });

  it("is what the command posts for a bundled template without one", async () => {
    // Weekly report has a job, and so no question; the command still asks generically.
    const used = await useGalleryCommand(handle.db, context(), { slug: "weekly-report", answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" }, roleSlots: {} });
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
    expect(weekly.document.template!.openingQuestion).toBeUndefined();

    const opened = await openFirstItemChatCommand(handle.db, context(), engineStub(), { projectId: used.projectId!, slug: "weekly-report", pipelineId: used.pipelineId });

    const brief = listCommentsForItem(handle.db, opened.conversation!.id as Uuid)[0]!;
    expect(brief.body).toContain(`> Weekly report: ${weekly.description} What is the first piece of work you want it to take on?`);
  });
});
