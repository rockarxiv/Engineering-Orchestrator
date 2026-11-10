import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ItemListFiltersSchema, type Item, type Run, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAttachment, getItemByKey } from "../db/repos/index.js";
import {
  moduleItemSummaries,
  moduleItemView,
  moduleRunsView,
  moduleTransitionsView,
  type ModuleItemPage,
  type ModuleItemView,
  type ModuleRunView,
  type ModuleTransitionView,
} from "../ipc/domainQueries.js";

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
  /** Every run on the item, oldest first, or null where no item has the key (EO-710). */
  runs(key: string): ModuleRunView[] | null;
  /** Every step move the item made, oldest first, or null where no item has the key (EO-710). */
  transitions(key: string): ModuleTransitionView[] | null;
  /**
   * A page of the items on one project — the running item's — narrowed
   * by what `items_list` takes, or the sentence saying why the filter
   * cannot be read (EO-710).
   */
  items(projectId: string | null, filter: unknown): ModuleItemPage | { refused: string };
  /** One attachment with its bytes, null where no attachment has the id, or why its file cannot be read (EO-710). */
  readAttachment(id: string): Promise<ModuleAttachmentContent | null | { refused: string }>;
}

/** One file and what it holds (EO-710). */
export interface ModuleAttachmentContent {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

/** The most items one `ctx.items()` page holds, and how many it holds when the module does not say. */
export const MODULE_ITEMS_PAGE_MAX = 500;
export const MODULE_ITEMS_PAGE_DEFAULT = 100;

/** `items_list`'s filters, and the page: `offset` and `limit`. */
const ModuleItemsFilterSchema = ItemListFiltersSchema.extend({
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(MODULE_ITEMS_PAGE_MAX).optional(),
}).strict();

/**
 * Which result key a run produced, where no pack says otherwise: the
 * `result` it answered with — a module's, a builtin's, a role's own
 * action's — or null.
 */
export function reportedRunResultKey(run: Run): string | null {
  const parsed: unknown = run.result !== null && "parsed" in run.result ? run.result["parsed"] : run.result;
  const reported = parsed !== null && typeof parsed === "object" ? (parsed as { result?: unknown }).result : undefined;
  return typeof reported === "string" ? reported : null;
}

export interface ModuleItemReaderOptions {
  /**
   * The branch an item's pull request is or will be opened against, or
   * null. The developer pack's `pullRequestTargetBranch`, handed in by
   * the composition root because this file may not reach into a pack
   * (invariant #13). Absent, every `targetBranch` is null.
   */
  targetBranch?: (item: Item) => Promise<string | null>;
  /**
   * Which declared result a finished run produced, as the installed
   * packs read its answer — a review's verdict is `approved` or
   * `changes_requested` (EO-710). Handed in for `targetBranch`'s reason.
   * `undefined` is "no pack has an opinion", and the run's own reported
   * `result` answers; absent, that is every run.
   */
  resultKey?: (run: Run, item: Item) => string | null | undefined;
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
    runs: (key) => {
      const item = getItemByKey(db, key);
      if (item === undefined) return null;
      return moduleRunsView(db, item, (run, of) => {
        const claimed = options.resultKey?.(run, of);
        return claimed === undefined ? reportedRunResultKey(run) : claimed;
      });
    },
    transitions: (key) => {
      const item = getItemByKey(db, key);
      return item === undefined ? null : moduleTransitionsView(db, item);
    },
    items: (projectId, filter) => {
      const parsed = ModuleItemsFilterSchema.safeParse(filter ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
        return { refused: `ctx.items() could not read that filter — ${where}${issue?.message ?? "it is not one"}.` };
      }
      const { offset = 0, limit = MODULE_ITEMS_PAGE_DEFAULT, ...filters } = parsed.data;
      return moduleItemSummaries(db, projectId as Uuid | null, filters, { offset, limit });
    },
    readAttachment: async (id) => {
      const attachment = getAttachment(db, id as Uuid);
      if (attachment === undefined) return null;
      let content: Buffer;
      try {
        content = await readFile(attachment.path);
      } catch {
        return { refused: `${attachment.name} can no longer be read from this machine.` };
      }
      return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: content.byteLength, content };
    },
  };
}
