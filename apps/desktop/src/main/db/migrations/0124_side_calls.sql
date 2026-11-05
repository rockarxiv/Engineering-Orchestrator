-- Short model calls that are not agent runs (EO-477, ARCHITECTURE.md,
-- "One interface, two backends").
--
-- One row per call: why it was made, the project and — where there is
-- one — the item and the run it happened inside, the backend and model,
-- what it used and cost, how long it took and how it came out. Never the
-- prompt or the answer.
--
-- `project_id` is SET NULL on a project's delete, because the money was
-- spent either way; `item_id` has no rule, because `deleteItem` removes
-- an item's side calls with its runs, explicitly, as it removes
-- everything else that names the item.
CREATE TABLE `side_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`project_id` text,
	`item_id` text,
	`run_id` text,
	`backend` text NOT NULL,
	`model` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_side_calls_started_at` ON `side_calls` (`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_side_calls_item` ON `side_calls` (`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_side_calls_project` ON `side_calls` (`project_id`);
