-- Memory entries (EO-478, ARCHITECTURE.md, "What an agent is given").
--
-- What an agent or a person learned that the next run should know, at
-- two scopes: a project (`scope_kind = 'project'`, `scope_id` a
-- project's id) and one of its workspaces (`'workspace'`, a
-- workspace's id). `scope_id` names either table, so it carries no
-- foreign key.
--
-- Nothing is deleted. An edit retires the old row (`retired_reason =
-- 'edited'`) and inserts a new one; a person retiring an entry, or a
-- consolidation folding it into fewer, sets `retired_at` and the reason,
-- and a restore clears them. Active entries are the rows whose
-- `retired_at` is null.
--
-- The source is a person (`source_kind = 'person'`, with their id in
-- organisation mode and null on a solo installation) or an agent's run on
-- an item (`'run'`). The run and item ids go null if the item is
-- deleted: the entry is the project's and outlives the item it was
-- learned on.
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`body` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_person_id` text,
	`source_run_id` text,
	`source_item_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	`retired_reason` text,
	`consolidation_id` text,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_memories_scope` ON `memories` (`scope_kind`,`scope_id`,`retired_at`);
