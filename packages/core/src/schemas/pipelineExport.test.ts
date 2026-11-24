import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ADMIN_GRANT_REFUSAL, ExportedModuleSchema, ExportedStepSchema, PIPELINE_EXPORT_VERSION, PipelineExportSchema } from "./pipelineExport.js";

/**
 * The pack format and its gate (EO-314, `ARCHITECTURE.md`, "One document",
 * "The `eo_admin` grant").
 *
 * The gate is in the schema rather than beside it, because this is the
 * one place every reader of a pack goes through: a check in the importer
 * would leave the preflight, a gallery install and anything else that
 * parses a document each needing to remember.
 */
function document(overrides: Record<string, unknown> = {}) {
  return {
    eoPipelineExport: PIPELINE_EXPORT_VERSION,
    pipeline: { name: "Triage", icon: null, entryStepId: "triage" },
    steps: [{ id: "triage", position: 0, name: "Triage", type: "agent", ownerRole: "triager", entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false }],
    routes: [],
    ...overrides,
  };
}

describe("a pack's shape", () => {
  /**
   * Every field the pack added is defaulted, so a document written
   * before them parses as a pack that ships none of them — which is what
   * it is.
   */
  it("reads a document that carries none of the pack's fields", () => {
    const parsed = PipelineExportSchema.parse(document({ eoPipelineExport: 1 }));

    expect(parsed.itemTypes).toEqual([]);
    expect(parsed.roles).toEqual([]);
    expect(parsed.connectors).toEqual([]);
    expect(parsed.vocabulary).toEqual({ types: [], results: [] });
    expect(parsed.previewItem).toBeNull();
  });

  /** A role that says nothing about tools is not a role that forbids them. */
  it("keeps an absent tool surface distinct from an empty one", () => {
    const absent = PipelineExportSchema.parse(document({ roles: [{ slug: "triager", prompt: "Go." }] }));
    const empty = PipelineExportSchema.parse(document({ roles: [{ slug: "triager", prompt: "Go.", allowedTools: [] }] }));

    expect(absent.roles[0]?.allowedTools).toBeNull();
    expect(empty.roles[0]?.allowedTools).toEqual([]);
  });

  /**
   * A role's own action definitions travel whole (EO-424), and a role
   * written before they did is a role that carries none.
   */
  it("carries a role's action definitions, and none where the document has none", () => {
    const sort = {
      action: "sort",
      description: "Decide which queue it belongs in.",
      results: [{ key: "urgent", label: "Needs someone now", meaning: "A customer is blocked." }],
      fields: { type: "object", properties: { queue: { type: "string" } }, required: ["queue"] },
    };
    const parsed = PipelineExportSchema.parse(document({ roles: [{ slug: "triager", prompt: "Go.", actions: [sort] }, { slug: "writer", prompt: "Go.", schemasByAction: { write: {} } }] }));

    expect(parsed.roles[0]?.actions).toEqual([sort]);
    expect(parsed.roles[1]?.actions).toEqual([]);
    expect(parsed.roles[1]?.schemasByAction).toEqual({ write: {} });
  });

  /** A role nobody is in carries no prompt, which is not the same as an empty one. */
  it("reads a role with no prompt as a role with no agent behind it", () => {
    const parsed = PipelineExportSchema.parse(document({ roles: [{ slug: "triager", prompt: null }, { slug: "writer", prompt: "" }] }));

    expect(parsed.roles.map((role) => role.prompt)).toEqual([null, ""]);
  });

  /** A JSON Schema document is carried as written, `false` included. */
  it("carries a role's output schemas as JSON Schema", () => {
    const shape = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    const parsed = PipelineExportSchema.parse(document({ roles: [{ slug: "triager", prompt: "Go.", schemasByAction: { review: shape, never: false } }] }));

    expect(parsed.roles[0]?.schemasByAction).toEqual({ review: shape, never: false });
  });
});

describe("the admin grant", () => {
  /**
   * Refused, not stripped (invariant #11). Stripping would import a pack
   * that quietly does less than it says — a prompt telling an agent to
   * reconfigure the installation, with the tools to do it silently
   * removed — and leave nobody to notice.
   */
  it("refuses a document whose role names it, in any spelling", () => {
    // Claude's, the whole-server grant, the bare name, and Codex's —
    // which is `${server}/${tool}` (EO-198). One grant; a schema that
    // read only the first would refuse a pack on one backend and parse
    // it on the other (invariant #12).
    for (const grant of ["mcp__eo_admin__pipeline_save", "mcp__eo_admin", "eo_admin", "eo_admin/pipeline_save"]) {
      const parsed = PipelineExportSchema.safeParse(document({ roles: [{ slug: "triager", prompt: "Go.", allowedTools: ["mcp__eo__item_detail", grant] }] }));

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain(ADMIN_GRANT_REFUSAL);
      // The document does not come back with the entry removed: there is
      // no document.
      expect(parsed.data).toBeUndefined();
    }
  });

  it("says nothing about a role granted EO's ordinary server", () => {
    const parsed = PipelineExportSchema.safeParse(document({ roles: [{ slug: "triager", prompt: "Go.", allowedTools: ["mcp__eo__item_detail", "mcp__eo__comment"] }] }));

    expect(parsed.success).toBe(true);
  });
});

/**
 * Format 10 (EO-571): a step's watch can say it never gives up.
 *
 * What makes the version bump work is that a build that predates the
 * flag still *parses* the document, so it reaches its format check and
 * says "Update EO and try again" — rather than calling the file damaged,
 * or importing the step with the week its hours say.
 */
describe("a watch that never gives up, in a document", () => {
  const neverGivesUp = document({
    steps: [
      {
        id: "watch",
        position: 0,
        name: "Watching",
        type: "builtin",
        ownerRole: null,
        entryAction: "watch_pull_request",
        instructionsSummary: null,
        isTerminal: false,
        planMode: false,
        watch: { everyMinutes: 5, neverGivesUp: true },
      },
    ],
  });

  it("parses under the watch a version-9 build reads, so that build reaches its format check and refuses it there", () => {
    expect(neverGivesUp.eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
    // `StepWatchSchema` as format 9 had it.
    const version9Watch = z.object({ everyMinutes: z.number().finite(), giveUpAfterHours: z.number().finite().default(168) });
    const watch = (JSON.parse(JSON.stringify(neverGivesUp)) as { steps: { watch: unknown }[] }).steps[0]!.watch;
    expect(version9Watch.safeParse(watch).success).toBe(true);
  });

  it("reads back unchanged through JSON", () => {
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(neverGivesUp)));
    expect(parsed.steps[0]?.watch).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
    expect(PipelineExportSchema.parse(JSON.parse(JSON.stringify(parsed))).steps[0]?.watch).toEqual(parsed.steps[0]?.watch);
  });
});

/**
 * Format 14 (EO-772): a module step and a module entry rule carry the
 * version they pin, and each module entry is that version.
 *
 * Bumped for format 10's reason, and held by the same test: a build that
 * predates the pin still *parses* the document — its step and module
 * schemas strip the two keys rather than refusing them — so it reaches
 * its format check and says "Update EO and try again" instead of calling
 * the file damaged or importing the module's code as if no version had
 * been pinned.
 */
describe("a pinned module version, in a document", () => {
  const module = {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys.",
    code: "export default async function run() { return { ok: true, result: 'deployed', detail: '' }; }",
    manifest: { name: "Deploy", description: "Deploys.", inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: ["deployed"] },
    originalScript: null,
    tests: [],
    version: 2,
  };
  const step = { id: "deploy", position: 0, name: "Deploy", type: "module", ownerRole: null, entryAction: "deploy", moduleVersion: 2, instructionsSummary: null, isTerminal: true, planMode: false };
  const pinned = document({
    pipeline: { name: "Shipping", icon: null, entryStepId: "deploy", entryRules: [{ kind: "module", module: "deploy", moduleVersion: 2 }] },
    steps: [step],
    modules: [module],
  });

  it("parses under the step and module schemas a version-13 build reads, so that build reaches its format check and refuses it there", () => {
    expect(pinned.eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
    const version13Step = ExportedStepSchema.omit({ moduleVersion: true });
    const version13Module = ExportedModuleSchema.omit({ version: true });
    expect(version13Step.safeParse(step).success).toBe(true);
    expect(version13Module.safeParse(module).success).toBe(true);
  });

  it("reads back the pins unchanged", () => {
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(pinned)));
    expect(parsed.steps[0]?.moduleVersion).toBe(2);
    expect(parsed.modules[0]?.version).toBe(2);
    expect(parsed.pipeline.entryRules[0]?.moduleVersion).toBe(2);
  });

  it("reads a format-13 document as pinning nothing", () => {
    const unpinnedStep: Record<string, unknown> = { ...step };
    delete unpinnedStep["moduleVersion"];
    const unpinnedModule: Record<string, unknown> = { ...module };
    delete unpinnedModule["version"];
    const parsed = PipelineExportSchema.parse(document({ eoPipelineExport: 13, steps: [unpinnedStep], modules: [unpinnedModule] }));
    expect(parsed.steps[0]?.moduleVersion).toBeUndefined();
    expect(parsed.modules[0]?.version).toBeNull();
  });
});

/**
 * Format 15 (EO-827): a person step may carry the brief its decision shows
 * behind "Show details". A version-14 build drops the key rather than
 * refusing it, so it parses the document and refuses it at its format
 * check instead of importing the step with the default brief.
 */
describe("a person step's brief, in a document", () => {
  const brief = [
    { show: "output", step: "triage" },
    { show: "comment", kind: "approval", role: "reviewer" },
    { show: "field", field: "acceptance_criteria" },
  ];
  const approve = { id: "approve", position: 1, name: "Approve", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false, brief };

  it("parses under the step schema a version-14 build reads, so that build reaches its format check", () => {
    expect(PIPELINE_EXPORT_VERSION).toBeGreaterThanOrEqual(15);
    expect(ExportedStepSchema.omit({ brief: true }).safeParse(approve).success).toBe(true);
  });

  it("reads the brief back unchanged, and a step without one as declaring none", () => {
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(document({ steps: [document().steps[0], approve] }))));
    expect(parsed.steps[1]?.brief).toEqual(brief);
    expect(parsed.steps[0]).not.toHaveProperty("brief");
  });

  it("refuses a part it cannot read", () => {
    expect(PipelineExportSchema.safeParse(document({ steps: [{ ...approve, brief: [{ show: "mood" }] }] })).success).toBe(false);
  });
});

/**
 * Format 16 (EO-877): a step names the kind of the agent it ran, and an
 * import binds that kind to one of the importing project's agents. The
 * shape is format 15's, so a version-15 build parses the document and
 * refuses it at its format check; a document of any earlier format still
 * reads, its `ownerRole` as the kind.
 */
describe("a step's kind, in a document", () => {
  it("parses under the step schema a version-15 build reads, so that build reaches its format check", () => {
    expect(PIPELINE_EXPORT_VERSION).toBeGreaterThanOrEqual(16);
    // No key was added: the step a version-15 build reads is this one.
    expect(ExportedStepSchema.safeParse(document().steps[0]).success).toBe(true);
    expect(PipelineExportSchema.parse(document()).eoPipelineExport).toBe(PIPELINE_EXPORT_VERSION);
  });

  it("carries a kind and never an agent's id", () => {
    const parsed = PipelineExportSchema.parse(document({ steps: [{ ...document().steps[0], agentId: "01900000-0000-7000-8000-000000000001" }] }));
    expect(parsed.steps[0]?.ownerRole).toBe("triager");
    expect(parsed.steps[0]).not.toHaveProperty("agentId");
  });

  it.each([1, 13, 15])("reads a format-%i document's ownerRole as the kind", (format) => {
    expect(PipelineExportSchema.parse(document({ eoPipelineExport: format })).steps[0]?.ownerRole).toBe("triager");
  });
});

/**
 * Format 17 (EO-843): an agent step may carry a report-only team, staffed
 * by role. A version-16 build drops the key rather than refusing it, so it
 * parses the document and refuses it at its format check instead of
 * importing the step as one agent.
 */
describe("an agent step's team, in a document", () => {
  const team = {
    coordination: "independent",
    participants: [
      { key: "security", role: "reviewer", instructions: "Look for injection and auth gaps." },
      { key: "tests", role: "tester", instructions: "Check the tests cover the criteria.", required: false },
    ],
    outcomes: [
      { key: "clear", label: "Clear" },
      { key: "concerns", label: "Concerns" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  };
  const review = { id: "review", position: 1, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "check", instructionsSummary: null, isTerminal: true, planMode: false, team };

  it("parses under the step schema a version-16 build reads, so that build reaches its format check", () => {
    expect(PIPELINE_EXPORT_VERSION).toBeGreaterThanOrEqual(17);
    expect(ExportedStepSchema.omit({ team: true }).safeParse(review).success).toBe(true);
  });

  it("carries a team's member mode (EO-867): isolated read back as written, and a team that names none as report-only", () => {
    const isolated = { ...review, team: { ...team, members: "isolated" } };
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(document({ steps: [document().steps[0], isolated] }))));
    expect(parsed.steps[1]?.team?.members).toBe("isolated");
    expect(PipelineExportSchema.parse(JSON.parse(JSON.stringify(parsed))).steps[1]?.team?.members).toBe("isolated");
    expect(PipelineExportSchema.parse(JSON.parse(JSON.stringify(document({ steps: [document().steps[0], review] })))).steps[1]?.team?.members).toBe("report_only");
  });

  it("reads the team back unchanged through JSON, with its limits filled in, and a step without one as one agent", () => {
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(document({ steps: [document().steps[0], review] }))));
    expect(parsed.steps[1]?.team).toMatchObject({ ...team, limits: { maxParticipants: 4, maxParallel: 2, maxRetries: 1 } });
    expect(PipelineExportSchema.parse(JSON.parse(JSON.stringify(parsed))).steps[1]?.team).toEqual(parsed.steps[1]?.team);
    expect(parsed.steps[0]).not.toHaveProperty("team");
  });

  it("refuses a team naming an agent rather than a role, or granting a participant tools", () => {
    const withAgent = { ...team, participants: [{ ...team.participants[0], agentId: "019f0000-0000-7000-8000-000000000001" }] };
    const withTools = { ...team, participants: [{ ...team.participants[0], allowedTools: ["Bash"] }] };
    expect(PipelineExportSchema.safeParse(document({ steps: [{ ...review, team: withAgent }] })).success).toBe(false);
    expect(PipelineExportSchema.safeParse(document({ steps: [{ ...review, team: withTools }] })).success).toBe(false);
  });
});

/**
 * Format 18 (EO-885): a step's team is the declared team it runs as, its
 * agents by kind and instructions and never by id. A version-17 build
 * cannot read that team, so the number refuses it at the format check;
 * a format-17 document's role-staffed team still reads.
 */
describe("a declared team, in a document", () => {
  const declared = {
    coordination: "leader",
    name: "Reviewers",
    memberMode: "isolated",
    toolPool: { cliTools: ["git"], mcpServers: ["repo"], skills: [] },
    modelRange: { runtimes: ["claude", "codex"], models: [], reasoning: ["high"] },
    memberCap: 6,
    leader: { name: "Lead", kind: "reviewer", instructions: "You review.", teamInstructions: "Assign criteria to Criteria and tests to Tests." },
    members: [
      { name: "Criteria", kind: "reviewer", instructions: "Check each criterion." },
      { name: "Tests", kind: "reviewer", instructions: "Check the tests." },
    ],
    limits: { maxRounds: 2 },
  };
  const review = { id: "review", position: 1, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: true, planMode: false, team: declared };

  it("is the newest format", () => {
    expect(PIPELINE_EXPORT_VERSION).toBe(18);
  });

  it("reads back through JSON unchanged, naming no agent id", () => {
    const parsed = PipelineExportSchema.parse(JSON.parse(JSON.stringify(document({ steps: [document().steps[0], review] }))));
    const team = parsed.steps[1]?.team;
    expect(team).toMatchObject(declared);
    expect(PipelineExportSchema.parse(JSON.parse(JSON.stringify(parsed))).steps[1]?.team).toEqual(team);
    expect(JSON.stringify(team)).not.toContain("agentId");
  });

  it("refuses eo_admin in the pool, an agent id on a member, and two agents of one name that differ", () => {
    const admin = { ...declared, toolPool: { ...declared.toolPool, mcpServers: ["eo_admin"] } };
    const withId = { ...declared, members: [{ ...declared.members[0], agentId: "019f0000-0000-7000-8000-000000000001" }] };
    const twins = { ...declared, members: [...declared.members, { name: "criteria", kind: "reviewer", instructions: "Something else." }] };
    for (const team of [admin, withId, twins]) expect(PipelineExportSchema.safeParse(document({ steps: [{ ...review, team }] })).success).toBe(false);
  });

  it("refuses more members than the team's cap", () => {
    const over = { ...declared, memberCap: 1 };
    expect(PipelineExportSchema.safeParse(document({ steps: [{ ...review, team: over }] })).success).toBe(false);
  });

  it("still reads a format-17 document's role-staffed team", () => {
    const team = { coordination: "leader", members: "isolated", leader: { role: "reviewer", instructions: "Split the review." }, roles: ["reviewer"] };
    const parsed = PipelineExportSchema.parse(document({ eoPipelineExport: 17, steps: [document().steps[0], { ...review, team }] }));
    expect(parsed.steps[1]?.team).toMatchObject(team);
  });
});
