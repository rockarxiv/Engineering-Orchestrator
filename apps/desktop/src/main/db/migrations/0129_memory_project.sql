-- Memory in organisation mode (EO-482, ARCHITECTURE.md, "The record").
--
-- The project an entry belongs to, on the entry itself. A workspace is a
-- path on somebody's disk and never travels to a record, so a record
-- holding a workspace's entries has no workspace row to ask which project
-- they are of — and that is what decides who holds them, what travels
-- when the project is handed over, and what a replica is sent. Null only
-- for a workspace with no project. Carries no foreign key: a replica may
-- be sent an entry a page before the project it names.
ALTER TABLE `memories` ADD `project_id` text;
--> statement-breakpoint
UPDATE `memories` SET `project_id` = `scope_id` WHERE `scope_kind` = 'project';
--> statement-breakpoint
UPDATE `memories`
SET `project_id` = (SELECT `workspaces`.`project_id` FROM `workspaces` WHERE `workspaces`.`id` = `memories`.`scope_id`)
WHERE `scope_kind` = 'workspace';
--> statement-breakpoint
CREATE INDEX `idx_memories_project` ON `memories` (`project_id`);
--> statement-breakpoint
-- What a replica pages on: every entry changed since a cursor, by when
-- it last changed and its id.
CREATE INDEX `idx_memories_updated` ON `memories` (`updated_at`,`id`);
