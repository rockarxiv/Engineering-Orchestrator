import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { advertisedSpelling, TOOLS } from "./catalog.js";
import { boundaryArguments, LEGACY_BOUNDARY_NAMES, toLegacyShape } from "./legacyNames.js";
import { inputSchemaFor } from "./toolSchema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/**
 * Every tool a client has actually registered against.
 *
 * Which is everything bar the `item_*` twins, and a twin is exactly a
 * tool that *is* some deprecated name's replacement — so this is read
 * off the pairing rather than off a field, and cannot fall behind it.
 *
 * And bar a tool *added* in EO's own vocabulary (EO-310). `item_decide`
 * is not a twin of anything: nobody has ever called it under another
 * name, so there is no registration to keep working and nothing frozen
 * about it. Offering it `ticketId` would be EO inventing a legacy it
 * never had. Read off the name for `catalog.ts`'s reason — a tool whose
 * name says `item` takes `itemId`, and the two places that decide it
 * cannot drift apart while they ask the same question of the same
 * string.
 */
const legacyTools = TOOLS.filter((tool) => advertisedSpelling(tool.name) === "ticket");

function advertised(name: string): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  return (tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
}

/**
 * The tools EO offers over MCP did not change when the entity did
 * (KAN-145).
 *
 * The rename kept the tool *names* — `ticket_get`, `tickets_list`,
 * `work_submit_ticket` — because external clients registered against
 * them through `mcp:registerWith`. It did not, at first, keep the
 * arguments those names take, and that is the hole these tests stand in:
 * every tool's input schema is generated from the IPC contract, so
 * renaming `ticketId` to `itemId` in the contract renamed it on the wire
 * too, and a client calling the tool it had always called was answered
 * "Invalid arguments" — or, where the field was optional, was answered
 * cheerfully with something else entirely.
 *
 * KAN-162 gave each of those names an `item_*` twin, which *does*
 * advertise `itemId`. So every check here is now about the tools
 * somebody's installed client is actually calling, rather than about the
 * whole catalog. The *answers* are untouched by that split — every tool
 * here answers in this vocabulary, twins included — and
 * `aliases.test.ts` is where a pair is held to answering identically.
 */
describe("the MCP boundary still speaks the old vocabulary", () => {
  /**
   * The invariant, rather than a list of the twelve tools that needed
   * it today. A channel that grows an item-shaped field later gets the
   * same translation for free through `channelTool`, and a *hand-built*
   * tool that forgets it fails here.
   */
  it("advertises no item-shaped argument on any tool a client registered against", () => {
    const offenders: string[] = [];
    for (const tool of legacyTools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const name of Object.keys(properties)) {
        if (name in LEGACY_BOUNDARY_NAMES) offenders.push(`${tool.name}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The twelve as they stood, named rather than counted — because the
   * point of the criterion is that these exact calls, which worked
   * before the rename, work after it.
   */
  it("takes ticketId on every tool that took one before", () => {
    const takesTicketId = legacyTools.filter((tool) => "ticketId" in ((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).map((tool) => tool.name);
    expect(takesTicketId.sort()).toEqual(
      ["comment_post", "jira_pull", "spend_read", "ticket_archive", "ticket_delete", "ticket_get", "ticket_hold", "ticket_move", "ticket_resume", "ticket_update"].sort(),
    );
    expect(Object.keys(advertised("worktree_release"))).toContain("ticketKey");
    expect(Object.keys(advertised("guardrails_set"))).toEqual(expect.arrayContaining(["perTicketAttemptLimit", "perTicketBudgetCents"]));
  });

  /**
   * Self-maintaining, so the table cannot fall behind the contract it
   * mirrors. Rename something else to `item…` in `ipc-schemas.ts` and
   * this fails until somebody decides whether the boundary has to carry
   * the old spelling of it too — which is the decision, not a chore.
   *
   * `itemTypes` is the reason this reads the IPC schemas rather than the
   * whole of `packages/core`: it lives on the registry, it was always
   * called that, and a table that "fixed" it would invent a
   * `ticketTypes` field no client has ever seen.
   */
  it("covers every item-shaped key the IPC contract carries", () => {
    const source = readFileSync(join(repoRoot, "packages", "core", "src", "ipc-schemas.ts"), "utf8");
    const declared = new Set<string>();
    for (const match of source.matchAll(/^\s{2,}(item|items|item[A-Z]\w*|perItem\w*):/gm)) declared.add(match[1]!);

    expect([...declared].sort()).toEqual(Object.keys(LEGACY_BOUNDARY_NAMES).sort());
  });

  it("leaves itemTypes alone, because it never was a ticket", () => {
    expect("itemTypes" in LEGACY_BOUNDARY_NAMES).toBe(false);
    expect(toLegacyShape({ itemTypes: { story: { label: "Story" } } })).toEqual({ itemTypes: { story: { label: "Story" } } });
  });
});

describe("translating a tool's arguments", () => {
  it("advertises the old name and hands the channel the new one", () => {
    const channel = z.object({ itemId: z.string(), archived: z.boolean() });
    const legacy = boundaryArguments(channel, "ticket");

    expect(inputSchemaFor(legacy.advertised)["properties"]).toHaveProperty("ticketId");
    expect(inputSchemaFor(legacy.advertised)["properties"]).not.toHaveProperty("itemId");
    expect(legacy.accepts.safeParse({ ticketId: "t1", archived: true })).toMatchObject({ success: true, data: { itemId: "t1", archived: true } });
  });

  /**
   * The other reading of the same spec (KAN-162). The twin advertises
   * what the channel declares, and its *acceptance* is the same schema
   * as the deprecated name's — which is what makes an identical call to
   * either name an identical call.
   */
  it("advertises the current name on the item-spelled twin, and accepts either on both", () => {
    const channel = z.object({ itemId: z.string(), archived: z.boolean() });
    const current = boundaryArguments(channel, "item");
    const legacy = boundaryArguments(channel, "ticket");

    expect(inputSchemaFor(current.advertised)["properties"]).toHaveProperty("itemId");
    expect(inputSchemaFor(current.advertised)["properties"]).not.toHaveProperty("ticketId");
    for (const boundary of [current, legacy]) {
      expect(boundary.accepts.safeParse({ itemId: "t1", archived: true })).toMatchObject({ success: true, data: { itemId: "t1", archived: true } });
      expect(boundary.accepts.safeParse({ ticketId: "t1", archived: true })).toMatchObject({ success: true, data: { itemId: "t1", archived: true } });
    }
  });

  /**
   * By identity, which is what `channelTool` reads to decide whether a
   * tool needs parsing at all — so a wrapper that always allocated would
   * quietly start validating twenty channels it used to pass through.
   */
  it("returns the schema untouched when nothing in it was renamed", () => {
    const channel = z.object({ repositoryId: z.string() });

    for (const spelling of ["item", "ticket"] as const) {
      const boundary = boundaryArguments(channel, spelling);
      expect(boundary.translated).toBe(false);
      expect(boundary.advertised).toBe(channel);
      expect(boundary.accepts).toBe(channel);
    }
  });

  it("keeps each field's description, its default and whether it is required", () => {
    const channel = z.object({
      itemId: z.string().describe("which one"),
      cancelActiveRun: z.boolean().default(false),
      comment: z.string().optional(),
    });
    const json = inputSchemaFor(boundaryArguments(channel, "ticket").advertised);

    expect(json["required"]).toEqual(["ticketId"]);
    expect((json["properties"] as Record<string, { description?: string }>)["ticketId"]?.description).toBe("which one");
    expect(json["properties"]).toHaveProperty("cancelActiveRun");
    expect(json["additionalProperties"]).toBe(false);
  });

  /**
   * Arguments are flat and a payload is not. `comment_post` carries a
   * body somebody typed; a rename that recursed would be rewriting what
   * they wrote if they happened to use one of these words as a key.
   */
  it("renames only the top level", () => {
    const channel = z.object({ itemId: z.string(), payload: z.object({ itemId: z.string() }) });
    const json = inputSchemaFor(boundaryArguments(channel, "ticket").advertised);
    const nested = (json["properties"] as Record<string, { properties?: Record<string, unknown> }>)["payload"];

    expect(json["properties"]).toHaveProperty("ticketId");
    expect(nested?.properties).toHaveProperty("itemId");
  });

  /**
   * The channel's own schema does the whole of the validation, so a
   * caller that gets a field wrong is answered about the field the
   * channel declares rather than about a copy of it made here.
   */
  it("reports a bad value in the channel's own words", () => {
    const channel = z.object({ itemId: z.string(), archived: z.boolean() });

    const refused = boundaryArguments(channel, "ticket").accepts.safeParse({ ticketId: "t1", archived: "yes" });

    expect(refused.success).toBe(false);
    expect(refused.success === false && refused.error.issues[0]?.path).toEqual(["archived"]);
  });
});

/**
 * The half of the freeze that is easy to get wrong, and was.
 *
 * An ordinary `z.object` strips a key it has never heard of. On a
 * *required* field that still fails, because the field it wanted is
 * missing — but on an *optional* one it succeeds, having quietly thrown
 * away the only thing the caller asked for. KAN-145 answered that by
 * refusing the new spelling by name; KAN-162 answers it by taking it,
 * which is what an `item_*` twin has to do to be worth having.
 *
 * What is left of the original danger is one case: a call that sends
 * both spellings of one field. There the guess EO would have to make is
 * exactly the wrong answer the freeze existed to prevent, so that one is
 * refused, by name.
 */
describe("taking either spelling, and refusing both at once", () => {
  it("takes an optional renamed field under EO's own name", () => {
    const channel = z.object({ itemId: z.string().optional(), date: z.string().optional() });

    expect(boundaryArguments(channel, "ticket").accepts.safeParse({ itemId: "t1" })).toMatchObject({ success: true, data: { itemId: "t1" } });
  });

  it("takes a required renamed field under either name", () => {
    const channel = z.object({ itemId: z.string(), toStepId: z.string() });
    const boundary = boundaryArguments(channel, "ticket");

    expect(boundary.accepts.safeParse({ itemId: "t1", toStepId: "review" })).toMatchObject({ success: true, data: { itemId: "t1" } });
    expect(boundary.accepts.safeParse({ ticketId: "t1", toStepId: "review" })).toMatchObject({ success: true, data: { itemId: "t1" } });
  });

  /**
   * Zod skips a refinement once the value it refines has already failed,
   * so a check written *on* the object would have gone unheard on
   * exactly the tools whose renamed field is required — the caller would
   * have been told "expected string, received undefined" about a field
   * it never mentioned. The guard sits ahead of the object for this
   * reason, and this is what proves it.
   */
  it("names both spellings when a call sends both, on a required field", () => {
    const channel = z.object({ itemId: z.string(), toStepId: z.string() });

    const refused = boundaryArguments(channel, "ticket").accepts.safeParse({ itemId: "a", ticketId: "b", toStepId: "review" });

    expect(refused.success).toBe(false);
    const said = refused.success === false ? refused.error.issues.map((issue) => issue.message).join(" ") : "";
    expect(said).toContain("`ticketId`");
    expect(said).toContain("`itemId`");
    expect(refused.success === false && refused.error.issues[0]?.path).toEqual(["itemId"]);
  });

  it("names every field a call spelled twice, not only the first", () => {
    const channel = z.object({ perItemAttemptLimit: z.number().optional(), perItemBudgetCents: z.number().nullable().optional() });

    const refused = boundaryArguments(channel, "ticket").accepts.safeParse({
      perItemAttemptLimit: 5,
      perTicketAttemptLimit: 6,
      perItemBudgetCents: 2_500,
      perTicketBudgetCents: 3_000,
    });

    expect(refused.success).toBe(false);
    const said = refused.success === false ? refused.error.issues.map((issue) => issue.message).join(" ") : "";
    expect(said).toContain("`perTicketAttemptLimit`");
    expect(said).toContain("`perTicketBudgetCents`");
  });

  /**
   * A key that was always spelled this way, or one that is simply a
   * typo, behaves as it always did — refusing those would be changing
   * the boundary rather than widening it by the one field it names.
   */
  it("still strips an unknown key that was never renamed", () => {
    const channel = z.object({ itemId: z.string().optional() });

    expect(boundaryArguments(channel, "ticket").accepts.safeParse({ ticketId: "t1", nonsense: 1 })).toMatchObject({ success: true, data: { itemId: "t1" } });
  });

  it("accepts a call that names nothing at all, because both fields are optional", () => {
    const channel = z.object({ itemId: z.string().optional(), date: z.string().optional() });

    expect(boundaryArguments(channel, "ticket").accepts.safeParse({})).toMatchObject({ success: true, data: {} });
  });
});

describe("translating what a tool answers with", () => {
  it("renames keys at every depth, because a response is a document", () => {
    expect(toLegacyShape({ item: { key: "EO-1" }, comments: [{ itemId: "t1" }] })).toEqual({ ticket: { key: "EO-1" }, comments: [{ ticketId: "t1" }] });
  });

  it("renames keys and never values", () => {
    // The title is what somebody wrote. Editing it would be the one
    // thing worse than not translating at all.
    expect(toLegacyShape({ items: [{ itemTitle: "Fix the item list" }] })).toEqual({ tickets: [{ ticketTitle: "Fix the item list" }] });
  });

  it("carries nulls, arrays and primitives through unchanged", () => {
    expect(toLegacyShape({ item: null, itemCount: 0, tags: ["a", "b"] })).toEqual({ ticket: null, ticketCount: 0, tags: ["a", "b"] });
    expect(toLegacyShape(null)).toBe(null);
    expect(toLegacyShape("item")).toBe("item");
  });

  it("leaves a Date as a Date rather than rebuilding it as an object", () => {
    const at = new Date(0);
    expect((toLegacyShape({ at }) as { at: unknown }).at).toBe(at);
  });
});
