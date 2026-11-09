-- An attachment is owned by one comment or by the item itself (EO-702).
--
-- A row with no `comment_id` is one of the item's own files — a mock it
-- is built against, a spec PDF, a screenshot of the bug — part of what
-- the item is, as its description is, rather than something said on its
-- thread. Every existing row keeps its comment: nothing is migrated,
-- the rows are copied across exactly as they are.
--
-- A rebuild because SQLite cannot drop NOT NULL with ALTER. Foreign keys
-- are off for the length of a migration (`runMigrations`), which is what
-- lets `attachments` be dropped while `jira_attachment_links` still
-- names it; the rename puts the name back, and `foreign_key_check`
-- afterwards proves nothing was orphaned. The columns, defaults, foreign
-- keys and both indexes are the ones the table had.
CREATE TABLE `__new_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL REFERENCES `items`(`id`),
	`comment_id` text REFERENCES `comments`(`id`),
	`storage_path` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`managed` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`jira_sync_error` text
);
--> statement-breakpoint
INSERT INTO `__new_attachments` (`id`, `item_id`, `comment_id`, `storage_path`, `name`, `mime_type`, `size`, `managed`, `created_at`, `jira_sync_error`)
SELECT `id`, `item_id`, `comment_id`, `storage_path`, `name`, `mime_type`, `size`, `managed`, `created_at`, `jira_sync_error` FROM `attachments`;
--> statement-breakpoint
DROP TABLE `attachments`;
--> statement-breakpoint
ALTER TABLE `__new_attachments` RENAME TO `attachments`;
--> statement-breakpoint
CREATE INDEX `idx_attachments_item` ON `attachments` (`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_attachments_comment` ON `attachments` (`comment_id`);
--> statement-breakpoint

-- Item files somebody removed, for the organisation record to page to
-- every replica (EO-702). A removed row is gone, so nothing in
-- `attachments` can say so; this is the list that does. No foreign key
-- to `items`: the item may go later, and `deleteItem` takes these rows
-- with it.
CREATE TABLE `attachment_removals` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`removed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachment_removals_paging` ON `attachment_removals` (`removed_at`, `attachment_id`);
