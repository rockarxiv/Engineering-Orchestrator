import { DEPRECATED_TOOL_NAMES, deprecationNotice, replacementToolName, type IpcChannel } from "@eo/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemSections, listItemSummaries } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { advertisedSpelling, TOOLS, type ToolSpec } from "./catalog.js";
import { answerToolCall } from "./server.js";
import { RESOLVE_KEY_CHANNEL } from "./itemKeys.js";

/**
 * Both names of every tool a client registered against (KAN-162).
 *
 * KAN-145 renamed the entity to `item` and left the MCP tool names
 * alone, because external clients registered against `ticket_get`,
 * `ticket_move`, `tickets_list` and `work_submit_ticket` through
 * `mcp:registerWith` (ARCHITECTURE.md, "Vocabulary"). This story gave
 * each of them an `item_*` twin so that there is something to migrate
 * *to* before the old name is retired — and the whole value of a twin is
 * that it is not a second tool. A pair that diverged in what it
 * dispatched, what it refused, or what it said would be two tools with a
 * story about being one, and the client that trusted the story would
 * find out a release later.
 *
 * So this is table-driven on purpose: one row per pair, every row driven
 * through the real registry against a real database, and the four calls
 * a pair can be made in — either name, in either spelling of its
 * arguments — held to one answer.
 *
 * ## Through `answerToolCall`, not through `ToolSpec.run`
 *
 * The first version of this file compared `run`'s `ToolOutcome`, which
 * is one layer too low to prove anything a client cares about: the
 * vocabulary translation and the gate refusal both happen *above* it, in
 * `callTool`, so a pair could agree there and still hand back two
 * different documents. It did, in fact — the twin answered `item` where
 * the name it aliases answered `ticket`, and this test was green.
 *
 * So every call here goes through `answerToolCall`, which is what the
 * `tools/call` handler calls and therefore what a client actually
 * receives: `isError`, the rendered `content`, and the
 * `structuredContent` it parses.
 */
const here = dirname(fileURLToPath(import.meta.url));
const opts = { exposeErrorDetails: true };

function tool(name: string): ToolSpec {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

/** One call, as a client makes it: by name, over the ungated internal host. */
function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

/**
 * One pair, and how to answer it.
 *
 * `legacy` and `current` are the *same call* in the two spellings — the
 * only difference a renamed key makes — so a row whose arguments name
 * nothing that was renamed gives the same object twice, deliberately,
 * rather than being exempted from half the checks.
 */
interface Pair {
  deprecated: string;
  channel: IpcChannel;
  legacy: Record<string, unknown>;
  current: Record<string, unknown>;
  /** Bound to its own channel here, so nothing in the table needs a cast. */
  register: (handle: DbHandle, itemId: string) => void;
}

const PAIRS: readonly Pair[] = [
  {
    deprecated: "tickets_list",
    channel: "items:list",
    legacy: {},
    current: {},
    register: (handle) => registerHandler("items:list", () => listItemSummaries(handle.db, null), opts),
  },
  {
    deprecated: "tickets_list_archived",
    channel: "items:listArchived",
    legacy: {},
    current: {},
    register: () => registerHandler("items:listArchived", () => ({ items: [] }), opts),
  },
  {
    deprecated: "ticket_get",
    channel: "items:getSections",
    legacy: { ticketId: "" },
    current: { itemId: "" },
    // The one row read off the database rather than canned, because it
    // is the deep one: an item that carries comments that carry an
    // `itemId` apiece is what proves the translation is not just the top
    // level.
    register: (handle) => registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts),
  },
  {
    deprecated: "work_submit_ticket",
    channel: "work:submitItem",
    legacy: { type: "story", title: "Rate limit the import", body: "It falls over at 200/s.", acceptanceCriteria: ["Refuses past 200/s"] },
    current: { type: "story", title: "Rate limit the import", body: "It falls over at 200/s.", acceptanceCriteria: ["Refuses past 200/s"] },
    register: () => registerHandler("work:submitItem", () => ({ created: true, key: "EO-9", problem: null }), opts),
  },
  {
    deprecated: "ticket_update",
    channel: "items:update",
    legacy: { ticketId: "", title: "Rate limit the import, properly" },
    current: { itemId: "", title: "Rate limit the import, properly" },
    register: () => registerHandler("items:update", () => ({ updated: true, problem: null }), opts),
  },
  {
    deprecated: "ticket_move",
    channel: "items:move",
    legacy: { ticketId: "", toStepId: "review", comment: "Ready for a look." },
    current: { itemId: "", toStepId: "review", comment: "Ready for a look." },
    register: () =>
      registerHandler("items:move", () => ({ moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null }), opts),
  },
  {
    deprecated: "ticket_hold",
    channel: "items:hold",
    legacy: { ticketId: "", comment: "Parked pending a decision." },
    current: { itemId: "", comment: "Parked pending a decision." },
    register: () => registerHandler("items:hold", () => ({ held: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null }), opts),
  },
  {
    deprecated: "ticket_resume",
    channel: "items:resume",
    legacy: { ticketId: "" },
    current: { itemId: "" },
    register: () => registerHandler("items:resume", () => ({ resumed: true, cancelledRunId: null, blockedByActiveRun: false }), opts),
  },
  {
    deprecated: "ticket_archive",
    channel: "items:setArchived",
    legacy: { ticketId: "", archived: true },
    current: { itemId: "", archived: true },
    register: () => registerHandler("items:setArchived", () => ({ archived: true, problem: null }), opts),
  },
  {
    deprecated: "ticket_delete",
    channel: "items:delete",
    legacy: { ticketId: "" },
    current: { itemId: "" },
    register: () =>
      registerHandler(
        "items:delete",
        () => ({ deleted: true, deletedCount: 1, blockedByActiveRun: false, blockedByUncommittedWork: false, problem: null, jira: null, leftoverWorktrees: [] }),
        opts,
      ),
  },
];

/** The row's arguments with the real item id put where the table left a hole. */
function withId(args: Record<string, unknown>, itemId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ["ticketId", "itemId"]) if (key in out) out[key] = itemId;
  return out;
}

let handle: DbHandle;
let itemId: string;
let itemKey: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
  itemId = item.id;
  itemKey = item.key;
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

describe("a tool and its twin", () => {
  /**
   * The table covers the whole list, and the list is what the screens
   * telling the person about the aliases read. A pair added to
   * `deprecations.ts` and not here would be an alias nothing has ever
   * proved is one.
   *
   * `ticket_detail` is the exception, and it is not this host's: it is
   * advertised by `mcp/eoServer.mjs`, the service every dispatched agent
   * talks to, and `eoServer.test.ts` holds that pair.
   */
  it("covers every pair this host offers", () => {
    const offered = DEPRECATED_TOOL_NAMES.filter((entry) => entry.server === "eo_host").map((entry) => entry.deprecated);

    expect(PAIRS.map((pair) => pair.deprecated).sort()).toEqual(offered.sort());
  });

  it.each(PAIRS.map((pair) => [pair.deprecated, pair] as const))("answers identically under either name: %s", async (deprecated, pair) => {
    const replacement = replacementToolName(deprecated);
    if (replacement === null) throw new Error(`${deprecated} is not an alias`);
    pair.register(handle, itemId);

    // The four calls a pair can be made in: either name, in either
    // spelling of its arguments. All four are the same request, so all
    // four have to be the same answer — the twin accepting only the new
    // spelling would break a client migrating one call at a time, and
    // the old name refusing the new one would contradict the tool list
    // it is advertised beside.
    const answers = [];
    for (const name of [deprecated, replacement]) {
      for (const args of [withId(pair.legacy, itemId), withId(pair.current, itemId)]) {
        answers.push(await call(name, args));
      }
    }

    const first = answers[0];
    expect(first?.isError).toBe(false);
    // Not a subset match and not field-by-field: the whole result,
    // because the criterion is that a client cannot tell which name it
    // called by looking at what came back.
    for (const answer of answers) expect(answer).toEqual(first);
  });

  /**
   * And the answer is the spelling clients registered against, under
   * *both* names.
   *
   * The half that was wrong before. `toLegacyShape` is applied to
   * everything this boundary answers, the twin included: a pair whose
   * two names hand back two shapes is two tools, and a `ticket_get`
   * client reading `ticketId` out of its reply is the reason the shape
   * is frozen at all. The release that retires the names is where the
   * answers follow.
   */
  it("answers in the vocabulary clients registered against, whichever name was called", async () => {
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    for (const name of ["ticket_get", "item_get"]) {
      const answer = await call(name, { itemId });

      const structured = answer.structuredContent as { ticket?: { key?: string } };
      expect(structured.ticket?.key).toBe(itemKey);
      // Nothing item-shaped on the wire, at any depth, from either name.
      expect(JSON.stringify(answer.structuredContent)).not.toMatch(/"item(s|Id|Key|Title|Count|State)?":/);
    }
  });

  /**
   * The identity check above is only worth what its rows can see.
   *
   * Most of these channels answer with nothing that was renamed —
   * `items:move` replies `{moved, cancelledRunId, blockedByActiveRun,
   * commentId, problem}`, `work:submitItem` with `{created, key,
   * problem}` — so on those rows the two names could not have diverged
   * in vocabulary whatever the boundary did, and their passing proves
   * only that the dispatch and the rendering agree. The rows that can
   * actually see a translation are the ones whose answer carries one of
   * the nine keys, and this is what insists at least one of them is in
   * the table: without it, the whole suite could go green against a
   * boundary that translated one name and not the other, which is
   * exactly the state the first version of this file was green in.
   */
  it("has at least one row whose answer carries a renamed key, so the check above can fail", async () => {
    const withRenamedKeys: string[] = [];
    for (const pair of PAIRS) {
      pair.register(handle, itemId);
      const answer = await call(pair.deprecated, withId(pair.legacy, itemId));
      if (/"ticket(s|Id|Key|Title|Count|State)?":/.test(JSON.stringify(answer.structuredContent))) withRenamedKeys.push(pair.deprecated);
      clearHandlerRegistry();
    }

    expect(withRenamedKeys).toEqual(["tickets_list", "tickets_list_archived", "ticket_get"]);
  });

  it.each(PAIRS.map((pair) => [pair.deprecated, pair] as const))("differs from its twin in two things and no others: %s", (deprecated, pair) => {
    const replacement = replacementToolName(deprecated);
    if (replacement === null) throw new Error(`${deprecated} is not an alias`);
    const old = tool(deprecated);
    const twin = tool(replacement);

    // Its name, and the notice in front of its description. Everything
    // else is one `ChannelToolSpec` read twice, so a divergence here is a
    // bug in `channelTool` rather than in a call site — and the third
    // thing, which spelling each advertises, is the test below.
    expect(twin.description).toBe(old.description.slice(deprecationNotice(replacement).length + 1));
    expect(old.description.startsWith(deprecationNotice(replacement))).toBe(true);
    expect(twin.kind).toBe(old.kind);
    expect(twin.annotations).toEqual(old.annotations);
    // And, on a tool that takes an item id, the channel its key is
    // resolved through (EO-539) — on both halves alike.
    const channels = old.itemKeys === undefined ? [pair.channel] : [pair.channel, RESOLVE_KEY_CHANNEL];
    expect(twin.channels).toEqual(channels);
    expect(old.channels).toEqual(channels);
    expect(twin.itemKeys === undefined).toBe(old.itemKeys === undefined);
    expect(twin.adminOnly).toBe(old.adminOnly);
  });

  /**
   * The one half of the pair that differs on purpose, and it is the half
   * a client is *shown* rather than the half it receives: the deprecated
   * name advertises the spelling it always has, and the twin advertises
   * EO's own. Both *take* either, which is what the identity test above
   * proves, so this changes what a `tools/list` reader is nudged towards
   * and nothing about what any call may say or get back.
   */
  it("advertises the old spelling on the old name and EO's own on the twin", () => {
    expect(Object.keys((tool("ticket_get").inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(["ticketId", "include", "commentsLimit", "commentsSince", "pinnedOnly", "runsLimit", "fields"]);
    expect(Object.keys((tool("item_get").inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(["itemId", "include", "commentsLimit", "commentsSince", "pinnedOnly", "runsLimit", "fields"]);
  });

  /**
   * A refusal names a tool, and for a release each of these has two
   * names. It names EO's own — the same one from either door — which is
   * both halves of one decision: a pair has to refuse in identical
   * words, and `item_move` must not send a caller back through
   * `ticket_move`, the deprecated name recommended by the tool that
   * replaced it. `canonicalToolName` is where that rule lives.
   */
  it("refuses in the same words from either name, and names EO's own", async () => {
    registerHandler("items:move", () => ({ moved: false, cancelledRunId: null, blockedByActiveRun: true, commentId: null, problem: null }), opts);

    const old = await call("ticket_move", { ticketId: itemId, toStepId: "review" });
    const twin = await call("item_move", { itemId, toStepId: "review" });

    expect(old).toEqual(twin);
    const said = JSON.stringify(old.content);
    expect(said).toContain("item_move");
    expect(said).not.toContain("ticket_move");
  });

  it("refuses a call that spells one field both ways, identically under either name", async () => {
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const old = await call("ticket_get", { ticketId: itemId, itemId });
    const twin = await call("item_get", { ticketId: itemId, itemId });

    expect(old.isError).toBe(true);
    // The same refusal, word for word. An `Invalid arguments for "…"`
    // that named the door it came in through would be the one sentence
    // in the whole pair that told a client which name it had used.
    expect(old).toEqual(twin);
    expect(JSON.stringify(old.content)).toContain("ticketId");
  });
});

/**
 * What a client is offered, checked in.
 *
 * The story's criterion is that "the catalog snapshot shows both names
 * for the alias period", and this is that snapshot: every tool the host
 * offers, in the order `tools/list` returns them, with the spelling of
 * the arguments it advertises and — where it has one — the name it is an
 * alias for. So the pairs are something a reviewer reads in one file
 * rather than something they assemble from eleven call sites, and the
 * release that retires them is a diff that deletes eleven lines.
 *
 * `takes` and not "answers": what comes back is the legacy spelling from
 * every line here, which is the whole point of an alias and why the
 * column says which word a caller is *offered*.
 *
 * Deliberately the whole catalog and not only the pairs: an alias added
 * to a tool that should not have one, or a new tool arriving in the
 * `item_*` spelling without a deprecated twin to explain it, both show
 * up here as a line nobody meant to write.
 */
describe("the catalog", () => {
  it("offers both names for the alias period, and the list is checked in", async () => {
    const lines = TOOLS.map((entry) => {
      const replacement = replacementToolName(entry.name);
      const note = replacement === null ? "" : ` → ${replacement} (deprecated)`;
      // Asked of the catalogue rather than restated here (EO-310): a
      // twin advertises EO's own word by construction, and a tool that
      // is nobody's twin advertises whatever its own name says — which
      // is how `item_decide`, added after the freeze, comes to take
      // `itemId` with no deprecated name to explain it. A column derived
      // separately is a column that can agree with a stale copy of the
      // rule and disagree with the tools.
      const takes = advertisedSpelling(entry.name);
      return `${entry.name} [${entry.kind}, takes ${takes}]${note}`;
    });

    await expect(lines.join("\n") + "\n").toMatchFileSnapshot(join(here, "catalogNames.txt"));
  });
});
