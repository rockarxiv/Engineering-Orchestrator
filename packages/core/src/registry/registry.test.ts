import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ClarifyOutputSchema, ImplementOutputSchema, isUndispatchedAction, resultSchemaFor, ReviewOutputSchema, zodOutputSchema } from "../schemas/index.js";
import { THREAD_PER_CONVERSATION_ACTIONS } from "../domain.js";
import { BUILTIN_ACTIONS, BUILTIN_RESULTS, BUILTIN_ROLES, SCHEMAS_BY_ACTION, developerRegistry } from "./developer.js";
import {
  FAILED_RESULT,
  PER_CONVERSATION,
  actionFactsFor,
  actionsAvailableTo,
  builtinInputs,
  builtinLabel,
  builtinOpensPullRequest,
  builtinResults,
  buildRegistry,
  emptyRegistry,
  fromRegistryView,
  isBuiltinAction,
  isBuiltinRole,
  reusesThreadPerItem,
  RegistryViewSchema,
  roleActionFactsOf,
  roleShipsAction,
  schemaByAction,
  toRegistryView,
  type BuiltinEntry,
  type RoleEntry,
} from "./index.js";

/**
 * The registry as EO ships it (KAN-124).
 *
 * Every lookup below is asked about the developer values, because the
 * acceptance criterion is that a registry built from today's constants
 * answers what the constants answered: these tests are the ones that
 * stood beside the constants, with the registry passed in and nothing
 * else changed.
 */
const registry = developerRegistry();

/**
 * What a built-in function can return, as data (EO-77).
 *
 * The outcomes were string literals inside `builtins.ts`, which meant the
 * only way to learn one was to run the function and see what came back.
 * Declared here, the configuration editor can offer a row per outcome and
 * `validatePipeline` can refuse a route key that is not one of them —
 * the check a module step has had since KAN-104.
 */
describe("a built-in function's declared outcomes", () => {
  it("covers every function EO ships, with at least one outcome each", () => {
    // A function missing from here would take its step back to where it
    // was: a free-text result key checked by nothing.
    expect(Object.keys(BUILTIN_RESULTS).sort()).toEqual([...BUILTIN_ACTIONS].sort());
    for (const action of BUILTIN_ACTIONS) expect(BUILTIN_RESULTS[action].length).toBeGreaterThan(0);
  });

  it("reads them back in the order they are declared, because that is the order the editor draws", () => {
    // The outcome, then its exceptions, then `failed` (EO-429 added the
    // two the step sends back to the implementer).
    expect(builtinResults(registry, "open_pull_request")).toEqual(["opened", "skipped", "uncommitted_changes", "remote_diverged", "failed"]);
    expect(builtinResults(registry, "create_worktree")).toEqual(["ready", "failed"]);
  });

  it("gives every function a way to say it did not work", () => {
    // Until `failed` was declared, a builtin that could not finish had no
    // result at all — so a pipeline could not send that anywhere, and
    // every failure ended the same way whatever the pipeline wanted. A
    // function shipped without it would quietly go back to that.
    for (const action of BUILTIN_ACTIONS) expect(BUILTIN_RESULTS[action]).toContain(FAILED_RESULT);
  });

  it("says nothing declares an agent action's verdict", () => {
    // Null is not "returns nothing". An agent returns whatever its prompt
    // asks it to, nothing says so up front, and that is exactly why the design
    // catches an unroutable agent result at runtime and asks a person.
    expect(builtinResults(registry, "review")).toBeNull();
    expect(builtinResults(registry, null)).toBeNull();
  });
});

/**
 * The per-agent thread-reuse switch (EO-88), and the roles it stopped
 * being a switch for (EO-178).
 *
 * One reader, shared, because the editor that draws the control and the
 * dispatch path that acts on it must not be able to disagree — about
 * what counts as on, or about who is even being asked.
 */
describe("whether an agent reuses its thread for a whole item", () => {
  // A role EO ships no opinion about, which is where the switch still
  // lives. Every case below that is about `config` uses one.
  const withConfig = (config: Record<string, unknown>) => ({ role: "tester", config });

  it("is on only for a literal true", () => {
    expect(reusesThreadPerItem(registry, withConfig({ reuseThreadPerItem: true }))).toBe(true);
  });

  it("is off for a key nobody has written", () => {
    expect(reusesThreadPerItem(registry, withConfig({}))).toBe(false);
    // The keys an agent actually carries must not be mistaken for it.
    expect(reusesThreadPerItem(registry, withConfig({ effort: "high", model: "claude-opus-5" }))).toBe(false);
  });

  it("is off for everything else `config` can hold", () => {
    // `config` is an open record: the editor writes it, MCP `agent_save`
    // writes it, and so does anyone who opens the database. A truthy-ish
    // value is not consent — reusing a thread is the surprising
    // behaviour, so anything short of `true` reads as off.
    for (const value of [undefined, null, 0, 1, "", "false", "true", "yes", {}, []]) {
      expect(reusesThreadPerItem(registry, withConfig({ reuseThreadPerItem: value }))).toBe(false);
    }
  });

  describe("on a role EO ships", () => {
    it("keeps the implementer's conversation and starts everyone else fresh", () => {
      // 0048's argument for the implementer, and the absence of one for
      // the other two. The reviewer is the case that is not merely
      // unsettled but inverted: resuming its own thread is re-reading a
      // diff it has already formed an opinion about. The system agent's
      // answer depends on what it was dispatched to do (EO-210), and an
      // unstated action is answered "no" — see below.
      expect(reusesThreadPerItem(registry, { role: "implementer", config: {} })).toBe(true);
      expect(reusesThreadPerItem(registry, { role: "system", config: {} })).toBe(false);
      expect(reusesThreadPerItem(registry, { role: "reviewer", config: {} })).toBe(false);
    });

    it("ignores what `config` says, in both directions", () => {
      // The editor draws no checkbox for these, so a key here is one
      // nobody can see — written by an older EO, by MCP `agent_save`, or
      // by whoever opened the database. Acting on it would make dispatch
      // disagree with a screen that shows no control at all.
      expect(reusesThreadPerItem(registry, { role: "implementer", config: { reuseThreadPerItem: false } })).toBe(true);
      expect(reusesThreadPerItem(registry, { role: "reviewer", config: { reuseThreadPerItem: true } })).toBe(false);
      expect(reusesThreadPerItem(registry, { role: "system", config: { reuseThreadPerItem: true } })).toBe(false);
    });
  });

  /**
   * The system agent serves several actions and only some of them are
   * chats (EO-210).
   *
   * This is the half that would otherwise have shipped as a bug: flip
   * the role's boolean and `interpret` and `respond` start reusing a
   * thread keyed on a *work* item, accumulating unrelated
   * interpretations of different parks in one conversation. That is
   * exactly what EO-178's "each dispatch is a separate question" was
   * written about, and it stays true there.
   */
  describe("on the system agent, where the action decides", () => {
    const systemAgent = { role: "system", config: {} };

    it.each(THREAD_PER_CONVERSATION_ACTIONS)("keeps one thread for a %s conversation", (action) => {
      expect(reusesThreadPerItem(registry, systemAgent, action)).toBe(true);
    });

    it.each(["interpret", "respond", "intake", "refine", "review", "implement"])(
      "starts a fresh thread for %s, which runs on a work ticket",
      (action) => {
        expect(reusesThreadPerItem(registry, systemAgent, action)).toBe(false);
      },
    );

    it("answers no when nobody said what the dispatch is", () => {
      // The renderer draws a checkbox rather than dispatching a run, so
      // it has no action to offer — and the safe direction for an
      // unstated one is the behaviour EO had before this existed.
      expect(reusesThreadPerItem(registry, systemAgent)).toBe(false);
      expect(reusesThreadPerItem(registry, systemAgent, null)).toBe(false);
      expect(reusesThreadPerItem(registry, systemAgent, "")).toBe(false);
    });

    it("changes nothing for the other two shipped roles, whatever the action", () => {
      // Their answer is about the shape of their runs rather than about
      // what any one run was asked for — an implementer's thread
      // surviving a review bounce, a clarification and a direct mention
      // alike is the whole of EO-86.
      for (const action of [...THREAD_PER_CONVERSATION_ACTIONS, "implement", "review", "respond"]) {
        expect(reusesThreadPerItem(registry, { role: "implementer", config: {} }, action), action).toBe(true);
        expect(reusesThreadPerItem(registry, { role: "reviewer", config: {} }, action), action).toBe(false);
      }
    });

    it("leaves an invented role's switch a switch, whatever the action", () => {
      for (const action of [...THREAD_PER_CONVERSATION_ACTIONS, "implement"]) {
        expect(reusesThreadPerItem(registry, withConfig({ reuseThreadPerItem: true }), action), action).toBe(true);
        expect(reusesThreadPerItem(registry, withConfig({}), action), action).toBe(false);
      }
    });
  });
});

/**
 * Which roles EO ships (EO-178).
 *
 * `role` stays a plain string everywhere — ARCHITECTURE.md, "An agent is a row"'s "roles are
 * configuration, not code" — so this is a list of the ones EO has an
 * opinion about, not a closed union of what a role may be.
 */
describe("isBuiltinRole", () => {
  it("names the three EO ships and nothing else", () => {
    // EO-181 merged the product owner and the pipeline architect into
    // `system`. Spelled out rather than counted, because the list is the
    // fact: `PROMPT_FILES` and the registry's role entries are both keyed
    // on it, so an entry here without one there is a compile error rather
    // than a screen quietly offering settings EO had already decided.
    expect(BUILTIN_ROLES).toEqual(["system", "implementer", "reviewer"]);
    expect([...registry.roles.keys()]).toEqual([...BUILTIN_ROLES]);
    for (const role of BUILTIN_ROLES) expect(isBuiltinRole(registry, role)).toBe(true);
  });

  it("says no to a role somebody invented", () => {
    // A pipeline step may name a role nobody has created yet, and an
    // agent may hold one EO has never heard of. Neither is built in, and
    // neither may be refused.
    expect(isBuiltinRole(registry, "tester")).toBe(false);
    expect(isBuiltinRole(registry, "")).toBe(false);
    expect(isBuiltinRole(registry, "Implementer")).toBe(false);
  });
});

/**
 * What the registry adds beyond the constants it was built from.
 */
describe("a registry built from the developer values", () => {
  it("holds exactly the constants, so nothing that read them can tell the difference", () => {
    expect([...registry.builtins.keys()]).toEqual([...BUILTIN_ACTIONS]);
    for (const action of BUILTIN_ACTIONS) expect(registry.builtins.get(action)?.results).toBe(BUILTIN_RESULTS[action]);
    // By `packSlug:slug` since KAN-129: a type is namespaced by the pack
    // that shipped it, and the bare word could not carry two packs' own.
    expect([...registry.itemTypes.keys()]).toEqual(["developer:feature", "developer:story", "developer:bug"]);
    // Every schema the map held is declared by exactly one role, and it
    // is the same shape. Not the same *value*: the registry wraps each
    // zod schema as an `OutputSchema` where it is built (KAN-125), so
    // what the map's identity used to prove is now proved by what the
    // wrapper emits — which is what reaches the provider either way.
    for (const [action, schema] of Object.entries(SCHEMAS_BY_ACTION)) {
      expect(schemaByAction(registry, action)?.toJsonSchema(), action).toEqual(zodOutputSchema(schema).toJsonSchema());
    }
    expect(schemaByAction(registry, "implement")?.toJsonSchema()).toEqual(zodOutputSchema(ImplementOutputSchema).toJsonSchema());
    expect(schemaByAction(registry, "review")?.toJsonSchema()).toEqual(zodOutputSchema(ReviewOutputSchema).toJsonSchema());
    expect(schemaByAction(registry, "some_custom_action")).toBeUndefined();
  });

  it("keeps the schema of an action on the role that ships it, but answers by action alone", () => {
    // A role somebody invents and puts on an `implement` step is held to
    // the implementer's shape, exactly as it was when the map had no
    // notion of roles at all (ARCHITECTURE.md, "An agent is a row": roles are configuration).
    expect(registry.roles.get("implementer")?.schemasByAction.get("implement")?.toJsonSchema()).toEqual(zodOutputSchema(ImplementOutputSchema).toJsonSchema());
    expect(registry.roles.get("reviewer")?.schemasByAction.get("review")?.toJsonSchema()).toEqual(zodOutputSchema(ReviewOutputSchema).toJsonSchema());
    expect(registry.roles.get("system")?.schemasByAction.has("implement")).toBe(false);
    expect([...(registry.roles.get("system")?.schemasByAction.keys() ?? [])].sort()).toEqual(
      ["assist", "clarify", "intake", "interpret", "refine", "respond", "scenario"],
    );
    // `clarify` is in that list from KAN-129 and was not before. No step
    // declares it as an entry action and none will — it is what `refine`
    // means on a leaf, reached by dispatching `refine` — but the leaf
    // types' override *names* this shape, and an override naming
    // something the registry cannot resolve would be data in appearance
    // only. Since KAN-163 that override is the only way here: the branch
    // that reached it by asking whether an item was a container is gone.
    expect(schemaByAction(registry, "clarify")?.toJsonSchema()).toEqual(zodOutputSchema(ClarifyOutputSchema).toJsonSchema());
    expect(resultSchemaFor(registry, "refine", registry.itemTypes.get("developer:story"))?.toJsonSchema()).toEqual(
      zodOutputSchema(ClarifyOutputSchema).toJsonSchema(),
    );
  });

  it("says which prompt file each shipped role reads, and how each treats its thread", () => {
    expect(registry.roles.get("system")).toMatchObject({ prompt: "system-agent.md", threadReuse: PER_CONVERSATION });
    expect(registry.roles.get("implementer")).toMatchObject({ prompt: "implementer.md", threadReuse: true });
    expect(registry.roles.get("reviewer")).toMatchObject({ prompt: "reviewer.md", threadReuse: false });
  });

  it("describes the three developer item types as data", () => {
    expect(registry.itemTypes.get("developer:feature")).toMatchObject({
      packSlug: "developer",
      slug: "feature",
      label: "Feature",
      plural: "Features",
      container: true,
    });
    // A spec shape is a JSON Schema for the item's `spec` since KAN-147 —
    // what creation validates against and what the intake schema is
    // composed from — so what is asserted is the document, and `required`
    // is what "creation demands this" is spelled as.
    const story = registry.itemTypes.get("developer:story");
    expect(story?.container).toBe(false);
    expect(story?.specShape.required).toEqual(["acceptance_criteria"]);
    expect(story?.specShape.properties["acceptance_criteria"]).toMatchObject({ type: "array", minItems: 1, "x-eo-criteria": true });
    expect(registry.itemTypes.get("developer:bug")?.specShape.required).toEqual(["steps_to_reproduce", "expected", "actual", "environment"]);
    // The one field a bug offers as a candidate criterion without EO
    // adopting it (EO-200, EO-213).
    expect(registry.itemTypes.get("developer:bug")?.specShape.properties["expected"]).toMatchObject({ "x-eo-criteria-offer": true });
  });

  it("is built fresh on every call, so one test's registry is nobody else's", () => {
    expect(developerRegistry()).not.toBe(registry);
    expect(developerRegistry().roles).not.toBe(registry.roles);
  });
});

describe("isBuiltinAction", () => {
  it("names the functions the registry holds and nothing else", () => {
    for (const action of BUILTIN_ACTIONS) expect(isBuiltinAction(registry, action)).toBe(true);
    expect(isBuiltinAction(registry, "implement")).toBe(false);
    expect(isBuiltinAction(registry, null)).toBe(false);
    expect(isBuiltinAction(emptyRegistry(), "create_worktree")).toBe(false);
  });
});

/**
 * What `buildRegistry` refuses, and why it throws rather than returns.
 *
 * A registry is built once at startup from what is installed. A broken
 * one is a pack author's mistake, met on the first launch that includes
 * the pack — the right moment for a programmer error, and the wrong one
 * for a typed result nobody is there to read.
 */
describe("building a registry", () => {
  const roleWith = (schemasByAction: Record<string, z.ZodType>): RoleEntry => ({
    prompt: "x.md",
    threadReuse: false,
    schemasByAction: new Map(Object.entries(schemasByAction).map(([action, schema]) => [action, zodOutputSchema(schema)])),
  });

  it("refuses a builtin whose failure has no name", () => {
    expect(() => buildRegistry({ ...emptyRegistry(), builtins: new Map([["deploy", { label: "Deploy", results: ["deployed"], sideEffects: false }]]) })).toThrow(/does not declare "failed"/);
    expect(() => buildRegistry({ ...emptyRegistry(), builtins: new Map([["deploy", { label: "Deploy", results: [], sideEffects: false }]]) })).toThrow(/declares no results/);
    expect(FAILED_RESULT).toBe("failed");
  });

  it("refuses a builtin the editor could not name, or an input it could not explain (EO-507)", () => {
    const build = (entry: BuiltinEntry) => () => buildRegistry({ ...emptyRegistry(), builtins: new Map([["deploy", entry]]) });
    const entry: BuiltinEntry = { label: "Deploy", results: ["deployed", "failed"], sideEffects: false };
    expect(build(entry)).not.toThrow();
    expect(build({ ...entry, label: " " })).toThrow(/declares no label/);
    expect(build({ ...entry, inputs: { target: { type: "string", description: "" } } })).toThrow(/"target" input has no description/);
    expect(build({ ...entry, inputs: { wait: { type: "number", description: "Seconds.", default: "ten" } } })).toThrow(/declared a number with a default that is not one/);
    expect(build({ ...entry, inputs: { wait: { type: "number", description: "Seconds.", default: 10 } } })).not.toThrow();
  });

  it("carries a builtin's label and inputs across the wire (EO-507)", () => {
    const inputs = { reportReady: { type: "boolean" as const, description: "Say ready.", default: false } };
    const registry = buildRegistry({ ...emptyRegistry(), builtins: new Map([["watch", { label: "Watch it", results: ["seen", "failed"], inputs, sideEffects: false }]]) });
    const view = toRegistryView(registry);
    expect(RegistryViewSchema.parse(view)).toEqual(view);
    expect(fromRegistryView(view).builtins.get("watch")).toEqual({ label: "Watch it", results: ["seen", "failed"], inputs, sideEffects: false });
    // A function with no inputs sends none, rather than an empty record.
    const bare = toRegistryView(buildRegistry({ ...emptyRegistry(), builtins: new Map([["go", { label: "Go", results: ["failed"], sideEffects: false }]]) }));
    expect(bare.builtins[0]).not.toHaveProperty("inputs");
    expect(builtinInputs(fromRegistryView(bare), "go")).toEqual({});
    expect(builtinInputs(fromRegistryView(bare), "nothing")).toBeNull();
    expect(builtinLabel(fromRegistryView(view), "watch")).toBe("Watch it");
  });

  it("says which function opens a pull request, and carries it across the wire (EO-663)", () => {
    const shipped = developerRegistry();
    expect(BUILTIN_ACTIONS.filter((action) => builtinOpensPullRequest(shipped, action))).toEqual(["open_pull_request"]);
    expect(builtinOpensPullRequest(shipped, null)).toBe(false);
    expect(builtinOpensPullRequest(shipped, "nothing")).toBe(false);
    const view = toRegistryView(shipped);
    expect(RegistryViewSchema.parse(view)).toEqual(view);
    expect(builtinOpensPullRequest(fromRegistryView(view), "open_pull_request")).toBe(true);
    expect(view.builtins.find((builtin) => builtin.action === "create_worktree")).not.toHaveProperty("opensPullRequest");
  });

  it("refuses two roles declaring one action's schema, since the lookup is by action", () => {
    const roles = new Map([
      ["a", roleWith({ review: ReviewOutputSchema })],
      ["b", roleWith({ review: ReviewOutputSchema })],
    ]);
    expect(() => buildRegistry({ ...emptyRegistry(), roles })).toThrow(/"a" and "b" both declare a schema for "review"/);
  });

  it("returns what it was given when nothing is wrong", () => {
    const built = { ...emptyRegistry(), roles: new Map([["a", roleWith({ review: ReviewOutputSchema })]]) };
    expect(buildRegistry(built)).toBe(built);
    expect(buildRegistry(emptyRegistry()).roles.size).toBe(0);
  });
});

/**
 * The wire form (`registry:get`), and that nothing is lost on the way
 * except the schemas, which are meant to stay behind.
 */
describe("the registry over IPC", () => {
  it("round-trips everything but the schemas, and validates against its own contract", () => {
    const view = toRegistryView(registry);
    expect(RegistryViewSchema.parse(view)).toEqual(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);

    const back = fromRegistryView(view);
    expect([...back.roles.keys()]).toEqual([...registry.roles.keys()]);
    for (const [slug, role] of registry.roles) {
      expect(back.roles.get(slug)).toEqual({ prompt: role.prompt, threadReuse: role.threadReuse, actions: role.actions });
    }
    expect(back.builtins).toEqual(registry.builtins);
    expect(back.itemTypes).toEqual(registry.itemTypes);
    expect("schemasByAction" in (view.roles[0] ?? {})).toBe(false);
  });

  it("answers the renderer's two questions the same way the main process does", () => {
    // The whole reason the registry crosses IPC: the editor's built-in
    // marking and its thread-reuse checkbox must agree with dispatch.
    const facts = fromRegistryView(toRegistryView(registry));
    for (const role of ["system", "implementer", "reviewer", "tester", ""]) {
      expect(isBuiltinRole(facts, role), role).toBe(isBuiltinRole(registry, role));
      for (const action of [undefined, ...THREAD_PER_CONVERSATION_ACTIONS, "implement"]) {
        expect(reusesThreadPerItem(facts, { role, config: {} }, action), `${role}/${action}`).toBe(reusesThreadPerItem(registry, { role, config: {} }, action));
      }
    }
    for (const action of [...BUILTIN_ACTIONS, "implement", null]) {
      expect(builtinResults(facts, action)).toEqual(builtinResults(registry, action));
    }
  });
});

/**
 * What an action is, short of its schema (EO-423): the facts
 * `validatePipeline` holds an agent step's routes to, and the renderer
 * holds a copy of.
 */
describe("the actions a registry declares (EO-423)", () => {
  const definition = (role: string, action: string, keys: string[]) => ({
    definition: {
      id: `${role}:${action}`,
      role,
      action,
      description: `What ${action} is for.`,
      results: keys.map((key) => ({ key, label: key.toUpperCase(), meaning: "" })),
      fields: {},
      createdAt: 0,
      updatedAt: 0,
    },
    schema: zodOutputSchema(ReviewOutputSchema),
  });

  const defined = new Map([
    ["qa", new Map([["alignment", definition("qa", "alignment", ["aligned", "gaps_found"])], ["review", definition("qa", "review", ["passed"])]])],
  ]);
  const withDefinitions = { ...registry, roleActions: roleActionFactsOf(defined) };

  it("declares the results of the four actions the developer pack's steps dispatch, on the role that ships each", () => {
    const keysOf = (role: string, action: string) => registry.roles.get(role)?.actions?.get(action)?.results.map((result) => result.key);

    expect(keysOf("implementer", "implement")).toEqual(["done"]);
    expect(keysOf("reviewer", "review")).toEqual(["approved", "changes_requested", "needs_user_input"]);
    expect(keysOf("system", "refine")).toEqual(["decomposed", "clarified"]);
    expect(keysOf("system", "intake")).toEqual(["done", "classified_non_feature"]);
  });

  it("declares an action only where the same role ships its schema, and none that no step dispatches", () => {
    for (const [slug, role] of registry.roles) {
      for (const [action, facts] of role.actions ?? []) {
        expect(roleShipsAction(registry, slug, action), `${slug}/${action}`).toBe(true);
        expect(isUndispatchedAction(action), action).toBe(false);
        expect(facts.packShipped).toBe(true);
        expect(facts.results.every((result) => result.label !== "")).toBe(true);
      }
    }
  });

  it("lists every key refine can report on the types the pack ships", () => {
    const keys = registry.roles.get("system")?.actions?.get("refine")?.results.map((result) => result.key) ?? [];
    for (const type of registry.itemTypes.values()) expect(keys).toContain(type.actionOverrides["refine"]?.resultKey);
  });

  it("answers with the role's own definition first, then the pack's by action name, and never another role's", () => {
    expect(actionFactsFor(withDefinitions, "qa", "alignment")).toEqual({
      description: "What alignment is for.",
      // With when to return each and the extra answer fields (EO-425):
      // a role's own definition says both, and a pack's action neither.
      results: [
        { key: "aligned", label: "ALIGNED", meaning: "" },
        { key: "gaps_found", label: "GAPS_FOUND", meaning: "" },
      ],
      packShipped: false,
      fields: {},
    });
    // Role plus action wins over the pack's action of the same name…
    expect(actionFactsFor(withDefinitions, "qa", "review")?.results.map((result) => result.key)).toEqual(["passed"]);
    // …for that role alone: the reviewer and a role that defined nothing get the pack's.
    expect(actionFactsFor(withDefinitions, "reviewer", "review")?.packShipped).toBe(true);
    expect(actionFactsFor(withDefinitions, "tester", "review")?.results.map((result) => result.key)).toEqual(["approved", "changes_requested", "needs_user_input"]);
    expect(actionFactsFor(withDefinitions, "tester", "alignment")).toBeUndefined();
    expect(actionFactsFor(withDefinitions, null, "alignment")).toBeUndefined();
    expect(actionFactsFor(registry, "qa", "alignment")).toBeUndefined();
  });

  it("lists a role's own actions and the pack's it falls back to, and nothing only another role defined", () => {
    // The role's own first, `review` once and as its own; then the pack's.
    expect(actionsAvailableTo(withDefinitions, "qa").map((entry) => entry.action)).toEqual(["alignment", "review", "refine", "intake", "implement"]);
    expect(actionsAvailableTo(withDefinitions, "tester").map((entry) => entry.action)).not.toContain("alignment");
    expect(actionsAvailableTo(withDefinitions, null).map((entry) => entry.action)).not.toContain("alignment");
    // The list is `actionFactsFor` enumerated: each entry is what a dispatch would resolve.
    for (const role of ["qa", "reviewer", "implementer", "tester", null]) {
      for (const { action, facts } of actionsAvailableTo(withDefinitions, role)) expect(facts, `${role}/${action}`).toEqual(actionFactsFor(withDefinitions, role, action));
    }
  });

  it("carries both kinds across the wire and answers the same on the far side", () => {
    const view = toRegistryView(withDefinitions);
    expect(RegistryViewSchema.parse(view)).toEqual(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(view.roleActions).toEqual([
      {
        role: "qa",
        actions: [
          {
            action: "alignment",
            description: "What alignment is for.",
            results: [{ key: "aligned", label: "ALIGNED", meaning: "" }, { key: "gaps_found", label: "GAPS_FOUND", meaning: "" }],
            packShipped: false,
            fields: {},
          },
          { action: "review", description: "What review is for.", results: [{ key: "passed", label: "PASSED", meaning: "" }], packShipped: false, fields: {} },
        ],
      },
    ]);

    const facts = fromRegistryView(view);
    // A role that only defines actions is still not one a pack ships.
    expect(isBuiltinRole(facts, "qa")).toBe(false);
    for (const role of ["qa", "reviewer", "implementer", "system", "tester", null]) {
      for (const action of ["alignment", "review", "implement", "refine", "intake", "respond", "ponder"]) {
        expect(actionFactsFor(facts, role, action), `${role}/${action}`).toEqual(actionFactsFor(withDefinitions, role, action));
      }
    }
  });

  it("reads a view written before actions were on it as a registry that declares none", () => {
    const view = toRegistryView(registry);
    const older = { ...view, roles: view.roles.map(({ actions: _actions, ...role }) => role), roleActions: undefined };

    expect(actionFactsFor(fromRegistryView(older), "reviewer", "review")).toBeUndefined();
  });

  it("refuses a pack's action that declares no results", () => {
    const role: RoleEntry = { prompt: "x.md", threadReuse: false, schemasByAction: new Map(), actions: new Map([["review", { description: "", results: [], packShipped: true }]]) };
    expect(() => buildRegistry({ ...emptyRegistry(), roles: new Map([["reviewer", role]]) })).toThrow(/"reviewer" role's "review" action declares no results/);
  });
});
