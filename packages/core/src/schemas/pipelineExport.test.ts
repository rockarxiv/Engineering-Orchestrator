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
    expect(neverGivesUp.eoPipelineExport).toBe(14);
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
    expect(pinned.eoPipelineExport).toBe(14);
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
    const { moduleVersion: _step, ...unpinnedStep } = step;
    const { version: _module, ...unpinnedModule } = module;
    const parsed = PipelineExportSchema.parse(document({ eoPipelineExport: 13, steps: [unpinnedStep], modules: [unpinnedModule] }));
    expect(parsed.steps[0]?.moduleVersion).toBeUndefined();
    expect(parsed.modules[0]?.version).toBeNull();
  });
});
