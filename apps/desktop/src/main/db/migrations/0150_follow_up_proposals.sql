-- A gap a run leaves becomes a proposal to file work, not a memory
-- (EO-595, ARCHITECTURE.md §7.5).
--
-- Extraction may answer with up to two follow-ups: a gap the work leaves,
-- or something wrong in the project that a note would only work around.
-- Each is posted on the item's thread as a comment offering File it and
-- Discard, and is a row here: what it proposes, the item and run it came
-- from, and what a person decided. File it creates an item through the
-- door submitted work takes, named by `filed_item_id`.
--
-- A discarded row is what keeps a later run on the project from proposing
-- the same title again, matched by `title_key` (`followUpTitleKey`). No
-- foreign key to items or runs, for `memories.project_id`'s reason
-- (0129): a discard outlives the item it was proposed on. The comment may
-- be deleted with that item; the row, and so the discard, stays.
CREATE TABLE `follow_up_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`item_id` text NOT NULL,
	`run_id` text,
	`title` text NOT NULL,
	`title_key` text NOT NULL,
	`reason` text NOT NULL,
	`acceptance_criteria` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`unfileable` text,
	`comment_id` text,
	`filed_item_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_follow_up_proposals_title` ON `follow_up_proposals` (`project_id`,`title_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_follow_up_proposals_comment` ON `follow_up_proposals` (`comment_id`);
