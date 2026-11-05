CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`repo_path` text NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`test_command` text,
	`lint_command` text,
	`build_command` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_key_prefix_unique` ON `projects` (`key_prefix`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
-- D-04: the configured repo becomes the first project. Everything below
-- this line is hand-written — drizzle-kit sees a new table and a dropped
-- one, not a rename, so it cannot know the rows have to come across.
--
-- `name` is the repo's directory name: rtrim(path, <path with its
-- separators removed>) strips the basename off the right, leaving the
-- parent prefix, which replace() then removes. Backslashes are folded
-- to `/` first so a Windows path gets the same treatment.
INSERT INTO `projects` (`id`, `name`, `key_prefix`, `repo_path`, `base_branch`, `test_command`, `lint_command`, `build_command`, `created_at`, `updated_at`)
SELECT
	`id`,
	replace(
		replace(`repo_path`, '\', '/'),
		rtrim(replace(`repo_path`, '\', '/'), replace(replace(`repo_path`, '\', '/'), '/', '')),
		''
	),
	'EO',
	`repo_path`,
	`base_branch`,
	`test_command`,
	`lint_command`,
	`build_command`,
	`created_at`,
	`updated_at`
FROM `workspaces`
-- Only the oldest row was ever read (getWorkspace returned [0]), so that
-- is the only one that was ever driving anything.
ORDER BY `created_at`
LIMIT 1;--> statement-breakpoint
-- A trailing separator, or a repo at the filesystem root, leaves the
-- name empty. The full path is a worse name than the directory, and a
-- much better one than nothing.
UPDATE `projects` SET `name` = `repo_path` WHERE `name` = '';--> statement-breakpoint
-- Every existing ticket belongs to it: before this migration there was
-- one repo, so there is no ambiguity about which.
UPDATE `tickets` SET `project_id` = (SELECT `id` FROM `projects` ORDER BY `created_at` LIMIT 1);