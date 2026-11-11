import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModuleManifest, PipelineExport, StepWatch, Uuid } from "@eo/core";
import { resetSearchPathForTests, resolveSearchPath } from "../process/searchPath.js";
import {
  actionShapeFromSchema,
  ADMIN_GRANT_REFUSAL,
  CONNECTOR_SETUP_REFUSAL,
  EMPTY_SPEC_SHAPE,
  isBoundAgent,
  isDispatchable,
  isDeliverableMcpServer,
  McpServerDraftSchema,
  moduleTestShortfalls,
  outputSchemaFor,
  PIPELINE_EXPORT_VERSION,
  UNBOUND_BACKEND,
  UNKNOWN_ITEM_TYPE,
  validateActionResult,
} from "@eo/core";
import type { Db, DbHandle } from "../db/client.js";
import {
  addMemory,
  addModuleTests,
  getActionDefinition,
  listActionDefinitions,
  saveActionDefinition,
  archiveAgent,
  createAgent,
  createDisconnectedConnector,
  createPipeline,
  createProject,
  createRoute,
  createStep,
  getJiraBinding,
  getModuleBySlug,
  insertItemType,
  isJiraConnected,
  getAgentAttachments,
  listAgents,
  listConnectorsForProject,
  getMcpServerByName,
  getPipeline,
  listItems,
  listItemTypes,
  listMcpServers,
  listModules,
  listModuleTests,
  listPipelines,
  listRoutesForPipeline,
  listStepsForPipeline,
  saveJiraBinding,
  saveMcpServer,
  saveModule,
  setEntryStep,
  setWebhookUnattended,
  updateAgent,
} from "../db/repos/index.js";
import { registryForProject } from "../registry.js";
import { migrateCarriedSchemas } from "../actionDefinitionAdoption.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { exportPipeline, importPipeline, parseExport, preflightImport } from "./pipelineTransfer.js";
import { galleryNeeds } from "../gallery/form.js";
import { storeReference, storeSecret, storeVariable, type ModuleSecretsOptions } from "./secrets.js";
import { attachmentEnvironment } from "../agentAttachments/serverEnvironment.js";
import { usePackConnectors } from "../connectors/declared.js";
import { listConnectorViews } from "../connectors/list.js";
import { connectConnectorTokenCommand } from "../ipc/connectorCommands.js";
import { listMcpServerSecretNames, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { listModuleViews } from "../ipc/moduleCommands.js";

/**
 * Moving a pipeline between machines (KAN-108).
 *
 * The payoff of the module contract: because a module declares what it
 * touches and can reach nothing else, an import can be checked against
 * this machine before a line of it runs.
 */

const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from([...text].reverse().join("")),
  decryptString: (buffer: Buffer) => [...buffer.toString()].reverse().join(""),
};

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Builds and deploys the branch to staging.",
  inputs: {},
  // `flyctl` is not on any test machine's PATH, which is the point:
  // preflight has to notice.
  needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

const code = "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }";

let handle: DbHandle;
let scratch: string;
let secrets: ModuleSecretsOptions;
/** Where a connector's values go — a server's own directory, not a module's (EO-104). */
let serverSecrets: McpServerSecretsOptions;

/** A two-step pipeline whose first step runs a deploy module. */
function shippingPipeline() {
  const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Builds and deploys the branch to staging.", code, manifest, approve: true });
  if (!saved.ok) throw new Error(saved.reason);

  const pipeline = createPipeline(handle.db, { name: "Shipping" });
  createStep(handle.db, { id: "deploy-step", pipelineId: pipeline.id, position: 0, name: "Deploy", type: "module", entryAction: saved.module.id });
  createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "deploy-step", resultKey: "deployed", label: "Deployed", target: "done" });
  createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "deploy-step", resultKey: "failed", label: "Failed", target: "user_attention", position: 1 });
  setEntryStep(handle.db, pipeline.id, "deploy-step");

  return { pipeline, module: saved.module };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo transfer "));
  secrets = { directory: join(scratch, "secrets"), store };
  serverSecrets = { directory: join(scratch, "mcp-server-secrets"), store };
  // No pack folded, so the reach list below is exactly what this
  // document put there and nothing the developer pack contributes.
  usePackConnectors(new Map());
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
  usePackConnectors(new Map());
});

describe("exporting", () => {
  it("carries the graph and every module its steps name", () => {
    const { pipeline } = shippingPipeline();

    const built = exportPipeline(handle.db, pipeline.id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.document.eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
    expect(built.document.pipeline.name).toBe("Shipping");
    expect(built.document.steps).toHaveLength(2);
    expect(built.document.routes).toHaveLength(2);
    expect(built.document.modules).toHaveLength(1);
    expect(built.document.modules[0]).toMatchObject({ slug: "deploy", code });
  });

  // Ids are local — the same module has a different uuid on each machine
  // — so the document refers to modules by slug.
  it("names modules by slug, not by id", () => {
    const { pipeline, module } = shippingPipeline();

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;

    const step = built.document.steps.find((candidate) => candidate.id === "deploy-step");
    expect(step?.entryAction).toBe("deploy");
    expect(step?.entryAction).not.toBe(module.id);
  });

  // Approval records that somebody *here* read this code. A stranger's
  // word for that is worth nothing, so it does not travel.
  it("carries no approval", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;

    expect(JSON.stringify(built.document)).not.toContain("approvedAt");
  });
});

/**
 * Memory and a pipeline export (EO-482, ARCHITECTURE.md, "One document").
 *
 * Memory is what a project's runs and people learned, kept as entries of
 * that project and its workspaces. A pipeline is configuration that can
 * be handed to anyone, as a file, a suggestion or a gallery template, so
 * none of it travels in the document.
 */
describe("exporting a pipeline whose project has memory (EO-482)", () => {
  it("contains no memory entry", () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const pipeline = createPipeline(handle.db, { name: "Support work", projectId: project.id });
    createStep(handle.db, { id: "answer", pipelineId: pipeline.id, position: 0, name: "Answer", type: "agent", ownerRole: "implementer" });
    createStep(handle.db, { id: "answered", pipelineId: pipeline.id, position: 1, name: "Answered", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "answer", resultKey: "done", label: "Done", target: "answered" });
    setEntryStep(handle.db, pipeline.id, "answer");
    const entry = addMemory(handle.db, { scope: { kind: "project", id: project.id }, body: "Customers on the old plan are billed in arrears.", source: { type: "person", personId: null } });
    if (!entry.ok) throw new Error(entry.problem);

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const text = JSON.stringify(built.document);
    expect(text).not.toContain(entry.entry.id);
    expect(text).not.toContain("billed in arrears");
    expect(Object.keys(built.document)).not.toContain("memories");
  });
});

/**
 * A project's own agents and a pipeline export (EO-476, ARCHITECTURE.md,
 * "One document").
 *
 * An export carries roles, never agents: no agent's id, name or project
 * is in the document, and the receiving machine chooses who fills each
 * slot. Which prompt a role carries follows the staffing rule's scope —
 * another project's agent never runs this pipeline's work.
 */
describe("exporting a pipeline beside project-scoped agents (EO-476)", () => {
  function writerPipeline(projectId: Uuid | null) {
    const pipeline = createPipeline(handle.db, { name: "Writing", projectId });
    createStep(handle.db, { id: `write-${pipeline.id}`, pipelineId: pipeline.id, position: 0, name: "Write", type: "agent", ownerRole: "writer" });
    createStep(handle.db, { id: `done-${pipeline.id}`, pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: `write-${pipeline.id}`, resultKey: "done", label: "Done", target: `done-${pipeline.id}` });
    setEntryStep(handle.db, pipeline.id, `write-${pipeline.id}`);
    return pipeline;
  }

  function arrange() {
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const global = createAgent(handle.db, { name: "House writer", role: "writer", provider: "fake", instructions: "Write for everyone." });
    const supportsOwn = createAgent(handle.db, { name: "Support writer", role: "writer", provider: "fake", instructions: "Write for Support.", projectId: support.id });
    return { support, shop, global, supportsOwn };
  }

  it("contains no agent at all — no id, no name, no project", () => {
    const { support, global, supportsOwn } = arrange();
    const built = exportPipeline(handle.db, writerPipeline(support.id).id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const text = JSON.stringify(built.document);
    for (const agent of [global, supportsOwn]) {
      expect(text).not.toContain(agent.id);
      expect(text).not.toContain(agent.name);
    }
    expect(text).not.toContain(support.id);
    // What it carries instead is the role, by its slug.
    expect(built.document.roles.map((role) => role.slug)).toEqual(["writer"]);
    expect(Object.keys(built.document)).not.toContain("agents");
  });

  it("carries the prompt of the agent that would run the pipeline's work: the project's own first", () => {
    const { support } = arrange();
    const built = exportPipeline(handle.db, writerPipeline(support.id).id);
    if (!built.ok) throw new Error(built.reason);

    expect(built.document.roles.find((role) => role.slug === "writer")?.prompt).toBe("Write for Support.");
  });

  it("never carries another project's agent's prompt", () => {
    const { shop } = arrange();
    for (const projectId of [shop.id, null]) {
      const built = exportPipeline(handle.db, writerPipeline(projectId).id);
      if (!built.ok) throw new Error(built.reason);

      expect(built.document.roles.find((role) => role.slug === "writer")?.prompt).toBe("Write for everyone.");
      expect(JSON.stringify(built.document)).not.toContain("Write for Support.");
    }
  });
});

/**
 * A reference is this machine's own setting (EO-416).
 *
 * Which variable `FLY_API_TOKEN` is read from says something about one
 * laptop's shell profile and nothing about the pipeline, so it travels
 * no further than a stored value does. Shared and on the step itself,
 * because the step's is the one filed against an id the document
 * carries.
 */
describe("exporting a pipeline whose names are references", () => {
  it("contains no reference", () => {
    const { pipeline } = shippingPipeline();
    storeReference(secrets, "FLY_API_TOKEN", "EO_416_SHARED_VARIABLE");
    storeReference(secrets, "FLY_API_TOKEN", "EO_416_STEP_VARIABLE", "deploy-step");

    const built = exportPipeline(handle.db, pipeline.id);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const document = JSON.stringify(built.document);
    expect(document).not.toContain("EO_416_SHARED_VARIABLE");
    expect(document).not.toContain("EO_416_STEP_VARIABLE");
    expect(document).not.toContain("reference");
    // The declaration is what travels: the name, and nothing about
    // where this machine gets it.
    expect(built.document.modules[0]?.manifest.needs.env).toEqual(["FLY_API_TOKEN"]);
  });
});

/**
 * An environment variable is this machine's own setting too (EO-485,
 * ARCHITECTURE.md §14.2): not secret, and still not part of the
 * pipeline. Neither its name nor its value travels — the declaration in
 * `needs.env` is the only thing that does.
 */
describe("exporting a pipeline that has environment variables set", () => {
  it("contains no variable name or value", () => {
    const { pipeline } = shippingPipeline();
    storeVariable(secrets, "EO485_SHARED_REGION", "eu-west-1-eo485");
    storeVariable(secrets, "EO485_STEP_TIER", "gold-eo485", "deploy-step");
    // A variable under the declared name as well: the name is the
    // manifest's, the value is this machine's.
    storeVariable(secrets, "FLY_API_TOKEN", "plain-value-eo485", "deploy-step");

    const built = exportPipeline(handle.db, pipeline.id);

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const document = JSON.stringify(built.document);
    for (const text of ["EO485_SHARED_REGION", "eu-west-1-eo485", "EO485_STEP_TIER", "gold-eo485", "plain-value-eo485"]) {
      expect(document).not.toContain(text);
    }
    expect(built.document.modules[0]?.manifest.needs.env).toEqual(["FLY_API_TOKEN"]);
  });
});

describe("preflight", () => {
  it("names what is missing and which module wants it", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;

    const preflight = preflightImport(handle.db, secrets, built.document);

    expect(preflight.pipelineName).toBe("Shipping");
    expect(preflight.missingBinaries).toEqual([{ name: "flyctl", wantedBy: ["Deploy"] }]);
    expect(preflight.missingSecrets).toEqual([{ name: "FLY_API_TOKEN", wantedBy: ["Deploy"] }]);
    // Not a problem, but a decision — said out loud rather than found out.
    expect(preflight.wantsNetwork).toEqual(["Deploy"]);
    // Declared nothing about items, so it is named nowhere (EO-74).
    expect(preflight.readsItems).toEqual([]);
  });

  /**
   * A module that says it reads items (EO-74).
   *
   * Reported like the rest, and unlike the rest it is not a check: the
   * host hands `ctx.ticket()` to a module whether or not it declared
   * one. What the person gets is the author's stated intent before they
   * read a line of the code, which is the whole of what this buys.
   */
  it("names a module that declares it reads items", () => {
    const saved = saveModule(handle.db, {
      slug: "release-notes",
      name: "Release notes",
      description: "Writes the notes from the ticket and its thread.",
      code,
      manifest: { ...manifest, name: "Release notes", needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false } },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const pipeline = createPipeline(handle.db, { name: "Release" });
    createStep(handle.db, { id: "notes", pipelineId: pipeline.id, position: 0, name: "Notes", type: "module", entryAction: saved.module.id });
    createStep(handle.db, { id: "out", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(preflightImport(handle.db, secrets, built.document).readsItems).toEqual(["Release notes"]);
  });

  /**
   * Said apart from the read (EO-75), because it points the other way:
   * a comment is written into a thread and mirrored to the Jira issue
   * behind it, so it is the declaration describing something that
   * leaves this machine.
   */
  it("names a module that declares it comments, apart from one that only reads", () => {
    const reader = saveModule(handle.db, {
      slug: "release-notes",
      name: "Release notes",
      description: "Writes the notes from the ticket and its thread.",
      code,
      manifest: { ...manifest, name: "Release notes", needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false } },
      approve: true,
    });
    const talker = saveModule(handle.db, {
      slug: "announce",
      name: "Announce",
      description: "Says where the build went.",
      code,
      manifest: { ...manifest, name: "Announce", needs: { bin: [], env: [], network: false, item: false, comment: true, attach: false, create: false } },
      approve: true,
    });
    if (!reader.ok) throw new Error(reader.reason);
    if (!talker.ok) throw new Error(talker.reason);
    const pipeline = createPipeline(handle.db, { name: "Release" });
    createStep(handle.db, { id: "notes", pipelineId: pipeline.id, position: 0, name: "Notes", type: "module", entryAction: reader.module.id });
    createStep(handle.db, { id: "announce", pipelineId: pipeline.id, position: 1, name: "Announce", type: "module", entryAction: talker.module.id });
    createStep(handle.db, { id: "out", pipelineId: pipeline.id, position: 2, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const preflight = preflightImport(handle.db, secrets, built.document);
    expect(preflight.postsComments).toEqual(["Announce"]);
    expect(preflight.readsItems).toEqual(["Release notes"]);
  });

  /** And the files (EO-414), apart again: what leaves is a file out of the step's directory, not words. */
  it("names a module that declares it attaches files, apart from one that comments", () => {
    const talker = saveModule(handle.db, {
      slug: "announce",
      name: "Announce",
      description: "Says where the build went.",
      code,
      manifest: { ...manifest, name: "Announce", needs: { bin: [], env: [], network: false, item: false, comment: true, attach: false, create: false } },
      approve: true,
    });
    const reporter = saveModule(handle.db, {
      slug: "report",
      name: "Report",
      description: "Leaves the nightly report.",
      code,
      manifest: { ...manifest, name: "Report", needs: { bin: [], env: [], network: false, item: false, comment: false, attach: true, create: false } },
      approve: true,
    });
    const filer = saveModule(handle.db, {
      slug: "follow-up",
      name: "Follow up",
      description: "Files the follow-up story.",
      code,
      manifest: { ...manifest, name: "Follow up", needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: true } },
      approve: true,
    });
    if (!talker.ok) throw new Error(talker.reason);
    if (!reporter.ok) throw new Error(reporter.reason);
    if (!filer.ok) throw new Error(filer.reason);
    const pipeline = createPipeline(handle.db, { name: "Release" });
    createStep(handle.db, { id: "announce", pipelineId: pipeline.id, position: 0, name: "Announce", type: "module", entryAction: talker.module.id });
    createStep(handle.db, { id: "report", pipelineId: pipeline.id, position: 1, name: "Report", type: "module", entryAction: reporter.module.id });
    createStep(handle.db, { id: "follow", pipelineId: pipeline.id, position: 3, name: "Follow up", type: "module", entryAction: filer.module.id });
    createStep(handle.db, { id: "out", pipelineId: pipeline.id, position: 2, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const preflight = preflightImport(handle.db, secrets, built.document);
    expect(preflight.attachesFiles).toEqual(["Report"]);
    expect(preflight.postsComments).toEqual(["Announce"]);
    // And the ones that create work (EO-433), listed the same way.
    expect(preflight.createsItems).toEqual(["Follow up"]);
  });

  it("stops naming a secret once it is set", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;
    storeSecret(secrets, "FLY_API_TOKEN", "tok-1");

    expect(preflightImport(handle.db, secrets, built.document).missingSecrets).toEqual([]);
  });

  /**
   * A shared reference covers a declared name on the terms a stored
   * value does (EO-416): when a dispatch would get a value. One whose
   * variable EO was not launched with is a name a run will refuse, so it
   * is still reported — the preflight must not promise what the engine
   * then declines to do.
   */
  it("does not name a secret covered by a shared reference that resolves, and does name one that dangles", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;
    storeReference(secrets, "FLY_API_TOKEN", "CI_FLY_TOKEN");

    expect(preflightImport(handle.db, { ...secrets, environment: { CI_FLY_TOKEN: "tok-1" } }, built.document).missingSecrets).toEqual([]);
    expect(preflightImport(handle.db, { ...secrets, environment: {} }, built.document).missingSecrets).toEqual([
      { name: "FLY_API_TOKEN", wantedBy: ["Deploy"] },
    ]);
  });

  // A shared variable is a value a module declaring the name would be
  // given (EO-485), so it covers the name as a secret would — which is
  // what the gallery's needs check reads too, through this function.
  it("does not name a secret covered by a shared environment variable", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;
    const needBefore = galleryNeeds(preflightImport(handle.db, secrets, built.document)).find((need) => need.key === "secret:FLY_API_TOKEN");
    storeVariable(secrets, "FLY_API_TOKEN", "plain");

    expect(preflightImport(handle.db, secrets, built.document).missingSecrets).toEqual([]);
    // The gallery's needs check: the red line was there, and is gone.
    expect(needBefore).toMatchObject({ met: false });
    expect(galleryNeeds(preflightImport(handle.db, secrets, built.document)).find((need) => need.key === "secret:FLY_API_TOKEN")).toBeUndefined();
  });

  it("finds a binary that is actually on PATH", () => {
    const saved = saveModule(handle.db, {
      slug: "shell",
      name: "Shell",
      description: "Runs sh.",
      code,
      manifest: { ...manifest, needs: { bin: ["sh"], env: [], network: false, item: false, comment: false, attach: false, create: false } },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const pipeline = createPipeline(handle.db, { name: "Shell" });
    createStep(handle.db, { id: "s", pipelineId: pipeline.id, position: 0, name: "Shell", type: "module", entryAction: saved.module.id });
    createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;

    expect(preflightImport(handle.db, secrets, built.document).missingBinaries).toEqual([]);
  });

  // EO-655: an app opened from Finder does not inherit the person's PATH,
  // so the preflight searches what their login shell said — the same
  // directories `ctx.exec` will be run with.
  it.skipIf(process.platform === "win32")("finds a binary only the login shell's PATH has", async () => {
    const bin = mkdtempSync(join(tmpdir(), "eo-login-bin-"));
    try {
      writeFileSync(join(bin, "eo-login-only-tool"), "#!/bin/sh\necho hi\n");
      chmodSync(join(bin, "eo-login-only-tool"), 0o755);
      const saved = saveModule(handle.db, {
        slug: "login-only",
        name: "Login only",
        description: "Runs a tool the login shell knows about.",
        code,
        manifest: { ...manifest, needs: { bin: ["eo-login-only-tool"], env: [], network: false, item: false, comment: false, attach: false, create: false } },
        approve: true,
      });
      if (!saved.ok) throw new Error(saved.reason);
      const pipeline = createPipeline(handle.db, { name: "Login only" });
      createStep(handle.db, { id: "s", pipelineId: pipeline.id, position: 0, name: "Login only", type: "module", entryAction: saved.module.id });
      createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
      const built = exportPipeline(handle.db, pipeline.id);
      if (!built.ok) throw new Error("export failed");

      expect(preflightImport(handle.db, secrets, built.document).missingBinaries.map((missing) => missing.name)).toEqual(["eo-login-only-tool"]);

      await resolveSearchPath({
        platform: "linux",
        shell: "/bin/sh",
        run: async () => ({ code: 0, stdout: `__EO_LOGIN_SHELL_PATH_START__\n${bin}:/usr/bin\n__EO_LOGIN_SHELL_PATH_END__\n`, timedOut: false }),
      });

      expect(preflightImport(handle.db, secrets, built.document).missingBinaries).toEqual([]);
    } finally {
      resetSearchPathForTests();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("reports a slug this catalog already uses", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) return;

    // The same DB stands in for "a machine that already has a `deploy`".
    const preflight = preflightImport(handle.db, secrets, built.document);
    expect(preflight.collisions).toEqual([{ slug: "deploy", localName: "Deploy", incomingName: "Deploy" }]);
  });
});

/**
 * What a human step offers, across a file (EO-310).
 *
 * The buttons are the graph's own shape rather than a fact about the
 * exporting machine — unlike the inputs, the time limits and the disk,
 * which are all deliberately left behind — so they travel. And because
 * they travel, the format version had to move: an EO that predates them
 * reads a document carrying them perfectly well and writes an approval
 * step with every branch drawn and nothing to press.
 */
describe("a human step's results in a document", () => {
  /** Shipping, with a person deciding before Done. */
  function decidingPipeline() {
    const { pipeline } = shippingPipeline();
    createStep(handle.db, {
      id: "sign-off",
      pipelineId: pipeline.id,
      position: 2,
      name: "Sign-off",
      type: "user",
      results: [
        { key: "approved", label: "Approve", tone: "success", requiresComment: false },
        { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
      ],
    });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "sign-off", resultKey: "approved", label: "Approve", tone: "success", target: "done" });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "sign-off", resultKey: "send_back", label: "Send back", tone: "warning", target: "deploy-step", position: 1 });
    return pipeline;
  }

  it("carries the buttons and whether each one asks for a reason", () => {
    const pipeline = decidingPipeline();

    const built = exportPipeline(handle.db, pipeline.id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.document.steps.find((step) => step.id === "sign-off")!.results).toEqual([
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ]);
  });

  /**
   * The version, tied to the thing that moved it.
   *
   * 2 is the format that had no results. A document carrying them must
   * not claim to be one, because the claim is the *only* thing standing
   * between an older EO and a silently gutted pipeline: `results`
   * defaults to empty, so that build parses the document without a
   * complaint and writes an approval step nobody can act on — and its
   * own validator has no opinion either, the checks having arrived with
   * the field.
   */
  it("does not claim to be a format that had no results", () => {
    const pipeline = decidingPipeline();

    const built = exportPipeline(handle.db, pipeline.id);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.document.eoPipelineExport).toBeGreaterThan(2);
  });

  /**
   * And the other side of the same number: a reader refuses a document
   * from a build newer than itself rather than importing part of it.
   *
   * Written as this build meeting a version it does not know, because
   * that is the same comparison an EO on format 2 makes when it is
   * handed today's export — `parseExport` compares the document against
   * whatever `PIPELINE_EXPORT_VERSION` the *reader* was built with.
   */
  it("is refused by a reader older than the format it declares", () => {
    const pipeline = decidingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    // The document as it stands, read by a build one version behind —
    // which is what raising the number by one on the document is, from
    // the reader's side.
    const fromTheFuture = parseExport(JSON.stringify({ ...built.document, eoPipelineExport: built.document.eoPipelineExport + 1 }));

    expect(fromTheFuture.ok).toBe(false);
    if (fromTheFuture.ok) return;
    expect(fromTheFuture.reason).toContain("newer version of EO");
    expect(fromTheFuture.reason).toContain("Update EO");
  });

  it("imports them into the step they belong to", () => {
    const pipeline = decidingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const second = openMigratedTestDb();
    try {
      const imported = importPipeline(second.db, { document: built.document });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;

      const signOff = listStepsForPipeline(second.db, imported.pipelineId).find((step) => step.name === "Sign-off")!;

      expect(signOff.results).toEqual([
        { key: "approved", label: "Approve", tone: "success", requiresComment: false },
        { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
      ]);
    } finally {
      second.close();
    }
  });
});

describe("keep checking in a document (EO-456)", () => {
  /** Shipping, with its module able to wait and its step set to keep checking. */
  function watchingPipeline(watch: StepWatch = { everyMinutes: 15, giveUpAfterHours: 48 }) {
    const saved = saveModule(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Builds and deploys the branch to staging.",
      code,
      manifest: { ...manifest, watch: true },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const pipeline = createPipeline(handle.db, { name: "Waiting" });
    createStep(handle.db, {
      id: "deploy-step",
      pipelineId: pipeline.id,
      position: 0,
      name: "Deploy",
      type: "module",
      entryAction: saved.module.id,
      watch,
    });
    createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "deploy-step", resultKey: "deployed", label: "Deployed", target: "done" });
    setEntryStep(handle.db, pipeline.id, "deploy-step");
    return pipeline;
  }

  it("carries the step's interval and give-up time, and the manifest's word that the module can wait", () => {
    const built = exportPipeline(handle.db, watchingPipeline().id);
    if (!built.ok) throw new Error(built.reason);

    expect(built.document.steps.find((step) => step.id === "deploy-step")!.watch).toEqual({ everyMinutes: 15, giveUpAfterHours: 48 });
    expect(built.document.modules[0]!.manifest.watch).toBe(true);
  });

  /**
   * Version 8 is the format with no keep checking. A version-8 reader
   * would strip both fields without a word and import a step that waits
   * for a week as one that runs once, so a document carrying them must
   * not claim to be one — the claim is what turns that silent change into
   * "update EO and try again".
   */
  it("does not claim to be a format a reader without keep checking would accept", () => {
    const built = exportPipeline(handle.db, watchingPipeline().id);
    if (!built.ok) throw new Error(built.reason);

    expect(built.document.eoPipelineExport).toBeGreaterThan(8);
  });

  it("imports the step still keeping checking", () => {
    const built = exportPipeline(handle.db, watchingPipeline().id);
    if (!built.ok) throw new Error(built.reason);

    const second = openMigratedTestDb();
    try {
      const imported = importPipeline(second.db, { document: built.document });
      if (!imported.ok) throw new Error(imported.reason);
      const step = listStepsForPipeline(second.db, imported.pipelineId).find((candidate) => candidate.name === "Deploy")!;
      expect(step.watch).toEqual({ everyMinutes: 15, giveUpAfterHours: 48 });
      expect(getModuleBySlug(second.db, "deploy")?.manifest.watch).toBe(true);
    } finally {
      second.close();
    }
  });

  /**
   * Never giving up (EO-571), through a file and back: the export says
   * it, the text it is written as reads it back, and the import stores
   * it. Format 10, which a version-9 reader refuses with "Update EO and
   * try again" rather than importing the step with a week.
   */
  it("carries a step that never gives up out and back in unchanged, in a format a version-9 reader refuses", () => {
    const never = { everyMinutes: 15, giveUpAfterHours: 168, neverGivesUp: true };
    const built = exportPipeline(handle.db, watchingPipeline(never).id);
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.eoPipelineExport).toBeGreaterThan(9);
    expect(built.document.steps.find((step) => step.id === "deploy-step")!.watch).toEqual(never);

    const read = parseExport(JSON.stringify(built.document));
    if (!read.ok) throw new Error(read.reason);
    const second = openMigratedTestDb();
    try {
      const imported = importPipeline(second.db, { document: read.document });
      if (!imported.ok) throw new Error(imported.reason);
      const step = listStepsForPipeline(second.db, imported.pipelineId).find((candidate) => candidate.name === "Deploy")!;
      expect(step.watch).toEqual(never);

      // And out again from there, still saying it.
      const again = exportPipeline(second.db, imported.pipelineId);
      if (!again.ok) throw new Error(again.reason);
      expect(again.document.steps.find((candidate) => candidate.name === "Deploy")!.watch).toEqual(never);
    } finally {
      second.close();
    }
  });

  it("imports a step whose watch leaves the give-up time out as giving up after a week", () => {
    const built = exportPipeline(handle.db, watchingPipeline().id);
    if (!built.ok) throw new Error(built.reason);
    const document = structuredClone(built.document);
    const step = document.steps.find((candidate) => candidate.id === "deploy-step")!;
    step.watch = { everyMinutes: 15 } as StepWatch;

    const read = parseExport(JSON.stringify(document));
    if (!read.ok) throw new Error(read.reason);
    const second = openMigratedTestDb();
    try {
      const imported = importPipeline(second.db, { document: read.document });
      if (!imported.ok) throw new Error(imported.reason);
      expect(listStepsForPipeline(second.db, imported.pipelineId).find((candidate) => candidate.name === "Deploy")!.watch).toEqual({ everyMinutes: 15, giveUpAfterHours: 168 });
    } finally {
      second.close();
    }
  });
});

describe("reading a document", () => {
  it("refuses something that is not an export", () => {
    expect(parseExport("{}").ok).toBe(false);
    expect(parseExport("not json at all").ok).toBe(false);
  });

  // Half a graph is not a smaller graph. A pipeline that imported *most*
  // of itself validates, publishes, and is not what anyone exported.
  it("refuses a document from a newer EO rather than importing part of it", () => {
    const parsed = parseExport(
      JSON.stringify({ eoPipelineExport: PIPELINE_EXPORT_VERSION + 1, pipeline: { name: "x", icon: null, entryStepId: null }, steps: [], routes: [], modules: [] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("newer version");
  });
});

describe("importing", () => {
  /** Exports from one DB and imports into a second, empty one. */
  function transfer() {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const target = openMigratedTestDb();
    return { document: built.document, target };
  }

  it("round-trips the graph and its modules into a fresh install", () => {
    const { document, target } = transfer();
    try {
      const result = importPipeline(target.db, { document });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const steps = listStepsForPipeline(target.db, result.pipelineId);
      expect(steps.map((step) => step.name)).toEqual(["Deploy", "Done"]);
      expect(listRoutesForPipeline(target.db, result.pipelineId)).toHaveLength(2);

      // The step points at the *local* id of the module that arrived.
      const imported = getModuleBySlug(target.db, "deploy")!;
      expect(steps.find((step) => step.type === "module")?.entryAction).toBe(imported.id);
      expect(imported.code).toBe(code);
    } finally {
      target.close();
    }
  });

  /**
   * The waiver does not travel (EO-405).
   *
   * Whether a pipeline may send what a webhook delivers without a person
   * reading it first is something somebody accepted *here*, about this
   * installation's webhook and this installation's connectors. A file is
   * how a pipeline reaches people who accepted nothing — so the export
   * has no field for it, and an import writes the column's default.
   */
  it("exports a pipeline that sends webhook items unread, and imports it with that off", () => {
    const { pipeline } = shippingPipeline();
    setWebhookUnattended(handle.db, pipeline.id, true);
    expect(getPipeline(handle.db, pipeline.id)?.webhookUnattended).toBe(true);

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    // Not carried as on — not carried at all, anywhere in the file.
    const file = JSON.stringify(built.document);
    expect(file).not.toContain("webhookUnattended");
    expect(file).not.toContain("webhook_unattended");

    const target = openMigratedTestDb();
    try {
      // The file, as a file: what the other machine actually reads.
      const read = parseExport(file);
      if (!read.ok) throw new Error("the export did not read back");
      const result = importPipeline(target.db, { document: read.document });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(getPipeline(target.db, result.pipelineId)?.webhookUnattended).toBe(false);
      // And the one it was exported from is untouched by having been exported.
      expect(getPipeline(handle.db, pipeline.id)?.webhookUnattended).toBe(true);
    } finally {
      target.close();
    }
  });

  it("lands with it off even from a file somebody edited to say otherwise", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    // Everywhere a hand could plausibly put it.
    const edited = JSON.stringify({
      ...built.document,
      webhookUnattended: true,
      pipeline: { ...built.document.pipeline, webhookUnattended: true },
    });

    const target = openMigratedTestDb();
    try {
      const read = parseExport(edited);
      if (!read.ok) throw new Error("the edited export did not read back");
      const result = importPipeline(target.db, { document: read.document });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(getPipeline(target.db, result.pipelineId)?.webhookUnattended).toBe(false);
    } finally {
      target.close();
    }
  });

  /**
   * The whole mitigation for a document carrying executable code from
   * another machine.
   *
   * Nothing else is needed, because KAN-104 already refuses to publish a
   * pipeline naming an unapproved module — this inherits enforcement
   * rather than adding a rule to remember.
   */
  it("lands imported modules unapproved, and says which", () => {
    const { document, target } = transfer();
    try {
      const result = importPipeline(target.db, { document });
      if (!result.ok) return;

      expect(getModuleBySlug(target.db, "deploy")?.approvedAt).toBeNull();
      expect(getModuleBySlug(target.db, "deploy")?.source).toBe("import");
      expect(result.unapprovedModules).toEqual(["Deploy"]);
    } finally {
      target.close();
    }
  });

  // The most dangerous case in this story: the local module is code
  // somebody here approved, the incoming one is code from elsewhere with
  // the same name.
  it("refuses a slug collision it was given no answer for", () => {
    const { document } = transfer();
    const result = importPipeline(handle.db, { document });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("already exists here");
  });

  it("reuses the local module when told to", () => {
    const { document } = transfer();
    const before = getModuleBySlug(handle.db, "deploy")!;

    const result = importPipeline(handle.db, { document, choices: { deploy: "reuse" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Nothing new, and the local one untouched — still approved.
    expect(listModules(handle.db, true)).toHaveLength(1);
    expect(getModuleBySlug(handle.db, "deploy")?.approvedAt).toBe(before.approvedAt);
    expect(listStepsForPipeline(handle.db, result.pipelineId).find((step) => step.type === "module")?.entryAction).toBe(before.id);
  });

  it("imports alongside under a fresh slug when told to", () => {
    const { document } = transfer();
    const before = getModuleBySlug(handle.db, "deploy")!;

    const result = importPipeline(handle.db, { document, choices: { deploy: "import" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(listModules(handle.db, true)).toHaveLength(2);
    // Neither side was overwritten: the local one keeps its approval, and
    // the incoming one arrives inert under its own slug.
    expect(getModuleBySlug(handle.db, "deploy")?.approvedAt).toBe(before.approvedAt);
    expect(getModuleBySlug(handle.db, "deploy-2")?.approvedAt).toBeNull();
    expect(listStepsForPipeline(handle.db, result.pipelineId).find((step) => step.type === "module")?.entryAction).toBe(getModuleBySlug(handle.db, "deploy-2")?.id);
  });

  /**
   * Step ids are re-minted, and everything that referenced one moves
   * with them.
   *
   * `pipeline_steps.id` is a primary key across the whole table rather
   * than one scoped to a pipeline, so keeping the document's ids would
   * work exactly until somebody imported their own export — see the case
   * below. What has to survive is the *shape*: where work enters, and
   * where each result leads.
   */
  it("re-mints step ids and rewrites everything that referenced them", () => {
    const { document, target } = transfer();
    try {
      const result = importPipeline(target.db, { document, projectId: null as Uuid | null });
      if (!result.ok) return;

      const steps = listStepsForPipeline(target.db, result.pipelineId);
      const deploy = steps.find((step) => step.name === "Deploy")!;
      const done = steps.find((step) => step.name === "Done")!;
      expect(deploy.id).not.toBe("deploy-step");

      const routes = listRoutesForPipeline(target.db, result.pipelineId);
      expect(routes.find((route) => route.resultKey === "deployed")).toMatchObject({ fromStepId: deploy.id, target: done.id });
      // A sentinel is not a step, so it travels unchanged.
      expect(routes.find((route) => route.resultKey === "failed")?.target).toBe("user_attention");
    } finally {
      target.close();
    }
  });

  /**
   * Nothing is written unless everything can be.
   *
   * Both halves of this were missing: a document could be refused after
   * its first module was already inserted, and a dangling step reference
   * threw out of the middle. Each left orphan modules and an empty
   * pipeline behind, while telling the person the import had failed.
   */
  it("writes nothing when a later module collides unanswered", () => {
    const { document } = transfer();
    const before = listModules(handle.db, true).length;
    const pipelinesBefore = listStepsForPipeline(handle.db, "default").length;

    const result = importPipeline(handle.db, { document });
    expect(result.ok).toBe(false);
    expect(listModules(handle.db, true)).toHaveLength(before);
    expect(listStepsForPipeline(handle.db, "default")).toHaveLength(pipelinesBefore);
  });

  // `freeSlug` asked the catalog only, so renaming a colliding `deploy`
  // to `deploy-2` collided with a `deploy-2` in the same document — a
  // collision preflight could not have named and the person could not
  // have answered.
  it("renames around a slug the document itself carries", () => {
    const { document } = transfer();
    const second = { ...document.modules[0]!, slug: "deploy-2", name: "Deploy again" };
    const withBoth = { ...document, modules: [...document.modules, second] };

    const result = importPipeline(handle.db, { document: withBoth, choices: { deploy: "import" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `deploy` renamed to `deploy-2`, so the document's own `deploy-2`
    // renamed again. Both arrived, nothing was overwritten, and no name
    // is ambiguous — which is all a slug has to be.
    const slugs = listModules(handle.db, true).map((module) => module.slug).sort();
    expect(slugs).toEqual(["deploy", "deploy-2", "deploy-2-2"]);
  });

  /**
   * A reference the schema cannot check.
   *
   * `entryStepId` and a route's ends are plain strings in the document
   * and foreign keys in the database, so reaching the insert with a bad
   * one threw a raw `SqliteError` out of a function whose type promises
   * a reason — and left half an import behind.
   */
  it("refuses a document whose entry step is not one of its steps", () => {
    const { document, target } = transfer();
    try {
      const broken = { ...document, pipeline: { ...document.pipeline, entryStepId: "not-a-step" } };
      const result = importPipeline(target.db, { document: broken });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("not-a-step");
      expect(listModules(target.db, true)).toHaveLength(0);
    } finally {
      target.close();
    }
  });

  it("refuses a document whose route leaves a step it does not carry", () => {
    const { document, target } = transfer();
    try {
      const broken = { ...document, routes: [...document.routes, { fromStepId: "ghost", resultKey: "x", label: "X", tone: "info" as const, target: "done", position: 9 }] };
      const result = importPipeline(target.db, { document: broken });
      expect(result.ok).toBe(false);
      expect(listModules(target.db, true)).toHaveLength(0);
    } finally {
      target.close();
    }
  });

  it("refuses a document whose module step names a module it does not carry", () => {
    const { document, target } = transfer();
    try {
      const broken = { ...document, modules: [] };
      const result = importPipeline(target.db, { document: broken });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("does not carry");
    } finally {
      target.close();
    }
  });

  // The case that made re-minting necessary. Importing your own export is
  // the obvious way to duplicate a pipeline, and it collided on the step
  // ids until the ids stopped travelling.
  it("imports a document back into the installation it came from", () => {
    const { document } = transfer();

    const result = importPipeline(handle.db, { document, choices: { deploy: "reuse" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listStepsForPipeline(handle.db, result.pipelineId).map((step) => step.name)).toEqual(["Deploy", "Done"]);
  });
});

/**
 * The alias period, on the surface where somebody reads a pack's
 * contents before agreeing to them (KAN-178).
 *
 * An exported pipeline is the only thing EO imports today, and it
 * carries both halves of what the design is about: the
 * prompts its steps hand to an agent, which name a tool, and the module
 * code the same screen is about to ask somebody to approve, which calls
 * `ctx.ticket()`. Neither line was written by the person standing in
 * front of the dialog, and both stop working one release later.
 */
/**
 * The document as a pack (`ARCHITECTURE.md`, "One document", KAN-178).
 *
 * "A data pack is that document plus … the roles with prompts … One
 * file, one format version, the same import gate." The prompts are the
 * half written in prose about tools, which is why they are what the
 * import preflight has to read: a role prompt telling an agent to read a
 * dependency with `mcp__eo__ticket_detail` works on the machine it was
 * written on, works here today, and stops working a release from now —
 * and the person adopting it wrote none of it.
 */
describe("a pack's roles and their prompts", () => {
  /**
   * A pipeline whose one agent step is owned by a role somebody here
   * fills.
   *
   * A role of its own rather than `implementer`, which the seed
   * migration already fills with a placeholder — the question here is
   * what travels and what the receiving machine is missing, and a role
   * every installation has by default can answer neither.
   */
  function packWithPrompt(prompt: string) {
    createAgent(handle.db, { name: "Release manager", role: "release_manager", provider: "fake", instructions: prompt });
    const pipeline = createPipeline(handle.db, { name: "Delivery" });
    createStep(handle.db, { id: "implement", pipelineId: pipeline.id, position: 0, name: "Implement", type: "agent", ownerRole: "release_manager" });
    createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    return built.document;
  }

  it("carries the prompt each agent step's role runs on", () => {
    const document = packWithPrompt("Read a dependency with `mcp__eo__ticket_detail`, then get to work.");

    // The backend travels beside the prompt as a recommendation
    // (EO-314, ARCHITECTURE.md, "An agent is a row") — `fake` is what this installation runs the
    // role
    // on, and what the far side is shown rather than held to.
    expect(document.roles).toEqual([
      {
        slug: "release_manager",
        prompt: "Read a dependency with `mcp__eo__ticket_detail`, then get to work.",
        schemasByAction: {},
        actions: [],
        allowedTools: null,
        backend: "fake",
        model: null,
      },
    ]);
  });

  /**
   * The acceptance criterion, end to end: a pack whose prompt names
   * `mcp__eo__ticket_detail`, through the import gate a person opens it
   * with, produces the line the Servers screen and a module's approval
   * card carry in the same words.
   */
  it("shows the preflight line for a pack prompt that names mcp__eo__ticket_detail", () => {
    const document = packWithPrompt("Read a dependency with `mcp__eo__ticket_detail`, then get to work.");

    expect(preflightImport(handle.db, secrets, document).oldNames).toEqual([
      { where: "the release_manager prompt", names: [{ deprecated: "ticket_detail", replacement: "item_detail" }] },
    ]);
  });

  it("says nothing about a pack whose prompt has moved to EO's own name", () => {
    const document = packWithPrompt("Read a dependency with `mcp__eo__item_detail`, then get to work.");

    expect(preflightImport(handle.db, secrets, document).oldNames).toEqual([]);
  });

  /**
   * A pack names a role and the installing machine chooses the agent
   * (ARCHITECTURE.md, "An agent is a row"), so importing fills no slots — and the preflight owes
   * the
   * person the list of empty ones, before a step refuses to dispatch
   * for the want of somebody in that role.
   */
  it("says which role slots this machine fills, and which it does not", () => {
    const document = packWithPrompt("Get to work.");

    // The exporting machine's agent is this machine's agent in this
    // test, so the slot is filled and the prompt travelled.
    expect(preflightImport(handle.db, secrets, document).roleSlots).toEqual([
      { slug: "release_manager", filled: true, carriesPrompt: true, recommendedBackend: "fake", recommendedModel: null, backendSignedIn: null },
    ]);

    // Read on a machine with nobody in that role: the same document, the
    // empty slot named.
    const elsewhere = openMigratedTestDb();
    try {
      expect(preflightImport(elsewhere.db, secrets, document).roleSlots).toEqual([
        { slug: "release_manager", filled: false, carriesPrompt: true, recommendedBackend: "fake", recommendedModel: null, backendSignedIn: null },
      ]);
    } finally {
      elsewhere.close();
    }
  });

  /**
   * A document written before KAN-178 names its roles through its steps
   * and carries no prompts at all. It is a pipeline, not a pack, and the
   * difference is worth stating rather than reporting an empty prompt.
   */
  it("tells a document that carries no prompts from one that does", () => {
    const document = packWithPrompt("Get to work.");

    const older = { ...document, roles: [] };
    expect(preflightImport(handle.db, secrets, older).roleSlots).toEqual([
      { slug: "release_manager", filled: true, carriesPrompt: false, recommendedBackend: null, recommendedModel: null, backendSignedIn: null },
    ]);
    expect(preflightImport(handle.db, secrets, older).oldNames).toEqual([]);
  });
});

describe("preflight: what is still written against the names EO renamed", () => {
  it("names a step whose prompt still says mcp__eo__ticket_detail", () => {
    const pipeline = createPipeline(handle.db, { name: "Delivery" });
    createStep(handle.db, {
      id: "implement",
      pipelineId: pipeline.id,
      position: 0,
      name: "Implement",
      type: "agent",
      instructionsSummary: "Read the dependencies with mcp__eo__ticket_detail before writing code.",
    });
    createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(preflightImport(handle.db, secrets, built.document).oldNames).toEqual([
      { where: "Implement", names: [{ deprecated: "ticket_detail", replacement: "item_detail" }] },
    ]);
  });

  it("names a module whose code still calls ctx.ticket()", () => {
    const saved = saveModule(handle.db, {
      slug: "release-notes",
      name: "Release notes",
      description: "Writes the notes from the ticket and its thread.",
      code: "export default async function run(ctx) { const it = await ctx.ticket(); return { ok: true, result: 'written', detail: it.key }; }",
      manifest: { ...manifest, name: "Release notes", needs: { bin: [], env: [], network: false, item: true, comment: false, attach: false, create: false } },
      approve: true,
    });
    if (!saved.ok) throw new Error(saved.reason);
    const pipeline = createPipeline(handle.db, { name: "Release" });
    createStep(handle.db, { id: "notes", pipelineId: pipeline.id, position: 0, name: "Notes", type: "module", entryAction: saved.module.id });
    createStep(handle.db, { id: "out", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(preflightImport(handle.db, secrets, built.document).oldNames).toEqual([
      { where: "Release notes", names: [{ deprecated: "ctx.ticket", replacement: "ctx.item" }] },
    ]);
  });

  it("says nothing about a pipeline that has moved to EO's own names", () => {
    const pipeline = createPipeline(handle.db, { name: "Delivery" });
    createStep(handle.db, {
      id: "implement",
      pipelineId: pipeline.id,
      position: 0,
      name: "Implement",
      type: "agent",
      instructionsSummary: "Read the dependencies with mcp__eo__item_detail before writing code.",
    });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(preflightImport(handle.db, secrets, built.document).oldNames).toEqual([]);
  });
});

/**
 * Values that only hold on the machine a pack was written on (EO-451).
 *
 * The import check is the one place a person reads a pack's contents
 * before agreeing to them, and nobody standing there wrote a line of it
 * — so the scan that runs where each piece is saved (EO-449, EO-450)
 * runs again over the document. Advice, like `oldNames` beside it: it
 * refuses nothing and changes nothing about the import.
 */
describe("preflight: values that only hold on the machine a pack was written on", () => {
  const prompt = ["Read the item and its thread.", "The checkout is at /Users/alex/work, so build there.", "Then hand it on."].join("\n");
  const caseSource = [
    "export default async function (harness) {",
    String.raw`  const artefacts = "C:\\builds";`,
    "  const run = await harness.run({",
    `    exec: [{ bin: "flyctl", args: ["deploy"], code: 1, stdout: "/home/dev/app/out.log", stderr: "fatal: 'main' is already checked out at '/home/dev/app'" }],`,
    "  });",
    "  harness.equal(run.result, 'failed', artefacts);",
    "}",
  ].join("\n");

  /** The shipping pipeline's document, carrying a role prompt and a module test case that each hold a machine's own path. */
  function machineBoundPack(): PipelineExport {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    const document = built.document;
    return {
      ...document,
      roles: [{ slug: "release_manager", prompt, schemasByAction: {}, actions: [], allowedTools: null, backend: null, model: null }],
      modules: document.modules.map((module) => ({ ...module, tests: [{ description: "fails when the branch is checked out elsewhere", source: caseSource }] })),
    };
  }

  it("names the role prompt and the test case each value is in, with its line and what matched", () => {
    expect(preflightImport(handle.db, secrets, machineBoundPack()).machineSpecific).toEqual([
      {
        where: "the release_manager prompt",
        warnings: [{ where: { in: "instructions", line: 2 }, text: "/Users/alex/work", kind: "machine_path", instead: expect.any(String) }],
      },
      {
        where: "Deploy",
        warnings: [
          {
            where: { in: "test", description: "fails when the branch is checked out elsewhere", line: 2 },
            text: String.raw`C:\\builds`,
            kind: "windows_path",
            instead: expect.stringContaining("harness.cwd"),
          },
        ],
      },
    ]);
  });

  // What a case scripts `ctx.exec` to answer is fake output the module
  // parses, not a path anything reads — left out here as it is where
  // the case is saved.
  it("does not report what a test case scripts as stdout or stderr", () => {
    const found = preflightImport(handle.db, secrets, machineBoundPack()).machineSpecific.flatMap((entry) => entry.warnings);
    expect(found.map((warning) => warning.text)).not.toContain("/home/dev/app/out.log");
    expect(found.some((warning) => warning.text.includes("/home/dev/app"))).toBe(false);
  });

  it("reads each step's name, instructions summary and the text inputs a template would set on it, and each module's code and manifest", () => {
    const pipeline = createPipeline(handle.db, { name: "Local" });
    createStep(handle.db, {
      id: "serve",
      pipelineId: pipeline.id,
      position: 0,
      name: "Serve from ~/site",
      type: "agent",
      instructionsSummary: "Check it answers on localhost:5173.",
    });
    createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    const module = {
      slug: "local-build",
      name: "Local build",
      description: "Builds in one place.",
      code: "export default async function run(ctx) {\n  return { ok: true, result: 'built', detail: '/tmp/build' };\n}",
      manifest: { ...manifest, name: "Local build", needs: { ...manifest.needs, bin: ["/usr/bin/git"] } },
      originalScript: null,
      tests: [],
    };
    const document: PipelineExport = {
      ...built.document,
      modules: [module],
      template: {
        slug: "local",
        title: "Local",
        description: "Serves the site.",
        version: "1",
        blanks: [
          { key: "serve.root", kind: "stepInput", label: "Where the site is", help: "", required: true, default: "/Users/alex/site", connector: null },
          { key: "serve.branch", kind: "stepInput", label: "Branch", help: "", required: true, default: "main", connector: null },
        ],
      },
    };

    const found = preflightImport(handle.db, secrets, document).machineSpecific;
    expect(found.map((entry) => entry.where)).toEqual(["Serve from ~/site", "Local build"]);
    expect(found[0]!.warnings.map((warning) => [warning.where, warning.text])).toEqual([
      [{ in: "step", step: "Serve from ~/site", field: "name", line: null }, "~/site"],
      [{ in: "step", step: "Serve from ~/site", field: "instructions summary", line: null }, "localhost:5173"],
      [{ in: "step", step: "Serve from ~/site", field: 'input "root"', line: null }, "/Users/alex/site"],
    ]);
    expect(found[1]!.warnings.map((warning) => [warning.where, warning.text])).toEqual([
      [{ in: "code", line: 2 }, "/tmp/build"],
      [{ in: "manifest", entry: 'needs.bin "/usr/bin/git"' }, "/usr/bin/git"],
    ]);
  });

  it("finds nothing in a document that holds no machine's own values", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    expect(preflightImport(handle.db, secrets, built.document).machineSpecific).toEqual([]);
  });

  // Advice, never a gate: the document imports, and what lands is what
  // it carried — the prompt and the case verbatim, the module inert as
  // every imported module is, and nothing refused or rewritten.
  it("still imports a document with findings, and imports it as it would without them", () => {
    const document = machineBoundPack();
    const target = openMigratedTestDb();
    try {
      expect(preflightImport(target.db, secrets, document).machineSpecific).toHaveLength(2);

      const result = importPipeline(target.db, { document });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.unapprovedModules).toEqual(["Deploy"]);

      const imported = getModuleBySlug(target.db, "deploy")!;
      expect(imported.code).toBe(code);
      expect(imported.approvedAt).toBeNull();
      expect(listModuleTests(target.db, imported.id).map((test) => test.source)).toEqual([caseSource]);
      expect(listAgents(target.db).find((agent) => agent.role === "release_manager")?.instructions).toBe(prompt);
      expect(listStepsForPipeline(target.db, result.pipelineId).map((step) => step.name)).toEqual(["Deploy", "Done"]);
    } finally {
      target.close();
    }
  });
});

/**
 * The document as a **data pack** (EO-314, the original design).
 *
 * "A data pack is that document plus the item types with their spec
 * shapes, the roles with prompts and output schemas as JSON Schema, the
 * connector definitions, the vocabulary, and a template item for
 * Preview. One file, one format version, the same import gate."
 *
 * The gate is what most of this is about. A pack is data, and the two
 * rules the review added (ARCHITECTURE.md, "The core is domain-neutral" and "The `eo_admin` grant")
 * are both about what data
 * is allowed to decide: it may not decide `allowedTools` (invariant
 * #11), and what it asks for is shown to a person as capabilities rather
 * than as tool names.
 */
describe("the pack", () => {
  /**
   * What a run of the pack's own action must answer in.
   *
   * `triage` on purpose: no installed pack declares it, so what resolves
   * for it after an import can only have come from the pack.
   */
  const TRIAGE_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: { severity: { type: "string", enum: ["low", "high"] }, note: { type: "string" } },
    required: ["severity"],
    additionalProperties: false,
  };

  /** The example this pack ships for Preview (ARCHITECTURE.md, "Preview") — authored, never harvested. */
  const PREVIEW_ITEM = { title: "Printer is offline", type: "support:case", body: "It stopped this morning.", spec: { severity: "high" } };
  /**
   * The setup that makes the pack's Slack server a connector (EO-315).
   *
   * A label, a kind, and the name the value is stored under — and not
   * one word about how the server runs, which is what makes it safe for
   * a document to carry under the same rule that keeps a transport out.
   */
  const SLACK_CONNECTOR = { label: "Slack", kind: "token" as const, secretNames: ["SLACK_BOT_TOKEN"], oauth: null };

  /**
   * An installation with something to share: a project of its own, a
   * type filed under its own pack, a role with a tool surface and its
   * own output shape, two connectors — one EO ships and one it has never
   * heard of — a described MCP server, a module, a template item for
   * Preview, and a four-step pipeline.
   */
  function packInstallation(db: Db) {
    const project = createProject(db, { name: "Support", keyPrefix: "SUP" });
    insertItemType(db, project.id, {
      packSlug: "support",
      slug: "case",
      label: "Case",
      plural: "Cases",
      container: false,
      specShape: EMPTY_SPEC_SHAPE,
      actionOverrides: {},
    });
    // Bound to a site *here*, which is exactly what must not travel.
    saveJiraBinding(db, project.id, { connectionId: "conn-1", projectKey: "SUP" });
    // A connector EO has never heard of: its label, its description and
    // the server it is reached through are the pack's words and nobody
    // else's, so they are the ones that have to survive a round trip.
    createDisconnectedConnector(db, project.id, {
      slug: "support-desk",
      label: "Support Desk",
      description: "reads and answers your support conversations",
      mcpServer: "support-desk",
    });
    // The server one of the triager's tools names, described by the
    // person who added it — which is where a capability line comes from
    // — and carrying the setup flow that makes it a connector (EO-315).
    // The setup is words and secret names; the command beside it is this
    // machine's and does not travel.
    const server = saveMcpServer(
      db,
      McpServerDraftSchema.parse({
        name: "slack",
        description: "reads your Slack channels",
        transport: "stdio",
        command: "slack-mcp",
        connector: SLACK_CONNECTOR,
      }),
    );
    if (!server.ok) throw new Error(server.problems.join(", "));
    createAgent(db, {
      name: "Triager",
      role: "triager",
      provider: "claude",
      model: "sonnet",
      instructions: "Read the case and route it.",
      config: {
        allowedTools: [
          "mcp__slack__conversations_history",
          // Codex's spelling of a tool id — `${server}/${tool}` — which
          // is as real a grant as Claude's and has to be read as one
          // (EO-198, invariant #12).
          "zendesk/tickets_list",
          "mcp__eo__item_detail",
          "Read",
        ],
      },
    });
    // What a run of this role has to answer in: the role's own
    // definition of the action (EO-421), which is where a data pack's
    // role keeps a shape and what an export writes out as JSON Schema
    // (ARCHITECTURE.md, "One document").
    const defined = saveActionDefinition(db, { role: "triager", action: "triage", ...actionShapeFromSchema(TRIAGE_SCHEMA) });
    if (!defined.ok) throw new Error(defined.problems.join(", "));

    const saved = saveModule(db, { slug: "deploy", name: "Deploy", description: "Builds and deploys the branch to staging.", code, manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);

    const pipeline = createPipeline(db, { projectId: project.id, name: "Triage", previewItem: PREVIEW_ITEM });
    createStep(db, { id: "triage", pipelineId: pipeline.id, position: 0, name: "Triage", type: "agent", ownerRole: "triager" });
    createStep(db, { id: "ship", pipelineId: pipeline.id, position: 1, name: "Ship", type: "module", entryAction: saved.module.id });
    createStep(db, {
      id: "approve",
      pipelineId: pipeline.id,
      position: 2,
      name: "Approve",
      type: "user",
      results: [{ key: "approved", label: "Ship it", tone: "success", requiresComment: false }],
    });
    createStep(db, { id: "done", pipelineId: pipeline.id, position: 3, name: "Done", type: "user", isTerminal: true });
    createRoute(db, { pipelineId: pipeline.id, fromStepId: "triage", resultKey: "done", label: "Triaged", target: "ship" });
    createRoute(db, { pipelineId: pipeline.id, fromStepId: "ship", resultKey: "deployed", label: "Deployed", target: "approve" });
    createRoute(db, { pipelineId: pipeline.id, fromStepId: "ship", resultKey: "failed", label: "Failed", target: "user_attention", position: 1 });
    createRoute(db, { pipelineId: pipeline.id, fromStepId: "approve", resultKey: "approved", label: "Ship it", tone: "success", target: "done" });
    setEntryStep(db, pipeline.id, "triage");

    return { project, pipeline, module: saved.module };
  }

  /**
   * The same document with its step ids replaced by positions.
   *
   * Step ids are re-minted on import and have to be
   * (`writeImport`): `pipeline_steps.id` is a primary key across the
   * whole table, so keeping them would collide the first time somebody
   * imported their own export. They are the one part of a document that
   * cannot round-trip, so the comparison is of everything else — and
   * *positional*, so that a route pointing at the wrong step still
   * fails the test.
   */
  /**
   * A pack as it comes back from a machine that imported it: its roles
   * carry the `memory_note` grant the agents made from them were given
   * there, as every new agent is (EO-593).
   */
  function withTheMemoryNoteGrant(document: PipelineExport): PipelineExport {
    return {
      ...document,
      roles: document.roles.map((role) => ({ ...role, allowedTools: role.allowedTools === null ? ["mcp__eo__memory_note"] : [...role.allowedTools, "mcp__eo__memory_note"] })),
    };
  }

  function withPositionalStepIds(document: PipelineExport): PipelineExport {
    const names = new Map(document.steps.map((step) => [step.id, `at-${step.position}`]));
    const named = (id: string): string => names.get(id) ?? id;
    return {
      ...document,
      pipeline: { ...document.pipeline, entryStepId: document.pipeline.entryStepId === null ? null : named(document.pipeline.entryStepId) },
      steps: document.steps.map((step) => ({ ...step, id: named(step.id) })),
      routes: document.routes.map((route) => ({ ...route, fromStepId: named(route.fromStepId), target: named(route.target) })),
    };
  }

  it("carries the types, the roles, the connectors and the vocabulary", () => {
    const { pipeline } = packInstallation(handle.db);

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(built.document.eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
    expect(built.document.itemTypes.map((type) => `${type.packSlug}:${type.slug}`)).toContain("support:case");
    expect(built.document.roles).toEqual([
      {
        slug: "triager",
        prompt: "Read the case and route it.",
        // No code pack ships this role, so it states no shipped shape;
        // what it defines for itself travels as the definition (EO-424).
        schemasByAction: {},
        actions: [{ action: "triage", description: "", results: [{ key: "done", label: "Done", meaning: "" }], fields: TRIAGE_SCHEMA }],
        allowedTools: [
          "mcp__slack__conversations_history",
          // Codex's spelling of a tool id — `${server}/${tool}` — which
          // is as real a grant as Claude's and has to be read as one
          // (EO-198, invariant #12).
          "zendesk/tickets_list",
          "mcp__eo__item_detail",
          "Read",
        ],
        backend: "claude",
        model: "sonnet",
      },
    ]);
    // The definition, never the connection: the site and the key this
    // installation mirrors to stay here.
    expect(built.document.connectors).toEqual([
      { slug: "jira", label: "Jira", description: "reads and updates your Jira issues", mcpServer: null },
      // A connector EO has never heard of travels with the words
      // somebody gave it, which are the only ones anybody has.
      { slug: "support-desk", label: "Support Desk", description: "reads and answers your support conversations", mcpServer: "support-desk" },
    ]);
    expect(JSON.stringify(built.document)).not.toContain("conn-1");
    // The server its roles reach, with what it does and nothing to run.
    expect(built.document.mcpServers).toEqual([{ name: "slack", description: "reads your Slack channels", connector: SLACK_CONNECTOR }]);
    // And the example Preview walks, authored rather than harvested.
    expect(built.document.previewItem).toEqual(PREVIEW_ITEM);
    // The words, gathered from the rows and the steps that carry them.
    expect(built.document.vocabulary.types).toContainEqual({ type: "support:case", label: "Case", plural: "Cases" });
    expect(built.document.vocabulary.results).toContainEqual({ key: "approved", label: "Ship it" });

  });

  /**
   * The acceptance criterion, whole: a pack leaves one installation,
   * lands on a fresh one, and what comes back out the other side is the
   * same document.
   *
   * Equality of the *documents* rather than a field-by-field walk,
   * because that is what the design need of this format — the export
   * is the unit a diff is shown over, so two installations running the
   * same pack must produce the same bytes or every diff is noise.
   */
  it("reproduces the pipeline, types, roles and vocabulary on a fresh installation", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, {
        document: built.document,
        projectId: project.id,
        // Signed in over there, so the recommendation binds (ARCHITECTURE.md, "An agent is a row").
        signedInBackends: ["claude"],
      });
      if (!imported.ok) throw new Error(imported.reason);

      // The types are rows on the far side, the role is an agent bound
      // to the backend it recommended, and the connector is known and
      // unconnected.
      expect(listItemTypes(fresh.db, project.id).map((type) => type.slug)).toContain("case");
      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager");
      expect(agent).toMatchObject({ provider: "claude", model: "sonnet", instructions: "Read the case and route it.", enabled: true });
      // The tool surface, which arrived with the pack. The shapes its
      // runs are held to arrived too, and are the role's definitions
      // rather than a key in this config (EO-421).
      expect(agent?.config).toEqual({
        allowedTools: [
          "mcp__slack__conversations_history",
          // Codex's spelling of a tool id — `${server}/${tool}` — which
          // is as real a grant as Claude's and has to be read as one
          // (EO-198, invariant #12).
          "zendesk/tickets_list",
          "mcp__eo__item_detail",
          "Read",
          // And the `memory_note` grant every new agent is given, the
          // pack's role or not (EO-593).
          "mcp__eo__memory_note",
        ],
      });
      expect(listActionDefinitions(fresh.db)).toHaveLength(1);
      expect(getActionDefinition(fresh.db, "triager", "triage")).toMatchObject({
        results: [{ key: "done", label: "Done", meaning: "" }],
        fields: TRIAGE_SCHEMA,
      });
      expect(isJiraConnected(getJiraBinding(fresh.db, project.id))).toBe(false);
      expect(listConnectorsForProject(fresh.db, project.id)).toEqual(["jira", "support-desk"]);
      // The pack's own example is on the pipeline, and no item was filed
      // from it.
      expect(getPipeline(fresh.db, imported.pipelineId)?.previewItem).toEqual(PREVIEW_ITEM);
      expect(listItems(fresh.db)).toHaveLength(0);
      // Code from another machine, unapproved on arrival, as ever.
      expect(imported.unapprovedModules).toEqual(["Deploy"]);
      expect(getModuleBySlug(fresh.db, "deploy")?.approvedAt).toBeNull();

      const again = exportPipeline(fresh.db, imported.pipelineId);
      if (!again.ok) throw new Error(again.reason);
      expect(withPositionalStepIds(again.document)).toEqual(withPositionalStepIds(withTheMemoryNoteGrant(built.document)));
    } finally {
      fresh.close();
    }
  });

  /**
   * A type somebody renamed here is theirs (ARCHITECTURE.md, "An item type is data"). An import
   * brings the
   * pack's word for a type this project does not have, and leaves the
   * one it does alone.
   */
  it("keeps a type this project already has rather than relabelling it", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      insertItemType(fresh.db, project.id, {
        packSlug: "support",
        slug: "case",
        label: "Enquiry",
        plural: "Enquiries",
        container: false,
        specShape: EMPTY_SPEC_SHAPE,
        actionOverrides: {},
      });

      const preflight = preflightImport(fresh.db, secrets, built.document, { projectId: project.id });
      expect(preflight.itemTypes).toContainEqual({ type: "support:case", label: "Case", present: true, conflict: null });

      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);
      expect(listItemTypes(fresh.db, project.id).filter((type) => type.slug === "case").map((type) => type.label)).toEqual(["Enquiry"]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A field this project added to the pack's type, under a name the
   * document's version of the type also uses (EO-735): the needs check
   * says so, naming both, and the import merges nothing.
   */
  it("says so when the document ships a field under the name of one this project added, and merges nothing", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    const document = {
      ...built.document,
      itemTypes: built.document.itemTypes.map((type) =>
        type.slug === "case" ? { ...type, specShape: { ...type.specShape, properties: { ...type.specShape.properties, automerge: { type: "string" as const } } } } : type,
      ),
    };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const ours = { type: "object" as const, properties: { automerge: { type: "boolean" as const, "x-eo-added": true } }, required: [] };
      insertItemType(fresh.db, project.id, { packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: ours, actionOverrides: {} });

      const preflight = preflightImport(fresh.db, secrets, document, { projectId: project.id });
      const line = preflight.itemTypes.find((type) => type.type === "support:case");
      expect(line?.conflict).toContain("The support pack's “Case” has a field “automerge”, and Support already added a field “automerge” of its own");
      expect(line?.conflict).toContain("merged nothing");

      const imported = importPipeline(fresh.db, { document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);
      expect(listItemTypes(fresh.db, project.id).find((type) => type.slug === "case")?.specShape).toEqual(ours);
    } finally {
      fresh.close();
    }
  });

  /**
   * ARCHITECTURE.md, "An agent is a row": a pack recommends a backend and may not require one.
   * Nobody
   * signed in to what this one was built on, so the agent arrives with
   * the prompt and the tool surface and no backend at all — visibly
   * unfinished rather than staffed-and-broken.
   */
  it("leaves the agent unbound when the recommended backend is not signed in", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: ["codex"] });
      if (!imported.ok) throw new Error(imported.reason);

      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager");
      expect(agent).toMatchObject({ provider: UNBOUND_BACKEND, model: null, enabled: false });
      expect(isBoundAgent(agent!)).toBe(false);

      // And the slot still reads as empty, because an agent with no
      // backend dispatches nothing.
      const preflight = preflightImport(fresh.db, secrets, built.document, { projectId: project.id, signedInBackends: ["codex"] });
      expect(preflight.roleSlots).toEqual([
        { slug: "triager", filled: false, carriesPrompt: true, recommendedBackend: "claude", recommendedModel: "sonnet", backendSignedIn: false },
      ]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A slot is about whether work arriving on that step will move, so
   * every row that dispatches nothing leaves it empty — a disabled agent
   * as much as an unbound one.
   *
   * The failure this covers is quiet: the agent exists, it is bound to a
   * backend, and somebody switched it off. Counting it would report a
   * staffed role, hide the line saying those steps will not dispatch,
   * and leave the imported pipeline sitting where it landed with nothing
   * having said why.
   */
  it("counts a disabled agent as nobody, the same as an unbound one", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Bound to a backend, not archived, and switched off.
      const agent = createAgent(fresh.db, { name: "Resting triager", role: "triager", provider: "claude", instructions: "Not right now.", enabled: false });
      expect(isBoundAgent(agent)).toBe(true);
      expect(isDispatchable(agent)).toBe(false);

      expect(preflightImport(fresh.db, secrets, built.document, { projectId: project.id, signedInBackends: ["claude"] }).roleSlots).toEqual([
        { slug: "triager", filled: false, carriesPrompt: true, recommendedBackend: "claude", recommendedModel: "sonnet", backendSignedIn: true },
      ]);

      // And once it is switched back on, the slot is filled: the
      // question is the scheduler's, asked the scheduler's way.
      updateAgent(fresh.db, agent.id, { enabled: true });
      expect(preflightImport(fresh.db, secrets, built.document, { projectId: project.id, signedInBackends: ["claude"] }).roleSlots[0]?.filled).toBe(true);

      // An archived agent is the third way of dispatching nothing.
      archiveAgent(fresh.db, agent.id);
      expect(preflightImport(fresh.db, secrets, built.document, { projectId: project.id, signedInBackends: ["claude"] }).roleSlots[0]?.filled).toBe(false);
    } finally {
      fresh.close();
    }
  });

  /**
   * The same round trip on the machine the design is actually about: one that
   * is not signed in to what the pack was built on.
   *
   * The recommendation is the whole of the needs line — "built on
   * claude, which you are not signed in to" — and an import that dropped
   * it would hand the next person a pack that had quietly forgotten what
   * it wants. The agent is unbound, so the row has no provider to read
   * it off; the pack's own answer is written down beside the prompt and
   * comes back out.
   */
  it("keeps the pack's recommendation when this machine cannot honour it", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Signed in to nothing the pack asked for.
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: [] });
      if (!imported.ok) throw new Error(imported.reason);

      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager");
      expect(agent).toMatchObject({ provider: UNBOUND_BACKEND, model: null, enabled: false });

      const again = exportPipeline(fresh.db, imported.pipelineId);
      if (!again.ok) throw new Error(again.reason);
      expect(again.document.roles[0]).toMatchObject({ backend: "claude", model: "sonnet" });
      expect(withPositionalStepIds(again.document)).toEqual(withPositionalStepIds(withTheMemoryNoteGrant(built.document)));

      // And the pack passed on from here still says what it wants, so
      // the next person reads the same red line rather than none.
      expect(preflightImport(fresh.db, secrets, again.document, { projectId: project.id, signedInBackends: [] }).roleSlots).toEqual([
        { slug: "triager", filled: false, carriesPrompt: true, recommendedBackend: "claude", recommendedModel: "sonnet", backendSignedIn: false },
      ]);
    } finally {
      fresh.close();
    }
  });

  /**
   * And once somebody here picks a backend, theirs is the answer: the
   * recommendation was what to do in the absence of a choice.
   */
  it("passes on this machine's own backend once the role is bound", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: [] });
      if (!imported.ok) throw new Error(imported.reason);

      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager");
      updateAgent(fresh.db, agent!.id, { provider: "codex", model: "gpt-5", enabled: true });

      const again = exportPipeline(fresh.db, imported.pipelineId);
      if (!again.ok) throw new Error(again.reason);
      expect(again.document.roles[0]).toMatchObject({ backend: "codex", model: "gpt-5" });
    } finally {
      fresh.close();
    }
  });

  /** An agent somebody here already has keeps their prompt: an import is not a reason to lose an edit (U-06). */
  it("does not touch a role this machine already has an agent in", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      createAgent(fresh.db, { name: "My triager", role: "triager", provider: "codex", instructions: "My own words." });

      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      const inRole = listAgents(fresh.db).filter((candidate) => candidate.role === "triager");
      expect(inRole).toHaveLength(1);
      expect(inRole[0]).toMatchObject({ name: "My triager", provider: "codex", instructions: "My own words." });
    } finally {
      fresh.close();
    }
  });

  /**
   * The pack's tool surface, as capabilities (ARCHITECTURE.md, "A connector is an MCP server with a
   * setup flow").
   *
   * One line per MCP server, in the person's words — never the tool
   * names, which are a list only the author can read. A server the pack
   * describes through a connector gets the pack's sentence; EO's own
   * servers get EO's; anything else gets its own name rather than an
   * invented description.
   */
  it("shows the tool surface as capabilities, one line per server", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const capabilities = preflightImport(handle.db, secrets, built.document).capabilities;

    expect(capabilities).toEqual([
      // Described by the person who added the server.
      { server: "slack", line: "reads your Slack channels" },
      // Named in Codex's spelling and read as a server all the same
      // (EO-198) — nobody has described it, so it is named rather than
      // described.
      { server: "zendesk", line: "uses your zendesk server" },
      // EO's own, in EO's own words.
      { server: "eo", line: "reads and updates your items and the comments on them" },
    ]);
    // A bare tool name is not a server, and is not turned into one.
    expect(capabilities.some((line) => line.server === "Read")).toBe(false);
    // And the tool names themselves are nowhere in what the gate asks about.
    expect(JSON.stringify(capabilities)).not.toContain("conversations_history");
    expect(JSON.stringify(capabilities)).not.toContain("tickets_list");
  });

  /**
   * A connector may describe the server it is reached through, which is
   * the other half of the document a pack can say it in.
   */
  it("takes a capability line from the connector that names the server", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const throughConnector = {
      ...built.document,
      mcpServers: [],
      connectors: [...built.document.connectors, { slug: "zendesk", label: "Zendesk", description: "reads your Zendesk tickets", mcpServer: "zendesk" }],
    };

    expect(preflightImport(handle.db, secrets, throughConnector).capabilities).toContainEqual({ server: "zendesk", line: "reads your Zendesk tickets" });
  });

  /**
   * The acceptance criterion the schemas exist for: a role that arrived
   * as data is a role runs are actually held to.
   *
   * Both halves, because they are two different failures. The
   * **provider** half is the original design's "demand structured output, never parse
   * prose" — a schema that never reaches the provider is an agent asked
   * for a shape nobody described. The **validation** half is what
   * happens to the answer: without it a result missing the field the
   * pack requires is accepted, recorded and routed on.
   *
   * Asked of `registryForProject`, because that is what the supervisor
   * resolves both through (`registryFor(item)`).
   */
  it("holds a run of an imported role to the schema the pack shipped", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });

      // Nothing answers for `triage` on an installation that has not
      // imported the pack — which is what makes the rest of this test
      // about the import rather than about the developer pack.
      expect(outputSchemaFor(registryForProject(fresh.db, project.id), "triage", UNKNOWN_ITEM_TYPE)).toBeUndefined();

      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      const registry = registryForProject(fresh.db, project.id);

      // The provider is asked for the pack's shape.
      const provider = outputSchemaFor(registry, "triage", UNKNOWN_ITEM_TYPE, "triager");
      expect(provider).toBeDefined();
      expect(JSON.stringify(provider)).toContain("severity");

      // And the answer is held to it: the required field is required,
      // and the values the pack allows are the values it allows.
      expect(validateActionResult(registry, "triage", { outcome: { result: "done", summary: "Routed.", note: "no severity here" } }, UNKNOWN_ITEM_TYPE, "triager").ok).toBe(false);
      expect(validateActionResult(registry, "triage", { outcome: { result: "done", summary: "Routed.", severity: "medium" } }, UNKNOWN_ITEM_TYPE, "triager").ok).toBe(false);

      const accepted = validateActionResult(registry, "triage", { outcome: { result: "done", summary: "Routed.", severity: "high", note: "the printer again" } }, UNKNOWN_ITEM_TYPE, "triager");
      expect(accepted.ok).toBe(true);
      expect(accepted.ok && accepted.value).toEqual({ result: "done", summary: "Routed.", severity: "high", note: "the printer again" });

      // The pack's role, and nobody else's (EO-421): the definition is
      // keyed by the role it arrived for.
      expect(outputSchemaFor(registry, "triage", UNKNOWN_ITEM_TYPE, "reviewer")).toBeUndefined();
      expect(outputSchemaFor(registry, "triage", UNKNOWN_ITEM_TYPE)).toBeUndefined();
    } finally {
      fresh.close();
    }
  });

  /**
   * A pack may not reopen what an installed pack's action means — for
   * anybody but its own role.
   *
   * A definition is keyed by role and action (EO-421), so an imported
   * role's schema for `review` is that role's own version of the action
   * and is in force for it. What an import still cannot do is re-shape
   * what every *other* reviewer on this installation is held to: a role
   * with no definition of its own, the shipped reviewer included, is
   * answered by the pack exactly as before.
   */
  it("lets an imported role define its own version of a pack's action, and nobody else's", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const own = {
      ...built.document,
      roles: built.document.roles.map((role) => ({ ...role, schemasByAction: { review: { type: "object", properties: { mine: { type: "string" } } } } })),
    };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const before = JSON.stringify(outputSchemaFor(registryForProject(fresh.db, project.id), "review", UNKNOWN_ITEM_TYPE));

      const imported = importPipeline(fresh.db, { document: own, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      const registry = registryForProject(fresh.db, project.id);
      expect(getActionDefinition(fresh.db, "triager", "review")).toMatchObject({ results: [{ key: "done", label: "Done", meaning: "" }] });
      expect(validateActionResult(registry, "review", { outcome: { result: "done", summary: "Read it.", mine: "yes" } }, UNKNOWN_ITEM_TYPE, "triager").ok).toBe(true);

      expect(JSON.stringify(outputSchemaFor(registry, "review", UNKNOWN_ITEM_TYPE))).toEqual(before);
      expect(JSON.stringify(outputSchemaFor(registry, "review", UNKNOWN_ITEM_TYPE, "reviewer"))).toEqual(before);
      expect(JSON.stringify(outputSchemaFor(registry, "review", UNKNOWN_ITEM_TYPE, "auditor"))).toEqual(before);
    } finally {
      fresh.close();
    }
  });

  /**
   * A file written before definitions existed carries `schemasByAction`
   * and nothing else about the action. Importing it writes the role's
   * definitions — the same ones a database that had the schema in an
   * agent's config is migrated to — and no config key.
   */
  it("writes a role's carried schemasByAction as its action definitions, as the migration does", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const carried = {
      triage: { type: "object", properties: { result: { type: "string", enum: ["urgent", "routine"] }, severity: { type: "string" } }, required: ["result", "severity"] },
      sort: { type: "object", properties: { bucket: { type: "string" } }, required: ["bucket"] },
    };
    // As a file from before EO-424 has it: the schemas, and no `actions`.
    const older = { ...built.document, roles: built.document.roles.map((role) => ({ ...role, schemasByAction: carried, actions: [] })) };

    const fresh = openMigratedTestDb();
    const upgraded = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: older, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      createAgent(upgraded.db, { name: "Triager", role: "triager", provider: "claude", instructions: "Route it.", config: { schemasByAction: carried } });
      migrateCarriedSchemas(upgraded.db);

      const shapeOf = (db: Db) => listActionDefinitions(db).map(({ role, action, description, results, fields }) => ({ role, action, description, results, fields }));
      expect(shapeOf(fresh.db)).toEqual([
        { role: "triager", action: "sort", description: "", results: [{ key: "done", label: "Done", meaning: "" }], fields: carried.sort },
        {
          role: "triager",
          action: "triage",
          description: "",
          results: [
            { key: "urgent", label: "Urgent", meaning: "" },
            { key: "routine", label: "Routine", meaning: "" },
          ],
          fields: { type: "object", properties: { severity: { type: "string" } }, required: ["severity"] },
        },
      ]);
      expect(shapeOf(fresh.db)).toEqual(shapeOf(upgraded.db));
      expect(listAgents(fresh.db).find((agent) => agent.role === "triager")?.config).not.toHaveProperty("schemasByAction");
    } finally {
      fresh.close();
      upgraded.close();
    }
  });

  /**
   * And one whose schema could not be a definition is refused whole,
   * before anything is written: result keys a route cannot name would
   * otherwise land as a role held to nothing.
   */
  it("refuses a pack whose carried schema the save would refuse", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const unnameable = {
      ...built.document,
      roles: built.document.roles.map((role) => ({ ...role, schemasByAction: { triage: { type: "object", properties: { result: { type: "string", enum: ["Needs Work"] } } } } })),
    };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });

      expect(preflightImport(fresh.db, secrets, unnameable, { projectId: project.id }).refusal).toContain(`The triager role's "triage" action cannot be defined`);

      const pipelinesBefore = listPipelines(fresh.db).length;
      const imported = importPipeline(fresh.db, { document: unnameable, projectId: project.id, signedInBackends: ["claude"] });
      expect(imported.ok).toBe(false);
      expect(listPipelines(fresh.db)).toHaveLength(pipelinesBefore);
      expect(listAgents(fresh.db).some((agent) => agent.role === "triager")).toBe(false);
      expect(listActionDefinitions(fresh.db)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A definition as a person wrote it: a description, results in an
   * order that is not alphabetical with labels and meanings of their
   * own, and fields with a required one (EO-424).
   *
   * Nothing here is what `actionShapeFromSchema` would have guessed from
   * a generated schema, which is the point: a round trip through
   * `schemasByAction` kept the keys and lost every other word.
   */
  const SORT_DEFINITION = {
    action: "sort",
    description: "Decide which queue the case belongs in.",
    results: [
      { key: "urgent", label: "Needs someone now", meaning: "A customer is blocked and nobody has answered." },
      { key: "routine", label: "Can wait", meaning: "Anything that is not blocking somebody today." },
    ],
    fields: { type: "object", properties: { queue: { type: "string", enum: ["billing", "support"] }, reason: { type: "string" } }, required: ["queue"] },
  };

  /** Every definition as the four things a document carries about it, beside its role. */
  const definitionsIn = (db: Db) => listActionDefinitions(db).map(({ role, action, description, results, fields }) => ({ role, action, description, results, fields }));

  /** `packInstallation`, with the triager also defining `sort`, exported. */
  function exportedWithSort(): PipelineExport {
    const { pipeline } = packInstallation(handle.db);
    const defined = saveActionDefinition(handle.db, { role: "triager", ...SORT_DEFINITION });
    if (!defined.ok) throw new Error(defined.problems.join(", "));
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    return built.document;
  }

  it("carries a role's definitions whole, and a clean database reproduces every one exactly", () => {
    const document = exportedWithSort();

    // In the file as they are held, and not as generated schemas.
    const triager = document.roles.find((role) => role.slug === "triager");
    expect(triager?.actions).toContainEqual(SORT_DEFINITION);
    expect(triager?.schemasByAction).toEqual({});

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Through the text, as a file is: what is asserted is what a
      // reader of the bytes gets, not what an object in memory held.
      const parsed = parseExport(JSON.stringify(document));
      if (!parsed.ok) throw new Error(parsed.reason);
      const imported = importPipeline(fresh.db, { document: parsed.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      expect(definitionsIn(fresh.db)).toEqual(definitionsIn(handle.db));
      expect(definitionsIn(fresh.db)).toContainEqual({ role: "triager", ...SORT_DEFINITION });
      // Nothing was already here, so nothing was kept over the file's.
      expect(imported.keptDefinitions).toEqual([]);

      // And it is in force: the provider is held to the declared keys.
      const registry = registryForProject(fresh.db, project.id);
      expect(validateActionResult(registry, "sort", { outcome: { result: "urgent", summary: "Blocked.", queue: "billing" } }, UNKNOWN_ITEM_TYPE, "triager").ok).toBe(true);
      expect(validateActionResult(registry, "sort", { outcome: { result: "done", summary: "Blocked.", queue: "billing" } }, UNKNOWN_ITEM_TYPE, "triager").ok).toBe(false);
    } finally {
      fresh.close();
    }
  });

  /**
   * A definition is the role's, not an agent's: it is saved without one
   * and stays when the agent is archived. So a role nobody is in still
   * carries what it defines — under no prompt, since nobody wrote one —
   * and the far side gets the definitions and no agent made of nothing.
   */
  it("carries the definitions of a role nobody staffs, and reproduces them on a clean database", () => {
    const { pipeline } = packInstallation(handle.db);
    expect(saveActionDefinition(handle.db, { role: "triager", ...SORT_DEFINITION }).ok).toBe(true);
    for (const agent of listAgents(handle.db).filter((candidate) => candidate.role === "triager")) archiveAgent(handle.db, agent.id);

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    const triager = built.document.roles.find((role) => role.slug === "triager");
    expect(triager).toMatchObject({ prompt: null, allowedTools: null, backend: null, model: null });
    expect(triager?.actions).toContainEqual(SORT_DEFINITION);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const parsed = parseExport(JSON.stringify(built.document));
      if (!parsed.ok) throw new Error(parsed.reason);

      // The slot is reported as one nobody wrote a prompt for.
      expect(preflightImport(fresh.db, secrets, parsed.document, { projectId: project.id }).roleSlots).toContainEqual(
        expect.objectContaining({ slug: "triager", filled: false, carriesPrompt: false }),
      );

      const imported = importPipeline(fresh.db, { document: parsed.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      expect(definitionsIn(fresh.db)).toEqual(definitionsIn(handle.db));
      expect(definitionsIn(fresh.db)).toContainEqual({ role: "triager", ...SORT_DEFINITION });
      expect(listAgents(fresh.db).some((agent) => agent.role === "triager")).toBe(false);

      // And out the other side again: still unstaffed, still defined.
      const again = exportPipeline(fresh.db, imported.pipelineId as Uuid);
      if (!again.ok) throw new Error(again.reason);
      expect(again.document.roles).toEqual(built.document.roles);
    } finally {
      fresh.close();
    }
  });

  /** A role nobody staffs that defines nothing still contributes nothing. */
  it("leaves out a role nobody staffs that defines no action", () => {
    const pipeline = createPipeline(handle.db, { name: "Empty slot" });
    createStep(handle.db, { id: "slot", pipelineId: pipeline.id, position: 0, name: "Slot", type: "agent", ownerRole: "nobody_yet", isTerminal: true });

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.roles).toEqual([]);
  });

  /**
   * A definition that is the wrong *shape* is refused by the document's
   * own schema before the save's rules are ever asked — and used to be
   * told as a damaged file. Through the text, because that is where it
   * happens: this is what choosing the file in the import dialog reads.
   */
  it.each([
    ["fields that are a list", { fields: [] }, "fields"],
    ["results that are not a list", { results: "urgent" }, "results"],
    ["a result with no key", { results: [{ label: "Urgent", meaning: "Now." }] }, "results.0.key"],
    ["a description that is not text", { description: 7 }, "description"],
  ])("names the role and the action of a definition with %s, and writes nothing", (_what, change, where) => {
    const document = exportedWithSort();
    const text = JSON.stringify({ ...document, roles: document.roles.map((role) => ({ ...role, actions: [{ ...SORT_DEFINITION, ...change }] })) });

    const parsed = parseExport(text);

    expect(parsed.ok).toBe(false);
    const reason = parsed.ok ? "" : parsed.reason;
    expect(reason).toContain(`The triager role's "sort" action cannot be defined`);
    expect(reason).toContain(where);
    expect(reason).not.toContain("damaged");
  });

  it("names the role of a definition that does not say which action it is", () => {
    const document = exportedWithSort();
    const text = JSON.stringify({ ...document, roles: document.roles.map((role) => ({ ...role, actions: [{ results: SORT_DEFINITION.results }] })) });

    expect(parseExport(text)).toEqual({ ok: false, reason: "The triager role carries an action definition with no action name, so it cannot be defined." });
  });

  /** And a file damaged somewhere else is still just that. */
  it("still calls a file damaged where no definition is at fault", () => {
    const document = exportedWithSort();

    expect(parseExport(JSON.stringify({ ...document, steps: "none" }))).toEqual({ ok: false, reason: "That file is not a pipeline export, or it is damaged." });
    expect(parseExport(JSON.stringify({ ...document, roles: [{ prompt: "Go.", actions: [{ action: "sort", results: "x" }] }] }))).toEqual({
      ok: false,
      reason: "That file is not a pipeline export, or it is damaged.",
    });
  });

  /**
   * A file does not edit the installation that adopted it.
   *
   * The installation's own `sort` says something else, so it stays, and
   * the import says which role and action — the pipeline that arrived
   * will run on a definition other than the one it was written against.
   * The definition it did not have arrives; the one it already had word
   * for word is not mentioned.
   */
  it("keeps a definition the installation already has differently, and names it", () => {
    const document = exportedWithSort();

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Somebody here already staffs the role and has defined `sort`
      // their own way.
      createAgent(fresh.db, { name: "Our triager", role: "triager", provider: "claude", instructions: "Ours." });
      const ours = { role: "triager", action: "sort", description: "Ours.", results: [{ key: "filed", label: "Filed", meaning: "It has a queue." }], fields: {} };
      expect(saveActionDefinition(fresh.db, ours).ok).toBe(true);

      const imported = importPipeline(fresh.db, { document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      expect(imported.keptDefinitions).toEqual([{ role: "triager", action: "sort" }]);
      expect(definitionsIn(fresh.db)).toContainEqual(ours);
      // The one that was missing here arrived, staffed role or not:
      // the steps that came with this file dispatch it either way.
      expect(getActionDefinition(fresh.db, "triager", "triage")).toBeDefined();
      // Their agent is still theirs.
      expect(listAgents(fresh.db).filter((agent) => agent.role === "triager").map((agent) => agent.instructions)).toEqual(["Ours."]);

      // The same file again: both definitions are here now, one of them
      // identical. Only the one that differs is named.
      const again = importPipeline(fresh.db, { document, choices: { deploy: "reuse" }, projectId: project.id, signedInBackends: ["claude"] });
      if (!again.ok) throw new Error(again.reason);
      expect(again.keptDefinitions).toEqual([{ role: "triager", action: "sort" }]);
      expect(definitionsIn(fresh.db)).toContainEqual(ours);
    } finally {
      fresh.close();
    }
  });

  /**
   * The same rule for a role the file spells with space around it.
   *
   * The save writes a definition under the role trimmed, so ` triager `
   * lands on `triager`. Asked by the file's own spelling, the lookup
   * found nothing installed, kept nothing, and the save replaced the
   * installation's definition without a word. Through the text, as a
   * file arrives.
   */
  it("keeps the installed definition when the file pads the role's slug", () => {
    const document = exportedWithSort();
    const text = JSON.stringify({ ...document, roles: document.roles.map((role) => ({ ...role, slug: ` ${role.slug} `, schemasByAction: { sort: { type: "object", properties: { result: { type: "string", enum: ["other"] } } } } })) });

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const ours = { role: "triager", action: "sort", description: "Ours.", results: [{ key: "filed", label: "Filed", meaning: "It has a queue." }], fields: {} };
      expect(saveActionDefinition(fresh.db, ours).ok).toBe(true);

      const parsed = parseExport(text);
      if (!parsed.ok) throw new Error(parsed.reason);
      const imported = importPipeline(fresh.db, { document: parsed.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      // Named by the role it is, not by how the file spelt it.
      expect(imported.keptDefinitions).toEqual([{ role: "triager", action: "sort" }]);
      expect(definitionsIn(fresh.db)).toContainEqual(ours);
      // Not by the carried schema for the same action either, which is
      // adopted with the agent this spelling of the role gets.
      expect(definitionsIn(fresh.db).filter((definition) => definition.action === "sort")).toEqual([ours]);
    } finally {
      fresh.close();
    }
  });

  it("refuses a file that defines one action for the same role under two spellings of it", () => {
    const document = exportedWithSort();
    const triager = document.roles.find((role) => role.slug === "triager")!;
    const twice = { ...document, roles: [...document.roles, { ...triager, slug: " triager ", actions: [{ ...SORT_DEFINITION, description: "Another." }] }] };

    const fresh = openMigratedTestDb();
    try {
      const imported = importPipeline(fresh.db, { document: twice, projectId: null, signedInBackends: [] });
      expect(imported).toEqual({ ok: false, reason: `The triager role's "sort" action is defined twice in this file.` });
      expect(listActionDefinitions(fresh.db)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  /**
   * Where a file names an action both ways, the definition is the one
   * read: it says everything the schema does and what the schema cannot.
   */
  it("reads a role's definition over a carried schema for the same action", () => {
    const document = exportedWithSort();
    const both = {
      ...document,
      roles: document.roles.map((role) => ({ ...role, schemasByAction: { sort: { type: "object", properties: { result: { type: "string", enum: ["other"] } } } } })),
    };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: both, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      expect(definitionsIn(fresh.db)).toContainEqual({ role: "triager", ...SORT_DEFINITION });
    } finally {
      fresh.close();
    }
  });

  /**
   * A definition the save's rules refuse is refused before anything is
   * written, and the sentence names the role and the action — each rule
   * the save has, since it is the save's rules that are asked.
   */
  it.each([
    ["duplicate result keys", { results: [SORT_DEFINITION.results[0]!, SORT_DEFINITION.results[0]!] }, "declared more than once"],
    ["no results", { results: [] }, "at least one result"],
    ["a result key a route could not name", { results: [{ key: "Needs Work", label: "", meaning: "" }] }, "lowercase letters"],
    ["a field named result", { fields: { type: "object", properties: { result: { type: "string" } } } }, 'named "result"'],
    ["fields that do not compile", { fields: { type: "object", properties: { queue: { type: "strng" } } } }, "not a JSON Schema EO can read"],
    ["an action no step dispatches", { action: "respond" }, "no pipeline step dispatches it"],
  ])("refuses a file whose definition has %s, and writes nothing", (_what, change, why) => {
    const document = exportedWithSort();
    const carried = { ...SORT_DEFINITION, ...change };
    const refused = { ...document, roles: document.roles.map((role) => ({ ...role, actions: [carried] })) };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });

      const refusal = preflightImport(fresh.db, secrets, refused, { projectId: project.id }).refusal;
      expect(refusal).toContain(`The triager role's "${carried.action}" action cannot be defined`);
      expect(refusal).toContain(why);

      const pipelinesBefore = listPipelines(fresh.db).length;
      const imported = importPipeline(fresh.db, { document: refused, projectId: project.id, signedInBackends: ["claude"] });
      expect(imported).toEqual({ ok: false, reason: refusal });
      expect(listPipelines(fresh.db)).toHaveLength(pipelinesBefore);
      expect(listAgents(fresh.db).some((agent) => agent.role === "triager")).toBe(false);
      expect(listItemTypes(fresh.db, project.id).map((type) => type.slug)).not.toContain("case");
      expect(listActionDefinitions(fresh.db)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("refuses a file that defines one action twice for a role", () => {
    const document = exportedWithSort();
    const twice = { ...document, roles: document.roles.map((role) => ({ ...role, actions: [SORT_DEFINITION, { ...SORT_DEFINITION, description: "Another." }] })) };

    const fresh = openMigratedTestDb();
    try {
      const imported = importPipeline(fresh.db, { document: twice, projectId: null, signedInBackends: [] });
      expect(imported).toEqual({ ok: false, reason: `The triager role's "sort" action is defined twice in this file.` });
      expect(listActionDefinitions(fresh.db)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A pack's own role restating the action that pack ships is one of the
   * save's refusals (EO-422), and so one of this gate's.
   */
  it("refuses a file that redefines the action an installed pack ships for its own role", () => {
    const document = exportedWithSort();
    const reopened = {
      ...document,
      roles: [...document.roles, { slug: "reviewer", prompt: "Review it.", schemasByAction: {}, actions: [{ ...SORT_DEFINITION, action: "review" }], allowedTools: null, backend: null, model: null }],
    };

    const fresh = openMigratedTestDb();
    try {
      const imported = importPipeline(fresh.db, { document: reopened, projectId: null, signedInBackends: [] });
      expect(imported.ok).toBe(false);
      expect(!imported.ok && imported.reason).toContain(`The reviewer role's "review" action cannot be defined`);
      expect(listActionDefinitions(fresh.db)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A schema ajv cannot compile is refused before anything is written.
   *
   * Storing it would leave a role whose runs are silently unvalidated
   * while the pack says they are held to something — and the moment to
   * say so is the one where refusing costs nothing.
   */
  it("refuses a pack whose output schema is not a JSON Schema EO can read", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const malformed = {
      ...built.document,
      roles: built.document.roles.map((role) => ({ ...role, schemasByAction: { triage: { type: "obect" } } })),
    };

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });

      const preflight = preflightImport(fresh.db, secrets, malformed, { projectId: project.id });
      expect(preflight.refusal).toContain(`The triager role's schema for "triage" is not a JSON Schema EO can read`);

      const pipelinesBefore = listPipelines(fresh.db).length;
      const imported = importPipeline(fresh.db, { document: malformed, projectId: project.id, signedInBackends: ["claude"] });
      expect(imported.ok).toBe(false);
      expect(listPipelines(fresh.db)).toHaveLength(pipelinesBefore);
      expect(listAgents(fresh.db).some((agent) => agent.role === "triager")).toBe(false);
    } finally {
      fresh.close();
    }
  });

  /**
   * The capability line comes from the **server definition** (ARCHITECTURE.md, "A connector is an
   * MCP server with a setup flow"), which is the only thing that knows what reaching a
   * server means — and it travels, because the machine reading the pack
   * has no such row to read it off.
   */
  it("takes each capability line from the MCP server's own description", () => {
    const { pipeline } = packInstallation(handle.db);

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.mcpServers).toEqual([{ name: "slack", description: "reads your Slack channels", connector: SLACK_CONNECTOR }]);
    // The words, and nothing anybody would have to run.
    expect(JSON.stringify(built.document.mcpServers)).not.toContain("slack-mcp");

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Read on a machine that has no Slack server at all: the sentence
      // travelled with the pack.
      const preflight = preflightImport(fresh.db, secrets, built.document, { projectId: project.id });
      expect(preflight.capabilities).toContainEqual({ server: "slack", line: "reads your Slack channels" });

      // Importing writes the *words* down and nothing to spawn: the row
      // arrives disabled, with no command, for the person to finish.
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);

      const declared = listMcpServers(fresh.db, true);
      expect(declared).toHaveLength(1);
      expect(declared[0]).toMatchObject({ name: "slack", description: "reads your Slack channels", enabled: false });
      expect(declared[0]?.config).toEqual({ transport: "stdio", command: "", args: [] });
      // Disabled, so nothing reaches a dispatch until somebody has
      // filled in the half only they can.
      expect(isDeliverableMcpServer(declared[0]!)).toBe(false);
    } finally {
      fresh.close();
    }
  });

  /**
   * The acceptance criterion, end to end and through the pack path
   * rather than around it (EO-315).
   *
   * "A pack that ships a `token` connector shows Connect on the step,
   * accepts a value, stores it under the declared secret name, and the
   * agent is served the server on the next dispatch." Every one of those
   * clauses is a line below, on a machine that has never heard of Slack
   * and holds nothing but the document.
   */
  it("ships a token connector a person can connect on the step, and the agent is served it next dispatch", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    // The setup travelled; the command did not.
    expect(built.document.mcpServers[0]?.connector).toEqual(SLACK_CONNECTOR);
    expect(JSON.stringify(built.document.mcpServers)).not.toContain("slack-mcp");

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      // **Shows Connect on the step.** The step is staffed by `triager`,
      // and what a step owned by that role can reach is the question the
      // reach list asks.
      const [connector] = listConnectorViews(fresh.db, serverSecrets, { role: "triager" });
      expect(connector).toMatchObject({
        serverName: "slack",
        label: "Slack",
        // The capability line, from the description that travelled with it.
        capability: "reads your Slack channels",
        setup: "token",
        secretNames: ["SLACK_BOT_TOKEN"],
        connected: false,
        problem: "Slack is not connected yet — EO still needs SLACK_BOT_TOKEN.",
        // And the other half of the truth: a pack ships no transport, so
        // until the person says how this server runs nothing is
        // delivered whatever they connect.
        deliverable: false,
      });

      // **Accepts a value, stores it under the declared secret name.**
      const connect = connectConnectorTokenCommand(fresh.db, serverSecrets, {
        serverId: connector!.serverId!,
        values: { SLACK_BOT_TOKEN: "xoxb-from-the-pack" },
      });
      expect(connect).toMatchObject({ connected: true, problem: null });
      expect(listMcpServerSecretNames(serverSecrets, connector!.serverId!)).toEqual(["SLACK_BOT_TOKEN"]);

      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager")!;
      // Still nothing, because the person has not finished their half —
      // and that is what `deliverable: false` said above rather than a
      // surprise at dispatch.
      expect(attachmentEnvironment(fresh.db, agent.id, serverSecrets).env).toEqual({});

      // The half only they can do: what to run, and on.
      const finished = saveMcpServer(
        fresh.db,
        McpServerDraftSchema.parse({ id: connector!.serverId!, name: "slack", transport: "stdio", command: "/opt/slack-mcp", enabled: true }),
      );
      if (!finished.ok) throw new Error(finished.problems.join(", "));
      // Editing the command did not take the pack's words or its setup
      // with it — a draft that says nothing about a connector is silence
      // rather than a deletion.
      expect(finished.server.connector).toEqual(SLACK_CONNECTOR);
      expect(finished.server.description).toBe("reads your Slack channels");

      // **And the agent is served the server on the next dispatch**,
      // read through the function a spawn reads it through.
      expect(attachmentEnvironment(fresh.db, agent.id, serverSecrets)).toEqual({
        env: { SLACK_BOT_TOKEN: "xoxb-from-the-pack" },
        unresolved: [],
        withheld: [],
      });
      expect(listConnectorViews(fresh.db, serverSecrets, { role: "triager" })[0]).toMatchObject({
        connected: true,
        problem: null,
        deliverable: true,
      });
    } finally {
      fresh.close();
    }
  });

  /**
   * Refused rather than written half-working, on the admin grant's own
   * grounds: this is the one place every reader of a pack goes through,
   * and the alternatives are a Connect button that cannot finish or a
   * setup silently dropped. The author is the person who can still fix
   * it, so the refusal says what is wrong with it.
   */
  it("refuses a pack whose connector setup could not be completed here", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    // An OAuth connector asking for a value the sign-in never produces
    // and no box exists to type — a line that would go on being red
    // however often somebody pressed Connect.
    const broken = {
      ...built.document,
      mcpServers: built.document.mcpServers.map((server) => ({
        ...server,
        connector: {
          label: "Slack",
          kind: "oauth",
          secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
          oauth: { authorizeUrl: "https://slack.test/authorize", tokenUrl: "https://slack.test/token", clientId: "eo", scopes: [], tokenSecretName: "SLACK_BOT_TOKEN" },
        },
      })),
    };

    const read = parseExport(JSON.stringify(broken));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain(CONNECTOR_SETUP_REFUSAL);
    expect(read.reason).toContain("SLACK_TEAM_ID");
    // Not "your file is damaged", which is the sentence a person cannot
    // act on.
    expect(read.reason).not.toContain("damaged");
  });

  /**
   * The link that made the rest of it reachable. Without the tick the
   * pack's own wiring stops one short: the role says it reaches Slack,
   * the server row is written beside it, and the step shows an empty
   * list with no Connect button anywhere in the product.
   */
  it("ties each imported role to the servers its own tool surface names", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);

      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager")!;
      const slack = getMcpServerByName(fresh.db, "slack")!;
      expect(getAgentAttachments(fresh.db, agent.id).mcpServerIds).toEqual([slack.id]);

      // A role that names no server gets none, and nothing is ticked
      // onto an agent for a server this document did not declare.
      expect(listMcpServers(fresh.db, true)).toHaveLength(1);
    } finally {
      fresh.close();
    }
  });

  /**
   * A server this installation already has is theirs, configuration and
   * description alike — **and so is the question of which agents hold
   * it** (EO-315).
   *
   * The row is the person's command and the person's credentials, and
   * ticking it onto an agent is giving that agent a working tool they
   * never gave it. So the import's auto-attachment is scoped to rows
   * *it created*, and this is the case that says so: everything else
   * about the import happens, and the existing server's attachments are
   * exactly what they were.
   */
  it("does not touch a server this machine already has, nor who holds it", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const mine = saveMcpServer(
        fresh.db,
        McpServerDraftSchema.parse({ name: "slack", description: "my own Slack", transport: "stdio", command: "/opt/slack-mcp" }),
      );
      if (!mine.ok) throw new Error(mine.problems.join(", "));

      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);

      expect(listMcpServers(fresh.db, true)).toHaveLength(1);
      expect(getMcpServerByName(fresh.db, "slack")).toMatchObject({ description: "my own Slack", enabled: true });

      // The agent the import created for the pack's role names
      // `mcp__slack__*`, and still holds nothing: the only `slack` here
      // is one the person configured, which the import may describe and
      // may not hand out.
      const agent = listAgents(fresh.db).find((candidate) => candidate.role === "triager")!;
      expect(getAgentAttachments(fresh.db, agent.id).mcpServerIds).toEqual([]);
      // And a run of that agent is served nothing, which is the same
      // fact one layer down.
      expect(attachmentEnvironment(fresh.db, agent.id, serverSecrets).env).toEqual({});
    } finally {
      fresh.close();
    }
  });

  /**
   * `agents.role` is not unique, and the reach list unions every
   * dispatchable agent staffing a role on purpose — so an import that
   * attached one of them advertised a connector the other agent's
   * dispatch would run without (EO-315).
   *
   * The failure is the worst shape available: the screen is green, the
   * token is stored, and whether the run gets it depends on which agent
   * the supervisor happened to pick.
   */
  it("gives every agent staffing an imported role the server the pack declared", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      // Two people already staff this role here. `writeRoles` leaves
      // both alone — a prompt somebody edited is theirs — so the import's
      // only job for them is the wiring.
      const day = createAgent(fresh.db, { name: "Day triager", role: "triager", provider: "claude", instructions: "Day shift." });
      const night = createAgent(fresh.db, { name: "Night triager", role: "triager", provider: "claude", instructions: "Night shift." });

      const imported = importPipeline(fresh.db, { document: built.document, projectId: project.id, signedInBackends: ["claude"] });
      if (!imported.ok) throw new Error(imported.reason);

      const slack = getMcpServerByName(fresh.db, "slack")!;
      expect(getAgentAttachments(fresh.db, day.id).mcpServerIds).toEqual([slack.id]);
      expect(getAgentAttachments(fresh.db, night.id).mcpServerIds).toEqual([slack.id]);

      // Connect once, on the step, exactly as a person would.
      const [connector] = listConnectorViews(fresh.db, serverSecrets, { role: "triager" });
      expect(connector).toMatchObject({ serverName: "slack", setup: "token", connected: false });
      const connect = connectConnectorTokenCommand(fresh.db, serverSecrets, {
        serverId: connector!.serverId!,
        values: { SLACK_BOT_TOKEN: "xoxb-shared" },
      });
      expect(connect.connected).toBe(true);

      const finished = saveMcpServer(
        fresh.db,
        McpServerDraftSchema.parse({ id: slack.id, name: "slack", transport: "stdio", command: "/opt/slack-mcp", enabled: true }),
      );
      if (!finished.ok) throw new Error(finished.problems.join(", "));

      // Whichever of the two the supervisor picks is served the server
      // and the credential the reach list promised.
      for (const agent of [day, night]) {
        expect(attachmentEnvironment(fresh.db, agent.id, serverSecrets), agent.name).toEqual({
          env: { SLACK_BOT_TOKEN: "xoxb-shared" },
          unresolved: [],
          withheld: [],
        });
      }
    } finally {
      fresh.close();
    }
  });

  /**
   * A server name may contain a double underscore, and Claude's spelling
   * then cannot be read from the string alone.
   *
   * `MCP_SERVER_NAME_PATTERN` permits it, so
   * `mcp__slack__prod__list_channels` is `slack__prod`'s `list_channels`
   * on an installation that has that server and `slack`'s
   * `prod__list_channels` on one that does not. Read against the names
   * that exist, the pack carries the definition that is really there and
   * the gate shows that server's own words instead of a generic line
   * about a server nobody has.
   */
  it("reads a server whose name contains a double underscore", () => {
    const server = saveMcpServer(
      handle.db,
      McpServerDraftSchema.parse({ name: "slack__prod", description: "reads your production Slack", transport: "stdio", command: "slack-mcp" }),
    );
    if (!server.ok) throw new Error(server.problems.join(", "));

    createAgent(handle.db, {
      name: "Sorter",
      role: "sorter",
      provider: "claude",
      instructions: "Sort it.",
      config: { allowedTools: ["mcp__slack__prod__list_channels"] },
    });
    const pipeline = createPipeline(handle.db, { name: "Sorting" });
    createStep(handle.db, { id: "sort", pipelineId: pipeline.id, position: 0, name: "Sort", type: "agent", ownerRole: "sorter" });
    createStep(handle.db, { id: "sorted", pipelineId: pipeline.id, position: 1, name: "Sorted", type: "user", isTerminal: true });

    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.mcpServers).toEqual([{ name: "slack__prod", description: "reads your production Slack", connector: null }]);

    // On a machine that has no such server, the pack's own definition is
    // what names it — and the line is that server's words rather than a
    // sentence about a `slack` nobody mentioned.
    const fresh = openMigratedTestDb();
    try {
      expect(preflightImport(fresh.db, secrets, built.document).capabilities).toEqual([
        { server: "slack__prod", line: "reads your production Slack" },
      ]);
    } finally {
      fresh.close();
    }
  });

  /**
   * And with nobody having described it, the line names the server
   * rather than inventing a sentence about somebody else's tools — or
   * falling back to the tool names, which is what the design is about.
   */
  it("names a server nobody has described, rather than listing its tools", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const capabilities = preflightImport(handle.db, secrets, built.document).capabilities;
    expect(capabilities).toContainEqual({ server: "zendesk", line: "uses your zendesk server" });
    expect(JSON.stringify(capabilities)).not.toContain("tickets_list");
  });

  /** A connector lands disconnected and says so, before anything is written (ARCHITECTURE.md, "Import is the needs check"). */
  it("reports a connector this project has not connected", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      expect(preflightImport(fresh.db, secrets, built.document, { projectId: project.id }).connectors).toEqual([
        // `server` is what the needs check's Connect button acts on
        // (EO-317): the connector's slug names it inside the pack, and
        // the server name is what the connectors list is keyed by.
        { slug: "jira", label: "Jira", description: "reads and updates your Jira issues", server: null, connected: false },
        { slug: "support-desk", label: "Support Desk", description: "reads and answers your support conversations", server: "support-desk", connected: false },
      ]);
    } finally {
      fresh.close();
    }
  });

  /**
   * A document from before any of this — no types, no connectors, no
   * vocabulary, and roles carrying a prompt and nothing else — still
   * imports, as a pack that ships none of them.
   */
  it("imports an old-format export", () => {
    const older = {
      eoPipelineExport: 2,
      pipeline: { name: "Delivery", icon: null, entryStepId: "implement" },
      steps: [
        { id: "implement", position: 0, name: "Implement", type: "agent", ownerRole: "triager", entryAction: null, instructionsSummary: null, isTerminal: false, planMode: false },
        { id: "done", position: 1, name: "Done", type: "user", entryAction: null, ownerRole: null, instructionsSummary: null, isTerminal: true, planMode: false },
      ],
      routes: [{ fromStepId: "implement", resultKey: "done", label: "Done", tone: "success", target: "done", position: 0 }],
      modules: [],
      roles: [{ slug: "triager", prompt: "Get to work." }],
    };

    const parsed = parseExport(JSON.stringify(older));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.itemTypes).toEqual([]);
    expect(parsed.document.connectors).toEqual([]);
    expect(parsed.document.vocabulary).toEqual({ types: [], results: [] });
    expect(parsed.document.previewItem).toBeNull();
    // The role it does carry is read as a role that recommends nothing,
    // which is what a document written before the design says.
    expect(parsed.document.roles).toEqual([{ slug: "triager", prompt: "Get to work.", schemasByAction: {}, actions: [], allowedTools: null, backend: null, model: null }]);

    const imported = importPipeline(handle.db, { document: parsed.document });
    if (!imported.ok) throw new Error(imported.reason);
    expect(listStepsForPipeline(handle.db, imported.pipelineId as Uuid)).toHaveLength(2);
  });

  /**
   * A pack authored with a template item for Preview keeps it, and
   * nothing is created from it: a preview item is Preview's to make,
   * marked and excluded from inbox, archive and cost (ARCHITECTURE.md, "Preview").
   */
  it("carries a template item without filing one", () => {
    const { pipeline } = packInstallation(handle.db);
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    const withPreview = { ...built.document, previewItem: { title: "Printer is offline", type: "support:case", body: "It stopped this morning.", spec: {} } };
    const text = JSON.stringify(withPreview);
    const parsed = parseExport(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.document.previewItem).toEqual({ title: "Printer is offline", type: "support:case", body: "It stopped this morning.", spec: {} });

    const fresh = openMigratedTestDb();
    try {
      const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
      const before = listItems(fresh.db).length;
      const imported = importPipeline(fresh.db, { document: parsed.document, projectId: project.id });
      if (!imported.ok) throw new Error(imported.reason);
      expect(listItems(fresh.db)).toHaveLength(before);
    } finally {
      fresh.close();
    }
  });

  /**
   * Invariant #11, at the import gate (ARCHITECTURE.md, "The `eo_admin` grant").
   *
   * A pack is data, `allowedTools` is what invariant #11 governs, and
   * data deciding it is the thing that invariant exists to prevent. So
   * the answer is no — refused, not stripped, with the line the design writes
   * — and nothing is written.
   */
  describe("a role that asks for the admin grant", () => {
    /**
     * The grant, in whichever spelling a pack writes it.
     *
     * Claude advertises `mcp__eo_admin__pipeline_save` and Codex sends
     * `eo_admin/pipeline_save` (EO-198, `roles/pipelineRead.ts`), and
     * they are one grant. A gate that read only the first would refuse
     * a pack on one backend and write its rows on the other, with every
     * test still green — invariant #12 exactly, which is why every
     * assertion below is made about both.
     */
    const SPELLINGS = [
      { backend: "Claude", grant: "mcp__eo_admin__pipeline_save" },
      { backend: "Codex", grant: "eo_admin/pipeline_save" },
    ];

    function packAskingForAdmin(grant = "mcp__eo_admin__pipeline_save") {
      const { pipeline } = packInstallation(handle.db);
      const built = exportPipeline(handle.db, pipeline.id);
      if (!built.ok) throw new Error(built.reason);
      return {
        ...built.document,
        roles: built.document.roles.map((role) => ({ ...role, allowedTools: ["mcp__eo__item_detail", grant] })),
      };
    }

    it.each(SPELLINGS)("is refused at preflight with the stated line ($backend's spelling)", ({ grant }) => {
      const document = packAskingForAdmin(grant);

      const parsed = parseExport(JSON.stringify(document));
      expect(parsed).toEqual({ ok: false, reason: "This pack asks for admin tools. EO does not allow that from a pack." });
      expect(parsed.ok === false && parsed.reason).toBe(ADMIN_GRANT_REFUSAL);

      // And the same line from the preflight itself, for a caller
      // holding a document it did not parse here.
      expect(preflightImport(handle.db, secrets, document).refusal).toBe(ADMIN_GRANT_REFUSAL);
    });

    /** The half that matters: refused *and* nothing written. */
    it.each(SPELLINGS)("creates nothing ($backend's spelling)", ({ grant }) => {
      const document = packAskingForAdmin(grant);

      const fresh = openMigratedTestDb();
      try {
        const project = createProject(fresh.db, { name: "Support", keyPrefix: "SUP" });
        const before = {
          pipelines: listPipelines(fresh.db).length,
          agents: listAgents(fresh.db).length,
          types: listItemTypes(fresh.db, project.id).length,
          modules: listModules(fresh.db, true).length,
          connectors: listConnectorsForProject(fresh.db, project.id).length,
          servers: listMcpServers(fresh.db, true).length,
        };

        const imported = importPipeline(fresh.db, { document, projectId: project.id, signedInBackends: ["claude"] });
        expect(imported).toEqual({ ok: false, reason: ADMIN_GRANT_REFUSAL });

        expect({
          pipelines: listPipelines(fresh.db).length,
          agents: listAgents(fresh.db).length,
          types: listItemTypes(fresh.db, project.id).length,
          modules: listModules(fresh.db, true).length,
          connectors: listConnectorsForProject(fresh.db, project.id).length,
          servers: listMcpServers(fresh.db, true).length,
        }).toEqual(before);
      } finally {
        fresh.close();
      }
    });

    /**
     * The whole-server spelling is the same grant — `mcp__eo_admin` is
     * Claude Code's own way of writing "everything this server offers",
     * and it is what the system agent actually carries.
     */
    it("refuses the whole-server spelling too", () => {
      const document = packAskingForAdmin();
      for (const whole of ["mcp__eo_admin", "eo_admin", "eo_admin/"]) {
        const asked = { ...document, roles: document.roles.map((role) => ({ ...role, allowedTools: [whole] })) };
        expect(parseExport(JSON.stringify(asked))).toEqual({ ok: false, reason: ADMIN_GRANT_REFUSAL });
      }
    });

    /**
     * And a tool id that merely begins with the same letters is not the
     * grant. The gate refusing an ordinary server called
     * `eo_administration` would be a pack refused for a name.
     */
    it("is not fooled by a server whose name merely starts the same way", () => {
      const document = packAskingForAdmin();
      for (const innocent of ["mcp__eo_administration__anything", "eo_administration/anything", "mcp__eo__pipeline_save", "pipeline_save"]) {
        const asked = { ...document, roles: document.roles.map((role) => ({ ...role, allowedTools: [innocent] })) };
        expect(parseExport(JSON.stringify(asked)).ok).toBe(true);
      }
    });

    /**
     * And the export end: an installation whose step-owning agent
     * somehow holds the grant is told so, rather than handed a file no
     * machine on earth will import.
     */
    it("refuses to export a pipeline whose role holds it", () => {
      const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
      createAgent(handle.db, {
        name: "Overreaching triager",
        role: "triager",
        provider: "claude",
        instructions: "Read the case and route it.",
        config: { allowedTools: ["mcp__eo_admin__pipeline_save"] },
      });
      const pipeline = createPipeline(handle.db, { projectId: project.id, name: "Triage" });
      createStep(handle.db, { id: "triage", pipelineId: pipeline.id, position: 0, name: "Triage", type: "agent", ownerRole: "triager" });
      createStep(handle.db, { id: "done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });

      const built = exportPipeline(handle.db, pipeline.id);
      expect(built.ok).toBe(false);
      expect(built.ok === false && built.reason).toContain("eo_admin");
    });
  });
});

/**
 * A module's tests travel with it (EO-355).
 *
 * Approving a module runs its test cases (EO-353), so a module that
 * arrived without them is one nobody on the far side could approve until
 * the cases were written again.
 */
describe("a module's test cases in a document", () => {
  const cases = [
    { description: "deploys the branch", source: "export default async function (harness) { await harness.run({ exec: [{ bin: 'flyctl' }] }); }" },
    { description: "fails when flyctl does", source: "import assert from 'node:assert/strict';\nexport default async function (h) {\n  const run = await h.run({ exec: [{ bin: 'flyctl', code: 1 }] });\n  assert.equal(run.outcome.ok, false);\n}\n" },
  ];

  function withTests() {
    const shipped = shippingPipeline();
    for (const each of addModuleTests(handle.db, shipped.module.id, cases)) if (!each.ok) throw new Error(each.reason);
    return shipped;
  }

  it("exports each case's description and source, in order, and nothing of this machine's", () => {
    const { pipeline } = withTests();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    expect(built.document.modules[0]!.tests).toEqual(cases);
  });

  it("restores them on a clean install with identical descriptions and source, through the file", () => {
    const { pipeline } = withTests();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);

    // Through JSON and the parser, as a file on another machine is read.
    const parsed = parseExport(JSON.stringify(built.document, null, 2));
    if (!parsed.ok) throw new Error(parsed.reason);

    const target = openMigratedTestDb();
    try {
      const result = importPipeline(target.db, { document: parsed.document });
      if (!result.ok) throw new Error(result.reason);

      const imported = getModuleBySlug(target.db, "deploy")!;
      expect(listModuleTests(target.db, imported.id).map((test) => ({ description: test.description, source: test.source }))).toEqual(cases);
      // Named back, so the caller can run them here.
      expect(result.createdModuleIds).toEqual([imported.id]);
    } finally {
      target.close();
    }
  });

  it("keeps two cases that read identically as two, on export and on import", () => {
    const shipped = shippingPipeline();
    const twin = { description: "deploys", source: "export default async function (h) { await h.run(); }" };
    for (const each of addModuleTests(handle.db, shipped.module.id, [twin, twin])) if (!each.ok) throw new Error(each.reason);
    const built = exportPipeline(handle.db, shipped.pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    expect(built.document.modules[0]!.tests).toEqual([twin, twin]);

    const target = openMigratedTestDb();
    try {
      const result = importPipeline(target.db, { document: built.document });
      if (!result.ok) throw new Error(result.reason);
      const imported = getModuleBySlug(target.db, "deploy")!;
      expect(listModuleTests(target.db, imported.id).map((test) => ({ description: test.description, source: test.source }))).toEqual([twin, twin]);
    } finally {
      target.close();
    }
  });

  it("brings no cases into a module the import reuses rather than creates", () => {
    const { pipeline } = withTests();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    const local = getModuleBySlug(handle.db, "deploy")!;

    const result = importPipeline(handle.db, { document: built.document, choices: { deploy: "reuse" } });
    if (!result.ok) throw new Error(result.reason);

    expect(listModuleTests(handle.db, local.id)).toHaveLength(cases.length);
    expect(result.createdModuleIds).toEqual([]);
  });

  it("imports a document from before tests travelled with zero tests, and the module shows as not fully tested", () => {
    const { pipeline } = shippingPipeline();
    const built = exportPipeline(handle.db, pipeline.id);
    if (!built.ok) throw new Error(built.reason);
    // What a version-6 export looks like: no `tests` on a module at all.
    const older = {
      ...built.document,
      eoPipelineExport: 6,
      modules: built.document.modules.map(({ tests: _tests, ...module }) => module),
    };
    expect(JSON.stringify(older)).not.toContain('"tests"');

    const parsed = parseExport(JSON.stringify(older));
    if (!parsed.ok) throw new Error(parsed.reason);

    const target = openMigratedTestDb();
    try {
      const result = importPipeline(target.db, { document: parsed.document });
      expect(result.ok).toBe(true);

      const view = listModuleViews(target.db, {}).modules.find((module) => module.slug === "deploy")!;
      expect(view.testCount).toBe(0);
      expect(moduleTestShortfalls(view)).toEqual([{ reason: "no_tests" }]);
    } finally {
      target.close();
    }
  });
});
