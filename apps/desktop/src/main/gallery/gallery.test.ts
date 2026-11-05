import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_SOURCE, type AgentEvent, type GalleryIndex } from "@eo/core";
import type { Uuid } from "@eo/core";
import { validatePipeline } from "@eo/engine";
import type { DbHandle } from "../db/client.js";
import { getItem, listActionDefinitions, listAgents, listPipelines, listRoutesForPipeline, listStepsForPipeline, updateAgent } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { registryForProject } from "../registry.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { importPipeline } from "../modules/pipelineTransfer.js";
import { previewGalleryCommand, listGalleryCommand, useGalleryCommand } from "../ipc/galleryCommands.js";
import { forgetListed } from "./session.js";
import { bundledTemplates, listGalleryTemplates } from "./templates.js";

/**
 * The gallery, in both places it lives (EO-316,
 * `ARCHITECTURE.md`, "The gallery").
 *
 * The decision under test is the one the whole module is shaped around:
 * **a network that is not there is not an error**. First run for a
 * non-developer is the one screen where a red line about a failed
 * request would be the first thing EO ever said to somebody, about a
 * thing they did not ask for and cannot fix.
 */

/** The directory the app ships — the real one, because what it holds is half of this story. */
export const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resources", "gallery");

/**
 * A keychain stand-in. The gallery never writes a secret; what needs one
 * is the preflight behind every card's "what this needs" list, which
 * reads the names it already holds.
 */
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-gallery-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  // What a previous case listed is held in a module — see
  // `gallery/session.ts` — so each starts from nothing.
  forgetListed();
});

afterEach(() => {
  handle.close();
});

/** A fetch that behaves like a machine with no network: it throws. */
const offline = vi.fn(async () => {
  throw new Error("getaddrinfo ENOTFOUND eo.dev");
}) as unknown as typeof fetch;

/** A fetch that serves whatever body is handed to it. */
function serving(body: unknown, status = 200): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("the bundled set", () => {
  it("ships the four templates the gallery is made of", () => {
    const slugs = bundledTemplates(GALLERY_DIRECTORY).map((template) => template.slug);

    // Named rather than counted. A template that failed to parse is
    // skipped silently — which is right for the screen and means this is
    // the only thing that can notice one going missing.
    expect(slugs).toEqual([
      "content-draft-and-approve",
      "inbox-triage",
      "software-feature-to-merge",
      "weekly-report",
    ]);
  });

  /**
   * Every bundled pack goes through the same gate a dragged-in file
   * does, so this is the test that would catch a template EO ships and
   * cannot install — which is a bug nobody would find until first run.
   */
  it("imports every one of them into a fresh installation", () => {
    for (const template of bundledTemplates(GALLERY_DIRECTORY)) {
      const imported = importPipeline(handle.db, { document: template.document, projectId: null, signedInBackends: [] });
      expect(imported, `${template.slug} did not import`).toMatchObject({ ok: true });
    }
  });

  /**
   * The three templates that are not software each define the actions
   * their agent steps dispatch (EO-424).
   *
   * They shipped with a custom action and no shape for it: the answer
   * came back as prose, was read as `done`, and parked, because every
   * one of these steps routes on other keys. So a template somebody
   * picked from the gallery stopped at its first step. Held here to the
   * validator a publish is held to — the definition and the routes are
   * two lists in one file, and this is what notices them parting.
   */
  it.each([
    ["weekly-report", { reporter: { gather: ["gathered", "nothing_to_report"], draft: ["drafted", "needs_more"] } }],
    ["inbox-triage", { triager: { triage: ["triaged", "unclear"] } }],
    ["content-draft-and-approve", { writer: { outline: ["outlined", "brief_unclear"], write: ["written", "needs_outline"] } }],
  ])("%s defines its actions with the keys its routes use, and validates", (slug, expected) => {
    const template = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === slug);
    if (template === undefined) throw new Error(`${slug} is not bundled`);

    const imported = importPipeline(handle.db, { document: template.document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    const defined: Record<string, Record<string, string[]>> = {};
    for (const definition of listActionDefinitions(handle.db)) {
      (defined[definition.role] ??= {})[definition.action] = definition.results.map((result) => result.key);
      // Every result says when to return it: the keys alone constrain
      // the answer and tell the agent nothing about which is true.
      for (const result of definition.results) expect(result.meaning, `${definition.role}/${definition.action}/${result.key}`).not.toBe("");
      expect(definition.description).not.toBe("");
    }
    expect(defined).toEqual(expected);

    const steps = listStepsForPipeline(handle.db, imported.pipelineId as Uuid);
    const problems = validatePipeline({
      steps,
      routes: listRoutesForPipeline(handle.db, imported.pipelineId as Uuid),
      entryStepId: listPipelines(handle.db).find((pipeline) => pipeline.id === imported.pipelineId)?.entryStepId ?? null,
      // The roles land unbound — no backend is signed in on a test
      // machine — and "nobody staffs this" is not what is being asked.
      staffedRoles: Object.keys(expected),
      itemCountByStep: {},
      existingSteps: [],
      registry: registryForProject(handle.db, null),
    });

    expect(problems.filter((problem) => problem.message.includes("is not validated"))).toEqual([]);
    // Nothing at all, with one exception that is not about an action and
    // predates this: the inbox template's *human* step offers Escalate
    // and routes it to `user_attention`, which the validator refuses
    // from a step a person is already on. Where that button should go
    // instead is a decision about the template's graph rather than its
    // actions, and was left to a story of its own when EO-424 asked.
    // Named exactly, so anything else appearing here fails — and so
    // that fixing the route fails this line and gets it removed.
    expect(problems.map((problem) => [problem.severity, problem.resultKey])).toEqual(slug === "inbox-triage" ? [["error", "escalate"]] : []);
  });

  /**
   * And the run itself: real work on the weekly report's Gather step,
   * answered `gathered`, goes to Draft.
   *
   * Not a preview, which is the case that was broken — a preview falls
   * to a step's first declared result when a run reports none, so the
   * rehearsal walked the whole pipeline while the first real item on it
   * parked.
   */
  it("moves a weekly report from Gather to Draft when the agent answers gathered", async () => {
    const template = bundledTemplates(GALLERY_DIRECTORY).find((candidate) => candidate.slug === "weekly-report");
    if (template === undefined) throw new Error("weekly-report is not bundled");
    const imported = importPipeline(handle.db, { document: template.document, projectId: null, signedInBackends: [] });
    if (!imported.ok) throw new Error(imported.reason);

    // The one thing the person does after "Use this": choose a backend.
    const reporter = listAgents(handle.db).find((agent) => agent.role === "reporter");
    if (reporter === undefined) throw new Error("the import wrote no reporter");
    updateAgent(handle.db, reporter.id, { provider: "fake", enabled: true });

    const steps = listStepsForPipeline(handle.db, imported.pipelineId as Uuid);
    const stepNamed = (name: string) => steps.find((step) => step.name === name)?.id;
    const item = createTestItem(handle.db, { type: "story", title: "Week of 8 September", stepId: stepNamed("Gather") as string });
    expect(item.previewAt).toBeNull();

    const schemas: unknown[] = [];
    const provider = {
      async *start(opts: { outputSchema?: unknown }): AsyncIterable<AgentEvent> {
        schemas.push(opts.outputSchema);
        yield { type: "thread_started", threadId: "t1" };
        yield { type: "result", data: { result: "gathered", summary: "Three things shipped and one slipped." } };
      },
      async *resume(): AsyncIterable<AgentEvent> {
        yield { type: "result", data: { result: "gathered", summary: "Three things shipped and one slipped." } };
      },
    };

    await createRunSupervisor({ db: handle.db, provider, limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 } }).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe(stepNamed("Draft"));
    // Held to the declared keys on the way, rather than read as `done`.
    expect(JSON.stringify(schemas[0])).toContain("nothing_to_report");
  });

  /**
   * The card, as the form will draw it: the blanks the pack asks and the
   * slots it names, end to end from the file on disk (ARCHITECTURE.md, "The gallery").
   *
   * `roleSlots` is what the "Use this" form renders a picker for, so a
   * terminal step reaching this list is a picker nobody should be shown
   * — and, in solo mode, an owner written onto a column with nothing to
   * decide. Asserted here as well as over `galleryRoleSlots` because
   * this is the shape that actually crosses to the screen.
   */
  it("offers the weekly report's Approve step as its only role slot", async () => {
    const answer = await listGalleryCommand(handle.db, {
      directory: GALLERY_DIRECTORY,
      fetchImpl: offline,
      moduleSecrets: NO_SECRETS,
      signedInBackends: [],
    });

    const weekly = answer.templates.find((template) => template.slug === "weekly-report");
    expect(weekly?.roleSlots.map((slot) => slot.name)).toEqual(["Approve"]);
    expect(weekly?.blanks.map((blank) => blank.kind)).toEqual(["folder", "schedule", "keyPrefix"]);

    // And the software template, whose one human step is terminal, asks
    // for nobody at all.
    const software = answer.templates.find((template) => template.slug === "software-feature-to-merge");
    expect(software?.roleSlots).toEqual([]);
  });

  it("says where each one came from and what version it is at", () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report");

    expect(weekly?.source).toBe(BUNDLED_SOURCE);
    expect(weekly?.version).toBe("1.0");
    expect(weekly?.bundled).toBe(true);
  });
});

describe("with no network", () => {
  it("shows the bundled templates and no error", async () => {
    const answer = await listGalleryCommand(handle.db, {
      directory: GALLERY_DIRECTORY,
      fetchImpl: offline,
      moduleSecrets: NO_SECRETS,
      signedInBackends: [],
    });

    expect(answer.templates.map((template) => template.slug)).toContain("weekly-report");
    expect(answer.templates.every((template) => template.bundled)).toBe(true);
    // The whole point: there is nowhere in this answer for an error to
    // be, and `fetched` is a fact rather than a failure.
    expect(answer.fetched).toBe(false);
    expect(Object.keys(answer)).toEqual(["templates", "fetched", "people"]);
  });

  /** The other three shapes of "not available", each of which used to be a different kind of throw. */
  it("treats a refusal, a bad body and a newer index the same way", async () => {
    const cases: typeof fetch[] = [
      serving({}, 503),
      serving("not an index at all"),
      serving({ eoGalleryIndex: 99, templates: [] }),
    ];

    for (const fetchImpl of cases) {
      const answer = await listGalleryCommand(handle.db, { directory: GALLERY_DIRECTORY, fetchImpl, moduleSecrets: NO_SECRETS, signedInBackends: [] });
      expect(answer.fetched).toBe(false);
      expect(answer.templates.length).toBeGreaterThan(0);
    }
  });
});

describe("with an index", () => {
  /** A pack from somewhere else: the bundled weekly report, renamed, as a site would serve it. */
  function fakeIndex(): GalleryIndex {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
    const pack = JSON.parse(JSON.stringify(weekly.document)) as typeof weekly.document;
    pack.template = { ...weekly.template, slug: "board-pack", title: "Board pack", version: "2.4" };
    return { eoGalleryIndex: 1, templates: [{ source: "acme.example", pack }] };
  }

  it("shows the fetched entries with their source and version", async () => {
    const answer = await listGalleryCommand(handle.db, {
      directory: GALLERY_DIRECTORY,
      fetchImpl: serving(fakeIndex()),
      moduleSecrets: NO_SECRETS,
      signedInBackends: [],
    });

    const fetched = answer.templates.find((template) => template.slug === "board-pack");
    expect(fetched?.source).toBe("acme.example");
    expect(fetched?.version).toBe("2.4");
    expect(fetched?.bundled).toBe(false);
    expect(answer.fetched).toBe(true);
    // And the bundled set is still there beside it (ARCHITECTURE.md, "The gallery": never hidden).
    expect(answer.templates.some((template) => template.slug === "weekly-report")).toBe(true);
  });

  /**
   * The original design's "the bundled set is the fallback and is never hidden", said
   * about the one case where the two lists overlap: the same template
   * arriving by the other road is the same template, and two cards with
   * one title would give a person nothing to choose on.
   */
  it("does not let a fetched entry replace a bundled one", async () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
    const index: GalleryIndex = { eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: weekly.document }] };

    const templates = await listGalleryTemplates({ directory: GALLERY_DIRECTORY, fetchImpl: serving(index) });

    const matches = templates.filter((template) => template.slug === "weekly-report");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe(BUNDLED_SOURCE);
  });

  /**
   * Invariant #11, at the door a stranger's document actually comes
   * through. A fetched template is the least trusted thing EO reads and
   * it goes through `parseExport` rather than around it, so the schema's
   * admin-grant refusal applies here without the gallery restating it.
   */
  it("refuses a fetched pack whose role asks for the admin grant", async () => {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
    const pack = JSON.parse(JSON.stringify(weekly.document)) as Record<string, unknown>;
    pack["roles"] = [{ slug: "reporter", prompt: "", schemasByAction: {}, allowedTools: ["mcp__eo_admin__pipelines_save"], backend: null, model: null }];
    pack["template"] = { ...weekly.template, slug: "helpful-assistant" };

    const templates = await listGalleryTemplates({
      directory: GALLERY_DIRECTORY,
      fetchImpl: serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack }] }),
    });

    expect(templates.some((template) => template.slug === "helpful-assistant")).toBe(false);
  });
});

/**
 * A card's buttons act on the document the card was drawn from
 * (`gallery/session.ts`).
 *
 * The bug: `gallery:list` fetched the index and drew the cards, and then
 * Preview and Use this each fetched it again. Between the two, a laptop
 * lid closes or the site publishes a new version — and the button either
 * answers "EO has no template called board-pack" about a card on screen,
 * or quietly installs a pipeline that is not the one whose description
 * the person just read. The second is the worse one, because nothing
 * about it looks wrong.
 */
describe("a card whose index has moved on", () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eo board pack "));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The bundled weekly report, published elsewhere under another name. */
  function published(overrides: Record<string, unknown> = {}) {
    const weekly = bundledTemplates(GALLERY_DIRECTORY).find((template) => template.slug === "weekly-report")!;
    const pack = JSON.parse(JSON.stringify(weekly.document)) as Record<string, unknown>;
    pack["pipeline"] = { ...(pack["pipeline"] as Record<string, unknown>), name: "Board pack" };
    pack["template"] = { ...weekly.template, slug: "board-pack", title: "Board pack", version: "2.4" };
    return { ...pack, ...overrides };
  }

  async function list(fetchImpl: typeof fetch) {
    return listGalleryCommand(handle.db, { directory: GALLERY_DIRECTORY, fetchImpl, moduleSecrets: NO_SECRETS, signedInBackends: [] });
  }

  it("still installs what it advertised when the connection has since dropped", async () => {
    const listed = await list(serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: published() }] }));
    expect(listed.templates.some((template) => template.slug === "board-pack")).toBe(true);

    // The lid closed between reading the card and pressing the button.
    const answer = await useGalleryCommand(
      handle.db,
      { directory: GALLERY_DIRECTORY, fetchImpl: offline, moduleSecrets: NO_SECRETS, signedInBackends: [] },
      { slug: "board-pack", answers: { folder, schedule: "monday 08:00", keyPrefix: "BRD" }, roleSlots: {} },
    );

    expect(answer.problem).toBeNull();
    expect(answer.pipelineId).not.toBeNull();
  });

  it("previews the pack it showed, not the one the site has since published", async () => {
    await list(serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: published() }] }));

    // The site publishes 2.5 under the same slug, with a different
    // example, a moment after the cards were drawn.
    const moved = published();
    moved["previewItem"] = { title: "Something else entirely", type: "weekly-report:report", body: "", spec: {} };
    const answer = await previewGalleryCommand(
      handle.db,
      { directory: GALLERY_DIRECTORY, fetchImpl: serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: moved }] }), moduleSecrets: NO_SECRETS, signedInBackends: [] },
      { slug: "board-pack" },
    );

    expect(answer.problem).toBeNull();
    const item = getItem(handle.db, answer.itemId as Uuid);
    expect(item?.title).toBe("Weekly report — week of 8 September");
  });

  /**
   * A form open across a republish installs the pack its own card was
   * drawn from — the main-process half of the same guarantee the screen
   * keeps by holding the card whole.
   *
   * The slug is the same in both listings, which is exactly what makes
   * it the wrong thing to act on. The token is what the card carried and
   * what the button sends back.
   */
  it("installs the document a card was drawn from, not the one that replaced it", async () => {
    const first = await list(serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: published() }] }));
    const token = first.templates.find((template) => template.slug === "board-pack")?.token;
    expect(token).toBeDefined();

    // The site publishes again under the same slug, and the gallery
    // lists again — a window regaining focus is all it takes.
    const moved = published();
    moved["template"] = { ...(moved["template"] as Record<string, unknown>), version: "2.5" };
    const second = await list(serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: moved }] }));
    expect(second.templates.find((template) => template.slug === "board-pack")?.token).not.toBe(token);

    const answer = await useGalleryCommand(
      handle.db,
      { directory: GALLERY_DIRECTORY, fetchImpl: offline, moduleSecrets: NO_SECRETS, signedInBackends: [] },
      { slug: "board-pack", token, answers: { folder, schedule: "monday 08:00", keyPrefix: "BRD" }, roleSlots: {} },
    );

    expect(answer.problem).toBeNull();
    // Version 2.4's pipeline, which is what the person was looking at.
    const installed = listPipelines(handle.db, answer.projectId as Uuid).find((pipeline) => pipeline.id === answer.pipelineId);
    expect(installed?.name).toBe("Board pack");
  });

  /**
   * And the honest failure when it cannot be kept: a token EO is no
   * longer holding is refused rather than quietly resolved by slug,
   * because falling back would reinstate the bug the token closes.
   */
  it("says the card moved on rather than installing something else", async () => {
    const answer = await useGalleryCommand(
      handle.db,
      { directory: GALLERY_DIRECTORY, fetchImpl: offline, moduleSecrets: NO_SECRETS, signedInBackends: [] },
      { slug: "weekly-report", token: "a token from a listing this process never saw", answers: {}, roleSlots: {} },
    );

    expect(answer.problem).toContain("Go back and choose it again");
    expect(answer.projectId).toBeNull();
  });

  /**
   * And the other direction, so the hold is not mistaken for a cache
   * that outlives its subject: a second listing replaces what is held,
   * and a template that has left the index leaves with it.
   */
  it("forgets a template the next listing no longer carries", async () => {
    await list(serving({ eoGalleryIndex: 1, templates: [{ source: "acme.example", pack: published() }] }));
    await list(serving({ eoGalleryIndex: 1, templates: [] }));

    const answer = await previewGalleryCommand(
      handle.db,
      { directory: GALLERY_DIRECTORY, fetchImpl: offline, moduleSecrets: NO_SECRETS, signedInBackends: [] },
      { slug: "board-pack" },
    );

    expect(answer.problem).toContain("board-pack");
  });
});

describe("a directory of things that are not templates", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo gallery "));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("skips a damaged file and a pipeline export that is not a template", () => {
    writeFileSync(join(directory, "broken.json"), "{ not json");
    const plain = bundledTemplates(GALLERY_DIRECTORY)[0]!.document;
    writeFileSync(join(directory, "plain.json"), JSON.stringify({ ...plain, template: null }));

    // A pipeline somebody dropped in here has no title, no description
    // and no version, and inventing three would be EO writing copy about
    // a stranger's graph.
    expect(bundledTemplates(directory)).toEqual([]);
  });

  it("has nothing to show when the directory is not there at all", () => {
    expect(bundledTemplates(join(directory, "gone"))).toEqual([]);
  });
});
