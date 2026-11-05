import { describe, expect, it } from "vitest";
import { TOOLS } from "./catalog.js";
import { GUIDES, guideNamed } from "./guides.js";
import { renderEngineStatus } from "./render.js";
import { SERVER_INSTRUCTIONS } from "./server.js";

describe("the guides", () => {
  it("are named so a client can tell whose they are", () => {
    for (const guide of GUIDES) {
      expect(guide.name, guide.name).toMatch(/^eo_[a-z_]+$/);
      expect(guide.description.length, guide.name).toBeGreaterThan(40);
      expect(guide.body.length, guide.name).toBeGreaterThan(400);
    }
  });

  it("covers the four things a client cannot infer from tool descriptions", () => {
    expect(GUIDES.map((guide) => guide.name)).toEqual(["eo_orient", "eo_submit_work", "eo_change_pipeline", "eo_unblock"]);
  });

  it("says the system agent carries on while EO is paused, in the guide and the tools that tell of a pause (EO-615)", () => {
    const flat = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ");

    expect(flat(guideNamed("eo_unblock")?.body)).toContain("system agent, which carries on while paused");
    for (const name of ["engine_pause", "engine_status"]) {
      expect(flat(TOOLS.find((tool) => tool.name === name)?.description), name).toMatch(/system agent.*carr(y|ies) on while paused/);
    }
    expect(renderEngineStatus({ paused: true, activeRunCount: 1, finishingRunCount: 0 })).toContain("the system agent's runs, which carry on while paused");
  });

  it("warns that saving a pipeline replaces the whole graph", () => {
    // The one irreversible mistake available to a connected client: a
    // step left out of a save is a step deleted, along with its routes.
    const pipeline = guideNamed("eo_change_pipeline");

    expect(pipeline?.body).toContain("replaces what");
    expect(pipeline?.body).toContain("pipeline_get");
  });

  it("says what entry rules are, how to set them, and what they do not replace (EO-610)", () => {
    const flat = (guideNamed("eo_change_pipeline")?.body ?? "").replace(/\s+/g, " ");

    expect(flat).toContain("`entryRules` is an ordered list of what an item must have to enter");
    expect(flat).toContain("leaving `entryRules` out keeps what the pipeline has and `[]` clears them");
    expect(flat).toContain("They replace nothing a module step does after entry");
  });

  it("tells whoever changes a pipeline not to hardcode what differs between machines", () => {
    // A pipeline, its modules and its agents' instructions are exported,
    // imported and published, and a client outside EO reads this guide
    // instead of the system agent's prompt, so it carries the same rule
    // (EO-448).
    const flat = (guideNamed("eo_change_pipeline")?.body ?? "").replace(/\s+/g, " ");

    expect(flat).toContain("modules, module test cases, pipeline steps and agent instructions alike** — not only to module code");
    for (const kind of [
      "**Absolute or home-directory paths**",
      "**User names, host names or local ports**",
      "**One operating system's shell, commands or path separators**",
      "**Personal tooling**",
      "**A step input with a sensible default**",
      "**Read while the step runs**, from the checkout (`ctx.cwd`, git) or from the forge",
      "**A declared environment variable or secret**",
      "build every path they use from `harness.cwd`",
      "a path in a scripted `stdout` or `stderr` is a realistic fixture, and it stays rather than being stripped out",
    ]) {
      expect(flat, kind).toContain(kind);
    }
  });

  it("spells out that a plan takes indices and a single item takes keys", () => {
    // The two submit tools name the same idea differently, and a caller
    // reading only the schemas has no way to know which it is holding: a
    // plan's stories have no keys yet, so they can only refer to each
    // other by position.
    const submit = guideNamed("eo_submit_work");

    const flat = (submit?.body ?? "").replace(/\s+/g, " ");

    expect(flat).toContain("In `work_submit_plan`, `depends_on` holds **indices into your own stories array**");
    expect(flat).toContain("In `work_submit_ticket`, `dependsOn` holds **keys of tickets that already exist**");
  });

  it("says a key is accepted wherever a ticket's id is, and that no list has to be read for one (EO-539)", () => {
    const flat = (guideNamed("eo_orient")?.body ?? "").replace(/\s+/g, " ");

    expect(flat).toContain("takes its key as well: `EO-486` names the same ticket as its UUID");
    expect(flat).toContain("There is no need to read `tickets_list` to turn a key into an id");
    expect(flat).not.toMatch(/ids? (must|have to) come from `?tickets_list/i);
    // And the lists' own filters, which run in EO's query.
    for (const filter of ["stepId", "stepName", "pipelineId", "type", "parentKey", "keys", "text", "createdSince", "updatedSince", "atTerminalStep"]) {
      expect(flat, filter).toContain(`\`${filter}\``);
    }
  });

  it("demands all four facts of a bug, which reaches the board without meeting intake", () => {
    // The refusal names what is missing, but only after a round trip. A
    // bug filed from outside skips the questioning that would have found
    // these, so the guide has to ask for them up front.
    const submit = guideNamed("eo_submit_work");

    for (const fact of ["stepsToReproduce", "expected", "actual", "environment"]) {
      expect(submit?.body, fact).toContain(`\`${fact}\``);
    }
    expect(submit?.body).toContain("never meets intake");
  });

  it("says what priority means, and that a plan's stories do not inherit the feature's (EO-568)", () => {
    const guide = guideNamed("eo_submit_work")!.body.replace(/\s+/g, " ");

    expect(guide).toContain("An integer, 0 or more, and the scheduler picks the highest first: 0 is Normal, 1 High, 2 Urgent");
    expect(guide).toContain("Left out, a ticket is 0.");
    expect(guide).toContain("a story does not inherit the feature's");
    expect(guide).toMatch(/negative or fractional priority is refused/i);
  });

  it("says dependencies can be changed after filing, with item_update (EO-600)", () => {
    const guide = guideNamed("eo_submit_work")!.body.replace(/\s+/g, " ");

    expect(guide).toContain("Dependencies can be changed after filing, with `item_update`");
    expect(guide).toContain("`addDependsOn`");
    expect(guide).toContain("`removeDependsOn`");
  });

  it("says an unknown pipeline name is refused rather than guessed at", () => {
    // Work placed on a pipeline nobody asked for, reported as a success,
    // is the failure this refusal exists to prevent.
    const submit = guideNamed("eo_submit_work");

    expect(submit?.body).toContain("refused, not guessed at");
    expect(submit?.body).toContain("pipelines_list");
  });

  it("qualifies that a parent feature's repository is inherited only when it has one", () => {
    // `routeToProject` falls back to the project's rules unless the
    // parent actually carries a repository, and a feature built by
    // `work_submit_plan` never does. Told inheritance is unconditional,
    // a caller filing under such a feature on a multi-repository project
    // walks into a refusal the guide promised could not happen.
    const submit = guideNamed("eo_submit_work");

    const flat = (submit?.body ?? "").replace(/\s+/g, " ");

    expect(flat).toContain("only when that feature has one");
    expect(flat).toContain("a feature made by `work_submit_plan` has none");
  });

  it("says who understanding is written for, since they cannot see the conversation", () => {
    // The field is pinned on the feature and read by every agent
    // downstream *instead of* the conversation that produced it. A
    // submitter who thinks of it as a summary for the person writes it
    // for the wrong reader, and the work loses the only account of why
    // it exists.
    const submit = guideNamed("eo_submit_work");

    expect(submit?.body).toContain("instead of* your conversation");
    expect(submit?.body).toContain("decisions");
  });

  it("says what to do after work is handed over", () => {
    // Handing over is not the end of the exchange: an agent that needs a
    // decision posts a comment and ends its run, so a submitter who
    // never looks again will not be told anything is waiting.
    const submit = guideNamed("eo_submit_work");

    expect(submit?.body).toContain("inbox_list");
    expect(submit?.body).toContain("parentId");
  });

  it("names only tools that exist", () => {
    // A guide is read at the moment someone is about to act on it, so a
    // tool name that has been withdrawn sends them at a door that is not
    // there — the same defect that made this whole change necessary.
    const offered = new Set(TOOLS.map((tool) => tool.name));
    const named = new Set(
      GUIDES.flatMap((guide) => [...guide.body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!)),
    );

    // Only backticked words that look like tool names, minus two kinds
    // that legitimately appear: argument names, which a guide has to be
    // able to spell out, and the names of other guides — one guide
    // pointing at the next is what keeps the set navigable rather than
    // four walls of text nobody knows to connect.
    const fields = new Set(["result_key", "run_events", "cancelActiveRun", "user_attention", "depends_on"]);
    const guides = new Set(GUIDES.map((guide) => guide.name));
    const missing = [...named].filter((word) => !offered.has(word) && !fields.has(word) && !guides.has(word));

    expect(missing).toEqual([]);
    expect(named.size).toBeGreaterThan(5);
  });

  it("does not repeat what the instructions already say in every context", () => {
    // Instructions are always loaded; guides are fetched. Restating the
    // instructions in a guide costs context on every session to save it
    // on none.
    for (const guide of GUIDES) {
      expect(SERVER_INSTRUCTIONS.includes(guide.body), guide.name).toBe(false);
    }
  });

  it("are named by the instructions, which is the one text every session reads", () => {
    // The guides shipped unreachable in practice: `prompts/list` is a
    // call most clients never make, and `eo_guide` is one name among
    // thirty that a model has to notice for itself. Unless the
    // always-loaded text says the guides are there and roughly what each
    // is for, three pages of procedure get read after the refusal they
    // would have prevented — or never. This is what stops a rewording of
    // the instructions quietly hiding them again.
    expect(SERVER_INSTRUCTIONS).toContain("eo_guide");
    for (const guide of GUIDES) expect(SERVER_INSTRUCTIONS, guide.name).toContain(guide.name);
  });

  it("are pointed at from the two tools most easily used wrongly", () => {
    // The submit tools are where a caller can do real damage while
    // succeeding — a plan on the wrong pipeline, a bug that skipped
    // intake. A description cannot hold the procedure, so it has to hold
    // the pointer.
    for (const name of ["work_submit_plan", "work_submit_ticket"]) {
      const tool = TOOLS.find((candidate) => candidate.name === name);

      expect(tool?.description, name).toContain("eo_submit_work");
      expect(tool?.description, name).toContain("eo_guide");
    }
  });
});

describe("the eo_guide tool", () => {
  const guideTool = TOOLS.find((tool) => tool.name === "eo_guide")!;
  const noDispatch = () => Promise.reject(new Error("a guide must not reach a handler"));

  it("exists, so a client that cannot fetch a prompt is not shut out", () => {
    // Prompt support is uneven across clients. A guide only reachable
    // through prompts/get is a guide most callers cannot read.
    expect(guideTool).toBeDefined();
    expect(guideTool.channels).toEqual([]);
  });

  it("lists what exists when asked for nothing", async () => {
    const outcome = await guideTool.run(noDispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const guide of GUIDES) expect(outcome.text).toContain(guide.name);
  });

  it("serves the same text the prompt does", async () => {
    const outcome = await guideTool.run(noDispatch, { name: "eo_unblock" });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe(guideNamed("eo_unblock")?.body);
  });

  it("puts the guide in `data` as well as `text`, because a client may show either", async () => {
    // Both halves of a successful call go out: `text` as `content` and
    // `data` as `structuredContent`. With the body in `text` alone, a
    // client that prefers structured output was handed a name and a
    // title — a well-formed answer with the guide missing from it, and
    // nothing about it a caller could notice (EO-202).
    for (const guide of GUIDES) {
      const outcome = await guideTool.run(noDispatch, { name: guide.name });

      expect(outcome.ok, guide.name).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.data, guide.name).toEqual({ name: guide.name, title: guide.title, body: guide.body });
      expect(outcome.text, guide.name).toBe(guide.body);
    }
  });

  it("lists in `data` everything it lists in `text`, so the listing has the same two doors", async () => {
    const outcome = await guideTool.run(noDispatch, {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toEqual({
      guides: GUIDES.map((guide) => ({ name: guide.name, title: guide.title, description: guide.description })),
    });
  });

  it("says what exists when asked for one that does not", async () => {
    const outcome = await guideTool.run(noDispatch, { name: "eo_nonsense" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("no arguments");
  });

  it("names every guide in its own description, which is all most callers read", () => {
    // The listing is a second call, and a model choosing between tools
    // sees only this. A guide missing from it is a guide nobody knows to
    // ask for.
    for (const guide of GUIDES) expect(guideTool.description, guide.name).toContain(guide.name);
  });

  it("documents the narrowing parameters every read tool takes in eo_orient (EO-538)", () => {
    const flat = (guideNamed("eo_orient")?.body ?? "").replace(/\s+/g, " ");

    for (const term of ["**`fields`**", "**`where`**", "**`sort`**", "**`limit`** (at most 1,000) and **`offset`**", "`total`", "`returned`", "`nextOffset`", "40,000 characters"]) {
      expect(flat, term).toContain(term);
    }
    for (const op of ["`eq`", "`ne`", "`in`", "`contains`", "`gt`", "`gte`", "`lt`", "`lte`", "`exists`"]) expect(flat, op).toContain(op);
  });

  it("offers only the guides that exist, so a client cannot guess wrong", () => {
    expect(guideTool.inputSchema["properties"]).toMatchObject({ name: { enum: GUIDES.map((guide) => guide.name) } });
  });
});
