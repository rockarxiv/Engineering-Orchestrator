import { canonicalToolName, ipcContract, type IpcChannel } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "../ipc/registry.js";
import { TOOLS, type ToolSpec } from "./catalog.js";
import { RESOLVE_KEY_CHANNEL } from "./itemKeys.js";
import { toLegacyShape } from "./legacyNames.js";
import { ANSWER_BUDGET, NARROWING_KEYS, NARROWING_PROPERTIES } from "./narrow.js";
import { answerToolCall } from "./server.js";

/**
 * The narrowing parameters across the whole catalogue, and through the
 * door a client actually calls (EO-538). narrow.test.ts is the same
 * logic on its own.
 */

/**
 * Every read tool, by EO's own name, and the main list it pages through
 * — or null for a read with no one list, which takes only `fields`.
 *
 * Written down rather than inferred, so a read tool added to the
 * catalogue fails here until somebody says which it is. Paths are in
 * EO's own words, as `ToolSpec.list` is declared.
 */
const MAIN_LIST: Record<string, string | null> = {
  eo_guide: null,
  view_current: null,
  projects_list: "projects",
  repositories_list: "repositories",
  items_list: "items",
  items_list_archived: "items",
  item_get: null,
  inbox_list: "items",
  run_events: "events",
  runs_list: "runs",
  runs_summary: "groups",
  memories_search: "entries",
  // One entry and its history: the entry, its earlier versions and two
  // consolidations, and none of them is the answer more than the others.
  memory_get: null,
  memory_consolidations_list: "consolidations",
  engine_status: null,
  item_types_list: "types",
  // Five catalogues side by side — roles, actions, builtins, item types,
  // packs — and none of them is the answer more than the others.
  registry_get: null,
  agents_list: "agents",
  runtime_status: "runtimes",
  runtime_describe: null,
  pipelines_list: "pipelines",
  // One pipeline: its steps and its routes are two halves of one graph.
  pipeline_get: null,
  modules_list: "modules",
  module_versions_list: "versions",
  module_version_get: null,
  settings_read: null,
  guardrails_get: null,
  spend_read: null,
  worktrees_list: "worktrees",
  jira_connections_list: "connections",
  jira_test: "steps",
  jira_fields: "fields",
  jira_statuses: "statuses",
  jira_outbox: null,
  forge_detect: null,
  mcp_servers_list: "servers",
  skills_list: "skills",
  agent_attachments_list: "attachments",
  pipeline_validate: "problems",
  pipeline_versions: "versions",
  // One held template update (EO-534): three graphs, its changed keys and
  // the person's edits, which together are the answer and none of them alone.
  pipeline_update_conflict: null,
  module_tests_list: "tests",
  pipeline_export: null,
  pipeline_import_check: null,
  workspace_list: "workspaces",
  environment_variables_list: "variables",
};

function properties(tool: ToolSpec): Record<string, unknown> {
  return (tool.inputSchema["properties"] ?? {}) as Record<string, unknown>;
}

function tool(name: string): ToolSpec {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

describe("the narrowing parameters, across the whole catalogue", () => {
  const reads = TOOLS.filter((candidate) => candidate.kind === "read");

  it("has a written-down answer for every read tool", () => {
    expect([...new Set(reads.map((read) => canonicalToolName(read.name)))].sort()).toEqual(Object.keys(MAIN_LIST).sort());
  });

  it("offers fields on every read tool, and declares each one's main list as written down", () => {
    for (const read of reads) {
      expect(properties(read), read.name).toHaveProperty("fields");
      expect(read.list ?? null, read.name).toBe(MAIN_LIST[canonicalToolName(read.name)]);
      expect(read.narrowing, read.name).toContain("fields");
    }
  });

  it("offers where, sort, limit and offset on every list-shaped read tool, and names them in its description", () => {
    for (const read of reads.filter((candidate) => candidate.list !== undefined)) {
      for (const key of NARROWING_KEYS) expect(properties(read), `${read.name}.${key}`).toHaveProperty(key);
      expect(read.description, read.name).toMatch(/Narrow the answer with fields, where, sort, limit and offset on its `[a-z.]+` list; the eo_orient guide says how\.$/);
    }
  });

  it("offers only fields on a read with no list", () => {
    for (const read of reads.filter((candidate) => candidate.list === undefined)) {
      expect(read.narrowing, read.name).toEqual(["fields"]);
      for (const key of ["where", "sort", "offset"]) expect(properties(read), `${read.name}.${key}`).not.toHaveProperty(key);
    }
  });

  it("declares a list that is an array in the channel's answer", () => {
    // Hand-built tools answer in a shape of their own rather than their
    // channel's, so only the tools that pass a channel's answer through
    // can be checked against its schema.
    const handBuilt = new Set(["runtime_status"]);
    for (const read of reads.filter((candidate) => candidate.list !== undefined && !handBuilt.has(candidate.name))) {
      // Its own channel, beside the one an item key is resolved through
      // where it takes an item (EO-539) — `runs_list`'s `itemId`.
      const own = read.channels.filter((channel) => channel !== RESOLVE_KEY_CHANNEL);
      expect(own, read.name).toHaveLength(1);
      const json = z.toJSONSchema(ipcContract[own[0] as IpcChannel].response, { io: "output", unrepresentable: "any" }) as {
        properties?: Record<string, { type?: unknown }>;
      };
      expect(json.properties?.[read.list!]?.type, read.name).toBe("array");
    }
  });

  it("gives each of the five the host's one meaning on every read tool", () => {
    // A read tool's own parameter under one of these names would be taken
    // off the call by the host before the tool saw it — or, as
    // `run_events`'s own `limit` once did, page the list a second time
    // before the host paged it again, answering empty pages. What is
    // advertised is the host's description exactly, or the tool declared
    // its own.
    for (const read of reads) {
      expect(read.narrowing, read.name).toEqual(read.list === undefined ? ["fields"] : NARROWING_KEYS);
      for (const key of read.narrowing ?? []) expect(properties(read)[key], `${read.name}.${key}`).toEqual(NARROWING_PROPERTIES[key]);
    }
  });

  it("adds nothing to a tool that writes", () => {
    for (const write of TOOLS.filter((candidate) => candidate.kind !== "read")) {
      expect(write.narrowing, write.name).toBeUndefined();
      expect(write.list, write.name).toBeUndefined();
    }
  });
});

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  registerHandler("items:list", () => listItemSummaries(handle.db, null), { exposeErrorDetails: true });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

/** What the tool itself answers, put on the wire the way `callTool` did before any of this. */
async function unnarrowed(name: string, args: Record<string, unknown>) {
  const outcome = await tool(name).run(dispatchIpc, args);
  if (!outcome.ok) throw new Error(outcome.message);
  return { isError: false, content: [{ type: "text", text: outcome.text }], structuredContent: toLegacyShape(outcome.data) };
}

describe("a narrowed answer, through answerToolCall", () => {
  beforeEach(() => {
    for (const title of ["Rate limit the import", "Retry the export", "Document the API"]) createTestItem(handle.db, { type: "story", title, stepId: "todo" });
  });

  it("keeps only the fields asked for, in the data and in the text", async () => {
    for (const name of ["tickets_list", "items_list"]) {
      const result = await call(name, { fields: ["tickets.key", "tickets.stepName"] });

      expect(result.isError, name).toBe(false);
      const tickets = (result.structuredContent as { tickets: Record<string, unknown>[] }).tickets;
      expect(tickets, name).toHaveLength(3);
      for (const row of tickets) expect(Object.keys(row).sort(), name).toEqual(["key", "stepName"]);

      const [summary, json] = textOf(result).split("\n");
      expect(summary, name).toBe("3 tickets matched; 3 returned, and there are no more.");
      expect(JSON.parse(json!), name).toEqual(result.structuredContent);
      expect(result.structuredContent, name).toMatchObject({ total: 3, returned: 3, nextOffset: null });
    }
  });

  it("filters, sorts and pages, and says where the next page starts", async () => {
    const first = await call("tickets_list", { where: [{ path: "title", op: "contains", value: "the" }], sort: { path: "title", direction: "desc" }, limit: 2, fields: ["tickets.title"] });
    const second = await call("tickets_list", { where: [{ path: "title", op: "contains", value: "the" }], sort: { path: "title", direction: "desc" }, limit: 2, offset: 2, fields: ["tickets.title"] });

    expect(first.structuredContent).toEqual({ tickets: [{ title: "Retry the export" }, { title: "Rate limit the import" }], total: 3, returned: 2, nextOffset: 2 });
    expect(second.structuredContent).toEqual({ tickets: [{ title: "Document the API" }], total: 3, returned: 1, nextOffset: null });
  });

  it("refuses an operator it does not know with a sentence, and reads nothing", async () => {
    const result = await call("tickets_list", { where: [{ path: "title", op: "like", value: "%rate%" }] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Invalid arguments for "items_list". Nothing was read.\n- where[0].op: "like" is not an operator EO knows. Use one of eq, ne, in, contains, gt, gte, lt, lte or exists.',
    );
  });

  it("answers byte for byte as before when nothing is narrowed and the answer is under the budget", async () => {
    const result = await call("tickets_list", {});
    const before = await unnarrowed("tickets_list", {});

    expect(JSON.stringify(result)).toBe(JSON.stringify(before));
  });
});

describe("the size budget, through answerToolCall", () => {
  it("answers the first page of a list over 40,000 characters, and how to narrow it", async () => {
    const long = "and a title long enough that a few hundred of these make an answer nobody can hold ".repeat(2);
    for (let n = 0; n < 150; n += 1) createTestItem(handle.db, { type: "story", title: `${n} ${long}`, stepId: "todo" });

    const before = await unnarrowed("tickets_list", {});
    expect(before.content[0]!.text.length + JSON.stringify(before.structuredContent).length).toBeGreaterThan(ANSWER_BUDGET);

    const result = await call("tickets_list", {});
    const text = textOf(result);
    const data = result.structuredContent as { tickets: unknown[]; total: number; returned: number; nextOffset: number | null };

    expect(result.isError).toBe(false);
    expect(text.length + JSON.stringify(data).length).toBeLessThanOrEqual(ANSWER_BUDGET);
    expect(data.total).toBe(150);
    expect(data.returned).toBeGreaterThan(0);
    expect(data.returned).toBeLessThan(150);
    expect(data.tickets).toEqual((before.structuredContent as { tickets: unknown[] }).tickets.slice(0, data.returned));
    expect(data.nextOffset).toBe(data.returned);

    const [summary, json] = text.split("\n");
    expect(summary).toContain(`this is the first page: ${data.returned} of 150 tickets`);
    for (const word of ["`where`", "`fields`", "`limit`"]) expect(summary).toContain(word);
    expect(JSON.parse(json!)).toEqual(data);
  });
});

describe("run_events, whose channel pages its own list", () => {
  /** A canned transcript, paged the way `listRunEventsPage` pages one: by `fromSeq`, `limit` at a time. */
  function transcript(events: { type: string; payload: unknown }[]) {
    const dispatched: { fromSeq: number; limit: number }[] = [];
    registerHandler(
      "runs:listEvents",
      ({ fromSeq, limit }) => {
        dispatched.push({ fromSeq, limit });
        const from = events.map((event, seq) => ({ seq, ts: 1_000 + seq, ...event })).filter((event) => event.seq >= fromSeq);
        const page = from.slice(0, limit);
        return { events: page, nextSeq: from.length > limit ? page.at(-1)!.seq + 1 : null, total: events.length };
      },
      { exposeErrorDetails: true },
    );
    return dispatched;
  }

  const three = [
    { type: "message", payload: { summary: "Read the brief", tokens: 10 } },
    { type: "tool_use", payload: "git status" },
    { type: "message", payload: { summary: "Wrote the test", tokens: 30 } },
  ];

  it("pages with limit and offset like any other list, counting the whole log", async () => {
    transcript(three);
    const seqs = (result: Awaited<ReturnType<typeof call>>) => (result.structuredContent as { events: { seq: number }[] }).events.map((event) => event.seq);

    const first = await call("run_events", { runId: "r", limit: 1 });
    const second = await call("run_events", { runId: "r", limit: 1, offset: 1 });
    const third = await call("run_events", { runId: "r", limit: 1, offset: 2 });

    expect(seqs(first)).toEqual([0]);
    expect(first.structuredContent).toMatchObject({ total: 3, returned: 1, nextOffset: 1 });
    expect(textOf(first).split("\n")[0]).toBe("3 events matched; 1 returned; the next page starts at offset 1.");
    expect(seqs(second)).toEqual([1]);
    expect(second.structuredContent).toMatchObject({ total: 3, returned: 1, nextOffset: 2 });
    expect(seqs(third)).toEqual([2]);
    expect(third.structuredContent).toMatchObject({ total: 3, returned: 1, nextOffset: null });
  });

  it("filters before it pages", async () => {
    transcript(three);

    const result = await call("run_events", { runId: "r", where: [{ path: "type", op: "eq", value: "message" }], limit: 1, offset: 1 });

    expect((result.structuredContent as { events: { seq: number }[] }).events.map((event) => event.seq)).toEqual([2]);
    expect(result.structuredContent).toMatchObject({ total: 2, returned: 1, nextOffset: null });
  });

  it("reads past the channel's largest page when it narrows, from fromSeq", async () => {
    const dispatched = transcript(Array.from({ length: 1_205 }, (_, n) => ({ type: n % 2 === 0 ? "even" : "odd", payload: n })));

    const result = await call("run_events", { runId: "r", fromSeq: 5, where: [{ path: "type", op: "eq", value: "odd" }], limit: 2, offset: 599 });

    expect(dispatched).toEqual([{ fromSeq: 5, limit: 1000 }, { fromSeq: 1005, limit: 1000 }]);
    expect((result.structuredContent as { events: { seq: number }[] }).events.map((event) => event.seq)).toEqual([1203]);
    expect(result.structuredContent).toMatchObject({ total: 600, returned: 1, nextOffset: null });
  });

  it("answers one channel page with its cursor, as before, when nothing is narrowed", async () => {
    const dispatched = transcript(three);

    const result = await call("run_events", { runId: "r" });

    expect(dispatched).toEqual([{ fromSeq: 0, limit: 200 }]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(await unnarrowed("run_events", { runId: "r" })));
    expect(textOf(result)).toContain("(end of the log so far)");
  });

  it("keeps a nested field only where it exists, in the data and in the text", async () => {
    transcript([...three, { type: "noop", payload: null }]);

    const result = await call("run_events", { runId: "r", fields: ["events.seq", "events.payload.summary"] });

    expect((result.structuredContent as { events: unknown[] }).events).toEqual([
      { seq: 0, payload: { summary: "Read the brief" } },
      { seq: 1 },
      { seq: 2, payload: { summary: "Wrote the test" } },
      { seq: 3 },
    ]);
    expect(JSON.parse(textOf(result).split("\n")[1]!)).toEqual(result.structuredContent);
  });

  it("cuts an over-budget transcript to its first page counting every event, not the 200 the first read held", async () => {
    const dispatched = transcript(Array.from({ length: 1_205 }, (_, n) => ({ type: "message", payload: { n, text: "z".repeat(500) } })));

    const result = await call("run_events", { runId: "r" });
    const data = result.structuredContent as { events: { seq: number }[]; total: number; returned: number; nextOffset: number | null };
    const text = textOf(result);

    // One default page, found over the budget, then the whole log.
    expect(dispatched).toEqual([
      { fromSeq: 0, limit: 200 },
      { fromSeq: 0, limit: 1000 },
      { fromSeq: 1000, limit: 1000 },
    ]);
    expect(result.isError).toBe(false);
    expect(text.length + JSON.stringify(data).length).toBeLessThanOrEqual(ANSWER_BUDGET);
    expect(data.total).toBe(1_205);
    expect(data.returned).toBeGreaterThan(0);
    expect(data.events.map((event) => event.seq)).toEqual(Array.from({ length: data.returned }, (_, n) => n));
    expect(data.nextOffset).toBe(data.returned);
    expect(text.split("\n")[0]).toContain(`this is the first page: ${data.returned} of 1,205 events`);

    // And the page after it is the same list, read on by offset.
    const next = await call("run_events", { runId: "r", offset: data.returned, limit: data.returned });
    expect((next.structuredContent as { events: { seq: number }[] }).events[0]?.seq).toBe(data.returned);
    expect(next.structuredContent).toMatchObject({ total: 1_205 });
  });

  it("reads nothing more for a transcript under the budget", async () => {
    const dispatched = transcript(Array.from({ length: 300 }, (_, n) => ({ type: "message", payload: n })));

    const result = await call("run_events", { runId: "r" });

    expect(dispatched).toEqual([{ fromSeq: 0, limit: 200 }]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(await unnarrowed("run_events", { runId: "r" })));
  });
});
