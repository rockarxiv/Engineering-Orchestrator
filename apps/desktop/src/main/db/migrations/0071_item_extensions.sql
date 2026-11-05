-- Pack state leaves the item row (KAN-148, ARCHITECTURE.md,
-- "One work entity").
--
-- `items` carried four Jira columns — the issue key, Jira's internal id,
-- the per-item sync switch and the pull-pending marker. None of them is
-- a fact about an item. They are one tracker binding's state, on the
-- table every item shares, and they are there because the developer pack
-- was the only pack there was; a support pack mirroring to Zendesk would
-- have had to add four more.
--
-- They become one `jira` row in `item_extensions`, and the next pack
-- that binds an item to something outside EO adds a row rather than a
-- column. Nothing about what any item mirrors changes here: the same
-- four values, under the same meanings, spelled without the prefix the
-- column names carried because inside the `jira` extension saying it
-- twice is noise.
--
-- **What a JSON column cannot carry is a unique index**, so the two
-- per-entity external ids do not move here. A comment's Jira id and an
-- attachment's are dedupe keys — they are what stop EO pushing Jira its
-- own words back and then reading them in again — and they become
-- indexed columns in the two side tables at the bottom, one per
-- extension.
--
-- **`ALTER TABLE ... DROP COLUMN` rather than the twelve-step rebuild**
-- 0069 and 0028 used. Those two had to rebuild for something ALTER
-- cannot do — a NOT NULL column with no default, a column becoming a
-- foreign key. Dropping needs none of that, and a rebuild of `items`,
-- `comments` and `attachments` would be three chances to lose an index
-- or a foreign key in exchange for nothing. The two indexed columns have
-- their index dropped first, which is the only thing DROP COLUMN
-- refuses.

CREATE TABLE `item_extensions` (
	`item_id` text NOT NULL REFERENCES `items`(`id`) ON DELETE cascade,
	`extension` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`item_id`, `extension`)
);
--> statement-breakpoint

-- "Which item mirrors KAN-7?" is asked on every link (it is what refuses
-- a key another item already holds), on every pull that maps an issue
-- back to an item, and on every import. It was an equality test on a
-- column; a partial expression index keeps it one rather than a scan of
-- every pack's state parsing JSON per row.
--
-- Deliberately not UNIQUE. One issue is one item (the pinned decision on
-- EO-121) and `linkJiraKey` is what enforces it, but `createItem` and
-- `importIssue` write keys without that check, so a database out there
-- may hold two items claiming one issue. A unique index would be an app
-- that will not open; the existing refusal stays where it is.
CREATE INDEX `idx_item_extensions_jira_key` ON `item_extensions` (json_extract(`data`, '$.key')) WHERE `extension` = 'jira';
--> statement-breakpoint

-- One row per item that has something to say, and none for the rest.
--
-- An item that has never been near Jira held `NULL, NULL, 1, 0` — the
-- column defaults — which is precisely what the accessor answers when it
-- finds no row, `sync: true` included. Writing those rows out would be
-- a row per item asserting silence, and the write path deletes one that
-- goes back to saying nothing for the same reason.
--
-- `json(...)` around the two flags, because `json_object('sync', 1)`
-- stores the integer 1 and the accessor's schema reads a boolean. The
-- CASE spells the JSON literal and `json()` splices it in as JSON rather
-- than as the string "true".
--
-- `updated_at` is the item's own. It is the closest true thing available
-- — the columns moved with the row, and nothing here is an edit anybody
-- made — and inventing a migration timestamp would date every mirrored
-- item's Jira state to the launch that upgraded it.
INSERT INTO `item_extensions` (`item_id`, `extension`, `data`, `updated_at`)
SELECT
	`id`,
	'jira',
	json_object(
		'key', `jira_key`,
		'id', `jira_id`,
		'sync', json(CASE WHEN `jira_sync` THEN 'true' ELSE 'false' END),
		'pullPending', json(CASE WHEN `jira_pull_pending` THEN 'true' ELSE 'false' END)
	),
	`updated_at`
FROM `items`
WHERE `jira_key` IS NOT NULL OR `jira_id` IS NOT NULL OR `jira_sync` = 0 OR `jira_pull_pending` = 1;
--> statement-breakpoint

ALTER TABLE `items` DROP COLUMN `jira_key`;
--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `jira_id`;
--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `jira_sync`;
--> statement-breakpoint
ALTER TABLE `items` DROP COLUMN `jira_pull_pending`;
--> statement-breakpoint

-- The comment side table.
--
-- `ON DELETE cascade` on both of these, which `deleteItem` and
-- `deleteComment` would otherwise each have to grow a line for. A link
-- row is not a record of anything — invariant 3 is about `run_events` —
-- it is a note saying "this comment and that Jira comment are the same
-- comment", which stops being true the moment the comment is gone.
CREATE TABLE `jira_comment_links` (
	`comment_id` text PRIMARY KEY NOT NULL REFERENCES `comments`(`id`) ON DELETE cascade,
	`jira_comment_id` text NOT NULL
);
--> statement-breakpoint

-- Unique now, where the column had a plain index. Two comments holding
-- one Jira comment id was always a bug — it is Jira's identifier for one
-- comment on one issue, and one issue is one item — and the failure it
-- produced was a comment imported twice.
CREATE UNIQUE INDEX `idx_jira_comment_links_remote` ON `jira_comment_links` (`jira_comment_id`);
--> statement-breakpoint

-- `min(id)` per id rather than a straight copy, because the index that
-- is unique from now on was not unique before. Ids are UUIDv7, so the
-- minimum is the oldest — the comment that claimed the Jira id first,
-- and the one the duplicate was a copy of. The copies lose their link,
-- which at worst makes one of them eligible to be read in again; the
-- alternative is a constraint failure on somebody's database at launch,
-- rolling back the whole upgrade for a row EO should never have written.
INSERT INTO `jira_comment_links` (`comment_id`, `jira_comment_id`)
SELECT min(`id`), `jira_comment_id` FROM `comments` WHERE `jira_comment_id` IS NOT NULL GROUP BY `jira_comment_id`;
--> statement-breakpoint

DROP INDEX `idx_comments_jira`;
--> statement-breakpoint
ALTER TABLE `comments` DROP COLUMN `jira_comment_id`;
--> statement-breakpoint

-- The attachment side table. Same shape, same reasoning.
--
-- The uniqueness is the remote id alone, where the dropped index was
-- (item, jira id): an attachment in Jira belongs to one issue, and one
-- issue is one item, so the item in that pair never told anyone
-- anything the id did not.
CREATE TABLE `jira_attachment_links` (
	`attachment_id` text PRIMARY KEY NOT NULL REFERENCES `attachments`(`id`) ON DELETE cascade,
	`jira_attachment_id` text NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX `idx_jira_attachment_links_remote` ON `jira_attachment_links` (`jira_attachment_id`);
--> statement-breakpoint

INSERT INTO `jira_attachment_links` (`attachment_id`, `jira_attachment_id`)
SELECT min(`id`), `jira_attachment_id` FROM `attachments` WHERE `jira_attachment_id` IS NOT NULL GROUP BY `jira_attachment_id`;
--> statement-breakpoint

DROP INDEX `idx_attachments_item_jira`;
--> statement-breakpoint
ALTER TABLE `attachments` DROP COLUMN `jira_attachment_id`;
