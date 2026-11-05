import type { ItemListFilters, Uuid } from "@eo/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createPipelineVersion, createStep, listItemsForProject, projectForWorkspace, setItemArchived, transitionItem } from "../db/repos/index.js";
import { pipelineSteps } from "../db/schema.js";
import { foldCase } from "../db/textFold.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listArchivedSummaries, listItemSummaries, resolveItemKey } from "./domainQueries.js";

/**
 * The item lists narrowed in EO's own query (EO-539), and keys turned
 * into the items they name.
 */

let handle: DbHandle;
let projectId: Uuid;
let workspaceId: Uuid;
let deploys: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  projectId = projectForWorkspace(handle.db, workspaceId)!.id;
  deploys = createPipeline(handle.db, { projectId, name: "Deploys" }).id;
  createStep(handle.db, { id: "deploy", pipelineId: deploys, position: 0, name: "Deploy", type: "user" });
  createStep(handle.db, { id: "deployed", pipelineId: deploys, position: 1, name: "Deployed", type: "user", isTerminal: true });
});

afterEach(() => {
  handle.close();
});

function item(title: string, stepId: string | null, extra: { type?: string; parentId?: Uuid } = {}) {
  return createTestItem(handle.db, { type: extra.type ?? "story", title, stepId, projectId, workspaceId, parentId: extra.parentId ?? null });
}

function keysOf(answer: { items: { key: string }[] }): string[] {
  return answer.items.map((row) => row.key).sort();
}

/** A small project with one of everything a filter can tell apart. */
function seed() {
  const feature = item("Import pipeline", null, { type: "feature" });
  const limit = item("Rate limit the IMPORT", "todo", { parentId: feature.id });
  const retry = item("Retry the export", "review", { parentId: feature.id });
  const crash = item("Crash on save", "todo", { type: "bug" });
  const shipped = item("Ship the importer", "todo");
  transitionItem(handle.db, { itemId: shipped.id, toStepId: "ready_to_merge", actor: "human" });
  const deploy = item("Deploy the import service", "deploy");
  return { feature, limit, retry, crash, shipped, deploy };
}

describe("items:list, filtered in the query", () => {
  it("keeps only the items each filter matches", () => {
    const { feature, limit, retry, crash, shipped, deploy } = seed();
    const cases: [ItemListFilters, string[]][] = [
      [{ stepId: "todo" }, [limit.key, crash.key]],
      [{ stepName: "to do" }, [limit.key, crash.key]],
      [{ stepName: "Done" }, [shipped.key]],
      [{ pipelineId: deploys }, [deploy.key]],
      [{ type: "bug" }, [crash.key]],
      [{ type: "feature" }, [feature.key]],
      [{ parentKey: feature.key }, [limit.key, retry.key]],
      [{ keys: [crash.key, deploy.key, "APP-999"] }, [crash.key, deploy.key]],
      [{ text: "import" }, [feature.key, limit.key, shipped.key, deploy.key]],
      [{ atTerminalStep: true }, [shipped.key]],
      // A container stands on no step, so it is not finished this way —
      // which is what its own row says — and `false` keeps it.
      [{ atTerminalStep: false }, [feature.key, limit.key, retry.key, crash.key, deploy.key]],
      [{ atTerminalStep: false, type: "feature" }, [feature.key]],
      // Every one given must hold.
      [{ text: "import", stepId: "todo" }, [limit.key]],
      [{ parentKey: feature.key, stepName: "Review" }, [retry.key]],
      [{ parentKey: "APP-999" }, []],
    ];

    for (const [filters, expected] of cases) {
      expect(keysOf(listItemSummaries(handle.db, projectId, filters)), JSON.stringify(filters)).toEqual([...expected].sort());
    }
  });

  it("matches a step name by each item's own version of its step, not by the step's id", () => {
    seed();
    // Two pipelines, one name: the name is what was asked for.
    createStep(handle.db, { id: "deploy-todo", pipelineId: deploys, position: 2, name: "To Do", type: "user" });
    const other = item("Plan the deploy", "deploy-todo");

    const answer = listItemSummaries(handle.db, projectId, { stepName: "TO DO" });

    expect(keysOf(answer)).toContain(other.key);
    for (const row of answer.items) expect(row.stepName).toBe("To Do");
  });

  it("reads a step's name and whether it is terminal from each item's own version, as the unfiltered list does", () => {
    const { shipped } = seed();
    // Entered while the step was "Deploy", and not terminal.
    const before = item("Deploy the first service", "deploy");
    // Then the step is renamed and made terminal, and published as v2 —
    // so work entering now meets "Ship", and finishes there.
    handle.db.update(pipelineSteps).set({ name: "Ship", isTerminal: true }).where(eq(pipelineSteps.id, "deploy")).run();
    createPipelineVersion(handle.db, deploys);
    const after = item("Deploy the second service", "deploy");

    const whole = listItemSummaries(handle.db, projectId).items;
    expect(whole.find((row) => row.id === before.id)).toMatchObject({ stepName: "Deploy", atTerminalStep: false });
    expect(whole.find((row) => row.id === after.id)).toMatchObject({ stepName: "Ship", atTerminalStep: true });

    expect(keysOf(listItemSummaries(handle.db, projectId, { stepName: "deploy" }))).toContain(before.key);
    expect(keysOf(listItemSummaries(handle.db, projectId, { stepName: "deploy" }))).not.toContain(after.key);
    expect(keysOf(listItemSummaries(handle.db, projectId, { stepName: "SHIP" }))).toEqual([after.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { atTerminalStep: true }))).toEqual([shipped.key, after.key].sort());

    // And for every name and both answers, the query keeps exactly the
    // rows whose own answer says so.
    for (const stepName of ["Deploy", "Ship", "To Do", "Review", "Done", "Nowhere"]) {
      const expected = whole.filter((row) => row.stepId !== null && foldCase(row.stepName) === foldCase(stepName));
      expect(keysOf(listItemSummaries(handle.db, projectId, { stepName })), stepName).toEqual(keysOf({ items: expected }));
    }
    for (const atTerminalStep of [true, false]) {
      expect(keysOf(listItemSummaries(handle.db, projectId, { atTerminalStep })), String(atTerminalStep)).toEqual(
        keysOf({ items: whole.filter((row) => row.atTerminalStep === atTerminalStep) }),
      );
    }
  });

  it("matches titles and step names without regard to case in any script", () => {
    const failure = item("Échec de l'import", "todo");
    const street = item("Straße sperren", "todo");
    createStep(handle.db, { id: "pruefung", pipelineId: deploys, position: 2, name: "Prüfung", type: "user" });
    const check = item("Prüfe die Lieferung", "pruefung");
    item("Rate limiting", "todo");

    expect(keysOf(listItemSummaries(handle.db, projectId, { text: "échec" }))).toEqual([failure.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { text: "ÉCHEC DE" }))).toEqual([failure.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { text: "STRASSE" }))).toEqual([street.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { text: "PRÜFE" }))).toEqual([check.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { stepName: "PRÜFUNG" }))).toEqual([check.key]);
    // `%` and `_` are characters, not wildcards.
    expect(keysOf(listItemSummaries(handle.db, projectId, { text: "%" }))).toEqual([]);
  });

  it("filters by when an item was made and when it last changed", () => {
    const { limit, retry, crash } = seed();
    const at = 1_800_000_000_000;
    handle.db.run(sql`update items set created_at = ${at - 10}, updated_at = ${at - 10}`);
    handle.db.run(sql`update items set created_at = ${at} where id = ${limit.id}`);
    handle.db.run(sql`update items set updated_at = ${at + 5} where id in (${retry.id}, ${crash.id})`);

    expect(keysOf(listItemSummaries(handle.db, projectId, { createdSince: at }))).toEqual([limit.key]);
    expect(keysOf(listItemSummaries(handle.db, projectId, { updatedSince: at }))).toEqual([crash.key, retry.key].sort());
    expect(keysOf(listItemSummaries(handle.db, projectId, { updatedSince: at + 6 }))).toEqual([]);
  });

  it("answers each kept item exactly as the unfiltered list does", () => {
    const { feature, retry } = seed();
    const whole = listItemSummaries(handle.db, projectId);

    for (const filters of [{ type: "feature" }, { keys: [retry.key] }, { parentKey: feature.key }, { stepName: "review" }] satisfies ItemListFilters[]) {
      const narrowed = listItemSummaries(handle.db, projectId, filters);
      expect(narrowed.items.length, JSON.stringify(filters)).toBeGreaterThan(0);
      // A feature listed alone still counts its stories, which the
      // narrowed rows do not hold; a story still knows its parent.
      for (const row of narrowed.items) expect(row, JSON.stringify(filters)).toEqual(whole.items.find((candidate) => candidate.id === row.id));
    }
  });

  it("answers as it always did when given no filter", () => {
    seed();

    expect(listItemSummaries(handle.db, projectId, {})).toEqual(listItemSummaries(handle.db, projectId));
  });
});

describe("items:list on a project with hundreds of items", () => {
  /** Every statement the database is asked to prepare while `read` runs. */
  function statementsDuring(read: () => void): string[] {
    // The connection drizzle prepares every statement on. Not on `Db`'s
    // type, and reached for here only: this test is about what is asked
    // of the database, which nothing above the connection can see.
    const client = (handle.db as unknown as { $client: { prepare: (source: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    const seen: string[] = [];
    client.prepare = (source: string) => {
      seen.push(source);
      return prepare(source);
    };
    try {
      read();
    } finally {
      client.prepare = prepare;
    }
    return seen;
  }

  it("asks the database for one step's items, and summarises only those", () => {
    for (let n = 0; n < 300; n += 1) item(`Backlog ${n}`, "todo");
    const inReview = [item("Review one", "review"), item("Review two", "review"), item("Review three", "review")];

    let answer: ReturnType<typeof listItemSummaries> = { items: [] };
    const filtered = statementsDuring(() => {
      answer = listItemSummaries(handle.db, projectId, { stepId: "review" });
    });
    const unfiltered = statementsDuring(() => listItemSummaries(handle.db, projectId));

    expect(keysOf(answer)).toEqual(inReview.map((row) => row.key).sort());
    // The step is in the read of the items itself, not applied after it.
    const itemReads = filtered.filter((source) => /from "items" inner join "item_types"/.test(source));
    expect(itemReads.some((source) => source.includes('"items"."step_id" = ?'))).toBe(true);
    // Each summarised item has its runs read; three were, not 303.
    const runReads = (statements: string[]) => statements.filter((source) => /from "runs" where "runs"\."item_id" = \?/.test(source)).length;
    expect(runReads(filtered)).toBe(3);
    expect(runReads(unfiltered)).toBe(303);
  });

  it("asks the database for a step name, finished work and a title, rather than reading every row first", () => {
    for (let n = 0; n < 300; n += 1) item(`Backlog ${n}`, "todo");
    const inReview = [item("Review one", "review"), item("Review two", "review"), item("Révision trois", "review")];
    const finished = item("Finished", "todo");
    transitionItem(handle.db, { itemId: finished.id, toStepId: "ready_to_merge", actor: "human" });

    // The repository's read *is* the query: what it hands back is what the
    // statement matched, hydrated, and nothing else was.
    const cases: [ItemListFilters, string[], RegExp][] = [
      [{ stepName: "REVIEW" }, inReview.map((row) => row.key), /eo_fold_case\(coalesce\(\(select json_extract\("bound_step"\."value", '\$\.name'\)/],
      [{ atTerminalStep: true }, [finished.key], /coalesce\(\(select json_extract\("bound_step"\."value", '\$\.isTerminal'\)/],
      [{ text: "RÉVISION" }, [inReview[2]!.key], /instr\(eo_fold_case\("items"\."title"\), \?\) > 0/],
    ];
    for (const [filters, expected, term] of cases) {
      let rows: ReturnType<typeof listItemsForProject> = [];
      const statements = statementsDuring(() => {
        rows = listItemsForProject(handle.db, projectId, filters);
      });
      expect(rows.map((row) => row.key).sort(), JSON.stringify(filters)).toEqual([...expected].sort());
      const itemReads = statements.filter((source) => /from "items" inner join "item_types"/.test(source));
      expect(itemReads, JSON.stringify(filters)).toHaveLength(1);
      expect(itemReads[0], JSON.stringify(filters)).toMatch(term);

      // And the list built on it summarises only those.
      const listed = statementsDuring(() => listItemSummaries(handle.db, projectId, filters));
      expect(listed.filter((source) => /from "runs" where "runs"\."item_id" = \?/.test(source)), JSON.stringify(filters)).toHaveLength(expected.length);
    }
  });
});

describe("items:listArchived, filtered in the query", () => {
  it("keeps only the archived items each filter matches", () => {
    const { feature, limit, retry, crash, deploy } = seed();
    const failure = item("Échec de l'export", "todo");
    for (const archived of [feature, limit, retry, crash, failure]) setItemArchived(handle.db, archived.id, Date.now());

    const cases: [Parameters<typeof listArchivedSummaries>[2], string[]][] = [
      [{ stepId: "todo" }, [limit.key, crash.key, failure.key]],
      [{ stepName: "review" }, [retry.key]],
      [{ type: "bug" }, [crash.key]],
      [{ parentKey: feature.key }, [limit.key, retry.key]],
      [{ keys: [crash.key, deploy.key] }, [crash.key]],
      [{ text: "IMPORT" }, [feature.key, limit.key]],
      [{ pipelineId: deploys }, []],
      [{ createdSince: 0, type: "feature" }, [feature.key]],
      [{ text: "échec" }, [failure.key]],
      [{ text: "ÉCHEC" }, [failure.key]],
    ];

    for (const [filters, expected] of cases) {
      expect(keysOf(listArchivedSummaries(handle.db, projectId, filters)), JSON.stringify(filters)).toEqual([...expected].sort());
    }
    expect(listArchivedSummaries(handle.db, projectId, { type: "feature" }).items[0]).toEqual(
      listArchivedSummaries(handle.db, projectId).items.find((row) => row.id === feature.id),
    );
  });
});

describe("items:resolveKey", () => {
  it("finds the item a key names, through the project carrying its prefix, in any case", () => {
    const { crash } = seed();

    expect(resolveItemKey(handle.db, { key: crash.key })).toEqual({ itemId: crash.id, problem: null });
    expect(resolveItemKey(handle.db, { key: ` ${crash.key.toLowerCase()} ` })).toEqual({ itemId: crash.id, problem: null });
  });

  it("finds an archived item, since a key is a lookup and not a policy", () => {
    const { crash } = seed();
    setItemArchived(handle.db, crash.id, Date.now());

    expect(resolveItemKey(handle.db, { key: crash.key }).itemId).toBe(crash.id);
  });

  it("finds an item on no project by the prefix no project holds", () => {
    const loose = createTestItem(handle.db, { type: "story", title: "Before any project", stepId: "todo" });

    expect(loose.key.startsWith("EO-")).toBe(true);
    expect(resolveItemKey(handle.db, { key: loose.key })).toEqual({ itemId: loose.id, problem: null });
  });

  it("refuses a key naming nothing with a sentence naming the key", () => {
    seed();

    expect(resolveItemKey(handle.db, { key: "APP-999" })).toEqual({ itemId: null, problem: '"APP-999" names no item: nothing on app has that key. items_list lists the keys there are.' });
    expect(resolveItemKey(handle.db, { key: "ZZ-1" })).toEqual({ itemId: null, problem: '"ZZ-1" names no item: no project\'s keys begin "ZZ-". projects_list names every project.' });
    expect(resolveItemKey(handle.db, { key: "APP-" }).problem).toBe('"APP-" is not an item key: a key is a project\'s prefix, a hyphen and a number, like EO-486.');
    expect(resolveItemKey(handle.db, { key: "APP-12a" }).itemId).toBeNull();
  });
});
