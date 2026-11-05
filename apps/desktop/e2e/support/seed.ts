import Database from "better-sqlite3";
import path from "node:path";

/**
 * Puts an item into a running app's database.
 *
 * There is no "create an item" door any more, and that is deliberate:
 * work reaches EO by being talked through with the product owner or by
 * being imported from Jira, and both produce something somebody already
 * agreed to (ARCHITECTURE.md, "A column is a responsibility, not a status"). Neither makes a good
 * fixture — one needs an agent
 * run, the other a Jira server — so a spec that just needs *an item* in
 * order to test something else writes the row.
 *
 * The same call `worktrees.spec.ts` makes when it creates its checkout
 * with git rather than through the app: setup is allowed to reach past
 * the UI, as long as what is under test does not.
 *
 * It declares an acceptance criterion by default (EO-213), because the
 * work it stands in for does: EO refuses to review an item that
 * declares none, so a seeded story without one is a fixture that stops
 * dead the moment a spec drives it as far as Review. That failure is a
 * thirty-second timeout on an assertion about something else entirely,
 * which is worth exactly one CI round to find out — so the default is
 * the realistic item, and a spec that wants the other one asks for it
 * with `acceptanceCriteria: []`.
 */
export function seedItem(
  home: string,
  item: {
    title: string;
    stepId?: string;
    type?: string;
    branch?: string | null;
    comment?: string;
    /** What a review would judge it against. Empty declares none, which no review will start against. */
    acceptanceCriteria?: string[];
  },
): { id: string; key: string } {
  const db = new Database(path.join(home, ".config/Electron/eo.db"));
  try {
    // A `git-worktree` workspace since KAN-130 — the row a repository
    // became, keeping its id.
    const workspace = db.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string } | undefined;
    const project = db.prepare("SELECT id, key_prefix FROM projects LIMIT 1").get() as { id: string; key_prefix: string } | undefined;
    const pipeline = db.prepare("SELECT id, entry_step_id FROM pipelines WHERE entry_step_id IS NOT NULL LIMIT 1").get() as
      | { id: string; entry_step_id: string }
      | undefined;
    if (!workspace || !project || !pipeline) throw new Error("seedItem: the app has no repository, project or pipeline yet");

    // The app's own counter, so the key it hands out next stays right.
    // The project's prefix, which is the only one there is (KAN-128).
    const prefix = project.key_prefix;
    const counter = db.prepare("SELECT next_value FROM key_counters WHERE prefix = ?").get(prefix) as { next_value: number } | undefined;
    const next = counter?.next_value ?? 1;
    db.prepare("INSERT INTO key_counters (prefix, next_value) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET next_value = ?").run(prefix, next + 1, next + 1);

    // uuidv7-shaped: time-ordered, which is what the app's own ids are and
    // what anything sorting by id expects.
    const now = Date.now();
    const id = `${now.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-${Math.floor(Math.random() * 0xffffffffffff)
      .toString(16)
      .padStart(12, "0")}`;

    // The app reads criteria out of `spec`, so this writes the same JSON
    // the refine and intake paths do. Null rather than `{}` when a spec
    // asks for none, which is the shape an item that declares nothing
    // actually has.
    const criteria = item.acceptanceCriteria ?? ["The limiter returns 429 after 100 requests in a minute."];
    const spec = criteria.length > 0 ? JSON.stringify({ acceptance_criteria: criteria }) : null;

    // The type is an `item_types` row since KAN-129, found in this
    // project's own scope — the app seeds one set per project, and a
    // seeded item points at the same row a real one would.
    const slug = item.type ?? "story";
    const type = db.prepare("SELECT id FROM item_types WHERE project_id = ? AND slug = ?").get(project.id, slug) as { id: string } | undefined;
    if (!type) throw new Error(`seedItem: this project has no "${slug}" item type`);

    db.prepare(
      // No Jira columns since KAN-148 and no git ones since KAN-169: a
      // seeded item's Jira state and its branch are `item_extensions`
      // rows, and the branch goes in as one below.
      `INSERT INTO items (id, key, type_id, parent_id, workspace_id, project_id, title, body, spec, pipeline_id, step_id, priority, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(
      id,
      `${prefix}-${next}`,
      type.id,
      workspace.id,
      project?.id ?? null,
      item.title,
      spec,
      pipeline.id,
      item.stepId ?? pipeline.entry_step_id,
      now,
      now,
    );

    // Only when there is one, which is the rule the migration and the
    // write path both keep: an item with no branch leaves no `git` row.
    const seededBranch = item.branch ?? null;
    if (seededBranch !== null) {
      db.prepare("INSERT INTO item_extensions (item_id, extension, data, updated_at) VALUES (?, 'git', ?, ?)").run(
        id,
        JSON.stringify({ branch: seededBranch, pullRequest: null }),
        now,
      );
    }

    // The description used to arrive as the opening comment of the thread
    // (U-08), which is what made it visible to agents and what survives an
    // archive. A seeded item says the same thing the same way.
    if (item.comment !== undefined) {
      db.prepare(
        `INSERT INTO comments (id, item_id, run_id, author_type, author_id, body, kind, options, parent_id, pinned, created_at)
         VALUES (?, ?, NULL, 'human', NULL, ?, 'note', NULL, NULL, 0, ?)`,
      ).run(`${id}-c`, id, item.comment, now);
    }

    return { id, key: `${prefix}-${next}` };
  } finally {
    db.close();
  }
}
