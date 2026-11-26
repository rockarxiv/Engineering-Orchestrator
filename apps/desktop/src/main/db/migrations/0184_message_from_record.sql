-- Where a message lives (EO-918): 1 for a replica's copy of one the
-- organisation's record holds — written by the pull and by a send or
-- press answered there — 0 for one this database wrote itself. Read to
-- send a press on it to the record and to clear the copies the record no
-- longer keeps. Asked of the row rather than inferred from its project,
-- since a message about a record-held job has none, and one sent here
-- about a project before it moved is this desktop's own.
--
-- A message already here is marked this database's own only on evidence
-- the row carries, never on a clock: one with a subject (a replica's copy
-- never has one), one about a project kept here (no copy is ever about
-- one), or one about no project on a desktop that has never pulled its
-- person's messages (the pull is the only way such a copy arrives). Any
-- other is left null — not known — rather than guessed: a press on it
-- asks the record first, nothing that deletes copies touches it, and the
-- first pull that reads the person's messages to the end settles it.
ALTER TABLE `messages` ADD `from_record` integer;
--> statement-breakpoint
UPDATE `messages` SET `from_record` = 0 WHERE `subject` IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM `projects`
    WHERE `projects`.`id` = `messages`.`project_id` AND `projects`.`managed_at` IS NULL AND `projects`.`adopting_at` IS NULL
  )
  OR (`project_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'record.messagesCursor'));
