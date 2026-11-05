-- Keep checking (EO-456, ARCHITECTURE.md, "A step", "Guardrails").
--
-- A `builtin` or `module` step may wait on something outside EO by
-- running a short check on an interval, rather than by holding a process
-- open for as long as the wait takes. Two settings on the step say how:
-- check every N minutes, give up after H hours. Both NULL on a step that
-- runs once, which is every step that exists today, so this migration
-- changes what no row means. REAL rather than INTEGER, because the
-- validator is what refuses half a minute — with a sentence naming the
-- step — and a column that truncated it first would turn the mistake
-- into a different interval.
ALTER TABLE `pipeline_steps` ADD `watch_every_minutes` real;
--> statement-breakpoint
ALTER TABLE `pipeline_steps` ADD `watch_give_up_hours` real;
--> statement-breakpoint
-- The watch itself: one row per item and step, which is where the wait
-- lives instead of in a process. That is what lets a watch survive a
-- closed app and a sleeping machine — the next check is a time on a row,
-- and the scheduler reads it.
--
-- A check that comes back waiting with nothing new leaves no run row; this
-- is where its time and outcome are written. `initiation_id` is the move
-- that brought the item onto the step, so an item that leaves and comes
-- back starts a fresh watch rather than inheriting the old one's clock,
-- failures and news. `posted_news_ids` is a JSON array of the ids of news
-- already posted for this watch, which is how a check's news is posted
-- once however many checks go on seeing it.
--
-- `updated_at` is when this database last changed the row. On an
-- organisation's record it is what the watch feed pages on, so the next
-- device to be leased the item reads where the watch has got to rather
-- than starting one of its own; a replica keeps the record's stamp.
--
-- `item_id` cascades: deleting an item deletes its watch, as it does
-- everything else about it. `step_id` is not a foreign key, for the
-- reason `transitions.to_step_id` is not one — a step a later save
-- removed still names where the item was.
CREATE TABLE `item_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`step_id` text NOT NULL,
	`initiation_id` text,
	`started_at` integer NOT NULL,
	`last_checked_at` integer,
	`next_check_at` integer NOT NULL,
	`checks` integer DEFAULT 0 NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`posted_news_ids` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_watches_item_step_unique` ON `item_watches` (`item_id`,`step_id`);
--> statement-breakpoint
CREATE INDEX `item_watches_updated` ON `item_watches` (`updated_at`,`id`);
