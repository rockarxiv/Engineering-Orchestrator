import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  McpServerDraftSchema,
  NO_POLICY,
  NO_WORKSPACE,
  SCRATCH_KIND,
  UNBOUND_BACKEND,
  placementAllows,
  type Job,
  type ModuleManifest,
  type Uuid,
} from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { archiveAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { saveMcpServer, setMcpServerEnabled } from "../db/repos/mcpServersRepo.js";
import { saveModule } from "../db/repos/modulesRepo.js";
import { createStep, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createWorkspace } from "../db/repos/workspacesRepo.js";
import { writePolicy } from "../policy/policy.js";
import { storeReference, storeSecret, type ModuleSecretsOptions } from "../modules/secrets.js";
import { createJob } from "./jobs.js";
import { placementForJob, runsOnOf, type BackendAuthKind, type PlacementFacts } from "./placement.js";

/**
 * What a job's pipeline needs, read off a real database (EO-330,
 * `ARCHITECTURE.md`, "Where a job runs").
 *
 * The gathering half. `packages/core/src/placement.test.ts` holds the
 * words and the direction to account with no machine under them; these
 * are about the walk — which rows are read, which are deliberately not,
 * and what the four kinds of need in the design look like when they are steps
 * and agents and secrets rather than a list in a document.
 *
 * The story's first two acceptance criteria are here, because both are
 * claims about a pipeline rather than about a sentence: a personal
 * Codex login greys the server until the agent is bound to a key, and a
 * module reading an organisation secret greys this machine.
 */

/** `safeStorage` minus the OS, exactly as `modules/secrets.test.ts` fakes it. */
const reverse = (text: string) => [...text].reverse().join("");
const store = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

let handle: DbHandle;
let directory: string;
let secrets: ModuleSecretsOptions;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo placement "));
  secrets = { directory, store };
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * How this machine is signed in, as the handler would have answered
 * after asking each CLI.
 *
 * A map rather than a single kind so that a test can sign one backend
 * in personally and leave the rest alone, which is the arrangement
 * every real desktop is in. Anything unnamed is `unknown` — a backend
 * EO cannot ask about — and `unknown` is never a reason.
 */
function facts(kinds: Record<string, BackendAuthKind> = {}): PlacementFacts {
  return {
    authKind: (provider) => kinds[provider] ?? "unknown",
    backendLabel: (provider) => (provider === "codex" ? "Codex" : provider),
    secrets,
  };
}

const TEMPLATE = { type: "developer:story", title: "{{job}} for {{date}}", body: null };

/** A job on the seeded pipeline, which is where every one of these walks starts. */
function job(overrides: Partial<Parameters<typeof createJob>[1]> = {}): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger: { kind: "manual" },
    pipelineId: "default",
    template: TEMPLATE,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.problem);
  return result.job;
}

/** The agent the seeded `todo` step dispatches to. */
function implementerId(): Uuid {
  return listAgents(handle.db).find((agent) => agent.role === "implementer")!.id as Uuid;
}

const DEPLOY: ModuleManifest = {
  name: "Deploy",
  description: "Builds and deploys the current branch.",
  inputs: {},
  needs: { bin: [], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

/** A module step on the job's pipeline, reading the names its manifest declares. */
function moduleStep(env: string[]): void {
  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Builds and deploys the current branch.",
    code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
    manifest: { ...DEPLOY, needs: { ...DEPLOY.needs, env } },
  });
  if (!saved.ok) throw new Error(saved.reason);
  createStep(handle.db, { pipelineId: "default" as Uuid, position: 90, name: "Deploy", type: "module", entryAction: saved.module.id });
}

/** An MCP server in this machine's catalogue, served to the implementer. */
function serverOn(name: string): string {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "npx", args: ["-y", name] }));
  if (!saved.ok) throw new Error(saved.problems.join(" "));
  setAgentAttachment(handle.db, { agentId: implementerId(), kind: "mcpServer", id: saved.server.id, attached: true });
  return saved.server.id;
}

describe("a pipeline that binds itself to nothing", () => {
  it("may run in either place", () => {
    // The seeded pipeline with every agent on a key: no personal login,
    // no secrets read, no disk named and nothing served. Which is the
    // case the two greyings have to be measured against — a walk that
    // found a reason here would be finding one everywhere.
    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placement).toMatchObject({ runsOn: "device", machineBound: [], serverBound: [] });
    expect(placementAllows(placement, "device")).toBe(true);
    expect(placementAllows(placement, "server")).toBe(true);
  });

  it("is placeable at all with no pipeline to walk", () => {
    // A `from-discussion` job: its work is whatever the approval
    // resolved, and there is no graph here to read. It never reaches a
    // control either — the Jobs screen does not keep one — so what is
    // asserted is only that asking is answerable.
    const conversation: Job = { ...job(), pipelineId: null };

    expect(placementForJob(handle.db, conversation, facts())).toMatchObject({ machineBound: [], serverBound: [] });
  });
});

/**
 * The story's first acceptance criterion, both halves.
 *
 * A personal login is the reason the design leads with, and the only one EO
 * cannot read out of its own database: it is what a CLI answered when
 * this desktop last asked it.
 */
describe("a step whose agent is signed in personally", () => {
  beforeEach(() => {
    updateAgent(handle.db, implementerId(), { provider: "codex" });
  });

  it("greys the organisation server, naming the step, the agent and the backend", () => {
    const placement = placementForJob(handle.db, job(), facts({ codex: "subscription" }));

    expect(placementAllows(placement, "server")).toBe(false);
    // …and this machine is untouched. A personal login is a reason the
    // work belongs *here*, never a reason it belongs nowhere.
    expect(placementAllows(placement, "device")).toBe(true);
    expect(placement.machineBound).toHaveLength(1);
    const [reason] = placement.machineBound;
    expect(reason).toMatchObject({ kind: "personal-login", subject: "Implementer", stepName: "To Do" });
    expect(reason!.line).toContain("Codex");
    expect(reason!.fix).toContain("API key");
  });

  it("clears the moment the agent is bound to a key instead", () => {
    // The criterion's own fix, and the reason nothing about placement is
    // stored (invariant #6): the same job, the same pipeline, a
    // different answer because the binding changed.
    const it = job();
    expect(placementAllows(placementForJob(handle.db, it, facts({ codex: "subscription" })), "server")).toBe(false);

    updateAgent(handle.db, implementerId(), { provider: "anthropic_api" });

    expect(placementAllows(placementForJob(handle.db, it, facts({ codex: "subscription", anthropic_api: "api_key" })), "server")).toBe(true);
  });

  it("says nothing on a probe that could not run", () => {
    // `unknown` is not a reason and never becomes one: greying an option
    // on the strength of a question EO could not ask would be inventing
    // the answer on a machine that is perfectly well signed in.
    expect(placementForJob(handle.db, job(), facts()).machineBound).toEqual([]);
  });

  it("says nothing about a role nothing staffs", () => {
    // An unstaffed step is already refused at dispatch with its own
    // sentence; a second one here wearing placement's name would send a
    // person to the wrong screen.
    archiveAgent(handle.db, implementerId());
    updateAgent(handle.db, listAgents(handle.db).find((agent) => agent.role === "reviewer")!.id as Uuid, {
      provider: UNBOUND_BACKEND,
    });

    expect(placementForJob(handle.db, job(), facts({ codex: "subscription" })).machineBound).toEqual([]);
  });
});

/** The story's second acceptance criterion, and the design's direction. */
describe("a step that reads a secret", () => {
  it("greys this machine where the organisation set the name", () => {
    writePolicy(handle.db, { ...NO_POLICY, secretNames: ["FLY_API_TOKEN"], publishedAt: 1 });
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placementAllows(placement, "device")).toBe(false);
    expect(placementAllows(placement, "server")).toBe(true);
    expect(placement.serverBound).toMatchObject([{ kind: "organisation-secret", subject: "FLY_API_TOKEN", stepName: "Deploy" }]);
    expect(placement.serverBound[0]!.fix).toContain("Ask your admin.");
  });

  it("greys the organisation server where the value is this machine's", () => {
    storeSecret(secrets, "FLY_API_TOKEN", "tok-1");
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placementAllows(placement, "server")).toBe(false);
    expect(placement.machineBound).toMatchObject([{ kind: "personal-secret", subject: "FLY_API_TOKEN" }]);
  });

  /**
   * A reference binds the work here harder than a stored value does
   * (EO-416): the value is not even on this disk, it is in the
   * environment this machine's EO was launched with, and the
   * organisation server has neither.
   */
  it("greys the organisation server where the name is read from this machine's environment", () => {
    storeReference(secrets, "FLY_API_TOKEN", "CI_FLY_TOKEN");
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), { ...facts({ fake: "api_key" }), secrets: { ...secrets, environment: { CI_FLY_TOKEN: "tok-1" } } });

    expect(placementAllows(placement, "server")).toBe(false);
    expect(placement.machineBound).toMatchObject([{ kind: "personal-secret", subject: "FLY_API_TOKEN", stepName: "Deploy" }]);
  });

  // "Set" means a dispatch would get a value, here as everywhere: a
  // reference to a variable EO does not have is a name nobody has set.
  it("says nothing about a reference whose variable this machine's EO does not have", () => {
    storeReference(secrets, "FLY_API_TOKEN", "CI_FLY_TOKEN");
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), { ...facts({ fake: "api_key" }), secrets: { ...secrets, environment: {} } });

    expect(placement.machineBound).toEqual([]);
  });

  it("reads a name the organisation published as the organisation's, whatever this disk also holds", () => {
    // The two namespaces are distinct (EO-328) and they point in
    // opposite directions, so a name in both is decided rather than
    // counted twice: the organisation's value is the one a run would be
    // handed.
    writePolicy(handle.db, { ...NO_POLICY, secretNames: ["FLY_API_TOKEN"], publishedAt: 1 });
    storeSecret(secrets, "FLY_API_TOKEN", "tok-1");
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placement.machineBound).toEqual([]);
    expect(placement.serverBound).toHaveLength(1);
  });

  it("says nothing about a name nobody has set anywhere", () => {
    // A module declaring a need nothing satisfies is a run that will
    // refuse at preflight, on either machine. Placement is about where
    // work can happen, not about whether it would succeed there.
    moduleStep(["NOBODY_SET_THIS"]);

    expect(placementForJob(handle.db, job(), facts({ fake: "api_key" }))).toMatchObject({ machineBound: [], serverBound: [] });
  });
});

describe("a step that is served an MCP server", () => {
  it("greys the organisation server for one only this machine has", () => {
    serverOn("reports");

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placement.machineBound).toMatchObject([{ kind: "local-mcp-server", subject: "reports", stepName: "To Do" }]);
  });

  it("says nothing about one the organisation published and this machine serves", () => {
    const id = serverOn("reports");
    writePolicy(handle.db, {
      ...NO_POLICY,
      mcpServers: [{ id, name: "reports", description: "", config: { transport: "stdio", command: "npx", args: [] }, envNames: [] }],
      publishedAt: 1,
    });

    expect(placementForJob(handle.db, job(), facts({ fake: "api_key" }))).toMatchObject({ machineBound: [], serverBound: [] });
  });

  it("greys this machine for one the organisation publishes and this machine is not serving", () => {
    // Switched off here is this machine's business (ARCHITECTURE.md, "Publish, lock and versions")
    // — and it is
    // exactly what makes the server the only place the step would be
    // served at all.
    const id = serverOn("reports");
    writePolicy(handle.db, {
      ...NO_POLICY,
      mcpServers: [{ id, name: "reports", description: "", config: { transport: "stdio", command: "npx", args: [] }, envNames: [] }],
      publishedAt: 1,
    });
    setMcpServerEnabled(handle.db, id, false);

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placement.serverBound).toMatchObject([{ kind: "organisation-mcp-server", subject: "reports" }]);
    expect(placementAllows(placement, "device")).toBe(false);
  });
});

describe("a step that works on a disk", () => {
  it("greys the organisation server, and names the folder so the reason reads on sight", () => {
    const workspace = createWorkspace(handle.db, { config: { name: "eo", repoPath: "/home/anna/eo" } });
    createStep(handle.db, { pipelineId: "default" as Uuid, position: 91, name: "Build", workspaceId: workspace.id });

    const placement = placementForJob(handle.db, job(), facts({ fake: "api_key" }));

    expect(placement.machineBound).toMatchObject([{ kind: "local-workspace", subject: "eo", stepName: "Build" }]);
    expect(placement.machineBound[0]!.line).toContain("/home/anna/eo");
  });

  it("says nothing about a step that asked for no disk, or for one the run makes itself", () => {
    const scratch = createWorkspace(handle.db, { kind: SCRATCH_KIND });
    createStep(handle.db, { pipelineId: "default" as Uuid, position: 92, name: "Collect", workspaceId: NO_WORKSPACE });
    createStep(handle.db, { pipelineId: "default" as Uuid, position: 93, name: "Render", workspaceId: scratch.id });

    expect(placementForJob(handle.db, job(), facts({ fake: "api_key" })).machineBound).toEqual([]);
  });

  it("inherits the project's repository for a step that named none", () => {
    // `inherit` is what every step said before a step could pick at all,
    // so a job in a project with a repository attached is a job whose
    // steps all work on somebody's disk.
    const project = createProject(handle.db, { name: "Reports", keyPrefix: "REP" });
    createWorkspace(handle.db, { projectId: project.id, config: { name: "eo", repoPath: "/home/anna/eo" } });

    const placement = placementForJob(handle.db, job({ projectId: project.id }), facts({ fake: "api_key" }));

    // One per agent step that inherited it, which is what the screen
    // draws: the reason belongs to the step, not to the workspace.
    expect(placement.machineBound.every((reason) => reason.kind === "local-workspace")).toBe(true);
    expect(placement.machineBound.map((reason) => reason.stepName)).toContain("To Do");
  });
});

describe("a job with reasons in both directions", () => {
  it("is stranded rather than placed, and says both", () => {
    updateAgent(handle.db, implementerId(), { provider: "codex" });
    writePolicy(handle.db, { ...NO_POLICY, secretNames: ["FLY_API_TOKEN"], publishedAt: 1 });
    moduleStep(["FLY_API_TOKEN"]);

    const placement = placementForJob(handle.db, job(), facts({ codex: "subscription" }));

    expect(placementAllows(placement, "device")).toBe(false);
    expect(placementAllows(placement, "server")).toBe(false);
  });
});

describe("where a row that predates the column says it runs", () => {
  it("is this machine, which is where every job has always run", () => {
    expect(runsOnOf(job())).toBe("device");
    expect(runsOnOf({ runsOn: "server" })).toBe("server");
    // The walk reports what the job asks for, so a screen drawing the
    // reasons and the control reads one answer rather than two.
    expect(placementForJob(handle.db, { ...job(), runsOn: "server" }, facts()).runsOn).toBe("server");
  });
});

/** The seeded graph these walks assume, so a change to it fails here rather than mysteriously. */
describe("the pipeline being walked", () => {
  it("has an agent step called 'To do' staffed by the implementer", () => {
    const steps = listStepsForPipeline(handle.db, "default" as Uuid);

    expect(steps.find((step) => step.ownerRole === "implementer")?.name).toBe("To Do");
  });
});
