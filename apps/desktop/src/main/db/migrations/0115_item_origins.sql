-- Where an item a module created came from (EO-433).
--
-- `ctx.createItem` lets a custom module file a work item straight onto a
-- pipeline, with no person accepting it first. Two of the guards on that
-- are facts that have to outlive the run that made them, so they are
-- rows rather than something the run remembers:
--
-- * **Running twice.** Every creation carries an idempotency key, unique
--   per originating item. A step that is retried, or re-run after a
--   crash, answers with the item it already made — which only works if
--   "already made" can be looked up.
-- * **Chains.** An item no module created is generation 0 and a created
--   item is its originator's generation plus one; a run on a generation
--   3 item cannot create. The number is stored on the created item, so
--   it holds after the item that made it is gone.
--
-- A table beside `items` rather than five columns on it, for the reason
-- `item_extensions` is one: nearly every item was typed by a person and
-- would carry five nulls forever, on the most referenced table in the
-- schema.
--
-- The two foreign keys say what deletion means. `item_id` cascades — a
-- deleted item stops answering a repeat, so the same key creates again.
-- `origin_item_id` is set to null — deleting the item a module ran on
-- leaves what it created in place, still knowing its generation, the
-- module and the run. Archiving touches neither, so an archived item
-- still answers a repeat.
--
-- `run_id` and `module_id` are not foreign keys. The run goes when the
-- originating item is deleted and a module can be removed; the record of
-- which one it was is worth more than a constraint that would have to
-- blank it.
CREATE TABLE `item_origins` (
	`item_id` text PRIMARY KEY NOT NULL,
	`origin_item_id` text,
	`run_id` text,
	`module_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_origins_origin_key_unique` ON `item_origins` (`origin_item_id`,`idempotency_key`);
