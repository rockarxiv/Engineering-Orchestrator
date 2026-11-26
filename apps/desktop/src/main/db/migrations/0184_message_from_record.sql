-- Where a message lives (EO-918): 1 for a replica's copy of one the
-- organisation's record holds — written by the pull and by a send or
-- press answered there — 0 for one this database wrote itself. Read to
-- send a press on it to the record and to clear the copies the record no
-- longer keeps. Asked of the row rather than inferred from its project,
-- since a message about a record-held job has none.
--
-- A message already here is placed by what its row carries, never by a
-- clock. Every sender that writes on a desktop leaves a mark a replica's
-- copy never has: a subject (a copy's is dropped), a job (a copy keeps
-- only a job this desktop holds, and the record's jobs never reach one),
-- or the local person as its recipient (`sendMessageHere`; a desktop
-- pulls only what is addressed to its signed-in person). And no copy is
-- about a project kept here, nor about no project on a desktop that has
-- never pulled its person's messages. A message with none of those marks
-- is one only the record writes: a copy.
ALTER TABLE `messages` ADD `from_record` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `messages` SET `from_record` = 1
WHERE `subject` IS NULL
  AND `job_id` IS NULL
  AND `recipient_id` <> '01a0a0af-6d78-73d8-9954-953391d30f68'
  AND NOT EXISTS (
    SELECT 1 FROM `projects`
    WHERE `projects`.`id` = `messages`.`project_id` AND `projects`.`managed_at` IS NULL AND `projects`.`adopting_at` IS NULL
  )
  AND (`project_id` IS NOT NULL OR EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'record.messagesCursor'));
