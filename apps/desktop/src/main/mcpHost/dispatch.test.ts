import { McpServerDraftSchema, NO_POLICY, resultsFromRoutes, USER_ATTENTION_TARGET, NOT_ALLOWED_BY_YOUR_ORGANISATION, SkillDraftSchema, SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, uuidv7, type Agent, type GuardConfigView, type IpcChannel, type IpcResponse, type Uuid, UNSCOPED_RUN } from "@eo/core";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createPipeline,
  createProject,
  createRun,
  createStep,
  deferPush,
  enqueueOutbox,
  getAgent,
  getAttachment,
  getComment,
  getItem,
  getJiraBinding,
  getModule,
  getModuleBySlug,
  getPipeline,
  listStepsForPipeline,
  listAgents,
  listCommentsForItem,
  listJiraConnections,
  listModuleTests,
  listPipelines,
  moduleTestFingerprint,
  postComment,
  projectForWorkspace,
  resolveAgentAttachments,
  saveJiraBinding,
  saveModule,
  saveModuleTest,
  setSetting,
  updateRun,
  type Workspace,
} from "../db/repos/index.js";
import { beginAdoption } from "../db/repos/projectsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { PREVIEW_PROJECT_KEY } from "../gallery/commands.js";
import { writePolicy } from "../policy/policy.js";
import type { CliRunner } from "../packs/developer/forge/cli.js";
import type { FetchLike } from "../packs/developer/jira/client.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import { hasToken, type CredentialsOptions } from "../packs/developer/jira/credentials.js";
import type { SecretStore } from "../secrets/store.js";
import { listAgentDetails, readGuards, saveAgent, savePipeline, writeGuards } from "../ipc/configCommands.js";
import { moveItem, postCommentCommand, readSettings, setPinned, writeSettings } from "../ipc/domainCommands.js";
import { getDailyCost, getItemCost } from "../ipc/costHandlers.js";
import { formatDateKey } from "../dateUtils.js";
import { deleteAttachmentCommand } from "../ipc/attachmentCommands.js";
import { AttachmentStorage } from "../attachments/storage.js";
import { detectForge } from "../ipc/forgeCommands.js";
import {
  connectJira,
  disconnectJira,
  jiraFields,
  jiraOutboxView,
  jiraStatuses,
  listJiraConnectionsCommand,
  removeJiraConnection,
  saveJiraConfig,
  saveJiraConnection,
  saveJiraStatusMap,
  saveJiraTransitionFields,
  testJira,
} from "../ipc/jiraCommands.js";
import { listAgentAttachmentsCommand, setAgentAttachmentCommand } from "../ipc/agentAttachmentCommands.js";
import {
  archiveMcpServerCommand,
  clearMcpServerSecretCommand,
  listMcpServerViews,
  saveMcpServerCommand,
  setMcpServerEnabledCommand,
  setMcpServerSecretCommand,
} from "../ipc/mcpServerCommands.js";
import {
  archiveSkillCommand,
  listSkillsCommand,
  listSkillVersionsCommand,
  restoreSkillVersionCommand,
  saveSkillCommand,
  setSkillEnabledCommand,
  setSkillLockedCommand,
} from "../ipc/skillCommands.js";
import { readMcpServerSecret, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { storeOrganisationSecret } from "../policy/organisationSecrets.js";
import { approveModuleCommand, saveModuleCommand } from "../ipc/moduleCommands.js";
import {
  addRepositoryToProjectCommand,
  createProjectCommand,
  listProjectsCommand,
  removeRepositoryFromProjectCommand,
  setActiveProjectCommand,
  updateProjectCommand,
} from "../ipc/projectCommands.js";
import { createPipelineCommand, updatePipelineCommand } from "../ipc/pipelineCommands.js";
import { createRepositoryCommand, listRepositoriesCommand, updateRepositoryCommand } from "../ipc/repositoryCommands.js";
import { getItemSections, listPipelineStepViews, listPipelineViews, listItemSummaries } from "../ipc/domainQueries.js";
import {
  describeRuntime,
  runtimeStatusWithAuth,
  setRuntimeAutomaticUpdates,
  setRuntimeEnabled,
  type RuntimeContext,
} from "../ipc/runtimeCommands.js";
import { invalidateRuntimeAuth, type AuthProbeRunner } from "../runtimes/auth.js";
import { RUNTIMES, versionFor } from "../runtimes/catalog.js";
import { git } from "../packs/developer/workspace/git.js";
import { agentAttachmentsHash } from "../agentAttachments/fingerprint.js";
import { deliverableAttachments } from "../agentAttachments/pluginDirectory.js";
import { providerCacheKey, type ProviderIdentity } from "../engine.js";
import { promptHash } from "../roles/prompts.js";
import { findReusableThread } from "../supervisor/threadReuse.js";
import { archiveProjectCommand, restoreProjectCommand } from "../ipc/archiveProjectCommand.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { clearModuleSecret, listModuleSecrets, setModuleSecret } from "../ipc/moduleSecretCommands.js";
import { clearEnvironmentVariable, listEnvironmentVariables, setEnvironmentVariable } from "../ipc/environmentVariableCommands.js";
import { environmentFor, readSecret, type ModuleSecretsOptions } from "../modules/secrets.js";
import type { ModuleTestRunAnswer } from "../modules/moduleTestRunner.js";
import { TOOLS, type Dispatch } from "./catalog.js";
import { removeScratch } from "../testing/scratch.js";

/**
 * The tools, driven against a real database through the real registry.
 *
 * Handlers are recorded here rather than by `registerAllHandlers`,
 * because that function reaches for `app`, `safeStorage` and
 * `BrowserWindow` — none of which exist under vitest. What is being
 * proved is the seam, not Electron: a tool that dispatches through the
 * registry reaches the same handler the renderer would.
 */
const opts = { exposeErrorDetails: true };
const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

/** A module as a client would send one — no `approve`, because none is offered. */
const moduleArgs = {
  slug: "deploy",
  name: "Deploy",
  description: "Builds and deploys the current branch to staging.",
  code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
  manifest: {
    name: "Deploy",
    description: "Builds and deploys the current branch to staging.",
    inputs: {},
    needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
    results: ["deployed", "failed"],
  },
};

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

describe("a read tool", () => {
  it("renders what the renderer would have been given", async () => {
    createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:list", () => listItemSummaries(handle.db, null), opts);

    const outcome = await tool("tickets_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Rate limit the import");
    expect(outcome.refused).toBe(false);
    // The machine-readable copy travels beside the prose, unchanged.
    expect(outcome.data).toMatchObject({ items: [{ title: "Rate limit the import" }] });
  });

  it("reads a project other than the one the window is showing, without switching it", async () => {
    // Why `project_set_active` can be offered at all: a read says its
    // scope rather than switching to it, so nothing but the tool that
    // announces itself ever moves what the person is looking at.
    const seen: (string | null)[] = [];
    registerHandler("items:list", (payload) => {
      seen.push(payload.projectId ?? null);
      return { items: [] };
    }, opts);

    await tool("tickets_list").run(dispatch, { projectId: "another-project" });
    await tool("tickets_list").run(dispatch, {});

    // Explicit when given, and the active project's fallback when not.
    expect(seen).toEqual(["another-project", null]);
  });

  it("sends undefined, not {}, to a channel that takes nothing", async () => {
    // The whole reason isVoidChannel exists. Every MCP client puts `{}`
    // on the wire for a tool with an empty schema, and z.void() rejects
    // it — so without the translation this call fails validation before
    // it reaches anything.
    const handler = vi.fn(() => ({ projects: [], activeProjectId: null }));
    registerHandler("projects:list", handler, opts);

    const outcome = await tool("projects_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("says plainly when there is nothing to show", async () => {
    registerHandler("items:list", () => listItemSummaries(handle.db, null), opts);

    const outcome = await tool("tickets_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // An empty string here would read as a broken tool rather than an
    // empty project.
    expect(outcome.text).toBe("No tickets here.");
  });

  it("reports a rejected argument instead of pretending it worked", async () => {
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const outcome = await tool("ticket_get").run(dispatch, { ticketId: 7 });

    expect(outcome.ok).toBe(false);
  });

  it("answers for an item that does not exist without erroring", async () => {
    // `items:get` is nullable by contract: "no such item" is an
    // answer, not a fault, and the tool has to say which.
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const outcome = await tool("ticket_get").run(dispatch, { ticketId: "01920000-0000-7000-8000-000000000000" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("No ticket with that id");
  });

  it("reports an unregistered channel as a tool failure, not a crash", async () => {
    const outcome = await tool("inbox_list").run(dispatch, {});

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("no handler registered") });
  });
});

describe("an item read", () => {
  it("warns that a run is in progress, because that is what refuses a move", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Needs a decision", stepId: "todo" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const outcome = await tool("ticket_get").run(dispatch, { ticketId: item.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The line that stops a model reading an item, deciding to move it,
    // and then being refused for a reason the read could have told it.
    expect(outcome.text).toContain("a run is in progress");
    expect(outcome.text).toContain("Needs a decision");
  });

  it("says nothing about a run when there is none", async () => {
    // The other half: a warning on every item would be noise a model
    // learns to skip, which is the same as not having one.
    const item = createTestItem(handle.db, { type: "story", title: "Quiet", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const outcome = await tool("ticket_get").run(dispatch, { ticketId: item.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).not.toContain("a run is in progress");
  });
});

describe("a tool whose advertised schema is not its channel's", () => {
  it("dispatches what the override produced, not what the client sent", async () => {
    // `worktrees:list` requires `repositoryId` — nullable, but present.
    // The tool advertises it as optional so a caller can say nothing and
    // mean "every repository"; that only works if the default it
    // declares actually reaches the channel.
    const seen: unknown[] = [];
    registerHandler("worktrees:list", (payload) => {
      seen.push(payload);
      return { worktrees: [], problem: null };
    }, opts);

    const outcome = await tool("worktrees_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ repositoryId: null }]);
  });

  it("keeps a headless caller away from a native dialog", async () => {
    // `pipelines:export` defaults to putting a save dialog in front of a
    // person. There is nobody on this side of it to answer one, so the
    // tool pins `destination` — and pinning it in the advertised schema
    // alone would be decoration: the value has to arrive at the handler.
    const seen: unknown[] = [];
    registerHandler("pipelines:export", (payload) => {
      seen.push(payload);
      return { written: false, path: null, document: "{}", problem: null };
    }, opts);

    await tool("pipeline_export").run(dispatch, { pipelineId: "p1" });

    expect(seen).toEqual([{ pipelineId: "p1", destination: "document" }]);
  });

  it("drops a self-approval a crafted call sent anyway", async () => {
    // `module_save` advertises no `approve` field, but the advertised
    // schema is only a description — nothing stops a client putting the
    // field on the wire. `modules:save` has no such field any more
    // (EO-353), so the parse drops it and the *handler* never sees it: a
    // module is code EO later runs unsandboxed, and writing it must not
    // approve it.
    const seen: unknown[] = [];
    registerHandler("modules:save", (payload) => {
      seen.push(payload);
      return { saved: true, module: null, problem: null, approvalWithdrawn: false };
    }, opts);

    await tool("module_save").run(dispatch, { ...moduleArgs, approve: true });

    expect(seen).toEqual([expect.objectContaining({ slug: "deploy" })]);
    expect(seen[0]).not.toHaveProperty("approve");
  });
});

describe("a write tool", () => {
  it("posts a comment through the same handler the composer uses", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    registerHandler("comments:post", (payload) => postCommentCommand(handle.db, undefined, payload), opts);

    const outcome = await tool("comment_post").run(dispatch, { ticketId: item.id, body: "Looks right to me." });

    expect(outcome.ok).toBe(true);
    // Written where the UI would have written it, not into a parallel store.
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toContain("Looks right to me.");
  });

  it("reports a refusal as an answer, not a failure, and names the way past it", async () => {
    // The case the whole `refusal` mechanism exists for. `items:move`
    // answers `{moved: false, blockedByActiveRun: true}` on a *successful*
    // call: reporting that as a protocol error would tell a model its
    // request was malformed when it was merely declined.
    const item = createTestItem(handle.db, { type: "story", title: "Busy", stepId: "todo" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
    registerHandler("items:move", (payload) => moveItem(handle.db, undefined, payload), opts);

    const outcome = await tool("ticket_move").run(dispatch, { ticketId: item.id, toStepId: "review" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("cancelActiveRun: true");
    expect(outcome.text).toContain("Nothing has changed");
    // And the structured half still carries the fact, for anything reading it.
    expect(outcome.data).toMatchObject({ moved: false, blockedByActiveRun: true });
    // Most importantly: the item did not move.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("moves the item when the refusal is answered", async () => {
    // The other half, so the refusal above is known to be a guard rather
    // than a tool that never works.
    const item = createTestItem(handle.db, { type: "story", title: "Ready", stepId: "todo" });
    registerHandler("items:move", (payload) => moveItem(handle.db, undefined, payload), opts);

    const outcome = await tool("ticket_move").run(dispatch, { ticketId: item.id, toStepId: "review", comment: "Needs a second look." });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    // The note went in as a comment, because that is the only channel
    // there is — a move with intent attached that was not a comment
    // would be a side channel by definition.
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toContain("Needs a second look.");
  });

  it("answers a step and a pipeline that disagree in words rather than as a failure (EO-70)", async () => {
    // The refusal the hand-off needs. `transitionItem` throws on a pair
    // that disagrees — right for the one function allowed to write both
    // columns — but off a packaged build `handleIpcRequest` turns a throw
    // into "Internal error", which tells a model nothing and would have
    // it retry the same call. So the pair is resolved before anything is
    // written and the answer is a sentence.
    const item = createTestItem(handle.db, { type: "story", title: "Ready to merge", stepId: "todo" });
    const merge = createPipeline(handle.db, { name: "Merge" });
    createStep(handle.db, { id: "mg_merge", pipelineId: merge.id, position: 0, name: "Merge It", ownerRole: "reviewer", entryAction: "review" });
    registerHandler("items:move", (payload) => moveItem(handle.db, undefined, payload), opts);

    // `review` is the default pipeline's step, so it is not Merge's to
    // arrive on. The call itself still succeeds: the answer is no.
    const raw = await dispatchIpc("items:move", { itemId: item.id, toStepId: "review", toPipelineId: merge.id });
    expect(raw.ok).toBe(true);

    const outcome = await tool("ticket_move").run(dispatch, { ticketId: item.id, toStepId: "review", toPipelineId: merge.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    // Both halves named, and where the right ids come from.
    expect(outcome.text).toContain("Review");
    expect(outcome.text).toContain("Merge");
    expect(outcome.text).toContain("pipeline_get");
    expect(outcome.text).toContain("Nothing has changed");
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", pipelineId: "default" });
  });

  it("hands an item to another pipeline when the step and the pipeline agree", async () => {
    // The other half, so the refusal above is known to be a guard rather
    // than a tool that cannot hand anything over.
    const item = createTestItem(handle.db, { type: "story", title: "Ready to merge", stepId: "todo" });
    const merge = createPipeline(handle.db, { name: "Merge" });
    const step = createStep(handle.db, { id: "mg_merge", pipelineId: merge.id, position: 0, name: "Merge It", ownerRole: "reviewer", entryAction: "review" });
    registerHandler("items:move", (payload) => moveItem(handle.db, undefined, payload), opts);

    const outcome = await tool("ticket_move").run(dispatch, { ticketId: item.id, toStepId: step.id, toPipelineId: merge.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    // Both columns, on the row: the step alone is the half-move this
    // whole path exists to prevent.
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: step.id, pipelineId: merge.id });
  });

  it("writes a module that lands unapproved, however the call asked", async () => {
    // Through the real command and against the real row, because the
    // response is the tool's own account of what happened and the point
    // here is what is on disk. `approvedAt` null is what keeps the module
    // inert: EO will not publish a pipeline naming it.
    registerHandler("modules:save", (payload) => saveModuleCommand(handle.db, payload), opts);

    const outcome = await tool("module_save").run(dispatch, { ...moduleArgs, approve: true });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(getModuleBySlug(handle.db, "deploy")?.approvedAt).toBeNull();
    // And the model is told, rather than left to assume its module runs.
    expect(outcome.text).toContain("not approved");
  });
});

/**
 * Machine-specific values in what `module_save` and `module_test_save`
 * wrote (EO-449): the answer names each one and what to use instead,
 * and says nothing was refused — because nothing was.
 */
describe("machine-specific values in an eo_admin answer", () => {
  it("module_save names them, and saves anyway", async () => {
    registerHandler("modules:save", (payload) => saveModuleCommand(handle.db, payload), opts);

    const outcome = await tool("module_save").run(dispatch, {
      ...moduleArgs,
      code: 'export default async function run(ctx) {\n  await ctx.exec("flyctl", ["deploy", "/home/dev/app"]);\n  return { ok: true, result: "deployed" };\n}',
    });

    expect(outcome.ok && outcome.refused).toBe(false);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('code line 2: "/home/dev/app" is a path that only exists on one machine — use ctx.cwd');
    expect(outcome.text).toContain("nothing was refused");
    expect(getModuleBySlug(handle.db, "deploy")).toBeDefined();
  });

  it("module_save says nothing about them when there are none", async () => {
    registerHandler("modules:save", (payload) => saveModuleCommand(handle.db, payload), opts);

    const outcome = await tool("module_save").run(dispatch, moduleArgs);

    expect(outcome.ok && outcome.text).not.toContain("only hold on this machine");
  });

  it("module_test_save names them in the case it saved, leaving its scripted output alone", async () => {
    const source = [
      "export default async (harness) => {",
      '  await harness.run({ inputs: { url: "http://127.0.0.1:8080" },',
      "    exec: [{ bin: \"git\", stderr: \"fatal: 'main' is already checked out at '/home/dev/app'\" }] });",
      "};",
    ].join("\n");
    registerHandler("moduleTests:save", (payload) => ({
      saved: true,
      test: { id: "t1", moduleId: payload.moduleId, description: payload.description, source: payload.source, createdAt: 1, updatedAt: 1 },
      problem: null,
      approvalWithdrawn: false,
    }), opts);

    const outcome = await tool("module_test_save").run(dispatch, { moduleId: "m1", description: "calls the local API", source });

    expect(outcome.ok && outcome.refused).toBe(false);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('test case "calls the local API" line 2: "127.0.0.1:8080" is a loopback address');
    expect(outcome.text).not.toContain("/home/dev/app");
  });
});

/**
 * The same advice in `pipeline_import_check`'s answer (EO-451): what a
 * pack carries that only holds on the machine it was written on, named
 * by the prompt or module it is in — the lines the import screens show.
 */
describe("machine-specific values in pipeline_import_check's answer", () => {
  const preflight = (machineSpecific: NonNullable<IpcResponse<"pipelines:importPreflight">["preflight"]>["machineSpecific"]) => ({
    preflight: {
      pipelineName: "Shipping",
      missingBinaries: [],
      missingSecrets: [],
      wantsNetwork: [],
      readsItems: [],
      postsComments: [],
      attachesFiles: [],
      createsItems: [],
      collisions: [],
      roleSlots: [],
      connectors: [],
      capabilities: [],
      refusal: null,
      itemTypes: [],
      oldNames: [],
      machineSpecific,
      moduleCount: 1,
    },
    document: "{}",
    problem: null,
  });

  it("names each one by where it is, and says the import is not refused", async () => {
    registerHandler(
      "pipelines:importPreflight",
      () =>
        preflight([
          {
            where: "the release_manager prompt",
            warnings: [{ where: { in: "instructions", line: 2 }, text: "/Users/alex/work", kind: "machine_path", instead: "refer to the step's working directory" }],
          },
          {
            where: "Deploy",
            warnings: [{ where: { in: "test", description: "fails cleanly", line: 2 }, text: "C:\\\\builds", kind: "windows_path", instead: "use harness.cwd" }],
          },
        ]),
      opts,
    );

    const outcome = await tool("pipeline_import_check").run(dispatch, { document: "{}" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('- the release_manager prompt, instructions line 2: "/Users/alex/work" is a path that only exists on one machine');
    expect(outcome.text).toContain('- Deploy, test case "fails cleanly" line 2: "C:\\\\builds" is a Windows drive path — use harness.cwd.');
    expect(outcome.text).toContain("the import is not refused or changed because of it");
  });

  it("says nothing about them when there are none", async () => {
    registerHandler("pipelines:importPreflight", () => preflight([]), opts);

    const outcome = await tool("pipeline_import_check").run(dispatch, { document: "{}" });

    expect(outcome.ok && outcome.text).not.toContain("only hold on the machine");
  });
});

/**
 * The same advice on the other shared things eo_admin saves (EO-450): a
 * pipeline's steps, an agent's instructions, a skill's body. Each answer
 * names the warnings, and each save happens exactly as it would without them.
 */
describe("machine-specific values in what pipeline_save, agent_save and skill_save wrote", () => {
  it("pipeline_save names them by step and field, and publishes anyway", async () => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const [first, ...rest] = graph.steps;
    if (first === undefined) throw new Error("the seeded pipeline has steps");
    const steps = [{ ...first, instructionsSummary: "Check out the repo.\nIt lives at /home/dev/app." }, ...rest];

    const outcome = await tool("pipeline_save").run(dispatch, { pipelineId: "default", steps, routes: graph.routes, entryStepId: graph.entryStepId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as IpcResponse<"pipeline:save">).saved).toBe(true);
    expect(outcome.text).toContain(`step "${first.name}" instructions summary line 2: "/home/dev/app." is a path that only exists on one machine`);
    expect(outcome.text).toContain("nothing was refused");
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.find((step) => step.id === first.id)?.instructionsSummary).toContain("/home/dev/app");
  });

  it("pipeline_save stores entry rules and pipeline_validate holds them to the same refusal (EO-610)", async () => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const sent = { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId };

    const refused = await tool("pipeline_save").run(dispatch, { ...sent, entryRules: [{ kind: "telepathy" }] });
    expect(refused.ok && refused.text).toContain("telepathy");

    const rules = [{ kind: "description", types: ["developer:story"], message: "a write-up" }];
    expect((await tool("pipeline_save").run(dispatch, { ...sent, entryRules: rules })).ok).toBe(true);
    expect(listPipelineStepViews(handle.db, { pipelineId: "default" }).entryRules).toEqual(rules);
  });

  it("pipeline_save says nothing about them when there are none", async () => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });

    const outcome = await tool("pipeline_save").run(dispatch, { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId });

    expect(outcome.ok && outcome.text).not.toContain("only hold on this machine");
  });

  it("agent_save names them by line, and saves anyway", async () => {
    registerHandler("agents:listDetailed", () => listAgentDetails(handle.db), opts);
    registerHandler("agents:save", (payload) => saveAgent(handle.db, payload), opts);
    const instructions = "Run the suite.\nThe staging API is at http://localhost:8080.";

    const outcome = await tool("agent_save").run(dispatch, { name: "Vega", role: "tester", provider: "fake", instructions });

    expect(outcome.ok && outcome.refused).toBe(false);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('instructions line 2: "localhost:8080" is a loopback address');
    expect(outcome.text).toContain("nothing was refused");
    expect(listAgents(handle.db).find((agent) => agent.name === "Vega")?.instructions).toBe(instructions);
  });

  it("skill_save names them by line, and saves anyway", async () => {
    registerHandler("skills:save", (payload) => saveSkillCommand(handle.db, payload), opts);

    const outcome = await tool("skill_save").run(dispatch, { name: "Deploy", description: "How we deploy.", body: "# Deploy\nRun ~/bin/deploy.sh first." });

    expect(outcome.ok && outcome.refused).toBe(false);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('skill body line 2: "~/bin/deploy.sh" is somebody\'s home directory');
    expect(outcome.text).toContain("nothing was refused");
    expect(listSkillsCommand(handle.db, {}).skills.map((skill) => skill.slug)).toEqual(["deploy"]);
  });
});

/**
 * `module_approve` runs the module's tests, and under 80% line coverage
 * it refuses with the figure until it is told the person accepted it
 * (EO-353). The runner is scripted — what is proved here is the tool's
 * seam and its words; the tests really running is moduleCommands.test.ts.
 */
describe("approving a module over eo_admin", () => {
  function moduleWithCoverage(percent: number): string {
    const saved = saveModule(handle.db, { ...moduleArgs, source: "architect" });
    if (!saved.ok) throw new Error(saved.reason);
    const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: "deploys", source: "export default async function () {}" });
    if (!test.ok) throw new Error(test.reason);
    const runner = {
      run: async (moduleId: string): Promise<ModuleTestRunAnswer> => {
        const module = getModule(handle.db, moduleId)!;
        return {
          run: {
            ranAt: 1,
            cases: [{ testId: test.test.id, description: "deploys", passed: true, failure: null, durationMs: 1, output: "" }],
            coverage: { lines: { covered: percent, total: 100, percent }, branches: { covered: 1, total: 2, percent: 50 } },
          },
          fingerprint: moduleTestFingerprint(module, listModuleTests(handle.db, moduleId)),
          problem: null,
        };
      },
    };
    registerHandler("modules:approve", (payload) => approveModuleCommand(handle.db, runner, payload), opts);
    return saved.module.id;
  }

  it("advertises the acknowledgement parameter", () => {
    const properties = (tool("module_approve").inputSchema["properties"] ?? {}) as Record<string, unknown>;
    expect(Object.keys(properties)).toContain("acknowledgeLowCoverage");
    expect(tool("module_approve").description).toContain("acknowledgeLowCoverage");
  });

  it("refuses under the bar with the coverage figure, and approves when the acknowledgement is passed", async () => {
    const id = moduleWithCoverage(62.5);

    const refused = await tool("module_approve").run(dispatch, { id });
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain("62.5%");
    expect(refused.text).toContain("acknowledgeLowCoverage: true");
    expect(getModule(handle.db, id)?.approvedAt).toBeNull();

    const approved = await tool("module_approve").run(dispatch, { id, acknowledgeLowCoverage: true });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.refused).toBe(false);
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
  });

  it("approves a module with machine-specific values, and names them in the answer", async () => {
    const id = moduleWithCoverage(90);
    saveModule(handle.db, { ...moduleArgs, id, source: "architect", manifest: { ...moduleArgs.manifest, needs: { ...moduleArgs.manifest.needs, bin: ["flyctl", "pwsh"] } } });

    const approved = await tool("module_approve").run(dispatch, { id });

    expect(approved.ok && approved.refused).toBe(false);
    if (!approved.ok) return;
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
    expect(approved.text).toContain('manifest needs.bin "pwsh": "pwsh" is a shell');
  });

  it("approves at the bar without being asked to acknowledge anything", async () => {
    const id = moduleWithCoverage(80);

    const approved = await tool("module_approve").run(dispatch, { id });
    expect(approved.ok && approved.refused).toBe(false);
    expect(getModule(handle.db, id)?.approvedAt).not.toBeNull();
  });
});

/**
 * A stored guard config that differs from the defaults in every field.
 *
 * The point of the merge is that it starts from what is *there*, and a
 * config left at `DEFAULT_GUARD_CONFIG` cannot tell "merged with the
 * current values" apart from "merged with the defaults" — a composite
 * that read nothing and merged into the defaults would pass every
 * assertion below.
 */
const STORED_GUARDS: GuardConfigView = {
  globalConcurrency: 4,
  perRepositoryConcurrency: 3,
  perAgentConcurrency: 2,
  perItemAttemptLimit: 7,
  wallClockTimeoutMs: 10 * 60 * 1000,
  inactivityTimeoutMs: 4 * 60 * 1000,
  perItemBudgetCents: 250,
  dailyBudgetCents: 1_000,
  // Differs from the default (true) for the same reason every field
  // here does: a merge that read nothing would still pass.
  interpretReplies: false,
  agentMentionDepth: 6,
  watchRoundTripsPerItem: 9,
  memoryDeliveryChars: 6_000,
  memoryScopeMaxEntries: 150,
  memoryScopeMaxChars: 30_000,
  skillStaleAfterRuns: 15,
  skillArchiveAfterRuns: 40,
  trialsFirst: false,
  trialRoundsPerDraft: 6,
  trialBudgetCentsPerDraft: 900,
  trialStopOnRepeatedFailure: false,
};

describe("a pin, through the tool that sets it", () => {
  beforeEach(() => {
    registerHandler("comments:post", (payload) => postCommentCommand(handle.db, undefined, payload), opts);
    registerHandler("comments:setPinned", (payload) => setPinned(handle.db, payload), opts);
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
  });

  it("pins a comment, and takes the pin off again", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    const posted = await tool("comment_post").run(dispatch, { ticketId: item.id, body: "Cap it at 100/minute, per key." });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const commentId = (posted.data as IpcResponse<"comments:post">).commentId;

    const pinned = await tool("comment_pin").run(dispatch, { commentId, pinned: true });

    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.refused).toBe(false);
    // Against the row, because the reply is the tool's own account of it.
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.id === commentId)?.pinned).toBe(true);

    // And back off, which is the same tool rather than a missing one.
    const unpinned = await tool("comment_pin").run(dispatch, { commentId, pinned: false });

    expect(unpinned.ok).toBe(true);
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.id === commentId)?.pinned).toBe(false);
    // The comment itself survives the unpin — that is what makes this an
    // ordinary write rather than something the gate should be holding.
    expect(listCommentsForItem(handle.db, item.id).map((comment) => comment.body)).toContain("Cap it at 100/minute, per key.");
  });

  it("refuses an id no comment has, rather than reporting a pin it did not make", async () => {
    // `setCommentPinned` is an UPDATE by id: nothing matched, nothing
    // was written, and nothing raised. Answering with the `pinned` that
    // was sent would tell a client that a comment EO has never held is
    // now the one every agent reads first.
    const outcome = await tool("comment_pin").run(dispatch, { commentId: uuidv7(), pinned: true });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.data).toMatchObject({ found: false });
    expect(outcome.text).toContain("ticket_get");
    expect(outcome.text).toContain("Nothing has changed");
  });

  it("refuses an unpin of a comment that is not there either", async () => {
    // The other direction of the same call, because `pinned: false` and
    // "there is no such comment" are the two ways a reply can carry a
    // false and they must not read the same.
    const outcome = await tool("comment_pin").run(dispatch, { commentId: uuidv7(), pinned: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).not.toContain("Comment unpinned");
  });

  it("marks the pin where the reader will find it", async () => {
    // ticket_get is the only place a client can read a pin back, and it
    // is also where the comment id it just pinned came from.
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    const posted = await tool("comment_post").run(dispatch, { ticketId: item.id, body: "Cap it at 100/minute, per key." });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    await tool("comment_pin").run(dispatch, { commentId: (posted.data as IpcResponse<"comments:post">).commentId, pinned: true });
    const read = await tool("ticket_get").run(dispatch, { ticketId: item.id });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toContain("[pinned]");
  });
});

describe("what the budget guards are measured against", () => {
  const implementer = () => listAgents(handle.db).find((agent) => agent.role === "implementer")!;

  function costedRun(itemId: Uuid, costCents: number, startedAt: number): void {
    const run = createRun(handle.db, { itemId, agentId: implementer().id, action: "implement", status: "succeeded" });
    updateRun(handle.db, run.id, { costCents, startedAt, endedAt: startedAt });
  }

  beforeEach(() => {
    registerHandler("costs:getDaily", (payload) => getDailyCost(handle.db, payload), opts);
    registerHandler("costs:getForItem", (payload) => getItemCost(handle.db, payload), opts);
  });

  it("reports the day without being asked about an item", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    const other = createTestItem(handle.db, { type: "story", title: "Import", stepId: "todo" });
    costedRun(item.id, 350, Date.now());
    costedRun(other.id, 125, Date.now());

    const outcome = await tool("spend_read").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("$4.75");
    // No item was asked about, so none is reported — a zero here would
    // read as an item that has cost nothing.
    expect(outcome.data).toMatchObject({ dailyCostCents: 475, item: null });
    expect(outcome.text).toContain("guardrails_get");
  });

  it("reports one item's whole spend alongside the day's", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    const other = createTestItem(handle.db, { type: "story", title: "Import", stepId: "todo" });
    costedRun(item.id, 350, Date.now());
    costedRun(item.id, 100, Date.now());
    costedRun(other.id, 125, Date.now()); // somebody else's spend — in the day, not in the item

    const outcome = await tool("spend_read").run(dispatch, { ticketId: item.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toMatchObject({ dailyCostCents: 575, item: { itemId: item.id, costCents: 450 } });
    expect(outcome.text).toContain("$4.50");
    expect(outcome.text).toContain("$5.75");
  });

  /**
   * The quietest of the twelve, and the reason the boundary handles this
   * key rather than dropping it.
   *
   * `ticketId` is optional here — omitting it is how a caller asks for
   * the day alone. So a call that sent the *new* spelling used to parse
   * as "no item named", and the tool answered with today's total across
   * everything: a real figure, correctly computed, and not the one
   * anybody asked for, with nothing in the answer to say so. KAN-145
   * refused it by name; KAN-162 takes it, which is the same bug closed
   * from the other side — either spelling names the item the caller
   * meant.
   */
  it("answers about the item when the new spelling is what was sent", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    costedRun(item.id, 350, Date.now());

    const outcome = await tool("spend_read").run(dispatch, { itemId: item.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Specifically not the shape of the old bug: an answer carrying only
    // the day.
    expect(outcome.data).toMatchObject({ item: { itemId: item.id, costCents: 350 } });
  });

  /**
   * The one case that is still refused, and the only one where EO would
   * otherwise have to guess: two spellings of one field, naming two
   * different items.
   */
  it("refuses a call that spells the same field both ways", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    costedRun(item.id, 350, Date.now());

    const outcome = await tool("spend_read").run(dispatch, { itemId: item.id, ticketId: uuidv7() });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues?.join(" ")).toContain("ticketId");
    expect(outcome.message).toContain("spend_read");
  });

  it("says which of the two things an item costing nothing might be", async () => {
    // 0¢ is the answer both for an item nothing has run on and for an id
    // EO has never seen, and a figure cannot say which it is.
    const outcome = await tool("spend_read").run(dispatch, { ticketId: uuidv7() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("$0.00");
    expect(outcome.text).toContain("ticket_get says which");
  });

  it("reads an earlier day, and refuses a date that is not one", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    costedRun(item.id, 900, yesterday);
    costedRun(item.id, 100, Date.now());

    const earlier = await tool("spend_read").run(dispatch, { date: formatDateKey(yesterday) });
    expect(earlier.ok).toBe(true);
    if (!earlier.ok) return;
    expect(earlier.data).toMatchObject({ date: formatDateKey(yesterday), dailyCostCents: 900 });

    // The channel would turn this into NaN bounds and answer $0.00 —
    // a wrong figure that reads exactly like a right one — so the tool
    // refuses it before dispatching.
    const refused = await tool("spend_read").run(dispatch, { date: "yesterday" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues?.join(" ")).toContain("YYYY-MM-DD");
  });

  it("refuses a date that is shaped right and is not a day", async () => {
    // The worse half of the same bug, and the one the shape check let
    // through: `new Date(2026, 1, 31)` is 3 March rather than an error,
    // so this would have answered with 3 March's spend under a February
    // label — a figure with nothing wrong-looking about it at all.
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit", stepId: "todo" });
    costedRun(item.id, 700, Date.now());

    for (const date of ["2026-02-31", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      const refused = await tool("spend_read").run(dispatch, { date });

      expect(refused.ok, date).toBe(false);
      if (refused.ok) return;
      expect(refused.issues?.join(" "), date).toContain("day that exists");
    }

    // And the leap day that is one, so the check is refusing impossible
    // days rather than unusual ones. Nothing ran on it, while today has
    // 700 on it — which is also what says the day asked for is the day
    // answered rather than today under another label.
    const leap = await tool("spend_read").run(dispatch, { date: "2028-02-29" });
    expect(leap.ok).toBe(true);
    if (!leap.ok) return;
    expect(leap.data).toMatchObject({ date: "2028-02-29", dailyCostCents: 0 });
  });
});

describe("EO's own settings, through the pair that reads and writes them", () => {
  beforeEach(() => {
    registerHandler("settings:get", () => readSettings(handle.db), opts);
    registerHandler("settings:set", (payload) => writeSettings(handle.db, payload), opts);
  });

  it("writes the one key it was given and leaves the others where they were", async () => {
    // Away from the defaults first, so "unchanged" below means the write
    // preserved these rather than never having moved them.
    await tool("settings_write").run(dispatch, { archiveAfterDays: 30, jiraPullMinutes: 15, branchPrefix: "acme", pipelineVersionsToKeep: 7, moduleVersionsToKeep: 4 });

    const written = await tool("settings_write").run(dispatch, { doNotDisturb: true });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.refused).toBe(false);
    // Read back through the other tool, not from the write's own reply:
    // the claim is about what is stored, and a write that only echoed
    // its argument would satisfy the reply.
    const read = await tool("settings_read").run(dispatch, {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data).toEqual({ doNotDisturb: true, archiveAfterDays: 30, jiraPullMinutes: 15, branchPrefix: "acme", pipelineVersionsToKeep: 7, moduleVersionsToKeep: 4 });
    // And settings_read says it in words, as it does the others (EO-359).
    expect(read.text).toContain("pipeline versions to keep: 7");
    expect(read.text).toContain("module versions to keep: 4");
  });

  it("reports every preference after a write, including the ones it did not touch", async () => {
    // What makes a partial write safe to make: the reply is the whole
    // object, so a caller can see what it left alone without a second call.
    await tool("settings_write").run(dispatch, { branchPrefix: "acme", jiraPullMinutes: 15 });

    const outcome = await tool("settings_write").run(dispatch, { archiveAfterDays: null });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("never");
    expect(outcome.text).toContain("every 15 minute(s)");
    expect(outcome.text).toContain("acme");
  });
});

describe("a composite tool", () => {
  it("changes the field it was sent and leaves the rest at their stored values", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", (payload) => writeGuards(handle.db, payload), opts);

    const outcome = await tool("guardrails_set").run(dispatch, { dailyBudgetCents: 5_000 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    // Everything else is exactly what was stored — which is the whole
    // reason this tool reads before it writes: `guards:set` demands all
    // seven fields, and a caller sending only the budget would otherwise
    // have to restate six values it never meant to touch.
    expect(readGuards(handle.db)).toEqual({ ...STORED_GUARDS, dailyBudgetCents: 5_000 });
    expect(outcome.text).toContain("$50.00");
    expect(outcome.text).toContain("4 global");
  });

  /**
   * The budget fields are optional, and that is what made this the worst
   * of the breakages KAN-145 nearly shipped.
   *
   * `guardrails_set` advertises its arguments from `GuardConfigSchema`,
   * so renaming `perTicketBudgetCents` to `perItemBudgetCents` renamed
   * what the tool accepts. Zod strips a key it does not know rather than
   * refusing it, so a client sending the name it had always sent got
   * `{ saved: true }` for a write that never happened — the tool read
   * the guards, laid an empty patch over them, and wrote them back
   * unchanged. A caller cannot tell that from success.
   */
  it("writes a budget sent under the name the tool has always taken", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", (payload) => writeGuards(handle.db, payload), opts);

    const outcome = await tool("guardrails_set").run(dispatch, { perTicketBudgetCents: 2_500, perTicketAttemptLimit: 5 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(readGuards(handle.db)).toEqual({ ...STORED_GUARDS, perItemBudgetCents: 2_500, perItemAttemptLimit: 5 });
  });

  /**
   * And the other half of the same bargain: the new spelling *writes*,
   * rather than being ignored.
   *
   * Ignoring it is what a plain `z.object` does, and on an optional
   * field that is indistinguishable from success — the tool reads the
   * guards, lays an empty patch over them, writes them back unchanged
   * and answers "saved". A caller cannot tell that from having got what
   * it asked for, which is the entire failure this boundary exists to
   * prevent. KAN-145 refused it by name because there was nothing yet to
   * migrate to; KAN-162 writes it, and the failure mode is closed either
   * way.
   */
  it("writes a budget sent under EO's own name for it", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", (payload) => writeGuards(handle.db, payload), opts);

    const outcome = await tool("guardrails_set").run(dispatch, { perItemBudgetCents: 2_500 });

    expect(outcome.ok).toBe(true);
    expect(readGuards(handle.db)).toEqual({ ...STORED_GUARDS, perItemBudgetCents: 2_500 });
  });

  it("writes the attempt limit under either name too, not only the budget", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", (payload) => writeGuards(handle.db, payload), opts);

    const outcome = await tool("guardrails_set").run(dispatch, { perItemAttemptLimit: 5 });

    expect(outcome.ok).toBe(true);
    expect(readGuards(handle.db)).toEqual({ ...STORED_GUARDS, perItemAttemptLimit: 5 });
  });

  /**
   * The case that is still refused, and it is the quiet one: a patch
   * naming one limit twice, with two different numbers. Nothing is read
   * and nothing is written — the refusal happens before either dispatch.
   */
  it("refuses a patch that spells the same limit both ways, and writes nothing", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    const set = vi.fn((payload: GuardConfigView) => writeGuards(handle.db, payload));
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", set, opts);

    const outcome = await tool("guardrails_set").run(dispatch, { perItemBudgetCents: 2_500, perTicketBudgetCents: 3_000 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The answer is in the refusal: a caller told only "invalid" retries
    // the same call.
    expect(outcome.issues?.join(" ")).toContain("perTicketBudgetCents");
    expect(set).not.toHaveBeenCalled();
    expect(readGuards(handle.db)).toEqual(STORED_GUARDS);
  });

  it("refuses a guardrail outside its range by name, and writes nothing", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    const set = vi.fn((payload: GuardConfigView) => writeGuards(handle.db, payload));
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", set, opts);

    // 16 is the cap; 99 is the kind of number a model picks when it has
    // decided concurrency is the problem.
    const outcome = await tool("guardrails_set").run(dispatch, { globalConcurrency: 99 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Named, because a caller told only that a number is too big has to
    // guess which of the seven it sent was wrong — and guessing is how a
    // limit nobody asked about gets rewritten.
    expect(outcome.issues?.join("\n")).toContain("globalConcurrency");
    expect(outcome.message).toContain("Nothing has been written");
    // And it did not reach the write at all, rather than writing
    // something the channel then rejected.
    expect(set).not.toHaveBeenCalled();
    expect(readGuards(handle.db)).toEqual(STORED_GUARDS);
  });

  /**
   * The refusal the channel itself makes (EO-162).
   *
   * Every other guardrail is independent, so `guards:set` could answer
   * with the configuration and be believed. A run timeout under a module
   * step's own time limit is the one write it declines — and a tool that
   * reported "written, here is the configuration" while nothing changed
   * would be the quiet no-op this whole story is about, told to an agent
   * this time instead of to a person.
   */
  it("reports a run timeout the channel declined as a refusal, not as a result", async () => {
    writeGuards(handle.db, STORED_GUARDS);
    createStep(handle.db, {
      id: "merge_slow",
      pipelineId: "default" as Uuid,
      position: 40,
      name: "Merge",
      type: "module",
      entryAction: "some-module",
      timeoutMs: 20 * 60_000,
    });
    registerHandler("guards:get", () => readGuards(handle.db), opts);
    registerHandler("guards:set", (payload) => writeGuards(handle.db, payload), opts);

    const outcome = await tool("guardrails_set").run(dispatch, { wallClockTimeoutMs: 5 * 60_000 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("not written");
    expect(outcome.text).toContain("Merge");
    // And nothing moved, including the fields that came along for the ride.
    expect(readGuards(handle.db)).toEqual(STORED_GUARDS);
  });
});

describe("an agent, through the tool that configures it", () => {
  beforeEach(() => {
    registerHandler("agents:listDetailed", () => listAgentDetails(handle.db), opts);
    registerHandler("agents:save", (payload) => saveAgent(handle.db, payload), opts);
  });

  it("creates one, where the Agents screen would have created it", async () => {
    const outcome = await tool("agent_save").run(dispatch, {
      name: "Vega",
      role: "tester",
      provider: "fake",
      instructions: "Run the suite and report what failed.",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(listAgents(handle.db).find((agent) => agent.name === "Vega")).toMatchObject({
      role: "tester",
      provider: "fake",
      instructions: "Run the suite and report what failed.",
      enabled: true,
    });
    // The two things a caller would otherwise learn by being surprised.
    expect(outcome.text).toContain("role is fixed");
    expect(outcome.text).toContain("next dispatch");
  });

  it("refuses a create that would leave the agent with no prompt, and creates nothing", async () => {
    // An agent is its prompt. One created without instructions looks
    // staffed on the Agents screen and behaves like nothing at all.
    const outcome = await tool("agent_save").run(dispatch, { name: "Vega", role: "tester", provider: "fake" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("instructions");
    expect(listAgents(handle.db).some((agent) => agent.name === "Vega")).toBe(false);
  });

  it("changes the one field it was sent and leaves the prompt where it was", async () => {
    // The whole reason this reads before it writes: `agents:save` takes
    // the whole agent, and a caller made to restate an instructions
    // block it never read will paraphrase it.
    const before = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    const outcome = await tool("agent_save").run(dispatch, { id: before.id, model: "claude-opus-5" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(getAgent(handle.db, before.id)).toMatchObject({
      name: before.name,
      role: before.role,
      provider: before.provider,
      instructions: before.instructions,
      enabled: before.enabled,
      model: "claude-opus-5",
    });
  });

  it("refuses to move an agent onto another role, by name, and writes nothing", async () => {
    // `updateAgent` simply does not carry `role`, so without this the
    // save would report success and the agent would still staff the old
    // role — a silence a caller has no way to notice.
    const before = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    const outcome = await tool("agent_save").run(dispatch, { id: before.id, role: "tester", name: "Renamed" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("implementer");
    expect(outcome.message).toContain("Nothing has been written");
    // Not merely the role: the refusal happens before the write, so the
    // name it was sent alongside did not land either.
    expect(getAgent(handle.db, before.id)).toEqual(before);
  });

  it("accepts an edit that restates the role it already has", async () => {
    // The other half. Refusing a role that matches would punish a caller
    // for echoing back what agents_list told it.
    const before = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;

    const outcome = await tool("agent_save").run(dispatch, { id: before.id, role: "reviewer", enabled: false });

    expect(outcome.ok).toBe(true);
    expect(getAgent(handle.db, before.id)).toMatchObject({ role: "reviewer", enabled: false });
  });

  it("lays a partial config over the one that is there instead of swapping it whole (EO-185)", async () => {
    // The promise in this tool's own description stopped at the edge of
    // `config`: inside it the object was replaced, so a caller that knew
    // one key and sent one key deleted every key it had never heard of.
    // `allowedTools` lives in there, and an agent saved by something
    // holding a reasoning effort came back with no tool surface at all —
    // which is how a shipped feature turned out never to have run.
    const before = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    saveAgent(handle.db, {
      id: before.id,
      name: before.name,
      role: before.role,
      provider: before.provider,
      model: before.model,
      instructions: before.instructions,
      enabled: before.enabled,
      config: { allowedTools: ["Read", "mcp__eo_admin"], effort: "high" },
    });

    const outcome = await tool("agent_save").run(dispatch, { id: before.id, config: { effort: "xhigh", reasoningEffort: "xhigh" } });

    expect(outcome.ok).toBe(true);
    expect(getAgent(handle.db, before.id)?.config).toEqual({
      // Untouched, because it was never mentioned.
      allowedTools: ["Read", "mcp__eo_admin"],
      effort: "xhigh",
      reasoningEffort: "xhigh",
    });
  });

  it("replaces a list wholesale and removes a key sent as null", async () => {
    // Key by key rather than deep: a list is the unit somebody means to
    // change, and merging into one would leave no way to take a tool
    // away. `null` is the other direction — without it a config key,
    // once written, could never come off an agent from here, which would
    // be a trap on the surface EO's own system agent reconfigures the
    // installation through.
    const before = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    saveAgent(handle.db, {
      id: before.id,
      name: before.name,
      role: before.role,
      provider: before.provider,
      model: before.model,
      instructions: before.instructions,
      enabled: before.enabled,
      config: { allowedTools: ["Read", "Grep", "Glob"], inheritAmbientConfig: true, effort: "high" },
    });

    const outcome = await tool("agent_save").run(dispatch, {
      id: before.id,
      config: { allowedTools: ["Read"], inheritAmbientConfig: null },
    });

    expect(outcome.ok).toBe(true);
    expect(getAgent(handle.db, before.id)?.config).toEqual({ allowedTools: ["Read"], effort: "high" });
  });

  it("leaves the config alone entirely when the patch does not mention it", async () => {
    // The case `patch.config ?? current.config` already got right, kept
    // honest now that the expression behind it does more.
    const before = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    saveAgent(handle.db, {
      id: before.id,
      name: before.name,
      role: before.role,
      provider: before.provider,
      model: before.model,
      instructions: before.instructions,
      enabled: before.enabled,
      config: { allowedTools: ["Read", "mcp__eo_admin"] },
    });

    const outcome = await tool("agent_save").run(dispatch, { id: before.id, model: "claude-opus-5" });

    expect(outcome.ok).toBe(true);
    expect(getAgent(handle.db, before.id)).toMatchObject({ model: "claude-opus-5", config: { allowedTools: ["Read", "mcp__eo_admin"] } });
  });

  it("names the tool that lists the ids when given one that is not an agent", async () => {
    const outcome = await tool("agent_save").run(dispatch, { id: "01920000-0000-7000-8000-000000000000", name: "Nobody" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("agents_list");
  });

  /**
   * The other door onto the same refusal (EO-328, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * The Agents screen greys a backend the organisation does not allow,
   * and a lock only the renderer knew about would let the assistant bind
   * an agent to one from a chat — which is the finding in one sentence.
   * The rule lives in the domain command, so this door gets the same
   * answer as that one, and gets it as a *refusal* rather than as a
   * fault: the request was well formed and the answer is no.
   */
  it("refuses a backend the organisation does not allow, as a refusal rather than a fault", async () => {
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["fake"], publishedAt: 1 });

    const outcome = await tool("agent_save").run(dispatch, { name: "Vega", role: "tester", provider: "codex", instructions: "x" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(listAgents(handle.db).some((agent) => agent.name === "Vega")).toBe(false);
  });

  /**
   * The system agent is always global (EO-474, ARCHITECTURE.md, "An
   * agent is a row"), and this is the door the system agent itself
   * reconfigures the installation through — so the refusal has to be
   * the command's, reached here exactly as the Agents screen reaches it.
   */
  it("refuses a project on the system agent, as a refusal with a sentence, on a create and on an edit", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const system = listAgents(handle.db).find((agent) => agent.role === "system")!;

    const created = await tool("agent_save").run(dispatch, { name: "Support assistant", role: "system", provider: "fake", instructions: "Help.", projectId: project.id });
    const edited = await tool("agent_save").run(dispatch, { id: system.id, projectId: project.id });

    for (const outcome of [created, edited]) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.refused).toBe(true);
      expect(outcome.text).toContain("A system agent cannot belong to a project");
    }
    expect(listAgents(handle.db).some((agent) => agent.name === "Support assistant")).toBe(false);
    expect(getAgent(handle.db, system.id)?.projectId).toBeNull();
  });

  it("scopes an agent to a project, and keeps the scope through a patch that does not mention it", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    await tool("agent_save").run(dispatch, { id: implementer.id, projectId: project.id });
    expect(getAgent(handle.db, implementer.id)?.projectId).toBe(project.id);

    await tool("agent_save").run(dispatch, { id: implementer.id, model: "claude-opus-5" });
    expect(getAgent(handle.db, implementer.id)).toMatchObject({ projectId: project.id, model: "claude-opus-5" });

    await tool("agent_save").run(dispatch, { id: implementer.id, projectId: null });
    expect(getAgent(handle.db, implementer.id)?.projectId).toBeNull();
  });
});

describe("the runtimes, seen before they are acted on", () => {
  let runtimeRoot: string;
  let context: RuntimeContext;
  /**
   * A machine, pinned.
   *
   * Not optional, for `runtimeCommands.test.ts`'s reason: left to the
   * host, "not installed" would pass or fail on whether whoever ran the
   * suite happens to have Codex, and the package names below would
   * differ on an arm64 laptop.
   */
  const machine = { platform: "linux" as NodeJS.Platform, arch: "x64" };
  const codexVersion = versionFor(RUNTIMES.codex, "linux", "x64")!;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "eo-mcp-runtimes-"));
    // The seam, as everywhere else: nothing in this file touches the
    // network. A 500 is what "the registry is not there" looks like.
    // Signed in, without spawning anything: the probe seam, for the same
    // reason as the fetch seam above.
    const authProbe: AuthProbeRunner = async () => ({
      ok: true,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claudeai" }),
      error: "",
      notFound: false,
    });
    context = { root: runtimeRoot, fetchImpl: () => Promise.resolve(new Response("", { status: 500 })), db: handle.db, authProbe };
    invalidateRuntimeAuth();
    // The production wiring: `runtime:status` is the channel that asks
    // the binary whether it is signed in (EO-82).
    registerHandler("runtime:status", (payload) => runtimeStatusWithAuth(context, payload, machine), opts);
    registerHandler("runtime:describe", (payload) => describeRuntime(context, payload, machine), opts);
    registerHandler("runtime:setAutomaticUpdates", (payload) => setRuntimeAutomaticUpdates(context, payload), opts);
  });

  afterEach(() => {
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  it("reports every runtime EO can fetch without being told their names", async () => {
    // The gap being closed: `runtime_install` and `runtime_remove` were
    // offered while nothing said what was installed, so a client that
    // did not already know the provider ids could act on runtimes it
    // could not inspect.
    const outcome = await tool("runtime_status").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Claude Code");
    expect(outcome.text).toContain("Codex");
    expect(outcome.data).toMatchObject({ runtimes: [{ provider: "claude" }, { provider: "codex" }] });
  });

  it("says whether the managed copy is installed and whether it is enabled, separately", async () => {
    // Two facts, not one. A runtime that is installed and disabled parks
    // every step owned by an agent on that backend and announces
    // nothing, so collapsing them would hide the more confusing state.
    setRuntimeEnabled(context, { provider: "codex", enabled: false });

    const outcome = await tool("runtime_status").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("EO's managed copy: not installed");
    expect(outcome.text).toMatch(/Codex[\s\S]*enabled: no/);
    expect(outcome.text).toMatch(/Claude Code[\s\S]*enabled: yes/);
  });

  it("says whether it is signed in, because installed is not the same as usable", async () => {
    // EO-82. A caller told only "installed" would go on dispatching
    // against a runtime that can run nothing — and nothing here is
    // installed, so the honest answer is that EO had nothing to ask.
    const outcome = await tool("runtime_status").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("signed in: EO could not tell");
    expect(outcome.text).toContain("no Claude Code executable to ask");
  });

  it("answers about one backend when it is named, including one that has no CLI", async () => {
    // `fake` runs in EO's own process. Reporting it as a missing
    // download would send someone looking for one that does not exist.
    const outcome = await tool("runtime_status").run(dispatch, { provider: "fake" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("runs inside EO");
    expect(outcome.text).not.toContain("Codex");
  });

  it("prices a download from the registry and fetches none of it", async () => {
    const asked: string[] = [];
    context.fetchImpl = (url) => {
      asked.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            versions: {
              [codexVersion]: {
                dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg.tgz", integrity: "sha512-whatever", unpackedSize: 92_000_000 },
              },
            },
          }),
          { status: 200 },
        ),
      );
    };

    const outcome = await tool("runtime_describe").run(dispatch, { provider: "codex" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Size and publisher: the two things the person agreeing is agreeing
    // about, and neither of which the schema alone would give them.
    expect(outcome.text).toContain("92.0 MB");
    expect(outcome.text).toContain("OpenAI");
    expect(outcome.text).toContain("@openai/codex");
    // It asked the registry for metadata and nothing else, and nothing
    // landed on disk — which is the whole claim the tool makes.
    expect(asked.every((url) => !url.endsWith(".tgz"))).toBe(true);
    expect(readdirSync(runtimeRoot)).toEqual([]);
  });

  it("still names what would be fetched when the registry cannot be reached", async () => {
    // The registry being down is not a reason to hide the name of what
    // would be downloaded — that is the part the consent is about.
    const outcome = await tool("runtime_describe").run(dispatch, { provider: "codex" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("@openai/codex");
    expect(outcome.text).toContain("could not reach the npm registry");
  });

  it("changes automatic updates, and the next status says so", async () => {
    const before = await tool("runtime_status").run(dispatch, { provider: "codex" });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.text).toContain("automatic updates: off");

    const written = await tool("runtime_set_automatic_updates").run(dispatch, { provider: "codex", enabled: true });

    expect(written.ok).toBe(true);
    if (!written.ok) return;
    // Honest about the half that failed: consent is stored before the
    // reconcile is attempted, so an unreachable registry does not mean
    // the setting was not written.
    expect(written.text).toContain("setting was written");

    const after = await tool("runtime_status").run(dispatch, { provider: "codex" });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.text).toContain("automatic updates: on");

    const off = await tool("runtime_set_automatic_updates").run(dispatch, { provider: "codex", enabled: false });
    expect(off.ok).toBe(true);
    const last = await tool("runtime_status").run(dispatch, { provider: "codex" });
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.text).toContain("automatic updates: off");
  });
});

describe("a file somebody attached, through the tool that deletes it", () => {
  let storageRoot: string;
  let storage: AttachmentStorage;

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), "eo mcp attachments "));
    storage = new AttachmentStorage(join(storageRoot, "managed"));
    registerHandler("attachments:delete", (payload) => deleteAttachmentCommand(handle.db, storage, payload), opts);
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
  });

  /** A comment with a managed file on it, as a Jira pull would leave one. */
  async function attach(itemId: Uuid): Promise<{ commentId: string; attachmentId: string; path: string }> {
    const record = await storage.storeImported({ name: "screenshot.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    const commentId = uuidv7();
    postComment(handle.db, { id: commentId, itemId, author: { type: "human" }, body: "Here is what I saw.", attachmentRecords: [record] });
    return { commentId, attachmentId: record.id, path: record.storagePath };
  }

  it("deletes the file and leaves the comment it hung off", async () => {
    const item = createTestItem(handle.db, { type: "bug", title: "Blank page", stepId: "todo" });
    const { commentId, attachmentId, path } = await attach(item.id);
    expect(existsSync(path)).toBe(true);

    const outcome = await tool("attachment_delete").run(dispatch, { attachmentId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    // The row, the bytes and — the point of the tool being narrow — not
    // the comment, which is still there without its file.
    expect(getAttachment(handle.db, attachmentId as Uuid)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(getComment(handle.db, commentId as Uuid)?.attachments).toEqual([]);
    // What the caller is told at the moment it matters: EO's copy is
    // gone, and Jira's is queued rather than gone. This attachment was
    // never mirrored, so the reply is conditional — the tool is handed
    // `{ deleted }` and nothing else, and guessing which case it was
    // would be worse than saying both.
    expect(outcome.text).toContain("queued");
  });

  it("answers an id EO does not have without pretending it deleted something", async () => {
    const outcome = await tool("attachment_delete").run(dispatch, { attachmentId: uuidv7() });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("ticket_get");
    expect(outcome.text).toContain("Nothing has changed");
  });
});

describe("setting EO up, through the tools that do it", () => {
  /**
   * Real repositories in a temp directory, because attaching one checks
   * that the path is a repository.
   *
   * Jira credentials live outside the database (J-01), so the commands
   * take the store the way handlers.ts hands it to them.
   */
  let scratch: string;
  let repoPath: string;
  let otherRepoPath: string;
  let plainFolder: string;
  const credentials = {
    directory: join(tmpdir(), "eo-mcp-test-credentials"),
    store: { isEncryptionAvailable: () => true, encryptString: (plain: string) => Buffer.from(plain), decryptString: (b: Buffer) => b.toString() },
  };

  async function makeRepo(name: string): Promise<string> {
    const path = join(scratch, name);
    mkdirSync(path, { recursive: true });
    const result = await git(["init", "-b", "main"], path);
    if (!result.ok) throw new Error(`git init failed: ${result.error}`);
    return path;
  }

  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), "eo mcp setup "));
    repoPath = await makeRepo("api");
    otherRepoPath = await makeRepo("web");
    plainFolder = join(scratch, "not a repository");
    mkdirSync(plainFolder, { recursive: true });

    registerHandler("projects:list", () => listProjectsCommand(handle.db), opts);
    registerHandler("projects:create", (payload) => createProjectCommand(handle.db, payload), opts);
    registerHandler("projects:update", (payload) => updateProjectCommand(handle.db, payload), opts);
    registerHandler("projects:addProject", (payload) => addRepositoryToProjectCommand(handle.db, payload), opts);
    registerHandler("projects:removeProject", (payload) => removeRepositoryFromProjectCommand(handle.db, payload), opts);
    registerHandler("projects:setActive", (payload) => setActiveProjectCommand(handle.db, payload), opts);
    registerHandler("projects:archive", (payload) => archiveProjectCommand(handle.db, undefined, payload), opts);
    registerHandler("projects:restore", (payload) => restoreProjectCommand(handle.db, undefined, payload), opts);
    registerHandler("repositories:list", () => listRepositoriesCommand(handle.db, credentials), opts);
    registerHandler("repositories:create", (payload) => createRepositoryCommand(handle.db, credentials, payload), opts);
    registerHandler("repositories:update", (payload) => updateRepositoryCommand(handle.db, credentials, payload), opts);
  });

  afterEach(() => {
    removeScratch(scratch);
  });

  /** The id of the repository the tool attached, read back from the listing. */
  async function attach(name: string, path: string): Promise<string> {
    const outcome = await tool("repository_create").run(dispatch, { name, repoPath: path });
    expect(outcome.ok).toBe(true);
    const listed = listRepositoriesCommand(handle.db, credentials);
    return listed.repositories.find((repository) => repository.repoPath === path)!.id;
  }

  it("creates a project, renames it, and moves a repository on and off it", async () => {
    const repositoryId = await attach("api", repoPath);

    const created = await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.refused).toBe(false);
    // Read back through the listing rather than believed from the reply:
    // a create that only echoed its argument would satisfy the reply.
    const acme = (await read()).projects.find((project) => project.keyPrefix === "ACME")!;
    expect(acme.name).toBe("Acme");
    expect(acme.repositoryIds).toEqual([]);

    const renamed = await tool("project_update").run(dispatch, { id: acme.id, name: "Acme Platform" });
    expect(renamed.ok).toBe(true);
    expect((await read()).projects.find((project) => project.id === acme.id)?.name).toBe("Acme Platform");

    const added = await tool("project_add_repository").run(dispatch, { projectId: acme.id, repositoryId });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.text).toContain(repositoryId);
    expect((await read()).projects.find((project) => project.id === acme.id)?.repositoryIds).toEqual([repositoryId]);

    const removed = await tool("project_remove_repository").run(dispatch, { projectId: acme.id, repositoryId });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.refused).toBe(false);
    expect((await read()).projects.find((project) => project.id === acme.id)?.repositoryIds).toEqual([]);
  });

  it("attaches a repository from a path, and changes what verification runs", async () => {
    const attached = await tool("repository_create").run(dispatch, { name: "the api", repoPath, testCommand: "pnpm test" });

    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.refused).toBe(false);
    // Said out loud, because a caller that does not know a project was
    // created goes looking for one to make — and one that does not know
    // the window moved has moved somebody's window by accident.
    expect(attached.text).toContain('EO made "the api"');
    expect(attached.text).toContain("is now the one the app window is showing");
    const repositoryId = listRepositoriesCommand(handle.db, credentials).repositories[0]!.id;

    const changed = await tool("repository_update").run(dispatch, {
      id: repositoryId,
      testCommand: "pnpm vitest run",
      lintCommand: "pnpm lint",
      buildCommand: "pnpm build",
    });

    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    // Read back through the listing, and through its rendered text —
    // which is where a caller checking its own change actually looks.
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("test: pnpm vitest run");
    expect(listed.text).toContain("lint: pnpm lint");
    expect(listed.text).toContain("build: pnpm build");
    expect(listed.data).toMatchObject({ repositories: [{ repoPath, name: "the api", buildCommand: "pnpm build" }] });
  });

  it("saves a repository's default reviewers trimmed, without blanks or repeats, and lists them (EO-741)", async () => {
    const repositoryId = await attach("api", repoPath);

    const changed = await tool("repository_update").run(dispatch, { id: repositoryId, forgeReviewers: [" alice ", "", "bob", "alice"] });

    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.refused).toBe(false);
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect((listed.data as IpcResponse<"repositories:list">).repositories[0]!.forge.reviewers).toEqual(["alice", "bob"]);
    expect(listed.text).toContain("default pull request reviewers: alice, bob");
  });

  it("refuses a reviewer with a space or a comma in it by name, and changes nothing about the repository (EO-741)", async () => {
    const repositoryId = await attach("api", repoPath);
    await tool("repository_update").run(dispatch, { id: repositoryId, forgeReviewers: ["carol"] });
    const before = listRepositoriesCommand(handle.db, credentials).repositories[0]!;

    for (const bad of ["alice smith", "alice,bob"]) {
      const refused = await tool("repository_update").run(dispatch, { id: repositoryId, testCommand: "pnpm test", forgeReviewers: ["dave", bad] });

      expect(refused.ok).toBe(true);
      if (!refused.ok) return;
      expect(refused.refused).toBe(true);
      expect(refused.text).toContain(`"${bad}"`);
      expect(listRepositoriesCommand(handle.db, credentials).repositories[0]).toEqual(before);
    }
  });

  it("refuses a path that is not a git repository, and says which path", async () => {
    // The screen has a folder picker, which proves a folder exists and
    // nothing more; a client has not even got that. Stored unchecked, the
    // path surfaces as a failed dispatch hours later and nowhere near
    // whoever typed it.
    const outcome = await tool("repository_create").run(dispatch, { name: "the api", repoPath: plainFolder });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // A refusal, not a failure: the call worked and the answer is no.
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(plainFolder);
    expect(outcome.text).toContain("not a git repository");
    expect(listRepositoriesCommand(handle.db, credentials).repositories).toEqual([]);
  });

  it("joins the project the window is showing, and says which", async () => {
    await attach("api", repoPath);
    const before = await read();

    const joined = await tool("repository_create").run(dispatch, { name: "web", repoPath: otherRepoPath });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.refused).toBe(false);
    expect(joined.text).toContain('It joined the project "api"');
    expect(joined.text).toContain("the app window has not moved");
    const after = await read();
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0]?.repositoryIds).toHaveLength(2);
    expect(after.activeProjectId).toBe(before.activeProjectId);
  });

  it("joins the project named rather than the one on screen", async () => {
    await attach("api", repoPath);
    const before = await read();
    await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" });
    const acme = (await read()).projects.find((project) => project.keyPrefix === "ACME")!;

    const joined = await tool("repository_create").run(dispatch, { name: "web", repoPath: otherRepoPath, projectId: acme.id });

    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.text).toContain('It joined the project "Acme"');
    const after = await read();
    expect(after.projects.find((project) => project.id === acme.id)?.repositoryIds).toHaveLength(1);
    expect(after.activeProjectId).toBe(before.activeProjectId);
  });

  it("refuses a project EO does not have, and attaches nothing", async () => {
    await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" });

    const outcome = await tool("repository_create").run(dispatch, { name: "api", repoPath, projectId: "01920000-0000-7000-8000-0000000000ff" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("That project no longer exists");
    expect(listRepositoriesCommand(handle.db, credentials).repositories).toEqual([]);
  });

  it("moves the window to another project, and says that is what it did", async () => {
    await attach("api", repoPath);
    await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" });
    const before = await read();
    const target = before.projects.find((project) => project.id !== before.activeProjectId)!;

    const outcome = await tool("project_set_active").run(dispatch, { id: target.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain(target.name);
    expect((await read()).activeProjectId).toBe(target.id);
  });

  it("refuses a key prefix on a repository joining a project, and names the project's", async () => {
    // A prefix is a project's and fixed when it is made, so one sent here
    // cannot be honoured — and silently dropping it would leave the caller
    // believing its tickets are numbered with a prefix they are not.
    await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" });

    const outcome = await tool("repository_create").run(dispatch, { name: "the api", repoPath, keyPrefix: "API" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("ACME");
    // Nothing written on either side: no orphan repository, and the
    // project that owned the prefix still spans nothing.
    expect(listRepositoriesCommand(handle.db, credentials).repositories).toEqual([]);
    expect((await read()).projects.map((project) => project.keyPrefix)).toEqual(["ACME"]);
  });

  it("refuses a key prefix the project a repository was attached with already holds, in the other order", async () => {
    await attach("api", repoPath);
    const held = (await read()).projects[0]!.keyPrefix;

    const outcome = await tool("project_create").run(dispatch, { name: "Also API", keyPrefix: held });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(held);
    // One project still — the one made for the repository.
    expect((await read()).projects.filter((project) => project.keyPrefix === held)).toHaveLength(1);
  });

  it("derives a prefix no project is using", async () => {
    // The suggestion becomes the key prefix of the project made for the
    // repository — here, because it would otherwise join Preview — so one
    // that ignored the projects already there is one the caller cannot
    // actually use: the create would be refused by the very prefix EO
    // chose for it.
    await tool("project_create").run(dispatch, { name: "Api", keyPrefix: "API" });
    setSetting(handle.db, PREVIEW_PROJECT_KEY, (await read()).projects[0]!.id);

    const outcome = await tool("repository_create").run(dispatch, { name: "api", repoPath });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect((await read()).projects.map((project) => project.keyPrefix)).toEqual(["API", "API2"]);
  });

  it("stores the description it was given, and changes it", async () => {
    // repository_update's description offers to change this, and the reply
    // says "Changed" either way — so it is read back rather than believed.
    const attached = await tool("repository_create").run(dispatch, {
      name: "the api",
      repoPath,
      description: "the Go payments service",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.text).toContain("the Go payments service");

    const repositoryId = listRepositoriesCommand(handle.db, credentials).repositories[0]!.id;
    const changed = await tool("repository_update").run(dispatch, { id: repositoryId, description: "the Rust payments service" });
    expect(changed.ok).toBe(true);

    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("the Rust payments service");
    expect(listed.data).toMatchObject({ repositories: [{ description: "the Rust payments service" }] });
  });

  it("refuses a repository id EO does not have, on both doors that take one", async () => {
    // Attaching is a write of the workspace's own project since KAN-130,
    // and a write keyed on an id EO has not got lands on nothing at all —
    // so both doors read the ids before they write any of them. What they
    // answer with matters as much as that they refuse: `{ ok: false,
    // problem }` is what these channels say everywhere else, and a thrown
    // dispatch error is something a client cannot tell from a broken EO.
    const stranger = "01920000-0000-7000-8000-0000000000ff";

    const created = await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME", repositoryIds: [stranger] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.refused).toBe(true);
    expect(created.text).toContain(stranger);
    expect((await read()).projects).toEqual([]);

    const repositoryId = await attach("api", repoPath);
    expect((await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME", repositoryIds: [repositoryId] })).ok).toBe(true);
    const target = (await read()).projects.find((project) => project.keyPrefix === "ACME")!;

    const added = await tool("project_add_repository").run(dispatch, { projectId: target.id, repositoryId: stranger });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.refused).toBe(true);
    expect(added.text).toContain(stranger);
    expect((await read()).projects.find((project) => project.id === target.id)?.repositoryIds).toEqual([repositoryId]);
  });

  it("refuses a repository for a project mid-move to the organisation's record (EO-605)", async () => {
    const repositoryId = await attach("api", repoPath);
    expect((await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME" })).ok).toBe(true);
    const target = (await read()).projects.find((project) => project.keyPrefix === "ACME")!;
    beginAdoption(handle.db, target.id as Uuid);

    const added = await tool("project_add_repository").run(dispatch, { projectId: target.id, repositoryId });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.refused).toBe(true);
    expect(added.text).toContain(`"Acme" is being moved to your organisation's record. Wait for the move to finish`);
    expect((await read()).projects.find((project) => project.id === target.id)?.repositoryIds).toEqual([]);
  });

  it("refuses a repository for the gallery's Preview project, in the words of the channel, and says so up front (EO-607)", async () => {
    const repositoryId = await attach("api", repoPath);
    expect((await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME", repositoryIds: [repositoryId] })).ok).toBe(true);
    expect((await tool("project_create").run(dispatch, { name: "Rehearsal", keyPrefix: "RHS" })).ok).toBe(true);
    const { projects } = await read();
    const acme = projects.find((project) => project.keyPrefix === "ACME")!;
    const preview = projects.find((project) => project.keyPrefix === "RHS")!;
    setSetting(handle.db, PREVIEW_PROJECT_KEY, preview.id);

    const added = await tool("project_add_repository").run(dispatch, { projectId: preview.id, repositoryId });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.refused).toBe(true);
    expect(added.text).toContain("Preview is EO's rehearsal, and a repository belongs on a real project.");
    expect((await read()).projects.find((project) => project.id === acme.id)?.repositoryIds).toEqual([repositoryId]);
    expect((await read()).projects.find((project) => project.id === preview.id)?.repositoryIds).toEqual([]);

    expect(tool("project_add_repository").description).toContain("Refused for the Preview project");
  });

  it("spans a repository once when the same one is named twice", async () => {
    // The list takes an order and an order can repeat itself. Attaching
    // is one write of the workspace's project and position, so `[a, a]`
    // would position the same repository twice and the second placing
    // would be the one that stuck — quietly renumbering what a feature's
    // worktree is cut from.
    const repositoryId = await attach("api", repoPath);

    const created = await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME", repositoryIds: [repositoryId, repositoryId] });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Deduplicated rather than refused: project_add_repository on one the
    // project already spans is an ok no-op, so one call naming it twice
    // means what two calls naming it once mean.
    expect(created.refused).toBe(false);
    // Spanned once, read back rather than believed — and said as one in
    // the confirmation, which is where a caller checks its own write.
    expect(created.text).toContain("1 repository");
    expect((await read()).projects.find((project) => project.keyPrefix === "ACME")?.repositoryIds).toEqual([repositoryId]);
  });

  it("takes either repository off a project without disturbing the Jira it mirrors into", async () => {
    // Two cases that KAN-130 collapsed into one. While the Jira settings
    // sat on a repository, `projects.jira_project_id` named the one a
    // project's features went through — so removing *that* repository had
    // to clear the column, and removing any other had to leave it alone.
    // The binding belongs to the project now, so no removal can reach it
    // and both halves are the same assertion; kept as one case over both
    // repositories rather than dropped, because "removal quietly changed
    // where a project mirrors" is still the failure worth catching.
    const apiId = await attach("api", repoPath);
    const webId = await attach("web", otherRepoPath);
    // The project `api` arrived with; a second member is what makes
    // removing the first something anybody would do.
    const project = (await read()).projects.find((candidate) => candidate.repositoryIds.includes(apiId))!;
    expect((await tool("project_add_repository").run(dispatch, { projectId: project.id, repositoryId: webId })).ok).toBe(true);
    saveJiraBinding(handle.db, project.id as Uuid, { connectionId: uuidv7(), projectKey: "ACME" });

    for (const repositoryId of [apiId, webId]) {
      const removed = await tool("project_remove_repository").run(dispatch, { projectId: project.id, repositoryId });

      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.refused).toBe(false);
      // Nothing is said about mirroring, because nothing about mirroring
      // changed — and a reply that mentioned it would send a person
      // looking for a setting to put back.
      expect(removed.text).not.toContain("Jira");
      expect(getJiraBinding(handle.db, project.id as Uuid)?.config.projectKey).toBe("ACME");
    }

    expect((await read()).projects.find((candidate) => candidate.id === project.id)?.repositoryIds).toEqual([]);
  });

  it("refuses a project id EO does not have, rather than reporting the one already active", async () => {
    // What the channel alone does: an id it does not recognise leaves the
    // stored one alone and answers with it, which reads as success to
    // anything that does not compare the two. So the tool reads first.
    await attach("api", repoPath);
    const active = (await read()).activeProjectId;

    const outcome = await tool("project_set_active").run(dispatch, { id: "01920000-0000-7000-8000-000000000000" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("projects_list");
    expect((await read()).activeProjectId).toBe(active);
  });

  it("archives a project only once asked twice, lists it as archived, will not show it, and restores it (EO-347)", async () => {
    await attach("api", repoPath);
    await attach("web", otherRepoPath);
    const before = await read();
    const target = before.projects.find((project) => project.id === before.activeProjectId)!;

    // The first call is the question.
    const asked = await tool("project_archive").run(dispatch, { projectId: target.id });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.refused).toBe(true);
    expect(asked.text).toContain("Nothing has been archived yet");
    expect((await read()).projects.find((project) => project.id === target.id)?.archivedAt).toBeNull();

    const archived = await tool("project_archive").run(dispatch, { projectId: target.id, confirm: true });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.refused).toBe(false);
    const after = await read();
    expect(after.projects.find((project) => project.id === target.id)?.archivedAt).not.toBeNull();
    // The window was on it, and has moved off it.
    expect(after.activeProjectId).not.toBe(target.id);

    const listed = await tool("projects_list").run(dispatch, {});
    expect(listed.ok && listed.text).toMatch(new RegExp(`id: ${target.id}.*archived`));

    const switched = await tool("project_set_active").run(dispatch, { id: target.id });
    expect(switched.ok).toBe(false);
    if (switched.ok) return;
    expect(switched.message).toContain("project_restore");

    const restored = await tool("project_restore").run(dispatch, { projectId: target.id });
    expect(restored.ok && !restored.refused).toBe(true);
    expect((await read()).projects.find((project) => project.id === target.id)?.archivedAt).toBeNull();
  });

  it("mirrors every repository a project spans through the project's one Jira, and offers no way to pick one", async () => {
    // What `jiraProjectId` was for, and why there is nothing left to
    // refuse. It named "a repository this project spans", but the column
    // referenced `repositories` and nothing narrower — so any attached
    // repository was accepted, and a project could be pointed at one
    // belonging to somebody else's work and mirror its features into that
    // Jira. The binding is the project's since KAN-130: the question has
    // no repository-shaped answer, so the argument is gone rather than
    // kept as a control that would do nothing (invariant 12).
    const apiId = await attach("api", repoPath);
    const webId = await attach("web", otherRepoPath);
    expect((await tool("project_create").run(dispatch, { name: "Acme", keyPrefix: "ACME", repositoryIds: [apiId, webId] })).ok).toBe(true);
    const acme = (await read()).projects.find((project) => project.keyPrefix === "ACME")!;
    saveJiraBinding(handle.db, acme.id as Uuid, { connectionId: uuidv7(), projectKey: "ACME" });

    expect(tool("project_update").inputSchema.properties).not.toHaveProperty("jiraProjectId");

    // Read back where a caller would look: both repositories report the
    // project's Jira, which is what makes choosing between them moot.
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { repositories } = listed.data as IpcResponse<"repositories:list">;
    const keyOf = (id: string) => repositories.find((repository) => repository.id === id)?.jira.projectKey;
    expect([keyOf(apiId), keyOf(webId)]).toEqual(["ACME", "ACME"]);
  });

  it("refuses to move a repository onto a checkout another one already holds", async () => {
    // repository_create refuses to attach one path twice, so two records
    // for one checkout is a state EO says it does not hold — update could
    // still reach it, and it would mean two prefixes minting keys and two
    // sets of worktrees over the same branches.
    await attach("api", repoPath);
    const webId = await attach("web", otherRepoPath);

    const outcome = await tool("repository_update").run(dispatch, { id: webId, repoPath });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain(repoPath);
    // Read back rather than believed: the reply says "Changed" either way.
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const web = (listed.data as IpcResponse<"repositories:list">).repositories.find((repository) => repository.id === webId);
    expect(web?.repoPath).toBe(otherRepoPath);
  });

  /** Every project, as the tool reads them — not as the command does. */
  async function read(): Promise<IpcResponse<"projects:list">> {
    const outcome = await tool("projects_list").run(dispatch, {});
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.data as IpcResponse<"projects:list">;
  }
});

/**
 * Connecting EO to a tracker, driven the way a client would.
 *
 * Real handlers over a real database, with two seams stubbed and both
 * of them deliberate: Jira answers through the `fetchImpl` the commands
 * already take for their own tests, and the forge CLI through the
 * `CliRunner` `detectForge` takes for the same reason. Nothing here
 * reaches the network or spawns `gh`.
 *
 * The token is a value nothing may ever hand back, so it is a
 * recognisable string and every assertion below that could carry it
 * checks that it does not. The same property is proved over the wire in
 * http.test.ts, against a live connection.
 */
describe("wiring EO to Jira and a forge, through the tools that do it", () => {
  const TOKEN = "jira-token-nobody-may-read";
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
    decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
  };

  let directory: string;
  let checkout: string;
  let repository: Workspace;
  /** Swapped by the tests that want a missing or signed-out CLI. */
  let cli: CliRunner;

  const credentials = (): CredentialsOptions => ({ directory, store });

  /** A Jira that answers every call the tracker tools make. */
  const jiraSays: FetchLike = async (url) => {
    const body = url.endsWith("/statuses")
      ? [{ statuses: [{ name: "In Progress" }, { name: "Done" }] }, { statuses: [{ name: "Done" }] }]
      : url.endsWith("/issuetypes")
        ? { issueTypes: [{ id: "10", name: "Epic" }, { id: "11", name: "Story" }] }
        : url.includes("/createmeta/")
          ? { fields: [{ fieldId: "customfield_1", name: "Team", required: true, schema: { type: "option" }, allowedValues: [{ id: "7", value: "Platform" }] }] }
          : url.includes("/myself")
            ? { accountId: "acc-1", displayName: "Dev" }
            : { id: "1", key: "ACME", name: "Acme API" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const context = (): JiraContext => ({ credentials: credentials(), fetchImpl: jiraSays });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp jira "));
    checkout = mkdtempSync(join(tmpdir(), "eo mcp forge "));
    const init = await git(["init", "-b", "main"], checkout);
    if (!init.ok) throw new Error(`git init failed: ${init.error}`);
    const remote = await git(["remote", "add", "origin", "https://github.com/acme/api.git"], checkout);
    if (!remote.ok) throw new Error(`git remote add failed: ${remote.error}`);
    repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: checkout, baseBranch: "main" });
    cli = () => Promise.resolve({ ok: true, stdout: "Logged in to github.com as dev", error: "", notFound: false });

    registerHandler("repositories:list", () => listRepositoriesCommand(handle.db, credentials()), opts);
    registerHandler("jiraConnections:list", () => listJiraConnectionsCommand(handle.db, credentials()), opts);
    registerHandler("jiraConnections:save", (payload) => saveJiraConnection(handle.db, context(), payload), opts);
    registerHandler("jiraConnections:remove", (payload) => removeJiraConnection(handle.db, context(), payload), opts);
    registerHandler("jira:connect", (payload) => connectJira(handle.db, context(), payload), opts);
    registerHandler("jira:disconnect", (payload) => disconnectJira(handle.db, context(), payload), opts);
    registerHandler("jira:test", (payload) => testJira(handle.db, context(), payload), opts);
    registerHandler("jira:fields", (payload) => jiraFields(handle.db, context(), payload), opts);
    registerHandler("jira:statuses", (payload) => jiraStatuses(handle.db, context(), payload), opts);
    registerHandler("jira:saveConfig", (payload) => saveJiraConfig(handle.db, payload), opts);
    registerHandler("jira:saveStatusMap", (payload) => saveJiraStatusMap(handle.db, payload), opts);
    registerHandler("jira:saveTransitionFields", (payload) => saveJiraTransitionFields(handle.db, payload), opts);
    registerHandler("jira:outbox", (payload) => jiraOutboxView(handle.db, payload), opts);
    registerHandler("forge:detect", (payload) => detectForge(handle.db, payload, (binary, args, cwd) => cli(binary, args, cwd)), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  /** The site, and the repository pointed at it — the two halves the settings screen has. */
  async function connect(): Promise<string> {
    const saved = await tool("jira_connection_save").run(dispatch, {
      name: "Acme",
      baseUrl: "https://acme.atlassian.net",
      flavour: "cloud",
      email: "dev@acme.com",
      token: TOKEN,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("the site was not saved");
    const connectionId = (saved.data as IpcResponse<"jiraConnections:save">).connection!.id;

    const bound = await tool("jira_connect").run(dispatch, { repositoryId: repository.id, connectionId, projectKey: "ACME" });
    expect(bound.ok).toBe(true);
    if (bound.ok) expect(bound.refused).toBe(false);
    return connectionId;
  }

  it("lists a site, says a token is stored for it, and never says what the token is", async () => {
    await connect();

    const outcome = await tool("jira_connections_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Acme");
    expect(outcome.text).toContain("a token is stored for it");
    expect(outcome.data).toMatchObject({ connections: [{ baseUrl: "https://acme.atlassian.net", credentialsConfigured: true, projectCount: 1 }] });
    // The rule the whole surface would be worth withdrawing over. Both
    // halves of the reply, because a caller reads one of them.
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("proves the path to Jira a step at a time, rather than reporting one verdict", async () => {
    await connect();

    const outcome = await tool("jira_test").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("Credentials: Signed in as Dev");
    expect(outcome.text).toContain("Repository: ACME — Acme API");
    // The field step names what has to be filled in, which is what
    // jira_save_config is for.
    expect(outcome.text).toContain("Team");
    expect(outcome.data).toMatchObject({ ok: true });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("says which step failed, rather than that Jira did not work", async () => {
    const outcome = await tool("jira_test").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Not connected at all is a different answer from credentials that
    // were refused, and a caller sent to check the wrong one wastes the
    // person's time rather than its own.
    expect(outcome.text).toContain("**failed** — Configuration");
    expect(outcome.text).toContain("not connected to Jira");
  });

  it("changes one Jira setting without restating the other three", async () => {
    await connect();
    const fields = await tool("jira_fields").run(dispatch, { repositoryId: repository.id, issueType: "Epic" });
    expect(fields.ok).toBe(true);
    if (!fields.ok) return;
    // The id is what the write is keyed by, and the allowed value is
    // what a caller has to choose rather than invent.
    expect(fields.text).toContain("customfield_1");
    expect(fields.text).toContain("Platform (id: 7)");

    await tool("jira_save_config").run(dispatch, {
      repositoryId: repository.id,
      fields: { customfield_1: { id: "7" } },
      createByDefault: true,
      storyIssueType: "Task",
    });
    const changed = await tool("jira_save_config").run(dispatch, { repositoryId: repository.id, createByDefault: false });

    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.refused).toBe(false);
    // The point of the merge: the issue types and the fields survived a
    // call that mentioned neither.
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("Epic for features, Task for stories");
    expect(listed.text).toContain("a new ticket creates an issue by default: no");
    expect(listed.text).toContain("customfield_1");
    expect(listed.data).toMatchObject({
      repositories: [{ jira: { featureIssueType: "Epic", storyIssueType: "Task", createByDefault: false, fields: { customfield_1: { id: "7" } } } }],
    });
  });

  it("refuses a repository id EO does not have, and writes nothing", async () => {
    // The composite's read is what makes this possible at all: the
    // channel alone reports "That repository no longer exists" as a
    // problem string, and a caller that mistyped an id is better told
    // where ids come from.
    // Connected first, so there is a setting to leave alone: the config
    // lives on the project's binding now, and an unconnected project has
    // no row at all — "nothing was written" would then be true of a
    // database that had never been asked anything.
    await connect();
    const projectId = projectForWorkspace(handle.db, repository.id)!.id;
    const before = getJiraBinding(handle.db, projectId)!.config.createByDefault;

    const outcome = await tool("jira_save_config").run(dispatch, { repositoryId: "01920000-0000-7000-8000-000000000000", createByDefault: !before });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("repositories_list");
    expect(getJiraBinding(handle.db, projectId)?.config.createByDefault).toBe(before);
  });

  it("saves a status map, and reads it back through the listing", async () => {
    await connect();
    const statuses = await tool("jira_statuses").run(dispatch, { repositoryId: repository.id });
    expect(statuses.ok).toBe(true);
    if (!statuses.ok) return;
    expect(statuses.text).toContain("- Done");

    const saved = await tool("jira_save_status_map").run(dispatch, {
      repositoryId: repository.id,
      statusMap: { review: "In Progress", done: "Done" },
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.refused).toBe(false);
    // Read back rather than believed: the channel answers `ok` and
    // nothing else, so the listing is the only place a caller can check
    // its own write — which is why the listing reports it.
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("review → In Progress");
    expect(listed.data).toMatchObject({ repositories: [{ jira: { statusMap: { review: "In Progress", done: "Done" } } }] });
  });

  it("fills in what a transition demands, and refuses a status nothing is known about", async () => {
    await connect();

    const early = await tool("jira_save_transition_fields").run(dispatch, {
      repositoryId: repository.id,
      status: "Done",
      values: { resolution: { id: "3" } },
    });

    expect(early.ok).toBe(true);
    if (!early.ok) return;
    // A refusal, not a failure: EO learns what a transition asks for by
    // being told no once, so there is nothing to fill in yet and the
    // text says why rather than leaving a caller to retry.
    expect(early.refused).toBe(true);
    expect(early.text).toContain("the first time Jira refuses one");

    // What that first refusal records, written onto the project's binding
    // the way the drain writes it.
    saveJiraBinding(handle.db, projectForWorkspace(handle.db, repository.id)!.id, {
      transitionFields: { Done: { requires: [{ id: "resolution", name: "Resolution", schemaType: "option", allowedValues: [] }], values: {} } },
    });

    const saved = await tool("jira_save_transition_fields").run(dispatch, {
      repositoryId: repository.id,
      status: "Done",
      values: { resolution: { id: "3" } },
    });

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.refused).toBe(false);
    const listed = await tool("repositories_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain('moving to "Done" needs Resolution (resolution: set)');
  });

  it("reports what is waiting for Jira and what is already failing", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Mirror me", stepId: "todo", workspaceId: repository.id });
    const stuck = enqueueOutbox(handle.db, { itemId: item.id, workspaceId: repository.id, channel: "jira", kind: "comment", payload: {} });
    enqueueOutbox(handle.db, { itemId: item.id, workspaceId: repository.id, channel: "jira", kind: "status", payload: {} });
    deferPush(handle.db, stuck.id, Date.now() + 60_000, "Jira said no");

    const outcome = await tool("jira_outbox").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("2 push(es) waiting");
    expect(outcome.text).toContain("1 of them has failed at least once");
    expect(outcome.data).toMatchObject({ pending: 2, failing: 1 });
  });

  it("says plainly when nothing is waiting for Jira", async () => {
    const outcome = await tool("jira_outbox").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("Nothing is waiting to reach Jira for this repository.");
  });

  it("reports the remote, its kind, and whether the CLI is installed and signed in", async () => {
    const outcome = await tool("forge_detect").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("https://github.com/acme/api.git");
    expect(outcome.text).toContain("host: github.com");
    expect(outcome.text).toContain("kind: github");
    expect(outcome.text).toContain("installed and signed in");
    expect(outcome.data).toMatchObject({ kind: "github", host: "github.com", cliInstalled: true, authenticated: true, problem: null });
  });

  it("says the CLI is missing, and names the one EO would have used", async () => {
    // A repository that finishes work and opens nothing is the symptom;
    // this is where the cause is legible.
    cli = () => Promise.resolve({ ok: false, stdout: "", error: "", notFound: true });

    const outcome = await tool("forge_detect").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("**not installed**");
    expect(outcome.text).toContain("`gh` is not installed");
    expect(outcome.data).toMatchObject({ cliInstalled: false, authenticated: false });
  });

  it("disconnects a repository, and takes the site's token with it when nothing else is using it", async () => {
    const connectionId = await connect();
    await tool("jira_save_status_map").run(dispatch, { repositoryId: repository.id, statusMap: { done: "Done" } });

    const outcome = await tool("jira_disconnect").run(dispatch, { repositoryId: repository.id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(outcome.text).toContain("mirrors nowhere");
    // Both halves of what the description promises, because both are
    // things a caller cannot get back by calling again. The status map
    // went with the binding row rather than being blanked in place:
    // "bound to nothing" and "never bound" are one state.
    expect(getJiraBinding(handle.db, projectForWorkspace(handle.db, repository.id)!.id)).toBeUndefined();
    expect(hasToken(credentials(), connectionId)).toBe(false);
  });

  it("refuses to forget a site while a repository still mirrors through it", async () => {
    const connectionId = await connect();

    const refused = await tool("jira_connection_remove").run(dispatch, { id: connectionId });

    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.refused).toBe(true);
    // Named, so a caller knows which repository to disconnect rather
    // than being told a number it cannot act on.
    expect(refused.text).toContain("acme-api");
    expect(refused.text).toContain("Disconnect them first");
    expect(hasToken(credentials(), connectionId)).toBe(true);

    await tool("jira_disconnect").run(dispatch, { repositoryId: repository.id });
    const removed = await tool("jira_connection_remove").run(dispatch, { id: connectionId });

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.refused).toBe(false);
    expect(listJiraConnections(handle.db)).toEqual([]);
  });
});

describe("making and renaming a pipeline", () => {
  /** Both channels the tool writes through, plus the read it checks itself against. */
  function recordPipelineHandlers(): void {
    registerHandler("pipelines:list", (payload) => listPipelineViews(handle.db, payload), opts);
    registerHandler("pipelines:create", (payload) => createPipelineCommand(handle.db, payload), opts);
    registerHandler("pipelines:update", (payload) => updatePipelineCommand(handle.db, payload), opts);
  }

  it("creates one and hands back the id a graph is published into", async () => {
    // The whole point of the tool: `pipeline:save` takes a pipelineId,
    // so a client that cannot learn one has to stop and ask a person to
    // click New pipeline. The id has to be in the reply, not behind a
    // second lookup.
    const project = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });
    recordPipelineHandlers();

    const outcome = await tool("pipeline_manage").run(dispatch, { projectId: project.id, name: "Release", icon: "workflow" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    const created = listPipelines(handle.db, project.id).find((pipeline) => pipeline.name === "Release");
    expect(created).toBeDefined();
    expect(created?.icon).toBe("workflow");
    expect(outcome.data).toMatchObject({ created: true, pipeline: { id: created?.id, name: "Release" } });
    expect(outcome.text).toContain(created!.id);
    // And it says what the id is for, because an empty pipeline runs nothing.
    expect(outcome.text).toContain("pipeline_save");
  });

  it("renames the pipeline an id names, and creates nothing", async () => {
    recordPipelineHandlers();
    const before = listPipelines(handle.db, undefined, true).length;

    const outcome = await tool("pipeline_manage").run(dispatch, { id: "default", name: "Shipping" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(getPipeline(handle.db, "default")?.name).toBe("Shipping");
    expect(listPipelines(handle.db, undefined, true).length).toBe(before);
    // Renaming touches the name and nothing else — the graph is
    // pipeline_save's business, and the text says so.
    expect(getPipeline(handle.db, "default")?.entryStepId).not.toBeNull();
    expect(outcome.text).toContain("pipeline_save");
  });

  it("refuses a name the project already has rather than creating a second one", async () => {
    // Work is placed on a pipeline by *name* — `resolvePlacement` matches
    // a submitted plan's `pipeline` against what the project can see. Two
    // of the same name is work that lands on whichever one sorted first.
    // "Delivery" is seeded with no project, so every project sees it.
    const project = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });
    recordPipelineHandlers();
    const before = listPipelines(handle.db, undefined, true).length;

    const outcome = await tool("pipeline_manage").run(dispatch, { projectId: project.id, name: "  delivery  " });

    // A refusal, not a failure: the call worked and the answer is no.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("Delivery");
    expect(outcome.text).toContain("Nothing has changed");
    expect(listPipelines(handle.db, undefined, true).length).toBe(before);
  });

  it("answers for an id no pipeline has instead of letting a throw reach the client", async () => {
    recordPipelineHandlers();

    // What the handler does on its own, and why the tool checks first:
    // `pipelines:update` throws on an unknown id, and off a packaged
    // build `handleIpcRequest` turns that into "Internal error" — a
    // model cannot act on that, and would retry the same call.
    const raw = await dispatchIpc("pipelines:update", { id: "no-such-pipeline", name: "Anything" });
    expect(raw.ok).toBe(false);

    const outcome = await tool("pipeline_manage").run(dispatch, { id: "no-such-pipeline", name: "Anything" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("no pipeline with id");
    expect(outcome.text).toContain("pipelines_list");
  });

  it("says what is missing when a call names neither a pipeline nor a project", async () => {
    recordPipelineHandlers();
    const before = listPipelines(handle.db, undefined, true).length;

    const noName = await tool("pipeline_manage").run(dispatch, {});
    const noProject = await tool("pipeline_manage").run(dispatch, { name: "Release" });
    const nothingToChange = await tool("pipeline_manage").run(dispatch, { id: "default" });

    expect(noName).toMatchObject({ ok: false, message: expect.stringContaining("`name`") });
    expect(noProject).toMatchObject({ ok: false, message: expect.stringContaining("projectId") });
    expect(nothingToChange).toMatchObject({ ok: false, message: expect.stringContaining("Nothing to change") });
    // None of them reached a write.
    expect(listPipelines(handle.db, undefined, true).length).toBe(before);
  });
});

/**
 * The catalogues an agent is dispatched with, read the way a client
 * reads them (EO-112).
 *
 * Real handlers over a real database, with one seam faked: `safeStorage`,
 * reversing rather than prefixing, so that "the value is nowhere in the
 * reply" stays a claim about the code under test rather than about the
 * fake. Saving a server, storing its secret and ticking it onto an agent
 * are done by calling the commands directly — those are the things a
 * person does in the app, and no tool offers them; what is driven
 * through a tool is only the reading, which is the whole of what this
 * story decided.
 *
 * The property being proved is the one this surface would be worth
 * withdrawing over. A value goes into the keychain and nothing hands it
 * back — not the Settings screen, and now not a client either — so the
 * secret here is a recognisable string and both halves of every reply
 * that could carry it are checked.
 */
describe("reading the catalogues EO gives its agents", () => {
  const SECRET = "ghp-nobody-may-ever-read-this";
  const reverse = (text: string) => [...text].reverse().join("");
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(reverse(text)),
    decryptString: (buffer) => reverse(buffer.toString()),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  let directory: string;
  let secrets: McpServerSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp catalogues "));
    secrets = { directory, store };

    registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, secrets, payload), opts);
    registerHandler("skills:list", (payload) => listSkillsCommand(handle.db, payload), opts);
    registerHandler("agentAttachments:list", (payload) => listAgentAttachmentsCommand(handle.db, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A stdio server with a variable it needs and a value stored for it. */
  function github(): string {
    const draft = McpServerDraftSchema.parse({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envNames: ["GITHUB_TOKEN"],
    });
    const saved = saveMcpServerCommand(handle.db, secrets, draft);
    expect(saved.problem).toBeNull();
    const id = saved.server?.id ?? "";

    expect(setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: SECRET }).saved).toBe(true);
    return id;
  }

  function playbook(): string {
    const saved = saveSkillCommand(
      handle.db,
      SkillDraftSchema.parse({ name: "House style", description: "How this team writes a pull request.", body: "Read the diff twice." }),
    );
    expect(saved.problem).toBeNull();
    return saved.skill?.id ?? "";
  }

  it("says which of a server's variables has a value, and never says what the value is", async () => {
    github();

    const outcome = await tool("mcp_servers_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("github");
    expect(outcome.text).toContain("npx -y @modelcontextprotocol/server-github");
    // A name and whether something is behind it. That is the whole of
    // what a client learns about a secret, in either direction: the
    // catalogue has no channel that reads one back and this tool invents
    // no field that would.
    expect(outcome.text).toContain("GITHUB_TOKEN (set)");
    // Both halves of the reply, because a caller reads one of them — the
    // text is what lands in a transcript and `data` is what travels
    // beside it as structuredContent.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("says a stored value this machine can no longer read is stored and unreadable, not set and not missing (EO-489)", async () => {
    github();
    // The value was written under one keychain and is read under another:
    // the registered handler reads `secrets` when it is called.
    secrets = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("not this keychain's");
        },
      },
    };

    const outcome = await tool("mcp_servers_list").run(dispatch, {});

    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(outcome.ok && outcome.text).toContain("GITHUB_TOKEN (stored, but this machine cannot read it)");
  });

  it("names the variables a server is still owed, so a person can see what is missing", async () => {
    const draft = McpServerDraftSchema.parse({ name: "linear", transport: "http", url: "https://mcp.linear.app/sse", envNames: ["LINEAR_KEY"] });
    expect(saveMcpServerCommand(handle.db, secrets, draft).problem).toBeNull();

    const outcome = await tool("mcp_servers_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Unset is the answer that decides something: a server dispatched
    // without the value it declared fails at the agent rather than here.
    expect(outcome.text).toContain("LINEAR_KEY (not set)");
    expect(outcome.text).toContain("https://mcp.linear.app/sse");
  });

  it("prints a remote server's header names and not what is in them", async () => {
    // A header that needs a secret is written `Bearer ${LINEAR_KEY}` and
    // interpolated where the configuration is generated — but EO cannot
    // tell a person who followed that convention from one who pasted a
    // token in, and a transcript is a bad place to find out. The row
    // itself still travels as structuredContent, so this is an assertion
    // about the text a client shows, not about the contract.
    const draft = McpServerDraftSchema.parse({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app/sse",
      headers: { Authorization: "Bearer lin_api_pasted_in_by_hand" },
    });
    expect(saveMcpServerCommand(handle.db, secrets, draft).problem).toBeNull();

    const outcome = await tool("mcp_servers_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("headers: Authorization");
    expect(outcome.text).not.toContain("lin_api_pasted_in_by_hand");
  });

  it("lists the skills a person wrote, with what each is for and which are switched off", async () => {
    playbook();
    const parked = saveSkillCommand(
      handle.db,
      SkillDraftSchema.parse({ name: "Release notes", description: "Half written.", body: "TBD.", enabled: false }),
    );
    expect(parked.problem).toBeNull();

    const outcome = await tool("skills_list").run(dispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("House style (slug: house-style");
    expect(outcome.text).toContain("How this team writes a pull request.");
    // The two switches mean different things, and a person asking why an
    // agent ignored a skill needs to be told which one is off.
    expect(outcome.text).toContain("disabled — not delivered at all");
  });

  it("says what one agent is dispatched with, and what every agent is", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    const serverId = github();
    const skillId = playbook();
    setAgentAttachmentCommand(handle.db, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });
    setAgentAttachmentCommand(handle.db, { agentId: reviewer.id, kind: "skill", id: skillId, attached: true });

    const one = await tool("agent_attachments_list").run(dispatch, { agentId: implementer.id });
    const all = await tool("agent_attachments_list").run(dispatch, {});

    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.text).toContain(`MCP servers: ${serverId}`);
    expect(one.text).not.toContain(skillId);
    // Ids and nothing else, so the reply says where each one is read.
    expect(one.text).toContain("mcp_servers_list");

    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.text).toContain(`skills: ${skillId}`);
    expect(all.text).toContain(`MCP servers: ${serverId}`);
    // And the join carries no secret either, which is the same
    // assertion made against a different reply.
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });
});

/**
 * The two catalogues, written from a client (EO-113).
 *
 * The reads above prove what a client may see. These prove what it may
 * change, and the property worth proving is the refusals rather than the
 * successes: `mcpServers:save` and `skills:save` answer `{ saved: false,
 * problem }` on a call that worked, so every way of getting an entry
 * wrong arrives as a sentence with `ok: true` behind it. A client that
 * cannot tell a refusal from a crash retries it.
 *
 * Each refusal is checked against the catalogue as well as against the
 * text, because "nothing has changed" is a claim and not a courtesy.
 */
describe("writing the catalogues EO gives its agents", () => {
  const SECRET = "ghp-nobody-may-ever-read-this";
  const reverse = (text: string) => [...text].reverse().join("");
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(reverse(text)),
    decryptString: (buffer) => reverse(buffer.toString()),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  let directory: string;
  let secrets: McpServerSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp catalogue writes "));
    secrets = { directory, store };

    registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:save", (payload) => saveMcpServerCommand(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:setEnabled", (payload) => setMcpServerEnabledCommand(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:archive", (payload) => archiveMcpServerCommand(handle.db, payload), opts);
    registerHandler("skills:list", (payload) => listSkillsCommand(handle.db, payload), opts);
    registerHandler("skills:save", (payload) => saveSkillCommand(handle.db, payload), opts);
    registerHandler("skills:setEnabled", (payload) => setSkillEnabledCommand(handle.db, payload), opts);
    registerHandler("skills:archive", (payload) => archiveSkillCommand(handle.db, payload), opts);
    registerHandler("skills:setLocked", (payload) => setSkillLockedCommand(handle.db, payload), opts);
    registerHandler("skills:versions", (payload) => listSkillVersionsCommand(handle.db, payload), opts);
    registerHandler("skills:restoreVersion", (payload) => restoreSkillVersionCommand(handle.db, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** What a client sends to add a local server, with a variable it needs. */
  const githubArgs = {
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envNames: ["GITHUB_TOKEN"],
  };

  function catalogued(includeArchived = false) {
    return listMcpServerViews(handle.db, secrets, { includeArchived }).servers;
  }

  it("adds a server, and says it is catalogued and nothing more", async () => {
    const outcome = await tool("mcp_server_save").run(dispatch, githubArgs);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(outcome.text).toContain("github");
    expect(outcome.text).toContain("npx -y @modelcontextprotocol/server-github");
    // The variable it is still owed, in the line the listing would have
    // given — a server dispatched without it fails at the agent.
    expect(outcome.text).toContain("GITHUB_TOKEN (not set)");
    // A row a person can see is not an agent that has it. A model told
    // only "saved" has handed nobody anything and will go looking for why.
    expect(outcome.text).toContain("until it is attached to one");
    expect(catalogued().map((server) => server.name)).toEqual(["github"]);
  });

  it("refuses the name `eo` in a sentence, because a client that cannot read a refusal retries it", async () => {
    const outcome = await tool("mcp_server_save").run(dispatch, { ...githubArgs, name: "eo" });

    // `ok: true` and refused, not a fault: the call reached the
    // catalogue and the catalogue said no. A schema rejection would come
    // back as `ok: false` with a list of zod issues, which is the thing
    // this must not be — a caller cannot tell that from EO being broken.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("Nothing was saved:");
    expect(outcome.text).toContain("EO's own MCP server");
    // The fix, in the same breath as the refusal.
    expect(outcome.text).toContain("Pick another name.");
    expect(outcome.text).toContain("Nothing has changed.");
    // And the claim is true.
    expect(catalogued()).toEqual([]);
  });

  it("says what did not happen and that nothing changed, when a save is refused", async () => {
    expect((await tool("mcp_server_save").run(dispatch, githubArgs)).ok).toBe(true);

    // A second entry under a name already taken. Refused rather than
    // resolved: the name is the key the model sees in every tool id, so
    // two of them means one silently never answers.
    const clash = await tool("mcp_server_save").run(dispatch, { name: "github", transport: "stdio", command: "other" });
    // And a stdio server with nothing to run, which is the other half —
    // a refusal about a field rather than about the row.
    const empty = await tool("mcp_server_save").run(dispatch, { name: "linear", transport: "stdio", command: "" });

    expect(clash.ok).toBe(true);
    if (!clash.ok) return;
    expect(clash.refused).toBe(true);
    expect(clash.text).toBe('Nothing was saved: Another MCP server is already called "github". Nothing has changed.');

    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.refused).toBe(true);
    expect(empty.text).toBe("Nothing was saved: A stdio server needs a command to run. Nothing has changed.");

    // Neither refusal wrote anything, and the one that was already there
    // still points where it did.
    const servers = catalogued();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.config).toMatchObject({ command: "npx" });
  });

  it("switches a server off without changing what it points at", async () => {
    const saved = await tool("mcp_server_save").run(dispatch, githubArgs);
    expect(saved.ok).toBe(true);
    const id = catalogued()[0]?.id ?? "";

    const off = await tool("mcp_server_set_enabled").run(dispatch, { id, enabled: false });

    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.refused).toBe(false);
    expect(off.text).toContain("Switched off");
    expect(off.text).toContain("disabled — no agent is given it");
    expect(off.text).toContain("next dispatch");
    const server = catalogued()[0];
    expect(server?.enabled).toBe(false);
    // The switch is its own channel precisely so this cannot move.
    expect(server?.config).toMatchObject({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
  });

  it("archives a server without deleting the row an attachment points at", async () => {
    expect((await tool("mcp_server_save").run(dispatch, githubArgs)).ok).toBe(true);
    const id = catalogued()[0]?.id ?? "";

    const outcome = await tool("mcp_server_archive").run(dispatch, { id });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(outcome.text).toContain("archived");
    // Gone from the catalogue a person picks from, kept for the
    // attachments and runs that still name it (invariant #3).
    expect(catalogued()).toEqual([]);
    expect(catalogued(true).map((server) => server.id)).toEqual([id]);
  });

  it("refuses to switch or archive an id the catalogue does not have", async () => {
    const missing = uuidv7();

    const switched = await tool("mcp_server_set_enabled").run(dispatch, { id: missing, enabled: false });
    const archived = await tool("skill_archive").run(dispatch, { id: missing });

    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.refused).toBe(true);
    expect(switched.text).toBe("Nothing was switched: That MCP server no longer exists. Nothing has changed.");

    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.refused).toBe(true);
    expect(archived.text).toBe("Nothing was archived: That skill no longer exists. Nothing has changed.");
  });

  it("writes a skill, and tells the caller the slug it decided", async () => {
    const outcome = await tool("skill_save").run(dispatch, {
      name: "House style",
      description: "How this team writes a pull request.",
      body: "Read the diff twice.",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    // The slug is the only part a model can invoke, and a create may
    // leave it out — so it is learned here or guessed at.
    expect(outcome.text).toContain("slug: house-style");
    expect(outcome.text).toContain("until it is attached to one");
    expect(listSkillsCommand(handle.db, {}).skills.map((skill) => skill.slug)).toEqual(["house-style"]);
  });

  it("refuses a supporting file that climbs out of the skill's own folder", async () => {
    const outcome = await tool("skill_save").run(dispatch, {
      name: "House style",
      description: "How this team writes a pull request.",
      body: "Read the diff twice.",
      files: [{ path: "../../.ssh/authorized_keys", content: "ssh-rsa AAAA" }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("Nothing was saved:");
    expect(outcome.text).toContain("has to stay inside the skill's own folder");
    expect(outcome.text).toContain("Nothing has changed.");
    expect(listSkillsCommand(handle.db, {}).skills).toEqual([]);
  });

  it("switches a skill off and archives it, saying which switch did what", async () => {
    expect((await tool("skill_save").run(dispatch, { name: "House style", description: "How we review.", body: "Read it twice." })).ok).toBe(true);
    const id = listSkillsCommand(handle.db, {}).skills[0]?.id ?? "";

    const off = await tool("skill_set_enabled").run(dispatch, { id, enabled: false });
    const archived = await tool("skill_archive").run(dispatch, { id });

    expect(off.ok).toBe(true);
    if (!off.ok) return;
    // Not delivered at all, which is the switch this is — the other one
    // travels on the save and only keeps it out of the model's choosing.
    expect(off.text).toContain("disabled — not delivered at all");

    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.text).toContain("archived");
    expect(listSkillsCommand(handle.db, {}).skills).toEqual([]);
    expect(listSkillsCommand(handle.db, { includeArchived: true }).skills.map((skill) => skill.id)).toEqual([id]);
  });

  it("lists who created each skill and whether it is locked, in the text and the structured reply (EO-714)", async () => {
    expect((await tool("skill_save").run(dispatch, { name: "House style", description: "How we review.", body: "Read it twice." })).ok).toBe(true);
    const id = listSkillsCommand(handle.db, {}).skills[0]?.id ?? "";

    const locked = await tool("skill_set_locked").run(dispatch, { id, locked: true });
    const listed = await tool("skills_list").run(dispatch, {});

    expect(locked.ok && locked.text).toContain("No agent can change it");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("created by a person");
    expect(listed.text).toContain("locked by a person");
    expect(listed.data).toMatchObject({ skills: [{ id, createdBy: "person", locked: true }] });
  });

  it("lists how each skill has been used, counted from the runs' events, person-written included (EO-715)", async () => {
    expect((await tool("skill_save").run(dispatch, { name: "House style", description: "How we review.", body: "Read it twice." })).ok).toBe(true);
    const id = listSkillsCommand(handle.db, {}).skills[0]?.id ?? "";
    const item = createTestItem(handle.db, { type: "story", title: "Used", stepId: "todo" });
    const given = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const loaded = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", status: "succeeded" });
    appendRunEvent(handle.db, given.id, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [id], slugs: ["house-style"] });
    appendRunEvent(handle.db, loaded.id, SKILLS_DELIVERED_EVENT, { type: SKILLS_DELIVERED_EVENT, skillIds: [id], slugs: ["house-style"] });
    appendRunEvent(handle.db, loaded.id, SKILL_LOADED_EVENT, { type: SKILL_LOADED_EVENT, skillId: id, slug: "house-style" });

    const listed = await tool("skills_list").run(dispatch, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("delivered to 2 runs, loaded by 1 run, last loaded");
    expect(listed.text).toContain("delivered to 0 runs since its last load");
    expect(listed.data).toMatchObject({ skills: [{ id, createdBy: "person", usage: { runsDelivered: 2, runsLoaded: 1, deliveriesSinceLoad: 0 } }] });
  });

  it("lists a skill's versions and restores an earlier one as a new version (EO-714)", async () => {
    expect((await tool("skill_save").run(dispatch, { name: "House style", description: "First.", body: "One." })).ok).toBe(true);
    const id = listSkillsCommand(handle.db, {}).skills[0]?.id ?? "";
    expect((await tool("skill_save").run(dispatch, { id, name: "House style", description: "Second.", body: "Two." })).ok).toBe(true);
    expect((await tool("skill_archive").run(dispatch, { id })).ok).toBe(true);

    const history = await tool("skill_versions_list").run(dispatch, { id });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.text).toContain("archive by a person");
    const versions = (history.data as IpcResponse<"skills:versions">).versions;
    expect(versions.map((version) => version.action)).toEqual(["archive", "edit", "create"]);

    const restored = await tool("skill_restore_version").run(dispatch, { id, versionId: versions[2]?.id });
    expect(restored.ok && restored.text).toContain("Restored House style");
    expect(listSkillsCommand(handle.db, {}).skills[0]).toMatchObject({ id, description: "First.", body: "One.", archivedAt: null });
    expect(listSkillVersionsCommand(handle.db, { id }).versions[0]).toMatchObject({ action: "restore", author: { kind: "person" }, restoredFrom: versions[2]?.id });

    const elsewhere = await tool("skill_restore_version").run(dispatch, { id, versionId: "019fb8c6-0000-7000-8000-00000000beef" });
    expect(elsewhere.ok && elsewhere.refused).toBe(true);
  });

  it("carries no stored value into what a write answers with", async () => {
    expect((await tool("mcp_server_save").run(dispatch, githubArgs)).ok).toBe(true);
    const id = catalogued()[0]?.id ?? "";
    expect(setMcpServerSecretCommand(handle.db, secrets, { serverId: id, name: "GITHUB_TOKEN", value: SECRET }).saved).toBe(true);

    // An edit and a switch, both of which answer with the whole row —
    // the same reply shape the listing has, and the same rule: a name
    // and whether something is behind it, never the value.
    const edited = await tool("mcp_server_save").run(dispatch, { ...githubArgs, id, args: ["-y", "@modelcontextprotocol/server-github", "--repo"] });
    const switched = await tool("mcp_server_set_enabled").run(dispatch, { id, enabled: false });

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.text).toContain("GITHUB_TOKEN (set)");
    // Both halves, because a caller reads one of them: the text lands in
    // a transcript and `data` travels beside it as structuredContent.
    expect(JSON.stringify(edited)).not.toContain(SECRET);
    expect(JSON.stringify(switched)).not.toContain(SECRET);
  });
});


/**
 * Ticking a catalogue entry onto an agent, from a client (EO-114).
 *
 * The reads say what an agent has and the catalogue writes fill the
 * shelf; this is the one that decides what the next dispatch is built
 * with, which is why it was the last of the three to be offered and why
 * the two properties below are the ones worth proving.
 *
 * The first is the reply. `agentAttachments:set` answers with the
 * agent's *whole* attachment set rather than the row that changed, and a
 * render that said only "attached" would throw that away and send the
 * caller back to `agent_attachments_list` for something it was already
 * holding.
 *
 * The second is that a tick is not inert until something restarts.
 * EO-106 made that true by folding a content fingerprint into the
 * provider cache key and refusing thread reuse when it differs, and both
 * halves re-read the database rather than being told — so nothing new
 * was needed here. What is new is the door: this is the first way to
 * attach something that does not go through EO's own window, and a test
 * that it lands the same way is what says so.
 */
describe("attaching a catalogue entry to an agent, from a client", () => {
  const CWD = "/tmp/eo/worktrees/EO-114";

  const identity = (): ProviderIdentity => ({
    eoMcpServerPath: "/unused/eoServer.mjs",
    dbPath: undefined,
    runtimeRoot: "/unused/runtimes",
    executablePath: null,
    sdkEntryPath: null,
    apiKeyDirectory: undefined,
    demoProviderDelayMs: undefined,
  });

  let directory: string;
  let secrets: McpServerSecretsOptions;
  let implementer: Agent;

  const reverse = (text: string) => [...text].reverse().join("");
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(reverse(text)),
    decryptString: (buffer) => reverse(buffer.toString()),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp attachments "));
    secrets = { directory, store };
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    registerHandler("mcpServers:save", (payload) => saveMcpServerCommand(handle.db, secrets, payload), opts);
    registerHandler("skills:save", (payload) => saveSkillCommand(handle.db, payload), opts);
    // `agent_attachments_set` reads both listings back to tell a
    // delivered attachment from one that is merely attached.
    registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, secrets, payload), opts);
    registerHandler("skills:list", (payload) => listSkillsCommand(handle.db, payload), opts);
    registerHandler("agentAttachments:list", (payload) => listAgentAttachmentsCommand(handle.db, payload), opts);
    registerHandler("agentAttachments:set", (payload) => setAgentAttachmentCommand(handle.db, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A catalogued server, added the way a client would add one. */
  async function server(name = "github"): Promise<string> {
    const outcome = await tool("mcp_server_save").run(dispatch, { name, transport: "stdio", command: "npx", args: ["-y", `@modelcontextprotocol/server-${name}`] });
    expect(outcome.ok).toBe(true);
    const servers = listMcpServerViews(handle.db, secrets, { includeArchived: false }).servers;
    return servers.find((candidate) => candidate.name === name)?.id ?? "";
  }

  async function skill(name = "House style"): Promise<string> {
    const outcome = await tool("skill_save").run(dispatch, { name, description: "How this team writes a pull request.", body: "Read the diff twice." });
    expect(outcome.ok).toBe(true);
    return listSkillsCommand(handle.db, {}).skills.find((candidate) => candidate.name === name)?.id ?? "";
  }

  const attached = (agentId: string) => listAgentAttachmentsCommand(handle.db, { agentId }).attachments[0]!;

  it("says what the agent will now be dispatched with, not merely that it worked", async () => {
    const serverId = await server();
    const skillId = await skill();

    const first = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });
    const second = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: skillId, attached: true });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.refused).toBe(false);
    expect(first.text).toContain(serverId);

    // The point of the story, and the reason the reply carries the whole
    // set: the second call attached a skill and the answer names the
    // server too. A caller reading this can say what the agent has
    // without asking again — which is what it is about to be asked.
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toContain(serverId);
    expect(second.text).toContain(skillId);
    expect(second.text).toContain(implementer.id);
    // And that it is not retroactive, said where a caller watching a run
    // in flight will read it.
    expect(second.text).toContain("next dispatch");
  });

  it("reports the set that is left after a detach, rather than the row it removed", async () => {
    const serverId = await server();
    const skillId = await skill();
    expect((await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true })).ok).toBe(true);
    expect((await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: skillId, attached: true })).ok).toBe(true);

    const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(false);
    expect(outcome.text).not.toContain(serverId);
    expect(outcome.text).toContain(skillId);
    // Detaching is not destruction: the catalogue row is still there to
    // be attached again, which is the judgement `destructiveHint` was
    // left off on.
    expect(listMcpServerViews(handle.db, secrets, { includeArchived: false }).servers.map((entry) => entry.id)).toEqual([serverId]);
    expect(attached(implementer.id).mcpServerIds).toEqual([]);
  });

  it("says nothing is attached when the last one comes off, rather than printing an empty list", async () => {
    const serverId = await server();
    expect((await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true })).ok).toBe(true);

    const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("nothing out of either catalogue");
  });

  it("refuses an agent and an entry it does not have, as sentences with nothing changed", async () => {
    const serverId = await server();
    const absent = uuidv7();

    const noAgent = await tool("agent_attachments_set").run(dispatch, { agentId: absent, kind: "mcpServer", id: serverId, attached: true });
    const noEntry = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: absent, attached: true });

    // `ok: true` and refused, not a fault — the call reached the
    // catalogue and the catalogue said no. A client that cannot tell
    // that from EO being broken retries it.
    expect(noAgent.ok).toBe(true);
    if (!noAgent.ok) return;
    expect(noAgent.refused).toBe(true);
    expect(noAgent.text).toContain("no longer exists");
    expect(noAgent.text).toContain("Nothing has changed.");

    expect(noEntry.ok).toBe(true);
    if (!noEntry.ok) return;
    expect(noEntry.refused).toBe(true);
    expect(noEntry.text).toContain("Nothing has changed.");

    expect(attached(implementer.id).mcpServerIds).toEqual([]);
    expect(attached(implementer.id).skillIds).toEqual([]);
  });

  it("is picked up by the next dispatch rather than waiting for a restart", async () => {
    // The EO-106 property, proved through the new door. Both halves of
    // it re-read the database, so what this really asserts is that a
    // tick arriving over MCP is the same row a tick from EO's own window
    // writes — there is no second path that could have needed telling.
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const serverId = await server();

    const keyBefore = providerCacheKey(implementer, handle.db, identity());
    // A thread this agent could have carried on: born with the tool
    // surface it had at the time, which is none.
    const prior = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
    });
    expect(findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD })).toEqual({ kind: "resume", run: prior });

    const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });

    expect(outcome.ok).toBe(true);
    // The provider is rebuilt rather than served from the cache, which
    // is how the next dispatch gets a session that was actually launched
    // with the server.
    expect(providerCacheKey(implementer, handle.db, identity())).not.toBe(keyBefore);
    // And the conversation that predates it is not carried on, because a
    // provider session keeps the tools it was started with. The refusal
    // is a sentence, so the run this displaces can say why.
    const decision = findReusableThread(handle.db, { itemId: item.id, agent: implementer, cwd: CWD });
    expect(decision.kind).toBe("refused");
    if (decision.kind === "resume") return;
    expect(decision.reason).toContain("MCP servers or skills attached");
    expect(decision.reason).toContain(implementer.name);
  });

  /**
   * Attached is not delivered, and the report has to hold them apart.
   *
   * `setAgentAttachment` accepts a disabled or archived row on purpose,
   * and `deliverableAttachments` filters both back out before a plugin
   * directory is written — so the raw attachment set overstates what the
   * next dispatch receives. A client told "now dispatched with github"
   * about a server that is switched off repeats that to a person, and
   * the first sign it was wrong is an agent that cannot do the thing it
   * was supposedly given.
   *
   * Each of these asserts the claim against `deliverableAttachments`
   * itself rather than against a second copy of its rule, so a change to
   * what EO delivers cannot leave the sentence behind.
   */
  describe("an entry that is attached but will not be delivered", () => {
    /** What a dispatch would actually write, for this agent, right now. */
    const wouldDeliver = (agentId: string) => deliverableAttachments(resolveAgentAttachments(handle.db, agentId));

    it("accepts a disabled server and says it is attached and not delivered", async () => {
      const serverId = await server();
      expect(setMcpServerEnabledCommand(handle.db, secrets, { id: serverId, enabled: false }).server?.enabled).toBe(false);

      const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });

      // Accepted, not refused: attaching something switched off is a
      // thing a person may be part way through doing.
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.refused).toBe(false);
      expect(attached(implementer.id).mcpServerIds).toEqual([serverId]);

      expect(outcome.text).toContain("Attached, and not delivered:");
      expect(outcome.text).toContain("disabled");
      // And it does not appear as something the agent will be dispatched
      // with, which is the whole claim.
      expect(outcome.text).not.toContain("will be dispatched with:");
      expect(wouldDeliver(implementer.id).servers).toEqual([]);
    });

    it("says the same about an archived skill, which archiving does not detach", async () => {
      const skillId = await skill();
      expect(archiveSkillCommand(handle.db, { id: skillId }).archived).toBe(true);

      const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: skillId, attached: true });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.text).toContain("Attached, and not delivered:");
      expect(outcome.text).toContain("archived");
      expect(wouldDeliver(implementer.id).skills).toEqual([]);
    });

    it("names both reasons when a row is switched off and archived", async () => {
      const serverId = await server();
      expect(setMcpServerEnabledCommand(handle.db, secrets, { id: serverId, enabled: false }).server?.enabled).toBe(false);
      expect(archiveMcpServerCommand(handle.db, { id: serverId }).archived).toBe(true);

      const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Being told only one of them sends a person back for the other.
      expect(outcome.text).toContain("disabled and archived");
    });

    it("separates the delivered from the withheld when an agent has both", async () => {
      const live = await server("github");
      const dead = await server("jira");
      const skillId = await skill();
      expect(archiveMcpServerCommand(handle.db, { id: dead }).archived).toBe(true);
      expect((await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: live, attached: true })).ok).toBe(true);
      expect((await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: dead, attached: true })).ok).toBe(true);

      const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: skillId, attached: true });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const [dispatchedWith, notDelivered] = outcome.text.split("Attached, and not delivered:");

      // The live server and the skill on one side of the split, the
      // archived server on the other — and nothing on the wrong side.
      expect(dispatchedWith).toContain("will be dispatched with:");
      expect(dispatchedWith).toContain(live);
      expect(dispatchedWith).toContain(skillId);
      expect(dispatchedWith).not.toContain(dead);
      expect(notDelivered).toContain(dead);
      expect(notDelivered).not.toContain(live);

      // Which is exactly the split a dispatch makes.
      const delivered = wouldDeliver(implementer.id);
      expect(delivered.servers.map((entry) => entry.id)).toEqual([live]);
      expect(delivered.skills.map((entry) => entry.id)).toEqual([skillId]);
      // Both are still attached: this is a report, not a detach.
      expect(attached(implementer.id).mcpServerIds).toEqual([live, dead]);
    });

    it("still reports the tick when a catalogue cannot be read back, rather than failing a write that happened", async () => {
      const serverId = await server();
      // The listing gone from under the tool, which is the only way the
      // set can succeed and the resolve cannot. The tick is already
      // written by then, so answering `ok: false` would tell a caller
      // nothing happened when something did.
      clearHandlerRegistry();
      registerHandler("agentAttachments:set", (payload) => setAgentAttachmentCommand(handle.db, payload), opts);

      const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "mcpServer", id: serverId, attached: true });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.refused).toBe(false);
      expect(attached(implementer.id).mcpServerIds).toEqual([serverId]);
      // The id, and no claim about delivery either way.
      expect(outcome.text).toContain(serverId);
      expect(outcome.text).toContain("could not read the catalogue back");
      expect(outcome.text).not.toContain("will be dispatched with:");
    });
  });

  it("takes a skill the same way, because the fingerprint is over both catalogues", async () => {
    // `kind` is the whole of the difference at this seam, and a
    // fingerprint that covered servers alone would make a skill attached
    // over MCP land only on the next restart.
    const skillId = await skill();
    const keyBefore = providerCacheKey(implementer, handle.db, identity());

    const outcome = await tool("agent_attachments_set").run(dispatch, { agentId: implementer.id, kind: "skill", id: skillId, attached: true });

    expect(outcome.ok).toBe(true);
    expect(providerCacheKey(implementer, handle.db, identity())).not.toBe(keyBefore);
    expect(attached(implementer.id).skillIds).toEqual([skillId]);
  });
});

/**
 * The values behind a catalogued server's variables, set and cleared
 * from a client (EO-115).
 *
 * The reads say what an agent has, the catalogue writes fill the shelf,
 * the tick decides what a dispatch is built with — and this is the last
 * of it: the token the server needs in order to be worth having. It is
 * offered on `module_secret_set`'s terms, and the property those terms
 * rest on is the one worth proving here, because it is the property the
 * whole surface would be withdrawn over. A value goes in and nothing
 * hands it back.
 *
 * "Nothing" is swept rather than sampled. Every assertion below
 * stringifies the whole outcome — the text a client puts in a
 * transcript, the `data` that travels beside it as structuredContent,
 * and an error envelope's message and issues — because a check on one
 * named field passes while the value is sitting in the next one along.
 * Each sweep is paired with a read of the keychain, so a green run means
 * the value really was there to leak rather than that the call quietly
 * did nothing.
 *
 * `safeStorage` is faked by reversing rather than by prefixing, as it is
 * for the reads above: a fake that stored the value verbatim would let a
 * leak of the *ciphertext* pass a search for the plaintext.
 */
describe("setting and clearing a catalogued server's secrets, from a client", () => {
  const SECRET = "ghp-nobody-may-ever-read-this";
  const reverse = (text: string) => [...text].reverse().join("");

  let backend = "gnome_libsecret";
  // A keychain that fails with the value in its hand, and says so in the
  // message — which is what a native binding that echoes its argument
  // would do, and what the last test below is about.
  let encryptThrows = false;
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      if (encryptThrows) throw new Error(`safeStorage could not encrypt "${text}"`);
      return Buffer.from(reverse(text));
    },
    decryptString: (buffer) => reverse(buffer.toString()),
    getSelectedStorageBackend: () => backend,
  };

  let directory: string;
  let secrets: McpServerSecretsOptions;

  beforeEach(() => {
    backend = "gnome_libsecret";
    encryptThrows = false;
    directory = mkdtempSync(join(tmpdir(), "eo mcp server secrets "));
    secrets = { directory, store };

    registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:save", (payload) => saveMcpServerCommand(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:setSecret", (payload) => setMcpServerSecretCommand(handle.db, secrets, payload), opts);
    registerHandler("mcpServers:clearSecret", (payload) => clearMcpServerSecretCommand(handle.db, secrets, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A catalogued server with a variable it declares, added the way a client would add one. */
  async function server(): Promise<string> {
    const outcome = await tool("mcp_server_save").run(dispatch, {
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      envNames: ["GITHUB_TOKEN"],
    });
    expect(outcome.ok).toBe(true);
    return listMcpServerViews(handle.db, secrets, { includeArchived: false }).servers[0]?.id ?? "";
  }

  it("stores a value and then says only that the name is set", async () => {
    const serverId = await server();

    const stored = await tool("mcp_server_set_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN", value: SECRET });
    const listed = await tool("mcp_servers_list").run(dispatch, {});

    // The sweep first, and before any narrowing — here and in every test
    // below. Whatever shape the reply took, a rendered success, a
    // refusal or an error envelope, the value is in none of it; a sweep
    // placed after `if (!outcome.ok) return` is one that stops running
    // at exactly the moment something has gone wrong.
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    // And it really went in — otherwise both sweeps are a search for
    // something that was never anywhere.
    expect(readMcpServerSecret(secrets, serverId, "GITHUB_TOKEN")).toBe(SECRET);

    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.refused).toBe(false);
    expect(stored.text).toContain("OS keychain");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("GITHUB_TOKEN (set)");
  });

  it("keeps the value out of a refusal, keychain and catalogue alike", async () => {
    const serverId = await server();
    // The two ways this call is answered no: a machine whose keychain is
    // encryption in name only, which is refused rather than written to
    // in the clear, and an id the catalogue does not have.
    backend = "basic_text";

    const weak = await tool("mcp_server_set_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN", value: SECRET });
    const missing = await tool("mcp_server_set_secret").run(dispatch, { serverId: uuidv7(), name: "GITHUB_TOKEN", value: SECRET });

    expect(JSON.stringify(weak)).not.toContain(SECRET);
    expect(JSON.stringify(missing)).not.toContain(SECRET);
    // Refused, not written anyway — the one thing this path must not do.
    expect(readMcpServerSecret(secrets, serverId, "GITHUB_TOKEN")).toBeNull();

    expect(weak.ok).toBe(true);
    if (!weak.ok) return;
    expect(weak.refused).toBe(true);
    // Which backend it means, because "EO will not store this" is only
    // actionable when it says that.
    expect(weak.text).toContain("basic_text");
    expect(weak.text).toContain("Nothing has changed.");

    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.refused).toBe(true);
    expect(missing.text).toContain("That MCP server no longer exists.");
  });

  it("keeps the value out of an error the channel returns", async () => {
    const serverId = await server();

    // A name that is not an environment-variable name fails the
    // contract's own validation, so what comes back is an error envelope
    // rather than a refusal — the third place a value could be echoed,
    // and the one nothing in this file writes.
    const outcome = await tool("mcp_server_set_secret").run(dispatch, { serverId, name: "GITHUB TOKEN", value: SECRET });

    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(readMcpServerSecret(secrets, serverId, "GITHUB_TOKEN")).toBeNull();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toContain("Use an environment-variable name.");
  });

  it("keeps the value out of the reply when the keychain throws with it in hand", async () => {
    const serverId = await server();
    // The path the sweep above cannot reach. `encryptString` is handed
    // the value, so an exception from it is the one error in EO that can
    // be quoting a token — and this store quotes it, the way a native
    // binding that echoes its argument would. Left to throw, it would
    // arrive here as `String(error)` in the IPC envelope, because the
    // host dispatches with `exposeErrorDetails` on.
    encryptThrows = true;

    const outcome = await tool("mcp_server_set_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN", value: SECRET });

    // This is the assertion the story turns on, and the one that fails
    // if the exception is left to escape: the envelope would be carrying
    // the message above, quotation marks and all.
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    // And nothing was written by a path that failed halfway.
    expect(readMcpServerSecret(secrets, serverId, "GITHUB_TOKEN")).toBeNull();

    // A refusal rather than a fault: the call reached the channel and
    // the answer is no, in a sentence EO wrote rather than one the
    // failure did.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refused).toBe(true);
    expect(outcome.text).toContain("Nothing has changed.");
  });

  it("clears a value, and answers the same way for one that was never there", async () => {
    const serverId = await server();
    expect((await tool("mcp_server_set_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN", value: SECRET })).ok).toBe(true);

    const cleared = await tool("mcp_server_clear_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN" });
    const again = await tool("mcp_server_clear_secret").run(dispatch, { serverId, name: "GITHUB_TOKEN" });
    const listed = await tool("mcp_servers_list").run(dispatch, {});

    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.refused).toBe(false);
    expect(cleared.text).toContain("EO holds no value for that variable now.");
    expect(readMcpServerSecret(secrets, serverId, "GITHUB_TOKEN")).toBeNull();
    expect(JSON.stringify(cleared)).not.toContain(SECRET);

    // A name with nothing behind it is not a failure, and it is answered
    // in the same words — the sentence is true either way, which is why
    // it does not claim a removal.
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.refused).toBe(false);
    expect(again.text).toBe(cleared.text);

    // And the listing agrees: the variable is owed again.
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("GITHUB_TOKEN (not set)");
  });
});

/**
 * A module's reference to EO's environment, from a client (EO-416).
 *
 * The three module-secret tools already existed; what is new is that a
 * name can be pointed at one of EO's own variables through them, listed
 * with the variable it reads, and cleared. Driven through the registry
 * like everything above, so the arguments a client sends are parsed by
 * the same schema the renderer's are.
 *
 * The variable's value is swept for in every outcome, for the reason
 * the server-secret tests sweep: a *name* may travel through a client's
 * transcript, and the value behind it may not.
 */
describe("a module secret that references EO's environment, from a client", () => {
  const VALUE = "/opt/jdk21-nobody-may-read-this";
  const reverse = (text: string) => [...text].reverse().join("");
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(reverse(text)),
    decryptString: (buffer) => reverse(buffer.toString()),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  let directory: string;
  let secrets: ModuleSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo module secret tools "));
    secrets = { directory, store, environment: { JDK21_HOME: VALUE } };

    registerHandler("moduleSecrets:list", (payload) => listModuleSecrets(handle.db, secrets, payload), opts);
    registerHandler("moduleSecrets:set", (payload) => setModuleSecret(handle.db, secrets, payload), opts);
    registerHandler("moduleSecrets:clear", (payload) => clearModuleSecret(handle.db, secrets, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("sets a reference, lists it with its variable, and clears it", async () => {
    const set = await tool("module_secret_set").run(dispatch, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } });
    const dangling = await tool("module_secret_set").run(dispatch, { name: "GOROOT", reference: {} });
    const listed = await tool("module_secrets_list").run(dispatch, {});

    expect(JSON.stringify([set, dangling, listed])).not.toContain(VALUE);
    // And it really resolves — otherwise the sweep is a search for
    // something that was never anywhere.
    expect(environmentFor(secrets, ["JAVA_HOME"]).env).toEqual({ JAVA_HOME: VALUE });

    expect(set.ok && !set.refused).toBe(true);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // Set, because a dispatch would get a value; and named as what it is.
    expect(listed.text).toContain("Shared: JAVA_HOME");
    expect(listed.text).toContain("JAVA_HOME (shared) reads JDK21_HOME — EO's environment has it");
    expect(listed.text).toContain("GOROOT (shared) reads GOROOT — missing or empty in EO's environment");

    const cleared = await tool("module_secret_clear").run(dispatch, { name: "JAVA_HOME" });
    const after = await tool("module_secrets_list").run(dispatch, {});

    expect(cleared.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.text).toContain("Shared: none");
    expect(after.text).not.toContain("JDK21_HOME");
  });

  // The one outcome a client has to be told rather than left to infer:
  // the stored value cannot be read back, so it cannot be put back.
  it("says a stored value was replaced, and that it is gone", async () => {
    await tool("module_secret_set").run(dispatch, { name: "JAVA_HOME", value: "/stored" });

    const replaced = await tool("module_secret_set").run(dispatch, { name: "JAVA_HOME", reference: { variable: "JDK21_HOME" } });

    expect(JSON.stringify(replaced)).not.toContain(VALUE);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.refused).toBe(false);
    expect(replaced.text).toContain("replaced a stored value");
    expect(replaced.text).toContain("gone for good");
  });

  it("refuses a call that gives both a value and a reference, having changed nothing", async () => {
    const both = await tool("module_secret_set").run(dispatch, { name: "JAVA_HOME", value: "/stored", reference: {} });

    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.refused).toBe(true);
    expect(both.text).toContain("Nothing has changed.");
    expect(listModuleSecrets(handle.db, secrets, {})).toMatchObject({ names: [], references: [] });
  });

  // Reveal exists on the desktop now (EO-489, ARCHITECTURE.md §14.2), and
  // this tool is still names only: the value a person can read on their
  // screen is never in what a client is told.
  it("lists a stored value by name and never returns it", async () => {
    const STORED = "fly-token-nobody-may-read-through-a-tool";
    const set = await tool("module_secret_set").run(dispatch, { name: "FLY_API_TOKEN", value: STORED });
    const listed = await tool("module_secrets_list").run(dispatch, {});

    expect(JSON.stringify([set, listed])).not.toContain(STORED);
    expect(JSON.stringify([set, listed])).not.toContain(reverse(STORED));
    // And it really went in, so the sweep is a search for something that is there.
    expect(readSecret(secrets, "FLY_API_TOKEN")).toBe(STORED);
    expect(listed.ok && listed.text).toContain("Shared: FLY_API_TOKEN");
  });

  // The gate is the whole reason an agent may hold these at all.
  it("keeps all three behind the gate", () => {
    for (const name of ["module_secrets_list", "module_secret_set", "module_secret_clear"]) {
      expect(tool(name).kind).toBe("dangerous");
    }
  });
});

/**
 * Environment variables, from a client (EO-485).
 *
 * The other way round from the secrets above: a variable is not secret,
 * so the list returns each value — and the writes are still gated,
 * because a variable reaches what every process EO starts is given.
 */
describe("environment variables, from a client", () => {
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from([...text].reverse().join("")),
    decryptString: (buffer) => [...buffer.toString()].reverse().join(""),
    getSelectedStorageBackend: () => "gnome_libsecret",
  };

  let directory: string;
  let secrets: ModuleSecretsOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo environment variable tools "));
    secrets = { directory, store };

    registerHandler("moduleSecrets:set", (payload) => setModuleSecret(handle.db, secrets, payload), opts);
    registerHandler("environmentVariables:list", (payload) => listEnvironmentVariables(handle.db, secrets, payload), opts);
    registerHandler("environmentVariables:set", (payload) => setEnvironmentVariable(handle.db, secrets, payload), opts);
    registerHandler("environmentVariables:clear", (payload) => clearEnvironmentVariable(handle.db, secrets, payload), opts);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("sets a variable, lists it with its value, and clears it", async () => {
    const set = await tool("environment_variable_set").run(dispatch, { name: "REGION", value: "eu-west-1" });
    const listed = await tool("environment_variables_list").run(dispatch, {});

    expect(set.ok && !set.refused).toBe(true);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("REGION=eu-west-1 (shared)");
    expect(environmentFor(secrets, ["REGION"]).env).toEqual({ REGION: "eu-west-1" });

    const cleared = await tool("environment_variable_clear").run(dispatch, { name: "REGION" });
    const after = await tool("environment_variables_list").run(dispatch, {});

    expect(cleared.ok).toBe(true);
    expect(after.ok && after.text).toBe("No environment variables are set.");
  });

  // A step's own value is the person's, typed on the assistant's card
  // (EO-522): the tool says the step sets the name, and gives neither
  // the text nor the structured answer its value. Shared values are
  // listed as they always were.
  it("lists a step's own variable by name only, in its text and its structured answer", async () => {
    const stepId = listStepsForPipeline(handle.db, "default")[0]!.id;
    await tool("environment_variable_set").run(dispatch, { name: "REGION", value: "eu-west-1" });
    await tool("environment_variable_set").run(dispatch, { name: "TIER", value: "the-steps-own-tier", stepId });

    const listed = await tool("environment_variables_list").run(dispatch, { stepId });

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain("REGION=eu-west-1 (shared)");
    expect(listed.text).toContain("TIER (this step) — set; a step's own value is not shown to agents");
    expect(listed.text).not.toContain("the-steps-own-tier");
    expect(listed.data).toEqual({
      variables: [
        { name: "REGION", value: "eu-west-1", scope: "shared" },
        { name: "TIER", value: null, scope: "step" },
      ],
    });
    // The person's own read is the channel, and it still has every value.
    expect(listEnvironmentVariables(handle.db, secrets, { stepId }).variables).toContainEqual({ name: "TIER", value: "the-steps-own-tier", scope: "step" });
  });

  it("refuses a name that is already a secret, having changed nothing", async () => {
    await tool("module_secret_set").run(dispatch, { name: "REGION", value: "secret" });

    const refused = await tool("environment_variable_set").run(dispatch, { name: "REGION", value: "eu-west-1" });

    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.refused).toBe(true);
    expect(refused.text).toContain("Secrets list");
    expect(refused.text).toContain("Nothing has changed.");
    expect(listEnvironmentVariables(handle.db, secrets, {}).variables).toEqual([]);
  });

  /**
   * What fills a server's declared name, in the order a spawn asks
   * (EO-488): the organisation's value, the server's own secret, then a
   * shared environment variable — and only then "not set".
   */
  it("says in mcp_servers_list which declared names an environment variable fills", async () => {
    const serverSecrets = { directory: join(directory, "mcp-server-secrets"), store };
    const organisation = { directory: join(directory, "organisation-secrets"), store };
    registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, serverSecrets, payload, { secrets: organisation, policy: NO_POLICY }, secrets), opts);
    const saved = saveMcpServerCommand(handle.db, serverSecrets, McpServerDraftSchema.parse({ name: "cloud", transport: "stdio", command: "cloud-mcp", envNames: ["REGION", "OWN", "ORG", "NOTHING"] }));
    const serverId = saved.server?.id ?? "";
    setMcpServerSecretCommand(handle.db, serverSecrets, { serverId, name: "OWN", value: "the-servers-own" });
    expect(storeOrganisationSecret(organisation, "ORG", "the-organisations").ok).toBe(true);
    for (const name of ["REGION", "OWN", "ORG"]) await tool("environment_variable_set").run(dispatch, { name, value: "from-a-variable" });

    const listed = await tool("mcp_servers_list").run(dispatch, {});

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.text).toContain(
      "needs REGION (from environment variables), OWN (set), ORG (set by your organisation), NOTHING (not set)",
    );
    // Names, never values — a variable's included.
    expect(listed.text).not.toContain("from-a-variable");
  });

  it("reads freely and keeps both writes behind the gate", () => {
    expect(tool("environment_variables_list").kind).toBe("read");
    expect(tool("environment_variable_set").kind).toBe("dangerous");
    expect(tool("environment_variable_clear").kind).toBe("dangerous");
  });
});

/**
 * Keep checking, as an agent working over MCP meets it (EO-506): what
 * pipeline_get says about it, what pipeline_save does with a step that
 * leaves it out, and what pipeline_save says when a save turns it off.
 */
describe("keep checking through pipeline_get and pipeline_save", () => {
  beforeEach(() => {
    registerHandler("pipelineSteps:list", (payload) => listPipelineStepViews(handle.db, payload), opts);
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
  });

  const watchOf = (id: string) => listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.find((step) => step.id === id)?.watch;

  it("pipeline_get shows the interval and give-up time of a step that keeps checking, as the field pipeline_save takes", async () => {
    const outcome = await tool("pipeline_get").run(dispatch, { pipelineId: "default" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const watching = outcome.text.split("\n").findIndex((line) => line.startsWith("- Watching pull request (id: pull_request_watch)"));
    expect(watching).toBeGreaterThanOrEqual(0);
    expect(outcome.text.split("\n")[watching + 1]).toBe(
      '  keeps checking: every 5 minutes, giving up after 7 days — `watch: { "everyMinutes": 5, "giveUpAfterHours": 168 }`',
    );
    // Only on the step that keeps checking: one that runs once says nothing.
    expect(outcome.text.match(/keeps checking:/g)).toHaveLength(1);
  });

  /**
   * Never giving up (EO-571), the whole way round over MCP: set with
   * pipeline_save, said by pipeline_get as never giving up with the field
   * as pipeline_save takes it, and read back unchanged in its data.
   */
  it("pipeline_save sets a step to never give up, and pipeline_get says so and hands the setting back unchanged", async () => {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const steps = graph.steps.map((step) => (step.id === "pull_request_watch" ? { ...step, watch: { everyMinutes: 5, neverGivesUp: true } } : step));
    const saved = await tool("pipeline_save").run(dispatch, { pipelineId: "default", steps, routes: graph.routes, entryStepId: graph.entryStepId });
    expect(saved.ok && (saved.data as IpcResponse<"pipeline:save">).saved).toBe(true);

    const outcome = await tool("pipeline_get").run(dispatch, { pipelineId: "default" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const lines = outcome.text.split("\n");
    const watching = lines.findIndex((line) => line.startsWith("- Watching pull request (id: pull_request_watch)"));
    expect(lines[watching + 1]).toBe('  keeps checking: every 5 minutes, never giving up — `watch: { "everyMinutes": 5, "neverGivesUp": true }`');
    expect(outcome.text).not.toContain("giving up after");
    const read = (outcome.data as IpcResponse<"pipelineSteps:list">).steps.find((step) => step.id === "pull_request_watch")!.watch;
    expect(read).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });

    // Saved back exactly as it was read, nothing changes.
    const again = await tool("pipeline_save").run(dispatch, {
      pipelineId: "default",
      steps: (outcome.data as IpcResponse<"pipelineSteps:list">).steps,
      routes: graph.routes,
      entryStepId: graph.entryStepId,
    });
    expect(again.ok && (again.data as IpcResponse<"pipeline:save">).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
  });

  it("pipeline_save keeps a step's keep checking when the step leaves watch out, and says nothing about it", async () => {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    const steps = graph.steps.map(({ watch: _watch, ...step }) => step);

    const outcome = await tool("pipeline_save").run(dispatch, { pipelineId: "default", steps, routes: graph.routes, entryStepId: graph.entryStepId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as IpcResponse<"pipeline:save">).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
    expect(outcome.text).not.toContain("Keep checking is now off");
  });

  it("pipeline_save turns it off on an explicit null, and its answer says so by step", async () => {
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });
    // A person checks the pull request instead: the one graph in which
    // the step may stop keeping checking (EO-505 refuses a pull request
    // watch that runs once). Its branches to a person go, since on a
    // person's step that is where the item already is.
    const routes = graph.routes.filter((route) => route.fromStepId !== "pull_request_watch" || route.target !== USER_ATTENTION_TARGET);
    const steps = graph.steps.map((step) => {
      if (step.id !== "pull_request_watch") return step;
      const person = { ...step, type: "user" as const, entryAction: null, ownerRole: null, watch: null };
      return { ...person, results: resultsFromRoutes(person, routes) };
    });

    const outcome = await tool("pipeline_save").run(dispatch, { pipelineId: "default", steps, routes, entryStepId: graph.entryStepId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.data as IpcResponse<"pipeline:save">).saved).toBe(true);
    expect(watchOf("pull_request_watch")).toBeNull();
    expect((outcome.data as IpcResponse<"pipeline:save">).watchTurnedOff).toEqual([{ stepId: "pull_request_watch", name: "Watching pull request" }]);
    expect(outcome.text).toContain("Keep checking is now off on these steps");
    expect(outcome.text).toContain("- Watching pull request (id: pull_request_watch)");
  });
});
