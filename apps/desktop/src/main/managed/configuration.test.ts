import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModuleViewSchema, SectionDocumentSchema, type ModuleManifest, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { addModuleTests, createAgent, deleteAgent, deleteModuleTest, getAgent, getModule, getSkill, getSkillBySlug, listModuleTests, saveModule, saveSkill, setSkillLocked } from "../db/repos/index.js";
import { listAgentDetails } from "../ipc/configCommands.js";
import { applySectionDocument, sectionDocument } from "./configuration.js";
import { listHeldSkillCopies, releaseHeldSkillCopies } from "../db/repos/skillsRepo.js";

/**
 * A deleted agent, published (EO-350).
 *
 * The tombstone has to arrive as a tombstone. Carried as an ordinary
 * archived agent it would land on every other desktop under "Show
 * archived" — the one place deleting it was meant to take it out of.
 */
describe("publishing a deleted agent", () => {
  let publisher: DbHandle;
  let replica: DbHandle;

  beforeEach(() => {
    publisher = openMigratedTestDb();
    replica = openMigratedTestDb();
  });

  afterEach(() => {
    publisher.close();
    replica.close();
  });

  it("carries the deletion, so a replica seeing the agent for the first time keeps it off its Agents screen", () => {
    const agent = createAgent(publisher.db, { name: "Doomed", role: "tester", provider: "fake", instructions: "Test it." });
    deleteAgent(publisher.db, agent.id, 42);

    const document = sectionDocument(publisher.db, "agents");
    expect(document?.agents.find((entry) => entry.id === agent.id)?.deletedAt).toBe(42);

    applySectionDocument(replica.db, document);

    expect(getAgent(replica.db, agent.id)).toMatchObject({ name: "Doomed", role: "tester", instructions: "", enabled: false, deletedAt: 42 });
    expect(listAgentDetails(replica.db).agents.some((entry) => entry.id === agent.id)).toBe(false);
  });

  it("turns a replica's existing copy into a tombstone, local backend and model included", () => {
    const agent = createAgent(publisher.db, { name: "Doomed", role: "tester", provider: "fake", instructions: "Test it." });
    applySectionDocument(replica.db, sectionDocument(publisher.db, "agents"));
    expect(listAgentDetails(replica.db).agents.some((entry) => entry.id === agent.id)).toBe(true);

    deleteAgent(publisher.db, agent.id as Uuid, 42);
    applySectionDocument(replica.db, sectionDocument(publisher.db, "agents"));

    expect(getAgent(replica.db, agent.id)).toMatchObject({ provider: "", model: null, instructions: "", config: {}, deletedAt: 42 });
    expect(listAgentDetails(replica.db).agents.some((entry) => entry.id === agent.id)).toBe(false);
  });
});

/**
 * A pipelines section across the EO-353 upgrade.
 *
 * The module view and the database lost `dryRunAt`; the document a
 * section publishes did not, because a desktop from before the change
 * parses it with a module schema that requires the field — and fails the
 * whole record pull when it is missing. Organisations upgrade one desktop
 * at a time, so both directions have to parse.
 */
describe("publishing modules across the dry-run removal", () => {
  const manifest: ModuleManifest = {
    name: "Deploy",
    description: "Deploys the branch.",
    inputs: {},
    needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
    results: ["deployed"],
  };

  /**
   * The module entry as a desktop from before EO-353 parses it: the
   * module view of that release, which had `dryRunAt` and required it,
   * minus what the section omits. Written out rather than derived from
   * today's document schema, so a change there cannot quietly make this
   * agree with it.
   */
  const OlderSectionDocument = z.object({
    modules: z.array(
      ModuleViewSchema.omit({ usedByStepCount: true, portability: true, machineSpecific: true, testRun: true, testsStale: true, testCount: true }).extend({ dryRunAt: z.number().nullable() }),
    ),
  });

  let publisher: DbHandle;
  let replica: DbHandle;

  beforeEach(() => {
    publisher = openMigratedTestDb();
    replica = openMigratedTestDb();
  });

  afterEach(() => {
    publisher.close();
    replica.close();
  });

  it("publishes a document a desktop from before the change can still parse", () => {
    const saved = saveModule(publisher.db, { slug: "deploy", name: "Deploy", description: "Deploys the branch.", code: "export default async () => ({ ok: true, result: 'deployed' });", manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);

    // Through JSON, as a publication travels.
    const published: unknown = JSON.parse(JSON.stringify(sectionDocument(publisher.db, "pipelines")));
    const older = OlderSectionDocument.safeParse(published);

    expect(older.success).toBe(true);
    expect(older.data?.modules).toEqual([expect.objectContaining({ id: saved.module.id, dryRunAt: null, approvedAt: saved.module.approvedAt })]);
  });

  it("applies a document published before the change, dry-run mark and all, keeping the approval", () => {
    const saved = saveModule(publisher.db, { slug: "deploy", name: "Deploy", description: "Deploys the branch.", code: "export default async () => ({ ok: true, result: 'deployed' });", manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);
    // What an older desktop published: its module, with the mark it
    // recorded. A stored module is exactly the section's fields bar that one.
    const older = { modules: [{ ...saved.module, dryRunAt: 1_700_000_000_000 }] };

    const document = SectionDocumentSchema.parse(JSON.parse(JSON.stringify(older)));
    applySectionDocument(replica.db, document);

    expect(getModule(replica.db, saved.module.id)).toMatchObject({ slug: "deploy", approvedAt: saved.module.approvedAt });
    expect(getModule(replica.db, saved.module.id)).not.toHaveProperty("dryRunAt");
  });
});

/**
 * A module arriving from an organisation brings its test cases (EO-355).
 *
 * Approving a module runs them, so a replica that received the code
 * without them would hold a module nobody there could approve again.
 */
describe("publishing a module's test cases", () => {
  const manifest: ModuleManifest = {
    name: "Deploy",
    description: "Deploys the branch.",
    inputs: {},
    needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
    results: ["deployed"],
  };
  const code = "export default async () => ({ ok: true, result: 'deployed' });";

  let publisher: DbHandle;
  let replica: DbHandle;

  beforeEach(() => {
    publisher = openMigratedTestDb();
    replica = openMigratedTestDb();
  });

  afterEach(() => {
    publisher.close();
    replica.close();
  });

  function published() {
    const saved = saveModule(publisher.db, { slug: "deploy", name: "Deploy", description: "Deploys the branch.", code, manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);
    const cases = addModuleTests(publisher.db, saved.module.id, [
      { description: "deploys", source: "export default async function (h) { await h.run(); }" },
      { description: "deploys again", source: "export default async function (h) { await h.run(); await h.run(); }" },
    ]).map((each) => {
      if (!each.ok) throw new Error(each.reason);
      return each.test;
    });
    return { module: saved.module, cases };
  }

  /** Through JSON, as a publication travels. */
  const travelled = (document: unknown) => SectionDocumentSchema.parse(JSON.parse(JSON.stringify(document)));

  it("carries the cases, and a replica applying it has them with the record's ids", () => {
    const { module, cases } = published();

    applySectionDocument(replica.db, travelled(sectionDocument(publisher.db, "pipelines")));

    expect(listModuleTests(replica.db, module.id)).toEqual(cases);
  });

  it("applies the same publication twice to the same cases, and drops one the organisation deleted", () => {
    const { module, cases } = published();
    applySectionDocument(replica.db, travelled(sectionDocument(publisher.db, "pipelines")));
    applySectionDocument(replica.db, travelled(sectionDocument(publisher.db, "pipelines")));
    expect(listModuleTests(replica.db, module.id)).toHaveLength(2);

    deleteModuleTest(publisher.db, cases[1]!.id);
    applySectionDocument(replica.db, travelled(sectionDocument(publisher.db, "pipelines")));
    expect(listModuleTests(replica.db, module.id).map((test) => test.description)).toEqual(["deploys"]);
  });

  it("leaves a replica's cases alone when a publication from before tests travelled is applied", () => {
    const { module } = published();
    applySectionDocument(replica.db, travelled(sectionDocument(publisher.db, "pipelines")));

    // What an older desktop published: the module and no `tests` field.
    const older = travelled(sectionDocument(publisher.db, "pipelines"));
    const withoutTests = { modules: older.modules.map(({ tests: _tests, ...rest }) => rest) };
    applySectionDocument(replica.db, travelled(withoutTests));

    expect(listModuleTests(replica.db, module.id)).toHaveLength(2);
  });
});

/**
 * A published skill whose slug a person's locked skill holds (EO-714).
 *
 * Making room archives the local one, and a lock refuses every write a
 * person did not make — so the published one is not taken, nothing is
 * written, and the rest of the publication still lands.
 */
describe("publishing a skill over a person's locked one", () => {
  let publisher: DbHandle;
  let replica: DbHandle;

  beforeEach(() => {
    publisher = openMigratedTestDb();
    replica = openMigratedTestDb();
  });

  afterEach(() => {
    publisher.close();
    replica.close();
  });

  it("leaves the locked skill as it is and takes the rest of the section", () => {
    const draft = { slug: "house-style", name: "House style", description: "How we review.", body: "Ours.", files: [] };
    const mine = saveSkill(replica.db, { ...draft, slug: "house-style" });
    if (!mine.ok) throw new Error("not saved");
    expect(setSkillLocked(replica.db, mine.skill.id, true).ok).toBe(true);
    const before = getSkill(replica.db, mine.skill.id);
    saveSkill(publisher.db, { ...draft, body: "Theirs." });
    saveSkill(publisher.db, { ...draft, slug: "release-notes", name: "Release notes" });

    const written = applySectionDocument(replica.db, sectionDocument(publisher.db, "packs"));

    expect(written).toBe(1);
    expect(getSkill(replica.db, mine.skill.id)).toEqual(before);
    expect(getSkillBySlug(replica.db, "house-style")?.body).toBe("Ours.");
    expect(getSkillBySlug(replica.db, "release-notes")).toBeDefined();
    // Held rather than dropped, and written once the person unlocks theirs and renames it.
    const theirs = listHeldSkillCopies(replica.db);
    expect(theirs.map((held) => [held.skill.slug, held.skill.body])).toEqual([["house-style", "Theirs."]]);
    expect(theirs[0]?.problem).toContain("a person locked");
    setSkillLocked(replica.db, mine.skill.id, false);
    saveSkill(replica.db, { ...draft, id: mine.skill.id, slug: "our-house-style" });
    expect(releaseHeldSkillCopies(replica.db)).toHaveLength(1);
    expect(getSkillBySlug(replica.db, "house-style")?.body).toBe("Theirs.");
    expect(getSkill(replica.db, mine.skill.id)?.body).toBe("Ours.");
  });
});
