-- Project and job threads retired (EO-730, ARCHITECTURE.md §7.1, §9.2).
--
-- A project thread (`SHOP-NOTES`, migration 0119) and a job's thread
-- (`JOB-n`, 0078) were off-board items EO posted on when it needed a
-- person to answer something no item was about. Messages do that now
-- (0163), and since EO-727, EO-728 and EO-729 nothing posts on a thread.
-- What was still waiting there is carried over and the threads go.
--
-- Runs once, on every database: a desktop's and the organisation's
-- record's alike, so the record converts and removes its own threads and
-- a desktop removes its replica copies of them in the same step.
--
-- 1. Every still-open mention of a person on a thread comment becomes an
--    open message to that person, with the comment's body, options and
--    date. Its id is deterministic, so a desktop converting its replica
--    copy of a record-held thread writes the very row the record writes
--    for the same mention; the record's sync then overwrites the one and
--    forgets the copies addressed to somebody else (EO-726). The first
--    mention of a comment, by person id, keeps the comment's own id —
--    which is what a skip's "Run it now" offer names in
--    `job_occurrences.offer_comment_id`, so answering the message fires
--    the occurrence without rewriting that append-only row. Any other
--    keeps the comment id's time and random head and takes its tail from
--    the person's id.
--
--    A skip offer becomes a `job_skipped` message about its job, as one
--    sent since EO-729 is; a template-update conflict notice still
--    unresolved becomes a `template_conflict` message whose subject is
--    the conflict, so resolving it resolves the message. Anything else is
--    `project_notes` or `job_thread`, after where it was asked.
INSERT INTO `messages`
	(`id`, `recipient_id`, `project_id`, `job_id`, `source`, `body`, `options`, `created_at`, `handled_at`, `handled_how`, `answer`, `subject`)
SELECT
	CASE WHEN `ranked`.`rank` = 1 THEN `ranked`.`comment_id`
	     ELSE substr(`ranked`.`comment_id`, 1, 24) || substr(lower(hex(`ranked`.`target_id`)), -12) END,
	`ranked`.`target_id`,
	`ranked`.`project_id`,
	coalesce(`ranked`.`offer_job_id`, `ranked`.`thread_job_id`),
	CASE WHEN `ranked`.`offer_job_id` IS NOT NULL THEN 'job_skipped'
	     WHEN `ranked`.`conflict_id` IS NOT NULL THEN 'template_conflict'
	     WHEN `ranked`.`step_id` = 'job-thread' THEN 'job_thread'
	     ELSE 'project_notes' END,
	`ranked`.`body`,
	`ranked`.`options`,
	`ranked`.`created_at`,
	NULL, NULL, NULL,
	`ranked`.`conflict_id`
FROM (
	SELECT
		`c`.`id` AS `comment_id`,
		`m`.`target_id`,
		`i`.`project_id`,
		`i`.`step_id`,
		`c`.`body`,
		`c`.`options`,
		`c`.`created_at`,
		(SELECT `j`.`id` FROM `jobs` `j` WHERE `j`.`thread_item_id` = `i`.`id`) AS `thread_job_id`,
		(SELECT `o`.`job_id` FROM `job_occurrences` `o` WHERE `o`.`offer_comment_id` = `c`.`id` LIMIT 1) AS `offer_job_id`,
		(SELECT `p`.`id` FROM `pipeline_update_conflicts` `p`, json_each(`p`.`notice_comment_ids`) `n`
		  WHERE `n`.`value` = `c`.`id` AND `p`.`resolved_at` IS NULL LIMIT 1) AS `conflict_id`,
		ROW_NUMBER() OVER (PARTITION BY `c`.`id` ORDER BY `m`.`target_id`) AS `rank`
	FROM `comment_mentions` `m`
	JOIN `comments` `c` ON `c`.`id` = `m`.`comment_id`
	JOIN `items` `i` ON `i`.`id` = `c`.`item_id`
	WHERE `i`.`step_id` IN ('project-thread', 'job-thread')
	  AND `m`.`status` = 'open'
	  AND `m`.`target_type` = 'human'
	  AND `m`.`target_id` IS NOT NULL
) AS `ranked`
WHERE true
ON CONFLICT(`id`) DO NOTHING;
--> statement-breakpoint
-- 2. The bytes of the files on those threads are EO's to remove, which a
--    migration cannot do: their paths are left here for
--    `removeRetiredAttachmentFiles` to delete at launch.
CREATE TABLE `retired_attachment_files` (
	`path` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `retired_attachment_files` (`path`)
SELECT `storage_path` FROM `attachments`
WHERE `managed` = 1 AND `item_id` IN (SELECT `id` FROM `items` WHERE `step_id` IN ('project-thread', 'job-thread'));
--> statement-breakpoint
-- 3. The threads, with everything written about them — `deleteItem`'s
--    order and reach, by hand, since foreign keys are off while a
--    migration runs and no cascade fires on its own.
CREATE TEMP TABLE `retired_threads` AS SELECT `id` FROM `items` WHERE `step_id` IN ('project-thread', 'job-thread');
--> statement-breakpoint
CREATE TEMP TABLE `retired_comments` AS SELECT `id` FROM `comments` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `attachments` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`) OR `comment_id` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
DELETE FROM `attachment_removals` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `comment_mentions` WHERE `comment_id` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
UPDATE `comment_mentions` SET `addressed_by` = NULL WHERE `addressed_by` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
DELETE FROM `jira_comment_links` WHERE `comment_id` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
UPDATE `skill_proposals` SET `comment_id` = NULL WHERE `comment_id` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
UPDATE `comments` SET `parent_id` = NULL WHERE `parent_id` IN (SELECT `id` FROM `retired_comments`) AND `id` NOT IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
DELETE FROM `comments` WHERE `id` IN (SELECT `id` FROM `retired_comments`);
--> statement-breakpoint
DELETE FROM `run_events` WHERE `run_id` IN (SELECT `id` FROM `runs` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`));
--> statement-breakpoint
DELETE FROM `side_calls` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`) OR `run_id` IN (SELECT `id` FROM `runs` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`));
--> statement-breakpoint
UPDATE `comments` SET `run_id` = NULL WHERE `run_id` IN (SELECT `id` FROM `runs` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`));
--> statement-breakpoint
DELETE FROM `runs` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `transitions` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `outbox` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `record_commands` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `item_deps` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`) OR `depends_on_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `dispatch_leases` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `item_extensions` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `item_origins` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
UPDATE `item_origins` SET `origin_item_id` = NULL WHERE `origin_item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `item_watches` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `repository_indexes` WHERE `item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
UPDATE `memories` SET `source_item_id` = NULL WHERE `source_item_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
UPDATE `items` SET `parent_id` = NULL WHERE `parent_id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DELETE FROM `items` WHERE `id` IN (SELECT `id` FROM `retired_threads`);
--> statement-breakpoint
DROP TABLE `retired_comments`;
--> statement-breakpoint
DROP TABLE `retired_threads`;
--> statement-breakpoint
-- 4. What kept them: their steps, the `JOB` key sequence, the one-per-
--    project index, and `jobs.thread_item_id`. A from-discussion job's
--    "thread" was its conversation, which its trigger names already.
--    The column is a foreign key, which `DROP COLUMN` refuses, so the
--    table is rebuilt; no index hangs off it.
DROP INDEX IF EXISTS `idx_items_project_thread`;
--> statement-breakpoint
DELETE FROM `pipeline_steps` WHERE `id` IN ('project-thread', 'job-thread');
--> statement-breakpoint
DELETE FROM `key_counters` WHERE `prefix` = 'JOB';
--> statement-breakpoint
CREATE TABLE `jobs_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`pipeline_id` text REFERENCES `pipelines`(`id`),
	`template` text,
	`owner_id` text NOT NULL REFERENCES `people`(`id`),
	`paused_at` integer,
	`budget_per_occurrence_cents` integer,
	`max_items_per_hour` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`paused_reason` text,
	`runs_on` text DEFAULT 'device' NOT NULL
);
--> statement-breakpoint
INSERT INTO `jobs_new`
	(`id`, `project_id`, `name`, `trigger`, `pipeline_id`, `template`, `owner_id`, `paused_at`, `budget_per_occurrence_cents`, `max_items_per_hour`, `created_at`, `updated_at`, `deleted_at`, `paused_reason`, `runs_on`)
SELECT `id`, `project_id`, `name`, `trigger`, `pipeline_id`, `template`, `owner_id`, `paused_at`, `budget_per_occurrence_cents`, `max_items_per_hour`, `created_at`, `updated_at`, `deleted_at`, `paused_reason`, `runs_on`
FROM `jobs`;
--> statement-breakpoint
DROP TABLE `jobs`;
--> statement-breakpoint
ALTER TABLE `jobs_new` RENAME TO `jobs`;
