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
import { assistantRow } from "../gallery/commands.js";
import { galleryNeedsCommand, openFirstItemChatCommand, staffAssistantCommand, useGalleryCommand } from "./galleryCommands.js";

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

function context(signedInBackends: string[] = []) {
  return { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends };
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

/**
 * The assistant as a line of the needs check (EO-664): the exit above
 * needs it, so a project with no job is not "everything it needs" until
 * the assistant is switched on and runs on a backend this machine is
 * signed in to — and the line's button makes it so, when pressed.
 */
describe("the assistant line, on a project with no job", () => {
  async function assistantLine(signedIn: string[], projectId: string) {
    const needs = await galleryNeedsCommand(handle.db, context(signedIn), { projectId, slug: CONTENT });
    return needs.needs.find((need) => need.key === "assistant");
  }

  it("is red on a fresh installation, whose assistant runs on the placeholder, and its button points it at the signed-in backend", async () => {
    const { projectId } = await useContent();
    expect(assistantRow(handle.db)?.provider).toBe("fake");

    const red = await assistantLine(["claude"], projectId);
    expect(red).toMatchObject({
      line: "The assistant, which plans the first piece of work with you",
      met: false,
      why: "The assistant does not run on a coding agent signed in on this machine yet, so nothing would answer.",
      fix: { kind: "assistant", label: "Use Claude Code for the assistant", target: "claude" },
    });

    expect(staffAssistantCommand(handle.db, context(["claude"]), { backend: "claude" })).toEqual({ ok: true, problem: null });

    expect(assistantRow(handle.db)).toMatchObject({ provider: "claude", enabled: true });
    expect(await assistantLine(["claude"], projectId)).toMatchObject({ met: true, why: null, fix: null });
  });

  it("says a switched-off assistant is off, and turning it on lets the needs check's exit open the chat", async () => {
    const { projectId, pipelineId } = await useContent();
    const assistant = assistantRow(handle.db)!;
    updateAgent(handle.db, assistant.id, { provider: "claude", enabled: false });

    expect(await assistantLine(["claude"], projectId)).toMatchObject({
      met: false,
      why: "The assistant is switched off, so nothing would answer.",
      fix: { kind: "assistant", label: "Turn the assistant on", target: "claude" },
    });
    // Before the repair, the exit is refused rather than opening a chat nobody answers.
    expect((await openFirstItemChatCommand(handle.db, context(["claude"]), engineStub(), { projectId, slug: CONTENT, pipelineId })).conversation).toBeNull();

    expect(staffAssistantCommand(handle.db, context(["claude"]), { backend: "claude" }).ok).toBe(true);

    const needs = await galleryNeedsCommand(handle.db, context(["claude"]), { projectId, slug: CONTENT });
    expect(needs.needs.find((need) => need.key === "assistant")?.met).toBe(true);
    const opened = await openFirstItemChatCommand(handle.db, context(["claude"]), engineStub(), { projectId, slug: CONTENT, pipelineId });
    expect(opened.problem).toBeNull();
    expect(opened.conversation).not.toBeNull();
  });

  it("asks for a sign-in while nothing is signed in", async () => {
    const { projectId } = await useContent();
    expect(await assistantLine([], projectId)).toMatchObject({
      met: false,
      why: "Nothing on this machine is signed in, so the assistant has nothing to run on yet.",
      fix: { kind: "backend", label: "Sign in", target: null },
    });
  });

  it("never switches the assistant on unasked, and refuses a backend nothing here is signed in to", async () => {
    const { projectId } = await useContent();
    const before = assistantRow(handle.db)!;
    await assistantLine(["claude"], projectId);
    expect(assistantRow(handle.db)).toEqual(before);

    const refused = staffAssistantCommand(handle.db, context(["claude"]), { backend: "codex" });
    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("Sign in first");
    expect(assistantRow(handle.db)).toEqual(before);
  });

  it("is not a line for a template with a job, which starts its first item itself", async () => {
    const used = await useGalleryCommand(handle.db, context(), { slug: "weekly-report", answers: { folder, schedule: "monday 08:00", keyPrefix: "REP" }, roleSlots: {} });
    const needs = await galleryNeedsCommand(handle.db, context(["claude"]), { projectId: used.projectId!, slug: "weekly-report" });
    expect(needs.needs.map((need) => need.key)).not.toContain("assistant");
  });
});
