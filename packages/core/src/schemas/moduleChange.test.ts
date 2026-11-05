import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AssistOutputSchema } from "./assist.js";
import { AssistModuleChangeSchema, ModuleChangeSchema } from "./moduleChange.js";
import { ModuleManifestSchema } from "./modules.js";
import { ScenarioModuleChangeSchema, ScenarioOutputSchema } from "./scenario.js";

/**
 * The one change shape both chats return (EO-418): a module's whole code
 * and, when the change needs it, its whole manifest.
 */

const manifest = {
  name: "Deploy",
  description: "Deploys the release.",
  needs: { bin: ["aws"], env: ["DEPLOY_TOKEN"], network: true },
  results: ["deployed"],
};
const code = "export default async () => ({ ok: true, result: 'deployed' });";
const question = { id: "which", question: "Which stage?", why: "It decides the default.", options: ["prod", "staging"] };

describe("ModuleChangeSchema", () => {
  it("is the scenario chat's change, under the name that room calls it by", () => {
    expect(ScenarioModuleChangeSchema).toBe(ModuleChangeSchema);
  });

  it("reads an absent manifest and a null one as the same thing: leave the manifest as it is", () => {
    expect(ModuleChangeSchema.parse({ summary: "Fixes it.", code })).toEqual({ summary: "Fixes it.", code, manifest: null });
    expect(ModuleChangeSchema.parse({ summary: "Fixes it.", code, manifest: null }).manifest).toBeNull();
  });

  it("carries the whole manifest, defaults filled in, when the change has one", () => {
    const parsed = ModuleChangeSchema.parse({ summary: "Drops two variables.", code, manifest });
    expect(parsed.manifest).toEqual(ModuleManifestSchema.parse(manifest));
    expect(parsed.manifest).toMatchObject({ needs: { env: ["DEPLOY_TOKEN"], item: false, comment: false, attach: false, create: false }, inputs: {} });
  });

  it("refuses a fragment of code and a change with no summary", () => {
    expect(ModuleChangeSchema.safeParse({ summary: "x", code: "" }).success).toBe(false);
    expect(ModuleChangeSchema.safeParse({ summary: "", code }).success).toBe(false);
  });

  // Decided on EO-418: a manifest that fails validation fails the reply,
  // so the turn goes back to the agent that wrote it with the reason. It
  // is not let through to be turned away in the thread.
  it("holds the manifest to the manifest schema, whole: a broken rule, a broken shape and a malformed nested value alike", () => {
    const broken: [unknown, string][] = [
      [{ ...manifest, results: [] }, "results"],
      [{ ...manifest, name: "" }, "name"],
      [{ ...manifest, results: "deployed" }, "results"],
      [{ name: "Deploy" }, "description"],
      [{ ...manifest, needs: "aws" }, "needs"],
      // Nested: an input that is not a module input, an environment variable that is not a name.
      [{ ...manifest, inputs: { stage: { type: "date" } } }, "inputs.stage.type"],
      [{ ...manifest, inputs: { stage: "prod" } }, "inputs.stage"],
      [{ ...manifest, needs: { ...manifest.needs, env: ["FLY-API-TOKEN"] } }, "needs.env.0"],
      [{ ...manifest, needs: { ...manifest.needs, bin: [""] } }, "needs.bin.0"],
      ["the same as before", ""],
      [[manifest], ""],
    ];
    for (const [value, where] of broken) {
      expect(ModuleManifestSchema.safeParse(value).success).toBe(false);
      const parsed = ModuleChangeSchema.safeParse({ summary: "x", code, manifest: value });
      expect(parsed.success, JSON.stringify(value)).toBe(false);
      expect(!parsed.success && parsed.error.issues.map((issue) => issue.path.join("."))).toContain(where === "" ? "manifest" : `manifest.${where}`);
    }
  });

  it("is described to a provider, inside both chats' output schemas, exactly as a manifest is", () => {
    const real = described(ModuleManifestSchema);
    for (const output of [AssistOutputSchema, ScenarioOutputSchema]) {
      const json = z.toJSONSchema(output, { io: "input" }) as unknown as { properties: { change: { anyOf: { properties?: { manifest: { anyOf: unknown[] } } }[] } } };
      const change = json.properties.change.anyOf.find((branch) => branch.properties !== undefined)!;
      expect(change.properties!.manifest.anyOf).toContainEqual(real);
      expect(change.properties!.manifest.anyOf).toContainEqual({ type: "null" });
    }
  });
});

/** A schema as a provider is handed it, without the dialect line a nested schema does not carry. */
function described(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema, { io: "input" })).filter(([key]) => key !== "$schema"));
}

describe("a change in the help chat's output", () => {
  it("names its module by id and may list test cases, which default to none", () => {
    const parsed = AssistOutputSchema.parse({ message: "Here.", change: { moduleId: "mod-1", summary: "Fixes it.", code } });
    expect(parsed.change).toEqual({ moduleId: "mod-1", summary: "Fixes it.", code, manifest: null, tests: [], removeTests: [] });

    const withTests = AssistModuleChangeSchema.parse({ moduleId: "mod-1", summary: "x", code, manifest, tests: [{ description: " deploys ", source: "export default async function () {}" }] });
    expect(withTests.tests).toEqual([{ description: "deploys", source: "export default async function () {}" }]);
    expect(AssistModuleChangeSchema.safeParse({ summary: "x", code }).success).toBe(false);
    expect(AssistModuleChangeSchema.safeParse({ moduleId: "mod-1", summary: "x", code, tests: [{ description: "", source: "x" }] }).success).toBe(false);
  });

  it("may list case ids to remove, defaulting to none, so a change can be removals alone (EO-499)", () => {
    const removals = AssistModuleChangeSchema.parse({ moduleId: "mod-1", summary: "Drops a case.", code, manifest: null, removeTests: ["case-1", "case-2"] });
    expect(removals).toEqual({ moduleId: "mod-1", summary: "Drops a case.", code, manifest: null, tests: [], removeTests: ["case-1", "case-2"] });
    expect(AssistModuleChangeSchema.parse({ moduleId: "mod-1", summary: "x", code }).removeTests).toEqual([]);
    expect(AssistModuleChangeSchema.safeParse({ moduleId: "mod-1", summary: "x", code, removeTests: [""] }).success).toBe(false);
    // The scenario chat's change has no such field: it never removes a case through a card.
    expect(ModuleChangeSchema.parse({ summary: "x", code, removeTests: ["case-1"] })).not.toHaveProperty("removeTests");
  });

  it("is null on a turn that carries none, whether the key is left out or written as null", () => {
    expect(AssistOutputSchema.parse({ message: "Hello." }).change).toBeNull();
    expect(AssistOutputSchema.parse({ message: "Hello.", change: null }).change).toBeNull();
  });

  it("is refused beside questions, in both chats", () => {
    const change = { summary: "Fixes it.", code, manifest };
    expect(AssistOutputSchema.safeParse({ message: "Here.", questions: [question], change: { ...change, moduleId: "mod-1" } }).success).toBe(false);
    expect(AssistOutputSchema.safeParse({ message: "Here.", questions: [question] }).success).toBe(true);
    expect(ScenarioOutputSchema.safeParse({ message: "Here.", questions: [question], change }).success).toBe(false);
    expect(ScenarioOutputSchema.safeParse({ message: "Here.", questions: [question] }).success).toBe(true);
    expect(ScenarioOutputSchema.safeParse({ message: "Here.", change }).success).toBe(true);
  });

  it("comes on its own: refused beside a draft or beside modules, with the reason", () => {
    const change = { moduleId: "mod-1", summary: "Fixes it.", code };
    const module = { name: "Tag", slug: "tag", description: "Tags.", code, manifest, why: "A script.", tests: [{ description: "tags", source: "export default async function () {}" }] };
    const beside = AssistOutputSchema.safeParse({ message: "Here.", change, modules: [module] });
    expect(beside.success).toBe(false);
    expect(!beside.success && beside.error.issues[0]?.message).toContain("comes on its own");
    expect(AssistOutputSchema.safeParse({ message: "Here.", change, modules: [] }).success).toBe(true);
  });
});
