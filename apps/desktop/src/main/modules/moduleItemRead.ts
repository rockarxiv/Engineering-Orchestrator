import type { Item } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItemByKey } from "../db/repos/index.js";
import { moduleItemView, type ModuleItemView } from "../ipc/domainQueries.js";

/**
 * What answers a module's `ctx.item()` and `ctx.itemByKey()` (EO-709),
 * and `ctx.commentOn()`'s check that its key names an item.
 *
 * The main process reads, with the code the screens and `item_get`
 * read with, and the host asks for it over a descriptor of its own (see
 * `runModule`). The host used to open EO's database read-only and answer
 * with SQL of its own, which went on reading columns after migrations
 * had moved them; it has no database handle any more.
 */
export interface ModuleItemReader {
  /** The whole item, or null where no item has the key. */
  read(key: string): Promise<ModuleItemView | null>;
  /** Whether an item has the key, without building it. */
  exists(key: string): boolean;
}

export interface ModuleItemReaderOptions {
  /**
   * The branch an item's pull request is or will be opened against, or
   * null. The developer pack's `pullRequestTargetBranch`, handed in by
   * the composition root because this file may not reach into a pack
   * (invariant #13). Absent, every `targetBranch` is null.
   */
  targetBranch?: (item: Item) => Promise<string | null>;
}

export function moduleItemReader(db: Db, options: ModuleItemReaderOptions = {}): ModuleItemReader {
  return {
    read: async (key) => {
      const item = getItemByKey(db, key);
      if (item === undefined) return null;
      let targetBranch: string | null = null;
      try {
        targetBranch = options.targetBranch === undefined ? null : await options.targetBranch(item);
      } catch {
        // A forge that could not be asked leaves the target unknown,
        // which is null; the rest of the item is still worth having.
        targetBranch = null;
      }
      // Read again after the wait: the forge can take seconds, and what
      // the module is handed should be the item as it is now.
      const current = getItemByKey(db, key);
      return current === undefined ? null : moduleItemView(db, current, targetBranch);
    },
    exists: (key) => getItemByKey(db, key) !== undefined,
  };
}
