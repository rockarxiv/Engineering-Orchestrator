import { EMPTY_SPEC_SHAPE, REPOSITORY_MCP_SERVER_NAME, coreRegistry, developerRegistry, type ConnectorSetup, type Registry, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createRoute, createStep, createWorkspace, getStep, getItem, listAgents, listCommentsForItem, listPipelineSteps, listRunsForItem } from "../db/repos/index.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { createEngine } from "../engine.js";
import { registry, useRegistry } from "../registry.js";
import { createFakeProvider } from "../providers/fake.js";
import { happyPathFixture } from "../providers/fixtures.js";
import { developerPack } from "./developer/index.js";
import { foldPacks, itemTypeContributions, missingPackRefusal, PackCollisionError, PACK_HOOKS, type CodePack } from "./pack.js";
import { fakeWorkspaceKind } from "../supervisor/testWorkspaceKinds.js";

/**
 * The pack boundary (KAN-144, ARCHITECTURE.md, "Where the seams are" and "The invariants").
 *
 * A pack is a value and `createEngine(options, packs)` is the fold. The
 * three things this file holds it to are the story's own: the developer
 * pack folds to what `engine.ts` used to write out by hand, a core with
 * nothing installed still starts and ticks but refuses to dispatch into
 * nothing, and two packs claiming one key are refused at startup rather
 * than one of them silently losing.
 *
 * Beside `pack.ts` rather than in `engine.test.ts` because the subject
 * is the fold, not the engine: the engine is here as the one caller
 * that performs it.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
  // The registry is process-wide and `createEngine` installs the fold
  // into it, so a test that composed an engine with no packs would
  // otherwise leave every later test in this file reading an empty one.
  useRegistry(developerRegistry());
});

const CASE_ENTRY = { packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} };

/** A pack shipping one `case` type of its own (ARCHITECTURE.md, "An item type is data" — two packs may). */
function withCase(id: string, label: string): CodePack {
  return bare(id, {
    registry: {
      itemTypes: new Map([[`${id}:case`, { packSlug: id, slug: "case", label, plural: `${label}s`, container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }]]),
    },
  });
}

/** A pack with nothing in it but an id, for the collision tests to add one thing to. */
function bare(id: string, extra: Partial<CodePack> = {}): CodePack {
  return { id, registry: {}, builtins: {}, ...extra };
}

/** The setup a pack might ship for a server (EO-315). A label and a kind; never a transport, and never what it reaches. */
const SLACK_SETUP: ConnectorSetup = {
  label: "Slack",
  kind: "token",
  secretNames: ["SLACK_BOT_TOKEN"],
  oauth: null,
};

describe("folding the installed packs", () => {
  it("takes the developer pack's ten hooks, its functions and its registry", () => {
    const folded = foldPacks([developerPack({ db: handle.db })]);

    // Every one of the eight the design named, plus the
    // capacity key and the dispatch gate the same finding took out of
    // `packages/engine` (KAN-161) — so a hook dropped from the pack is a
    // failure here rather than a capability that silently stopped being
    // supplied.
    for (const hook of PACK_HOOKS) expect(typeof folded[hook], hook).toBe("function");
    // The pack's four, and the core's own beside them (EO-459, EO-460).
    expect(Object.keys(folded.builtins).sort()).toEqual(["create_worktree", "index_repository", "open_pull_request", "wait_until", "watch_pull_request"]);
    expect([...folded.registry.roles.keys()].sort()).toEqual(["implementer", "reviewer", "system"]);
    expect([...folded.registry.builtins.keys()].sort()).toEqual(["create_worktree", "index_repository", "open_pull_request", "wait_until", "watch_pull_request"]);
    // By `packSlug:slug` since KAN-129, which is what lets a second pack
    // ship a word this one already uses.
    expect([...folded.registry.itemTypes.keys()].sort()).toEqual(["developer:bug", "developer:feature", "developer:story"]);
  });

  it("folds the entry rule kinds packs contribute, and refuses one claiming a kind that is taken (EO-610)", () => {
    const kind = { noun: "a case number", extension: "support", property: "number" };
    const shipping = (id: string, name: string) => bare(id, { registry: { entryRuleKinds: new Map([[name, kind]]) } });

    expect(foldPacks([shipping("alpha", "case_number")]).registry.entryRuleKinds?.get("case_number")).toEqual(kind);
    expect(() => foldPacks([shipping("alpha", "case_number"), shipping("beta", "case_number")])).toThrow(PackCollisionError);
    expect(() => foldPacks([shipping("alpha", "description")])).toThrow(PackCollisionError);
  });

  it("with no packs, supplies no hook, only the core's own functions and the core's registry", () => {
    const folded = foldPacks([]);

    for (const hook of PACK_HOOKS) expect(folded[hook], hook).toBeUndefined();
    // The core ships `wait_until` itself (EO-459), so a pipeline that
    // only waits for a date runs with nothing installed.
    expect(Object.keys(folded.builtins)).toEqual(["wait_until"]);
    expect(folded.registry).toEqual(coreRegistry());
    expect(folded.registry.roles.size).toBe(0);
    // And the wiring answers "no opinion", which is what the supervisor
    // reads as "route on the reported result key".
    expect(folded.resolveNextState({} as never, [], {}, "implement", {} as Item)).toBeUndefined();
  });

  it("asks each pack's wiring in turn and takes the first that claims the action", () => {
    const claims = (id: string, action: string): CodePack =>
      bare(id, {
        wiring: {
          resolveNextState: (_step, _steps, _result, dispatched) => (dispatched === action ? { park: id } : undefined),
          onRunSucceeded: () => {},
        },
      });
    const folded = foldPacks([claims("first", "review"), claims("second", "review"), claims("third", "implement")]);

    expect(folded.resolveNextState({} as never, [], {}, "review", {} as Item)).toEqual({ park: "first" });
    expect(folded.resolveNextState({} as never, [], {}, "implement", {} as Item)).toEqual({ park: "third" });
    // Nobody's: back to the supervisor's own default.
    expect(folded.resolveNextState({} as never, [], {}, "refine", {} as Item)).toBeUndefined();
  });

  it("lets a second pack route its own action even with the developer pack ahead of it", () => {
    // The regression this is here for: the developer wiring's last line
    // used to be `return "done"`, so it answered for every action in
    // existence — and the fold takes the first answer. A second pack
    // installed after it could never route anything of its own, and
    // nothing would have said so; the item would simply have gone
    // wherever `done` routed, or parked with a comment about a result
    // key its step never declared.
    const weekly = bare("weekly-report", {
      wiring: {
        resolveNextState: (_step, _steps, _result, action) => (action === "draft_report" ? { park: "weekly-report" } : undefined),
        onRunSucceeded: () => {},
      },
    });
    const folded = foldPacks([developerPack({ db: handle.db }), weekly]);

    expect(folded.resolveNextState({} as never, [], {}, "draft_report", {} as Item)).toEqual({ park: "weekly-report" });
    // And the developer pack still answers for its own, which is the
    // other half: declining everything would be as wrong as claiming it.
    const review = getStep(handle.db, "review")!;
    const story = createTestItem(handle.db, { type: "story", title: "Judged", stepId: "review", spec: REVIEWABLE_SPEC });
    const verdict = { verdict: "approve", feedback: "LGTM" };
    expect(folded.resolveNextState(review, listPipelineSteps(handle.db), verdict, "review", story)).toEqual({
      stepId: "merge_request",
      pipelineId: review.pipelineId,
      // The result it was sent on (EO-586), which the verdict never spells.
      resultKey: "approved",
    });
  });

  it("declines an action no installed pack owns, so the supervisor's own default answers", () => {
    // An action somebody invented and put on a step, run by a role they
    // wrote themselves. The developer pack has no opinion about it and
    // must say so.
    const developer = foldPacks([developerPack({ db: handle.db })]);

    expect(developer.resolveNextState({} as never, [], {}, "draft_report", {} as Item)).toBeUndefined();
    // A module's id is the same case for the same reason: a module is
    // the core's machinery rather than any pack's, and what the
    // supervisor does with an unclaimed action — take the key it
    // reported — is exactly what this wiring used to do with one.
    expect(developer.resolveNextState({} as never, [], { result: "deployed" }, "0199aa00-0000-7000-8000-000000000000", {} as Item)).toBeUndefined();
  });

  it("concatenates every pack's prompt sections, in the order they were installed", () => {
    // Sections compose rather than collide (KAN-161): two packs each
    // with something to say about the item in front of an agent both
    // get to say it, and the order is the one the caller wrote down.
    const says = (id: string): CodePack => bare(id, { sectionRenderers: [{ id, after: "item", render: () => `## ${id}` }] });
    const folded = foldPacks([says("first"), says("second")]);

    expect(folded.sectionRenderers.map((renderer) => renderer.id)).toEqual(["first", "second"]);
  });

  it("supplies the developer pack's eight sections, and none with nothing installed", () => {
    expect(foldPacks([developerPack({ db: handle.db })]).sectionRenderers.map((renderer) => renderer.id)).toEqual([
      "clarify",
      "planModeCheck",
      "currentOutput",
      "acceptanceCriteria",
      "ticketFiles",
      "planCommentResponse",
      "reviewPlan",
      "approvedPlan",
    ]);
    // A core with no pack sends the sections it writes itself and no
    // others — it does not invent the ones a pack would have supplied.
    expect(foldPacks([]).sectionRenderers).toEqual([]);
  });

  it("distinguishes a pack answering null from a pack having no opinion", () => {
    // `null` is an answer — "do not move this item, and let the run
    // finish", which is what a conversation turn is — so a pack that
    // returns it must not fall through to the next one.
    const folded = foldPacks([
      bare("quiet", { wiring: { resolveNextState: () => null, onRunSucceeded: () => {} } }),
      bare("loud", { wiring: { resolveNextState: () => ({ park: "loud" }), onRunSucceeded: () => {} } }),
    ]);

    expect(folded.resolveNextState({} as never, [], {}, "discuss", {} as Item)).toBeNull();
  });

  /**
   * So a developer's reach list reads the same as everybody else's
   * (EO-315). The repository server is one EO injects rather than a
   * catalogue row, so without this line a developer's step would show an
   * empty list beside a step that plainly does reach something.
   */
  it("takes the developer pack's one connector: the repository server, with nothing to connect", () => {
    const folded = foldPacks([developerPack({ db: handle.db })]);

    expect([...folded.connectors.keys()]).toEqual([REPOSITORY_MCP_SERVER_NAME]);
    expect(folded.connectors.get(REPOSITORY_MCP_SERVER_NAME)).toEqual({
      label: "Repository intelligence",
      kind: "none",
      secretNames: [],
      oauth: null,
    });
  });

  it("lets two packs ship a type of the same name, namespaced by pack (KAN-129, §2.2)", () => {
    // The settled case: a support pack and a legal one both calling
    // something a "case". The registry is keyed by `packSlug:slug`, so
    // both survive the fold — a map keyed by the bare word would have
    // had to refuse the second pack, which is the opposite of what a
    // pack boundary is for. The picker is what disambiguates them for a
    // person, showing "Case (Support)".
    const folded = foldPacks([withCase("support", "Case"), withCase("legal", "Case")]);

    expect([...folded.registry.itemTypes.keys()].sort()).toEqual(["legal:case", "support:case"]);
    expect(folded.registry.itemTypes.get("support:case")?.packSlug).toBe("support");
    // And what the seed writes: one entry per pack per word, each
    // saying whose it is, because that is the pair `item_types` is
    // unique on.
    expect(itemTypeContributions([withCase("support", "Case"), withCase("legal", "Case")]).map((type) => `${type.packSlug}:${type.slug}`)).toEqual([
      "support:case",
      "legal:case",
    ]);
    // A pack contributing none contributes nothing, rather than an
    // empty something the caller has to skip.
    expect(itemTypeContributions([bare("quiet")])).toEqual([]);
    expect(itemTypeContributions([developerPack({ db: handle.db })]).map((type) => type.slug).sort()).toEqual(["bug", "feature", "story"]);
  });

  it("still refuses one pack claiming the type another pack ships", () => {
    // Namespacing is not a free-for-all: a pack whose entry says it is
    // the support pack's `case` is a pack lying about whose type it
    // ships, and the key it is filed under is what catches that.
    expect(() => foldPacks([withCase("support", "Case"), bare("impostor", { registry: { itemTypes: new Map([["support:case", CASE_ENTRY]]) } })])).toThrow(
      PackCollisionError,
    );
  });

  /**
   * The half of an override's validation only the fold can do (KAN-163).
   *
   * `buildRegistry` has already refused one naming a schema no role
   * declares. A poster is a function a pack holds rather than registry
   * data, so the name is resolvable only here, where every installed
   * pack is in one hand — and an override naming a poster nobody
   * registers is a run that finishes, routes, and leaves nothing in the
   * thread (invariant 8).
   */
  describe("an override naming a comment poster", () => {
    // The shipped roles short of their own defaults: this fixture is a
    // pack of its own, borrowing the schemas so that `clarify` resolves
    // while saying nothing about what any action means by default — the
    // developer pack's defaults name the developer pack's posters, which
    // a pack that is not it does not register.
    const schemasOnly = new Map(
      [...developerRegistry().roles].map(([slug, role]) => [slug, { prompt: role.prompt, threadReuse: role.threadReuse, schemasByAction: role.schemasByAction }]),
    );

    const posting = (id: string, name: string, entry = CASE_ENTRY): CodePack =>
      bare(id, {
        registry: {
          roles: schemasOnly,
          itemTypes: new Map([[`${entry.packSlug}:${entry.slug}`, entry]]),
        },
        posters: { [name]: () => {} },
      });

    const overriding = (poster: string) => ({ ...CASE_ENTRY, actionOverrides: { refine: { schema: "clarify", resultKey: "clarified", poster } } });

    it("refuses one no installed pack registers, naming the type and the action", () => {
      const fold = () => foldPacks([posting("support", "case_note", overriding("case_note_typo"))]);

      expect(fold).toThrow(/"support:case" item type/);
      expect(fold).toThrow(/"refine"/);
      expect(fold).toThrow(/"case_note_typo"/);
    });

    it("accepts one another installed pack registers, since the wirings are all asked", () => {
      expect(() => foldPacks([posting("support", "case_note", overriding("case_note"))])).not.toThrow();
      // Registered by a second pack rather than by the type's own, which
      // is fine: every wiring sees a success, so whoever has the name
      // posts it.
      expect(() => foldPacks([bare("elsewhere", { posters: { case_note: () => {} } }), posting("support", "other", overriding("case_note"))])).not.toThrow();
    });

    it("refuses a name two packs both register, like every other key", () => {
      expect(() => foldPacks([bare("alpha", { posters: { note: () => {} } }), bare("beta", { posters: { note: () => {} } })])).toThrow(PackCollisionError);
    });

    it("takes the developer pack's two, which are what its own types name", () => {
      expect(Object.keys(foldPacks([developerPack({ db: handle.db })]).posters).sort()).toEqual(["clarification_note", "refine_proposal"]);
      expect(foldPacks([]).posters).toEqual({});
    });
  });

  it("lets every pack's wiring see a success, since a comment is a side effect rather than a decision", () => {
    const spoke: string[] = [];
    const speaks = (id: string): CodePack =>
      bare(id, { wiring: { resolveNextState: () => undefined, onRunSucceeded: () => spoke.push(id) } });

    foldPacks([speaks("first"), speaks("second")]).onRunSucceeded({} as Item, {} as never, "implement", {}, "run" as never);

    expect(spoke).toEqual(["first", "second"]);
  });
});

describe("two packs claiming one key", () => {
  const roleEntry = { prompt: "x.md", threadReuse: false, schemasByAction: new Map() };
  const withRole = (id: string, slug: string): CodePack => bare(id, { registry: { roles: new Map([[slug, roleEntry]]) } as Partial<Registry> });

  it("refuses a hook two packs both supply, naming both", () => {
    const gate = () => null;

    expect(() => foldPacks([bare("alpha", { dispatchGate: gate }), bare("beta", { dispatchGate: gate })])).toThrow(PackCollisionError);
    expect(() => foldPacks([bare("alpha", { dispatchGate: gate }), bare("beta", { dispatchGate: gate })])).toThrow(/"alpha" and "beta".*dispatchGate/);
  });

  it("refuses a workspace kind two packs both claim, naming both", () => {
    // The one that matters most now that the eight hooks are five
    // methods on a value (EO-295): a workspace row names a slug, and
    // two packs answering to it would mean an item's disk depended on
    // which pack was folded first.
    const kind = fakeWorkspaceKind({ slug: "git-worktree" });

    expect(() => foldPacks([bare("alpha", { kinds: [kind] }), bare("beta", { kinds: [kind] })])).toThrow(PackCollisionError);
    expect(() => foldPacks([bare("alpha", { kinds: [kind] }), bare("beta", { kinds: [kind] })])).toThrow(/"alpha" and "beta".*git-worktree/);
  });

  it("keys every installed kind by its own slug, so an item's workspace can find it", () => {
    const folded = foldPacks([bare("alpha", { kinds: [fakeWorkspaceKind({ slug: "git-worktree" })] }), bare("beta", { kinds: [fakeWorkspaceKind({ slug: "folder" })] })]);

    expect([...folded.kinds.keys()].sort()).toEqual(["folder", "git-worktree"]);
    expect(folded.kinds.get("folder")?.slug).toBe("folder");
  });

  it("refuses a connector two packs both describe, naming both", () => {
    // Which set of words an installation shows must not depend on which
    // pack was folded first — the same reason a workspace kind collides
    // above. A connector's *words* are what a person acts on: the
    // Connect button, and whether the line is red.
    const connectors = [{ serverName: "slack", setup: SLACK_SETUP }];

    expect(() => foldPacks([bare("alpha", { connectors }), bare("beta", { connectors })])).toThrow(PackCollisionError);
    expect(() => foldPacks([bare("alpha", { connectors }), bare("beta", { connectors })])).toThrow(/"alpha" and "beta".*slack/);
  });

  it("refuses a setup a pack got wrong, at composition rather than at the button", () => {
    // A Connect button whose flow cannot complete is a guard dropping
    // work in silence (invariant 8) at the one moment somebody is trying
    // to sign in — so a malformed setup stops the engine coming up
    // instead, which is a programmer error in a pack and is answered
    // like one.
    const broken = [{ serverName: "slack", setup: { ...SLACK_SETUP, label: "" } }];

    expect(() => foldPacks([bare("alpha", { connectors: broken })])).toThrow(/"alpha" pack's "slack" connector is not well-formed/);
  });

  it("keys every declared connector by its server name", () => {
    const folded = foldPacks([
      bare("alpha", { connectors: [{ serverName: "slack", setup: SLACK_SETUP }] }),
      bare("beta", { connectors: [{ serverName: "zendesk", setup: { ...SLACK_SETUP, label: "Zendesk" } }] }),
    ]);

    expect([...folded.connectors.keys()].sort()).toEqual(["slack", "zendesk"]);
    expect(folded.connectors.get("slack")?.label).toBe("Slack");
  });

  it("refuses a role slug two packs both contribute, naming both", () => {
    expect(() => foldPacks([withRole("alpha", "reviewer"), withRole("beta", "reviewer")])).toThrow(/"alpha" and "beta".*reviewer/);
  });

  it("refuses a pack shipping a function the core already does, naming the core", () => {
    const rival = bare("calendar", { builtins: { wait_until: async () => ({ ok: true, result: "reached", detail: "" }) } });
    expect(() => foldPacks([rival])).toThrow(PackCollisionError);
    expect(() => foldPacks([rival])).toThrow(`The "core" and "calendar" packs both supply the builtin "wait_until"`);
    const declares = bare("calendar", { registry: { builtins: new Map([["wait_until", { label: "Wait until", results: ["reached", "failed"], sideEffects: false }]]) } });
    expect(() => foldPacks([declares])).toThrow(`The "core" and "calendar" packs both supply the builtin action "wait_until"`);
  });

  it("refuses a builtin two packs both ship, naming both", () => {
    const runner = async () => ({ ok: true as const, result: "ready", detail: "" });

    expect(() => foldPacks([bare("alpha", { builtins: { cut: runner } }), bare("beta", { builtins: { cut: runner } })])).toThrow(/"alpha" and "beta".*cut/);
  });

  it("allows two packs to supply different contributions and different roles", () => {
    const folded = foldPacks([
      { ...withRole("alpha", "writer"), dispatchGate: () => null },
      { ...withRole("beta", "editor") },
    ]);

    expect([...folded.registry.roles.keys()].sort()).toEqual(["editor", "writer"]);
    expect(typeof folded.dispatchGate).toBe("function");
    expect(folded.kinds.size).toBe(0);
  });
});

describe("createEngine(options, packs)", () => {
  const eoMcpServerPath = "/unused/eoServer.mjs";

  /** A project with a git workspace attached, so an item on it resolves to the developer pack's kind. */
  function gitProject() {
    const workspace = createWorkspace(handle.db, { kind: "git-worktree", config: { name: "api", repoPath: "/tmp/eo/not-a-checkout" } });
    return createDefaultProject(handle.db, workspace, "EO").id;
  }

  it("installs the folded registry, so every lookup answers for what is installed", () => {
    createEngine({ db: handle.db, eoMcpServerPath }, []);
    expect([...registry.roles.keys()]).toEqual([]);
    expect([...registry.builtins.keys()]).toEqual(["wait_until"]);

    createEngine({ db: handle.db, eoMcpServerPath }, [developerPack({ db: handle.db })]);
    expect([...registry.roles.keys()].sort()).toEqual(["implementer", "reviewer", "system"]);
  });

  it("with no packs, starts and ticks and refuses each dispatch with a comment naming the role", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
    const supervisor = createEngine({ db: handle.db, eoMcpServerPath, provider: createFakeProvider(happyPathFixture) }, []);

    // Starts and ticks rather than throwing, which is the half of the
    // invariant a type cannot state: the core composes with nothing
    // installed. `start` then `stop` so the interval it arms does not
    // outlive the test.
    supervisor.start();
    supervisor.stop();
    await supervisor.runOnce();

    const refusals = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.body).toContain(`"implementer" role`);
    expect(refusals[0]?.body).toContain("No pack is installed");
    // Nothing was dispatched: the run exists to carry the refusal, and
    // it never reached a provider.
    const runs = listRunsForItem(handle.db, item.id);
    // Parked rather than failed: a refused dispatch is a question for a
    // person, and the run row exists to carry it. No thread was ever
    // opened, which is what says no provider was reached.
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(runs[0]?.threadId).toBeNull();
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("refuses a builtin step the same way, rather than calling its function a missing module", async () => {
    // The registry is empty with nothing installed, so `open_pull_request`
    // classifies as a module id and the step used to park saying a
    // module was missing, deleted or unapproved — a sentence about
    // something this pipeline never named. The refusal has to be the
    // same one an agent step gets, or "the core with no pack installed"
    // is a state EO describes two different ways.
    const item = createTestItem(handle.db, { type: "story", title: "Ready to send", stepId: "merge_request", spec: REVIEWABLE_SPEC });
    const supervisor = createEngine({ db: handle.db, eoMcpServerPath, provider: createFakeProvider(happyPathFixture) }, []);

    await supervisor.runOnce();

    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.body).toContain("No pack is installed");
    expect(escalations[0]?.body).toContain(`"open_pull_request" function`);
    expect(escalations[0]?.body).not.toContain("module");
    // Parked, so the scheduler stops offering the step rather than
    // asking again every tick.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("merge_request");
  });

  it("with no packs, runs the core's own wait_until rather than refusing it (EO-459)", async () => {
    createStep(handle.db, {
      id: "wait",
      pipelineId: "default" as Uuid,
      position: 15,
      name: "Wait for the date",
      type: "builtin",
      entryAction: "wait_until",
      inputs: { at: "2000-01-01T00:00Z" },
      watch: { everyMinutes: 5, giveUpAfterHours: 168 },
    });
    createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "wait", resultKey: "reached", label: "Reached", target: "terminal", position: 0 });
    const item = createTestItem(handle.db, { type: "story", title: "Long since due", stepId: "wait" });
    const supervisor = createEngine({ db: handle.db, eoMcpServerPath, provider: createFakeProvider(happyPathFixture) }, []);

    await supervisor.runOnce();

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.body.includes("No pack is installed"))).toEqual([]);
    expect(listRunsForItem(handle.db, item.id)[0]?.result?.parsed).toEqual({ result: "reached" });
    expect(getStep(handle.db, getItem(handle.db, item.id)!.stepId!)?.isTerminal).toBe(true);
  });

  it("with the developer pack, the dispatch reaches the pack's own workspace instead", async () => {
    // On a project with a repository attached, but naming none of its
    // own — which is what makes the git kind the one that answers for
    // it (EO-296). An item on no project at all resolves to `none` and
    // gets an empty directory, which proves nothing about *this* pack.
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC, projectId: gitProject() });
    const supervisor = createEngine({ db: handle.db, eoMcpServerPath, provider: createFakeProvider(happyPathFixture) }, [developerPack({ db: handle.db })]);

    await supervisor.runOnce();

    // The same item, the same tick, a different refusal — and this one
    // is the git worktree's, which is the evidence that the pack's
    // `prepareWorkspace` is what the supervisor is holding. What
    // happens after a repository *is* assigned is the whole of the rest
    // of this suite, which composes the engine exactly this way.
    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.body).toContain("no repository assigned");
    expect(escalations[0]?.body).not.toContain("No pack is installed");
  });

  it("folds the developer pack by default, so a caller that names no packs gets the engine EO ships", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC, projectId: gitProject() });
    const supervisor = createEngine({ db: handle.db, eoMcpServerPath, provider: createFakeProvider(happyPathFixture) });

    await supervisor.runOnce();

    expect(listCommentsForItem(handle.db, item.id)[0]?.body).toContain("no repository assigned");
    expect([...registry.roles.keys()].sort()).toEqual(["implementer", "reviewer", "system"]);
  });
});

describe("the refusal a core with no pack gives", () => {
  it("says nothing at all while any pack is installed, so an invented role still dispatches", () => {
    // A role nobody shipped is configuration, not an error
    // (ARCHITECTURE.md, "An agent is a row") — somebody writes its prompt in the Agents
    // editor and a step names it. The refusal must not be about the
    // registry, or that would stop working.
    expect(missingPackRefusal([developerPack({ db: handle.db })], { role: "weekly-report-writer", action: "draft" })).toBeNull();
    expect(missingPackRefusal([], { role: "implementer", action: "implement" })).toContain(`"implementer"`);
  });

  it("names the role on an agent step and the function on a builtin one, which is owned by nobody", () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;

    expect(missingPackRefusal([], { role: implementer.role, action: "implement" })).toContain(`"implementer" role`);
    expect(missingPackRefusal([], { role: null, action: "open_pull_request" })).toContain(`"open_pull_request" function`);
  });

  it("refuses nothing about a function the core ships itself (EO-459)", () => {
    expect(missingPackRefusal([], { role: null, action: "wait_until" })).toBeNull();
    // A role named after it is still a role nobody provides.
    expect(missingPackRefusal([], { role: "wait_until", action: "wait_until" })).toContain(`"wait_until" role`);
  });
});
