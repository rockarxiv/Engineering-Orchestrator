-- Skill ownership, history and lock (EO-714).
--
-- Every skill that exists now was written or saved by a person, so each
-- is `person`'s and unlocked. Every write from here on files a
-- `skill_versions` row: the description, body and files after it, the
-- author, and when. The table is append-only, as `run_events` is.
ALTER TABLE `skills` ADD `created_by` text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`action` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`files` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text,
	`restored_from` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_versions_skill` ON `skill_versions` (`skill_id`,`created_at`);--> statement-breakpoint
-- Each skill's history starts with what it says now, as a person's write
-- at the moment it was last saved: a `create` when it was never edited,
-- an `edit` otherwise, and an `archive` for one already archived. The id
-- is uuidv7-shaped the way 0109 builds one.
INSERT INTO `skill_versions` (`id`, `skill_id`, `action`, `description`, `body`, `files`, `author_kind`, `author_id`, `restored_from`, `created_at`)
SELECT
	substr(printf('%012x', `s`.`updated_at`), 1, 8) || '-' ||
		substr(printf('%012x', `s`.`updated_at`), 9, 4) || '-7' ||
		substr(lower(hex(randomblob(2))), 2) || '-a' ||
		substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
	`s`.`id`,
	CASE WHEN `s`.`archived_at` IS NOT NULL THEN 'archive' WHEN `s`.`updated_at` = `s`.`created_at` THEN 'create' ELSE 'edit' END,
	`s`.`description`,
	`s`.`body`,
	`s`.`files`,
	'person',
	NULL,
	NULL,
	`s`.`updated_at`
FROM `skills` AS `s`;
--> statement-breakpoint
-- A copy of a skill from the organisation's record that a person's lock
-- kept out (EO-714): held here rather than dropped, written as soon as
-- the lock is lifted, and told to the person once on a project thread.
CREATE TABLE `held_skill_copies` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`copy` text NOT NULL,
	`project_id` text,
	`problem` text NOT NULL,
	`held_at` integer NOT NULL,
	`told_at` integer
);
