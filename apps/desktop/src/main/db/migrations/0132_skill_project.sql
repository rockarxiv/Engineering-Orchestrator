-- A moved project's skills on the organisation's record (EO-513).
--
-- The project a scoped skill belongs to, on the skill itself, for
-- `memories.project_id`'s reason (0129): a workspace is a path on
-- somebody's disk and never travels to a record, so a record holding a
-- workspace's skills has no workspace row to ask which project they are
-- of — and that is what decides what travels when the project is handed
-- over and what a replica is sent. Null for a global skill, and for a
-- workspace with no project. Carries no foreign key: a replica may be
-- sent a skill a page before the project it names.
ALTER TABLE `skills` ADD `project_id` text;
--> statement-breakpoint
UPDATE `skills` SET `project_id` = `scope_id` WHERE `scope` = 'project';
--> statement-breakpoint
UPDATE `skills`
SET `project_id` = (SELECT `workspaces`.`project_id` FROM `workspaces` WHERE `workspaces`.`id` = `skills`.`scope_id`)
WHERE `scope` = 'workspace';
--> statement-breakpoint
CREATE INDEX `idx_skills_project` ON `skills` (`project_id`);
--> statement-breakpoint
-- When this database last wrote the row, by its own clock — what a
-- replica pages on. Kept apart from `updated_at`, which is the version
-- the skill's author gave it and what decides which of two copies is
-- newer: a record finalising a move has to offer the project's skills
-- again without making them look newer than an edit the sender's last
-- sweep is still carrying.
ALTER TABLE `skills` ADD `local_changed_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `skills` SET `local_changed_at` = `updated_at`;
--> statement-breakpoint
CREATE INDEX `idx_skills_local_changed` ON `skills` (`local_changed_at`,`id`);
