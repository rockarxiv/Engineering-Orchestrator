import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { items } from "../schema.js";

/**
 * "…and it belongs to this project" (EO-325, review).
 *
 * `record:changes` pages each list on when its rows were written, which
 * is right for a record that only ever grows forwards and wrong for the
 * one thing that does not arrive in order: a project moved to the
 * record brings years of history with its own timestamps on it, and a
 * desktop whose cursors had already run past those dates would never
 * ask for any of it again. So it asks a second time, scoped to the
 * project and on cursors of its own — see `RecordChangesRequest.within`.
 *
 * A subselect rather than a join because every caller is a keyset page
 * with its own `ORDER BY`, and a join would put a second table in front
 * of the index that ordering depends on. `item_id` is indexed on all
 * four tables that use this, and `items.project_id` is indexed too, so
 * what SQLite does with it is two index lookups.
 */
export function onProject(itemId: AnyColumn, projectId: string): SQL {
  return sql`${itemId} in (select ${items.id} from ${items} where ${items.projectId} = ${projectId})`;
}
